//! Compressing a local, lossless or otherwise large audio file (FLAC, WAV, AAC/M4A, OGG/Vorbis, Opus — one
//! the file scope already allows reading) down to MP3, the same "compression" ask `video_transcode.rs`
//! already answers for video (CLAUDE.md's "Just like we did the compression feature for videos, let's do a
//! similar compression feature for audio files: convert lossless (or other large) audio files to mp3"), and
//! built the identical way — this module mirrors that one's own shape deliberately, down to the names, so a
//! reader of one already knows the other.
//!
//! **Scoped the same way**, for the same reasons:
//! - **Windows desktop only.** Android would need the same separate MediaCodec implementation
//!   `video_transcode.rs` already declined to attempt in this pass; refused with the identical honest
//!   "not available on this platform yet".
//! - **Convert once, to a cached file.** The same once-to-a-file-then-serve-it design, not a live stream.
//!
//! **Unlike the video module, there is no "does this already play here" question to answer.** Every audio
//! format this app recognizes at all (`lib/media.ts`'s `mediaKindOf` — mp3/m4a/aac/wav/oga/ogg/opus/flac)
//! already decodes in an ordinary `<audio>` element; the ask here is specifically about *file size* — a
//! lossless or otherwise large source compressed down to a small MP3 to save space or make it easier to
//! move around — not playback compatibility. So this module has no `*_playability` probe and no in-app
//! "convert so it plays" button: only the begin/progress/status/delete/export quintet, the same shape
//! `video_transcode.rs`'s own "Compress and save a copy…" half already has, used on its own rather than
//! alongside a separate "Convert for compatible playback" feature.
//!
//! **The pipeline** (`convert`) is the audio half of `video_transcode.rs`'s own `convert`, with the video
//! stream and its whole encode side removed: `MFCreateSourceReaderFromURL` opens the file, the first actual
//! audio stream is found and decoded to PCM (`MFAudioFormat_PCM`, via `SetCurrentMediaType` — this is what
//! makes the *decoder* side format-agnostic, exactly as for video: whatever codec the stream is actually in,
//! Media Foundation's own topology resolver finds a decoder MFT for it). `MFCreateSinkWriterFromURL` writes
//! a new file with an MP3 output type picked from `MFTranscodeGetAudioOutputAvailableTypes(&MFAudioFormat_MP3,
//! …)` — Windows' own built-in MP3 Audio Encoder MFT (`CLSID_MP3ACMCodecWrapper`, present since Windows 8;
//! Server editions without the "Desktop Experience" component may lack it, the same caveat the AAC encoder
//! already has) — the identical "ask the real encoder what it actually supports" pattern `pick_aac_output_type`
//! already uses, since an MP3 encoder's own accepted sample rate/channel count/bitrate combinations are a
//! small, discrete set too. From there it's the same plain pump: `ReadSample`/`WriteSample` until the one
//! selected stream reports end-of-stream, then `Finalize`. A source with no audio track at all is refused.
//!
//! **Caching, serving, progress and ownership** are exactly `video_transcode.rs`'s own conventions, applied
//! to a second letter: `files/a/NNN/n/…` (`layout.rs`'s `FILES_AUDIO_TRANSCODES_FOLDER`, `"n"`, a sibling of
//! `m`) via `files_cache.rs`'s `n_path`/`n_done`/`n_lookup`/`n_delete` and `local_branches.rs`'s
//! `local_n_path`/`local_n_done`/`local_n_lookup`/`local_n_delete` — the same `versioned_cache_file` sharing
//! `m`'s own already did, named `<name>.<modified>-<size>.mp3`; served at `/@audio-transcode/<root>/<path>`
//! (`notes_pages.rs`'s `Special::AudioTranscode`), the same `/@device/`-shaped address, re-resolved and
//! re-looked-up fresh on every request rather than a cache-internal filename; progress a plain ratio of the
//! output file's own growing size against the input's, capped at 99% until `Finalize` completes; a job
//! belongs to the window that began it (`caller_key`), the same `TranscodeJobs`-shaped ownership.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Manager, State};

use crate::app_state::AppDbState;
use crate::files_cache::Cache;
use crate::fs_scope::FsScope;
use crate::window_host::{caller_key, CallerWindow};

struct Job {
    owner: String,
    percent: AtomicU32,
    done: AtomicBool,
    error: Mutex<Option<String>>,
    /// What to address the result at, once done — `root`/`path` exactly as the caller gave them, so the
    /// finished address is built the same deterministic way `audio_transcode_progress` would build it even
    /// for an already-cached hit (see `address_of`).
    root: String,
    path: String,
}

/// Jobs in flight or finished, by a random id — the identical "kept until the window that began them asks
/// again" lifetime `video_transcode.rs`'s own `TranscodeJobs` already has.
#[derive(Default)]
pub struct AudioTranscodeJobs {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTranscodeStatus {
    percent: u32,
    done: bool,
    error: Option<String>,
    /// Set once `done` and `error` is `None` — the address to play.
    url: Option<String>,
}

/// The address a window may load the compressed MP3 of `root`/`path` at, once there is one — the same
/// `/@device/<root>/<path>` shape `video_transcode.rs`'s own `address_of` already builds, re-resolved by
/// `notes_pages::serve` on every request rather than naming a cache-internal file directly.
fn address_of(root: &str, path: &str) -> String {
    let mut url = tauri::Url::parse(&format!("{}://localhost/", crate::USER_PROTOCOL)).expect("static URL");
    url.path_segments_mut()
        .expect("has a base")
        .pop_if_empty()
        .extend(["@audio-transcode", root])
        .extend(path.trim_start_matches('/').split('/').filter(|s| !s.is_empty()));
    crate::window_host::navigation_url(&url).to_string()
}

/// Where a compressed copy of `root`/`path`'s *current* version is cached, if one exists — local roots only
/// (the same Filen limitation `video_transcode.rs`'s own `lookup` has: a Filen file isn't a real local path
/// until the cache has it). Used both by `audio_transcode_begin`'s own "already compressed" check and by
/// `notes_pages::serve`'s `/@audio-transcode/` handler, kept in one place so they can't disagree.
pub(crate) async fn lookup(app: &tauri::AppHandle, scope: &FsScope, root: &str, path: &str) -> Result<Option<PathBuf>, String> {
    let real = scope.check_in(root, path, true)?;
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Ok(None);
    }
    let guid = crate::picked_roots::root_guid_of(&app.state::<AppDbState>().pool, root).await?;
    app.state::<Cache>().local_n_lookup(&guid, path, crate::video_transcode::modified_ms(&meta), meta.len())
}

/// Starts compressing `path` of `root` to MP3, or resolves at once if a cached compression of the file as it
/// is *now* (its size and modified time) already exists. Resolves to a job id either way —
/// `audio_transcode_progress` reports `done: true` immediately for an already-cached one.
#[tauri::command]
pub async fn audio_transcode_begin(
    window: CallerWindow,
    scope: State<'_, FsScope>,
    jobs: State<'_, AudioTranscodeJobs>,
    app: tauri::AppHandle,
    root: String,
    path: String,
) -> Result<String, String> {
    let real = scope.check_in(&root, &path, true)?;
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("That isn't a file.".to_string());
    }
    let mtime = crate::video_transcode::modified_ms(&meta);
    let size = meta.len();
    let guid = crate::picked_roots::root_guid_of(&app.state::<AppDbState>().pool, &root).await?;
    let owner = caller_key(&window);
    let id = uuid::Uuid::new_v4().to_string();

    if app.state::<Cache>().local_n_lookup(&guid, &path, mtime, size)?.is_some() {
        let job = Arc::new(Job { owner, percent: AtomicU32::new(100), done: AtomicBool::new(true), error: Mutex::new(None), root, path });
        jobs.jobs.lock().unwrap().insert(id.clone(), job);
        return Ok(id);
    }

    let output = app.state::<Cache>().local_n_path(&guid, &path, mtime, size)?;
    let job = Arc::new(Job { owner, percent: AtomicU32::new(0), done: AtomicBool::new(false), error: Mutex::new(None), root: root.clone(), path: path.clone() });
    jobs.jobs.lock().unwrap().insert(id.clone(), job.clone());

    let input_len = size.max(1);
    let part = output.with_extension("mp3.part");
    // Same reasoning as `video_transcode.rs`'s own `video_transcode_begin`: `Cache` isn't `Clone`, so the
    // blocking task fetches the state it needs (`local_n_done`, once the rename below succeeds) fresh.
    let app_for_task = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let part_for_progress = part.clone();
        let job_for_progress = job.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_progress = stop.clone();
        let progress_thread = std::thread::spawn(move || {
            while !stop_for_progress.load(Ordering::Relaxed) {
                if let Ok(meta) = std::fs::metadata(&part_for_progress) {
                    let pct = ((meta.len() as f64 / input_len as f64) * 100.0).min(99.0) as u32;
                    job_for_progress.percent.store(pct, Ordering::Relaxed);
                }
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        });
        let result = platform::convert(&real, &part);
        stop.store(true, Ordering::Relaxed);
        let _ = progress_thread.join();
        match result {
            Ok(()) => {
                if let Err(e) = std::fs::rename(&part, &output) {
                    *job.error.lock().unwrap() = Some(format!("The compression finished but couldn't be saved: {e}"));
                } else {
                    let _ = app_for_task.state::<Cache>().local_n_done(&guid, &path, mtime, size);
                    job.percent.store(100, Ordering::Relaxed);
                }
            }
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                *job.error.lock().unwrap() = Some(e);
            }
        }
        job.done.store(true, Ordering::Relaxed);
    });

    Ok(id)
}

#[tauri::command]
pub fn audio_transcode_progress(window: CallerWindow, jobs: State<'_, AudioTranscodeJobs>, job_id: String) -> Result<AudioTranscodeStatus, String> {
    let owner = caller_key(&window);
    let job = {
        let jobs = jobs.jobs.lock().unwrap();
        jobs.get(&job_id).filter(|j| j.owner == owner).cloned().ok_or("That compression isn't open.")?
    };
    let done = job.done.load(Ordering::Relaxed);
    let error = job.error.lock().unwrap().clone();
    let url = if done && error.is_none() { Some(address_of(&job.root, &job.path)) } else { None };
    Ok(AudioTranscodeStatus { percent: job.percent.load(Ordering::Relaxed), done, error, url })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTranscodeAvailability {
    /// Whether a compressed copy of the file's *current* version is already cached — never starts one.
    cached: bool,
    /// Set when `cached` — the same address `audio_transcode_progress` would give for an already-cached
    /// job, without having to start (or fake) one just to learn it.
    url: Option<String>,
}

/// Whether a compressed copy of `root`/`path`'s *current* version already exists, with no side effect —
/// unlike `audio_transcode_begin`, nothing is started and no job id is made.
#[tauri::command]
pub async fn audio_transcode_status(scope: State<'_, FsScope>, app: tauri::AppHandle, root: String, path: String) -> Result<AudioTranscodeAvailability, String> {
    match lookup(&app, &scope, &root, &path).await? {
        Some(_) => Ok(AudioTranscodeAvailability { cached: true, url: Some(address_of(&root, &path)) }),
        None => Ok(AudioTranscodeAvailability { cached: false, url: None }),
    }
}

/// Deletes the cached compressed copy of `root`/`path`'s *current* version, if one exists — the person's
/// own "delete the compressed file" action. The source file is never touched, and nothing is refused if
/// there was no cached copy to begin with.
#[tauri::command]
pub async fn audio_transcode_delete(scope: State<'_, FsScope>, app: tauri::AppHandle, root: String, path: String) -> Result<(), String> {
    let real = scope.check_in(&root, &path, true)?;
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("That isn't a file.".to_string());
    }
    let guid = crate::picked_roots::root_guid_of(&app.state::<AppDbState>().pool, &root).await?;
    app.state::<Cache>().local_n_delete(&guid, &path, crate::video_transcode::modified_ms(&meta), meta.len())
}

/// Exports the cached compressed copy of `root`/`path` to a device location the person chooses —
/// "Compress and save a copy…" for audio, the exact mirror of `video_transcode.rs`'s own
/// `video_transcode_export`: `device_files::export_file` is the same copy-to-a-chosen-location primitive,
/// handed the cache's own real path (`lookup`, above) since the compressed copy lives in the protected
/// `files/` cache. Refuses if nothing is cached yet rather than silently starting a compression of its own.
#[tauri::command]
pub async fn audio_transcode_export(
    window: CallerWindow,
    app: tauri::AppHandle,
    scope: State<'_, FsScope>,
    exports: State<'_, crate::device_files::ExportState>,
    root: String,
    path: String,
    name: String,
    token: Option<String>,
) -> Result<String, String> {
    crate::device_files::confirm_export(&app, &window, &name).await?;
    let cached = lookup(&app, &scope, &root, &path).await?.ok_or("Nothing is cached yet — compress it first.")?;
    crate::device_files::export_file(exports.inner(), name, token, cached).await
}

#[cfg(windows)]
mod platform {
    use std::path::Path;

    use windows::core::{Interface, HSTRING, PCWSTR};
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    struct ComGuard;
    impl ComGuard {
        fn new() -> windows::core::Result<Self> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
            Ok(ComGuard)
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    struct MfGuard;
    impl MfGuard {
        fn new() -> windows::core::Result<Self> {
            unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL)? };
            Ok(MfGuard)
        }
    }
    impl Drop for MfGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
            }
        }
    }

    /// Same gap, same fix, as `video_transcode.rs`'s own `hstring_url`: `fs_scope.rs` hands back
    /// `std::fs::canonicalize`'s extended-length form (`\\?\C:\...`), which Media Foundation's URL parser
    /// misreads as a UNC share unless the prefix is stripped first.
    fn hstring_url(path: &Path) -> HSTRING {
        let raw = path.to_string_lossy();
        let plain = raw.strip_prefix(r"\\?\UNC\").map(|rest| format!(r"\\{rest}")).unwrap_or_else(|| raw.strip_prefix(r"\\?\").map(str::to_string).unwrap_or_else(|| raw.to_string()));
        HSTRING::from(plain)
    }

    /// The *first* actual audio stream, as a concrete reader index — `video_transcode.rs`'s own
    /// `find_streams`, the audio half only (this module never looks for a video stream at all).
    fn find_audio_stream(reader: &IMFSourceReader) -> windows::core::Result<Option<u32>> {
        for i in 0u32.. {
            let kind = unsafe { reader.GetNativeMediaType(i, 0) };
            let Ok(kind) = kind else { break };
            if let Ok(major) = unsafe { kind.GetGUID(&MF_MT_MAJOR_TYPE) } {
                if major == MFMediaType_Audio {
                    return Ok(Some(i));
                }
            }
        }
        Ok(None)
    }

    /// An MP3 output type the system's own encoder actually supports — the audio-encoder-side mirror of
    /// `video_transcode.rs`'s own `pick_aac_output_type` (see its doc comment for why this has to be asked
    /// of the real encoder MFT rather than invented): picks the first available type that matches the
    /// decoded PCM's own sample rate and channel count, else just the first one at all.
    fn pick_mp3_output_type(decoded_pcm: &IMFMediaType) -> windows::core::Result<IMFMediaType> {
        let want_rate = unsafe { decoded_pcm.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND) }.unwrap_or(0);
        let want_channels = unsafe { decoded_pcm.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS) }.unwrap_or(0);
        let available = unsafe { MFTranscodeGetAudioOutputAvailableTypes(&MFAudioFormat_MP3, MFT_ENUM_FLAG_ALL.0 as u32, None) }?;
        let count = unsafe { available.GetElementCount() }?;
        let mut fallback: Option<IMFMediaType> = None;
        for i in 0..count {
            let Ok(unk) = (unsafe { available.GetElement(i) }) else { continue };
            let Ok(candidate) = unk.cast::<IMFMediaType>() else { continue };
            if fallback.is_none() {
                fallback = Some(candidate.clone());
            }
            let rate = unsafe { candidate.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND) }.unwrap_or(0);
            let channels = unsafe { candidate.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS) }.unwrap_or(0);
            if rate == want_rate && channels == want_channels {
                return Ok(candidate);
            }
        }
        fallback.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_NOTIMPL))
    }

    /// `input` → `output`, a plain MP3 of `input`'s first audio stream — see the module's own doc comment
    /// for the full pipeline. `output` is a path this function alone writes (the caller's own
    /// `.part`-then-rename convention); nothing here assumes it doesn't already exist.
    pub fn convert(input: &Path, output: &Path) -> Result<(), String> {
        let to_err = |e: windows::core::Error| format!("{}", e.message());
        unsafe {
            let _com = ComGuard::new().map_err(to_err)?;
            let _mf = MfGuard::new().map_err(to_err)?;

            let reader = MFCreateSourceReaderFromURL(PCWSTR(hstring_url(input).as_ptr()), None)
                .map_err(|e| format!("This file can't be opened: {}", to_err(e)))?;

            let audio_idx = find_audio_stream(&reader).map_err(to_err)?;
            let Some(audio_idx) = audio_idx else {
                return Err("This file has no audio that could be found.".to_string());
            };
            // Deselect everything, then select only the one audio stream we actually want — a video track
            // or anything else in the container is left out entirely.
            reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false).map_err(to_err)?;
            reader.SetStreamSelection(audio_idx, true).map_err(to_err)?;
            let want = MFCreateMediaType().map_err(to_err)?;
            want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(to_err)?;
            want.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(to_err)?;
            reader.SetCurrentMediaType(audio_idx, None, &want).map_err(|e| format!("This file's audio can't be decoded: {}", to_err(e)))?;
            let decoded_audio = reader.GetCurrentMediaType(audio_idx).map_err(to_err)?;

            let sink_attrs: Option<IMFAttributes> = {
                let mut attrs = None;
                MFCreateAttributes(&mut attrs, 3).map_err(to_err)?;
                let attrs = attrs.unwrap();
                attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1).map_err(to_err)?;
                attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1).map_err(to_err)?;
                // Same reasoning as `video_transcode.rs`'s own sink attributes: the real output path is a
                // `.part` file first, whose extension Media Foundation can't infer a container from — naming
                // it explicitly removes the guesswork regardless of the URL's own extension.
                attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MP3).map_err(to_err)?;
                Some(attrs)
            };
            let writer = MFCreateSinkWriterFromURL(PCWSTR(hstring_url(output).as_ptr()), None, sink_attrs.as_ref())
                .map_err(|e| format!("The compressed file couldn't be created: {}", to_err(e)))?;

            let out_type = pick_mp3_output_type(&decoded_audio).map_err(|e| format!("This file's audio can't be encoded to MP3: {}", to_err(e)))?;
            let audio_out = writer.AddStream(&out_type).map_err(|e| format!("This file's audio can't be encoded to MP3: {}", to_err(e)))?;
            writer.SetInputMediaType(audio_out, &decoded_audio, None).map_err(to_err)?;

            writer.BeginWriting().map_err(to_err)?;

            loop {
                let mut flags = 0u32;
                let mut timestamp = 0i64;
                let mut sample: Option<IMFSample> = None;
                reader
                    .ReadSample(audio_idx, 0, None, Some(&mut flags), Some(&mut timestamp), Some(&mut sample))
                    .map_err(to_err)?;
                if flags & (MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                    break;
                }
                let Some(sample) = sample else { continue };
                writer.WriteSample(audio_out, &sample).map_err(to_err)?;
            }

            writer.Finalize().map_err(|e| format!("The compressed file couldn't be finished: {}", to_err(e)))?;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// The same extended-length-path fix `video_transcode.rs` already found and fixed live, re-verified
        /// here since this module duplicates its own copy of `hstring_url` rather than sharing the private one.
        #[test]
        fn the_extended_length_prefix_is_stripped_before_building_the_url() {
            assert_eq!(hstring_url(Path::new(r"\\?\C:\Temp\a.flac")).to_string(), r"C:\Temp\a.flac");
            assert_eq!(hstring_url(Path::new(r"\\?\UNC\server\share\a.flac")).to_string(), r"\\server\share\a.flac");
            assert_eq!(hstring_url(Path::new(r"C:\Temp\a.flac")).to_string(), r"C:\Temp\a.flac", "an already-plain path is left alone");
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::path::Path;

    pub fn convert(_input: &Path, _output: &Path) -> Result<(), String> {
        Err("Compressing audio isn't available on this platform yet.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_served_address_is_the_same_shape_device_paths_already_have() {
        let a = address_of("user", "/a.flac");
        let b = address_of("user", "/b.flac");
        let c = address_of("picked-root", "/a.flac");
        assert_ne!(a, b, "a different path is a different address");
        assert_ne!(a, c, "a different root is a different address");
        assert_eq!(a, address_of("user", "/a.flac"), "the same root and path address the same way every time");
        assert!(a.contains("@audio-transcode/user/"), "names the root, never a cache-internal file: {a}");
        assert!(a.ends_with("a.flac"), "names the real path, not a hash: {a}");
    }

    /// Not run by a plain `cargo test --lib` — a real compression of a real file, driven directly rather
    /// than through the Tauri command stack, for a fast iteration loop while getting the Media Foundation
    /// pipeline right. `cargo test --lib audio_transcode -- --ignored --nocapture`, with
    /// `CSDRIVE_TEST_AUDIO` pointing at a real local audio file (FLAC, WAV, AAC/M4A, OGG, …).
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn real_file_conversion() {
        let input = std::env::var("CSDRIVE_TEST_AUDIO").expect("set CSDRIVE_TEST_AUDIO to a real audio file's path");
        let input = std::path::Path::new(&input);
        let output = std::env::temp_dir().join("csdrive-audio-transcode-test.mp3");
        let _ = std::fs::remove_file(&output);
        let started = std::time::Instant::now();
        let result = platform::convert(input, &output);
        println!("compression took {:?}: {:?}", started.elapsed(), result);
        result.expect("compression failed");
        let meta = std::fs::metadata(&output).expect("output file should exist");
        println!("output is {} bytes", meta.len());
        assert!(meta.len() > 0, "the output file is empty");
    }
}
