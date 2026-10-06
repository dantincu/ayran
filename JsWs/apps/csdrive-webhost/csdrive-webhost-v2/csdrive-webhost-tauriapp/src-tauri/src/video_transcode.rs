//! Converting a local video file (one the file scope already allows reading) into a browser-playable MP4,
//! using whatever decoder **Windows itself** has for the source's codecs — a third-party codec pack's own
//! registered decoder included — and re-encoding to H.264/AAC, which every engine this app ships on can
//! play. CLAUDE.md's "item 19" ask, scoped to what was actually tractable in one pass:
//!
//! - **Windows desktop only.** Android would need an entirely separate MediaCodec/MediaExtractor
//!   implementation through the existing JNI bridge pattern (`android_jni.rs`) — not attempted here, and
//!   refused with an honest "not available on this platform yet", the same shape `secure_store.rs`'s iOS
//!   stub and `secondary_windows::focus_admin_window`'s Android stub already use.
//! - **Convert once, to a cached file — not a live streaming transcode.** A real-time pipeline that keeps
//!   pace with an HTTP Range request while simultaneously decoding and encoding would mean synchronizing
//!   Media Foundation's own pull-based reads with the piece-by-piece server this app already has for every
//!   other file (`file_serving.rs`) — a much bigger, riskier design than converting once, to a file, and
//!   serving that file exactly the way every other cached file in this app already is.
//!
//! **Why the browser alone can't do this.** Chromium's own `<video>` decodes with whatever codecs are
//! compiled into *it*, not whatever the OS has — it never consults the OS's own codec registry at all, so
//! an OS-installed codec pack (what this feature's other half, the Help page's own instructions, points
//! someone at) changes nothing for the in-page player by itself. Windows Media Foundation, by contrast,
//! *does* search every registered decoder on the system — including a third-party pack's own — the moment
//! it's asked to decode a stream to a *different* type than the one it's natively in, which is the whole
//! reason to route through it here rather than trying to patch the browser's own decoding.
//!
//! **The pipeline** (`convert`): `MFCreateSourceReaderFromURL` opens the file. Every stream is probed by
//! index (`GetNativeMediaType`, stopping at the first `MF_E_INVALIDSTREAMNUMBER`) to find the *first* actual
//! video stream and the *first* actual audio stream — concrete numeric indices, not the `_FIRST_..._STREAM`
//! sentinel constants, which are only trustworthy for *selecting*, not for interpreting what `ReadSample`'s
//! own `actual_stream_index` output later reports. Only those two (of however many a container holds — a
//! second audio track, subtitles) are selected; each is told to decode to an intermediate uncompressed type
//! (`MFVideoFormat_NV12`, `MFAudioFormat_PCM`) via `SetCurrentMediaType` — this is what makes the *decoder*
//! side format-agnostic: whatever codec the stream is actually in, Media Foundation's own topology resolver
//! finds a decoder MFT for it the moment it's asked for a type the stream isn't already in.
//! `MFCreateSinkWriterFromURL` then writes a new file: each stream is `AddStream`-ed with its *output* type
//! (H.264 for video, built by `CopyAllItems`-ing the decoded type's own frame size/rate/aspect/interlace
//! attributes and overriding just the subtype and a bitrate — avoiding ever having to pack `MF_MT_FRAME_SIZE`/
//! `MF_MT_FRAME_RATE`'s own `UINT64` high/low halves by hand; AAC for audio, picked from
//! `MFTranscodeGetAudioOutputAvailableTypes`'s own list of what the system's AAC encoder actually supports —
//! its sample rate/channel count/bitrate combinations are a small, discrete set the encoder MFT accepts, not
//! anything a caller may simply invent, unlike video's much more permissive bitrate) and `SetInputMediaType`-
//! ed with the *decoded* type from the reader — again a different type on each side of the same stream, which
//! is what makes the sink writer look for an *encoder* MFT the same way the reader just looked for a decoder
//! one. From there it's a plain pump: `ReadSample`/`WriteSample` in a loop (`MF_SOURCE_READER_ANY_STREAM`,
//! dispatched to the right output stream by which concrete index each sample actually came back on) until
//! both selected streams report end-of-stream, then `Finalize`. Nothing here ever touches a sample's own
//! bytes — decode and encode both happen inside Media Foundation's own MFTs, driven purely by which media
//! *type* each side is told to expect.
//!
//! **A source with only one of the two tracks** (silent video, an audio-only file) is handled the same way
//! with just that one stream added — `AddStream`/`SetInputMediaType` are only ever called for a track that
//! was actually found. A source with *neither* is refused outright.
//!
//! **Caching** (`files/video-transcodes/`, a flat, content-addressed working folder — see `layout.rs`'s own
//! doc comment on why it isn't a folder-pairs cache like the Filen/local-branch ones). Keyed by a hash of the
//! *root id + path* (so two different roots can't collide on the same relative path) plus the source's own
//! size and modified time in the filename — the same "a changed file simply misses the cache" idea
//! thumbnails already use elsewhere in this app. Written to a `.part` file and renamed into place only once
//! `Finalize` succeeds — the same safety convention as everything else this app writes piece by piece — so
//! an interrupted conversion never leaves a half-written file being served, and a crash mid-run leaves only
//! an orphaned `.part` file, never something `video_transcode_url` could be handed.
//!
//! **Progress** is a plain ratio of the *output* file's own growing size against the *input* file's size —
//! not the input position Media Foundation is actually at, which would need `IMFPresentationDescriptor`'s own
//! `MF_PD_DURATION` (a `PROPVARIANT`, needing two more Cargo features this module didn't otherwise need) just
//! to turn into a percentage. A transcoded file is usually a comparable order of magnitude to its source for
//! similar quality settings, so this is a reasonable, honest approximation of "how far along it is" — not an
//! exact one — capped at 99% until `Finalize` actually completes, so it never visibly finishes early.
//!
//! **Ownership.** A job belongs to the window that began it (`caller_key`, the same convention
//! `filen_cache.rs`'s `UploadSessions`/`SeedSessions` already use) — another window's `video_transcode_progress`/
//! `video_transcode_url` for someone else's job id is refused, not merely ignored, since unlike those two this
//! job keeps running in the background regardless of who asks about it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::fs_scope::FsScope;
use crate::window_host::{caller_key, CallerWindow};

struct Job {
    owner: String,
    percent: AtomicU32,
    done: AtomicBool,
    error: Mutex<Option<String>>,
    output: PathBuf,
}

/// Jobs in flight or finished, by a random id — kept until the window that began them asks again after
/// they're done (a browser tab is free to poll as many times as it likes; nothing times these out, since a
/// finished job is cheap to keep and the output file it names is a real, reusable cache entry regardless).
#[derive(Default)]
pub struct TranscodeJobs {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeStatus {
    percent: u32,
    done: bool,
    error: Option<String>,
    /// Set once `done` and `error` is `None` — the address to play.
    url: Option<String>,
}

/// `files/video-transcodes/<hash of root+path>.<modified ms>-<size>.mp4` — content-addressed, so a changed
/// source file naturally misses the cache rather than serving a stale conversion, and two different roots
/// can't collide on the same relative path.
fn cache_path(dir: &Path, root: &str, path: &str, len: u64, modified_ms: u128) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(root.as_bytes());
    hasher.update([0u8]);
    hasher.update(path.as_bytes());
    let digest = hasher.finalize();
    let hash = hex::encode(&digest[..12]);
    dir.join(format!("{hash}.{modified_ms}-{len}.mp4"))
}

fn modified_ms(meta: &std::fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0)
}

/// Starts converting `path` of `root` for compatible playback, or resolves at once if a cached conversion of
/// the file as it is *now* (its size and modified time) already exists. Resolves to a job id either way —
/// `video_transcode_progress` reports `done: true` immediately for an already-cached one.
#[tauri::command]
pub async fn video_transcode_begin(
    window: CallerWindow,
    scope: State<'_, FsScope>,
    jobs: State<'_, TranscodeJobs>,
    app: tauri::AppHandle,
    root: String,
    path: String,
) -> Result<String, String> {
    let real = scope.check_in(&root, &path, true)?;
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("That isn't a file.".to_string());
    }
    let data_dir = crate::data_location::effective_data_dir(&app)?;
    let dir = crate::layout::video_transcodes_dir(&data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let output = cache_path(&dir, &root, &path, meta.len(), modified_ms(&meta));
    let owner = caller_key(&window);
    let id = uuid::Uuid::new_v4().to_string();

    if output.is_file() {
        let job = Arc::new(Job { owner, percent: AtomicU32::new(100), done: AtomicBool::new(true), error: Mutex::new(None), output });
        jobs.jobs.lock().unwrap().insert(id.clone(), job);
        return Ok(id);
    }

    let job = Arc::new(Job { owner, percent: AtomicU32::new(0), done: AtomicBool::new(false), error: Mutex::new(None), output: output.clone() });
    jobs.jobs.lock().unwrap().insert(id.clone(), job.clone());

    let input_len = meta.len().max(1);
    let part = output.with_extension("mp4.part");
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
                    *job.error.lock().unwrap() = Some(format!("The conversion finished but couldn't be saved: {e}"));
                } else {
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
pub fn video_transcode_progress(window: CallerWindow, jobs: State<'_, TranscodeJobs>, job_id: String) -> Result<TranscodeStatus, String> {
    let owner = caller_key(&window);
    let job = {
        let jobs = jobs.jobs.lock().unwrap();
        jobs.get(&job_id).filter(|j| j.owner == owner).cloned().ok_or("That conversion isn't open.")?
    };
    let done = job.done.load(Ordering::Relaxed);
    let error = job.error.lock().unwrap().clone();
    let url = if done && error.is_none() { Some(address_of(&job.output)) } else { None };
    Ok(TranscodeStatus { percent: job.percent.load(Ordering::Relaxed), done, error, url })
}

/// The address a window may load the converted file at — not a real path (`window_host::navigation_url`
/// builds it the same way `notes_pages::media_url` does for every other kind of media this app serves).
fn address_of(output: &Path) -> String {
    let name = output.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let mut url = tauri::Url::parse(&format!("{}://localhost/", crate::USER_PROTOCOL)).expect("static URL");
    url.path_segments_mut().expect("has a base").pop_if_empty().extend(["@video-transcode", &name]);
    crate::window_host::navigation_url(&url).to_string()
}

/// Serves a converted file by its cache filename (parsed out of the address `address_of` built) — not a job
/// id, so the address survives past the job's own lifetime and a page can keep `<video src>` pointed at it.
/// Still only ever a name *this module itself* generated (`cache_path`'s own hex-hash-dot-digits-dash-digits
/// shape, checked below), inside `files/video-transcodes/` alone — never a caller-supplied path.
pub async fn serve(app: &tauri::AppHandle, name: &str, meta: &crate::file_serving::RequestMeta, csp: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::StatusCode;
    let forbidden = || crate::respond_text(StatusCode::FORBIDDEN, "Forbidden", csp);
    if !is_cache_file_name(name) {
        return forbidden();
    }
    let Ok(data_dir) = crate::data_location::effective_data_dir(app) else { return forbidden() };
    let path = crate::layout::video_transcodes_dir(&data_dir).join(name);
    if !path.is_file() {
        return crate::respond_text(StatusCode::NOT_FOUND, "Not found", csp);
    }
    crate::file_serving::respond_file_blocking(path, meta, csp).await
}

/// `cache_path`'s own shape: 24 hex characters, `.`, digits, `-`, digits, `.mp4` — rejecting anything else
/// keeps `serve` (above) from ever joining an attacker-chosen name onto `video_transcodes_dir`.
fn is_cache_file_name(name: &str) -> bool {
    let Some(rest) = name.strip_suffix(".mp4") else { return false };
    let Some((hash, suffix)) = rest.split_once('.') else { return false };
    if hash.len() != 24 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let Some((modified, size)) = suffix.split_once('-') else { return false };
    !modified.is_empty() && modified.bytes().all(|b| b.is_ascii_digit()) && !size.is_empty() && size.bytes().all(|b| b.is_ascii_digit())
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

    /// A path `fs_scope.rs` hands back is `std::fs::canonicalize`'s own output, which on Windows is always
    /// extended-length (`\\?\C:\...`) — fine for `CreateFile`-family APIs, but found live to break Media
    /// Foundation's own URL parser: it reads the leading `\\` as a UNC share and tries to resolve `?` as a
    /// server name, failing with "The network path was not found" even though the file plainly exists (the
    /// *un*prefixed form of the exact same path opened correctly — confirmed by stripping it here). The
    /// prefix is stripped — `\\?\UNC\server\share\...` back to `\\server\share\...`, `\\?\C:\...` back to
    /// `C:\...` — before building the URL; a path not shaped like this (already caller-built, the ignored
    /// test's own env var) passes through unchanged.
    fn hstring_url(path: &Path) -> HSTRING {
        let raw = path.to_string_lossy();
        let plain = raw.strip_prefix(r"\\?\UNC\").map(|rest| format!(r"\\{rest}")).unwrap_or_else(|| raw.strip_prefix(r"\\?\").map(str::to_string).unwrap_or_else(|| raw.to_string()));
        HSTRING::from(plain)
    }

    /// The *first* actual video stream and the *first* actual audio stream, as concrete reader indices — not
    /// the `MF_SOURCE_READER_FIRST_..._STREAM` sentinels, which are only meaningful for *selecting* a stream,
    /// not for interpreting what `ReadSample`'s own `actual_stream_index` output later reports a sample
    /// belongs to.
    fn find_streams(reader: &IMFSourceReader) -> windows::core::Result<(Option<u32>, Option<u32>)> {
        let (mut video, mut audio) = (None, None);
        for i in 0u32.. {
            let kind = unsafe { reader.GetNativeMediaType(i, 0) };
            let Ok(kind) = kind else { break };
            let Ok(major) = (unsafe { kind.GetGUID(&MF_MT_MAJOR_TYPE) }) else { continue };
            if video.is_none() && major == MFMediaType_Video {
                video = Some(i);
            } else if audio.is_none() && major == MFMediaType_Audio {
                audio = Some(i);
            }
        }
        Ok((video, audio))
    }

    /// An AAC output type the system's own encoder actually supports — its sample rate/channel count/bitrate
    /// are a small, discrete set the real encoder MFT accepts, not anything a caller may simply invent (unlike
    /// video's much more permissive bitrate). Picks the first one that matches the decoded PCM type's own
    /// sample rate and channel count, else just the first available type at all (letting the Sink Writer's own
    /// topology resolution insert a resampler/channel mixer if one is needed and available).
    fn pick_aac_output_type(decoded_pcm: &IMFMediaType) -> windows::core::Result<IMFMediaType> {
        let want_rate = unsafe { decoded_pcm.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND) }.unwrap_or(0);
        let want_channels = unsafe { decoded_pcm.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS) }.unwrap_or(0);
        let available = unsafe { MFTranscodeGetAudioOutputAvailableTypes(&MFAudioFormat_AAC, MFT_ENUM_FLAG_ALL.0 as u32, None) }?;
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

    /// `input` → `output`, a plain MP4 with H.264 video (if the source has any) and AAC audio (likewise) —
    /// see the module's own doc comment for the full pipeline. `output` is a path this function alone writes
    /// (the caller's own `.part`-then-rename convention); nothing here assumes it doesn't already exist.
    pub fn convert(input: &Path, output: &Path) -> Result<(), String> {
        let to_err = |e: windows::core::Error| format!("{}", e.message());
        unsafe {
            let _com = ComGuard::new().map_err(to_err)?;
            let _mf = MfGuard::new().map_err(to_err)?;

            let reader = MFCreateSourceReaderFromURL(PCWSTR(hstring_url(input).as_ptr()), None)
                .map_err(|e| format!("This file can't be opened: {}", to_err(e)))?;

            let (video_idx, audio_idx) = find_streams(&reader).map_err(to_err)?;
            if video_idx.is_none() && audio_idx.is_none() {
                return Err("This file has no video or audio that could be found.".to_string());
            }
            // Deselect everything, then select only the one video and one audio stream we actually want —
            // a second audio track, subtitles or anything else is left out of the conversion entirely.
            reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false).map_err(to_err)?;

            let mut decoded_video: Option<IMFMediaType> = None;
            if let Some(idx) = video_idx {
                reader.SetStreamSelection(idx, true).map_err(to_err)?;
                let want = MFCreateMediaType().map_err(to_err)?;
                want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(to_err)?;
                want.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(to_err)?;
                reader.SetCurrentMediaType(idx, None, &want).map_err(|e| format!("This file's video can't be decoded: {}", to_err(e)))?;
                decoded_video = Some(reader.GetCurrentMediaType(idx).map_err(to_err)?);
            }
            let mut decoded_audio: Option<IMFMediaType> = None;
            if let Some(idx) = audio_idx {
                reader.SetStreamSelection(idx, true).map_err(to_err)?;
                let want = MFCreateMediaType().map_err(to_err)?;
                want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(to_err)?;
                want.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(to_err)?;
                reader.SetCurrentMediaType(idx, None, &want).map_err(|e| format!("This file's audio can't be decoded: {}", to_err(e)))?;
                decoded_audio = Some(reader.GetCurrentMediaType(idx).map_err(to_err)?);
            }

            let sink_attrs: Option<IMFAttributes> = {
                let mut attrs = None;
                MFCreateAttributes(&mut attrs, 3).map_err(to_err)?;
                let attrs = attrs.unwrap();
                attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1).map_err(to_err)?;
                attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1).map_err(to_err)?;
                // `MFCreateSinkWriterFromURL` otherwise infers the container (MP4, ASF, …) from the URL's own
                // file extension — found live to matter: the real output path is written to a `.part` file
                // first (this module's own caller, `video_transcode_begin`, renaming it to `.mp4` only once
                // `Finalize` succeeds), whose extension is `.part`, not `.mp4` — an extension Media Foundation
                // doesn't recognize as any container at all, so creating the sink writer failed outright
                // ("The specified object or value does not exist") the moment a real `.part`-suffixed path was
                // actually exercised (an earlier, direct-to-a-plain-`.mp4`-path test run never hit this, which
                // is why it wasn't caught until going through the real `video_transcode_begin` path live).
                // Naming the container explicitly removes the guesswork entirely, regardless of the URL's own
                // extension.
                attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4).map_err(to_err)?;
                Some(attrs)
            };
            let writer = MFCreateSinkWriterFromURL(PCWSTR(hstring_url(output).as_ptr()), None, sink_attrs.as_ref())
                .map_err(|e| format!("The converted file couldn't be created: {}", to_err(e)))?;

            // Reader stream index -> sink writer stream index, so a sample's own `actual_stream_index` (from
            // `ReadSample`) tells us which `WriteSample` call it belongs to.
            let mut video_out: Option<u32> = None;
            if let Some(decoded) = &decoded_video {
                let out_type = MFCreateMediaType().map_err(to_err)?;
                decoded.CopyAllItems(&out_type).map_err(to_err)?;
                out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(to_err)?;
                out_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(to_err)?;
                out_type.SetUINT32(&MF_MT_AVG_BITRATE, video_bitrate(decoded)).map_err(to_err)?;
                let idx = writer.AddStream(&out_type).map_err(|e| format!("This file's video can't be encoded for playback: {}", to_err(e)))?;
                writer.SetInputMediaType(idx, decoded, None).map_err(to_err)?;
                video_out = Some(idx);
            }
            let mut audio_out: Option<u32> = None;
            if let Some(decoded) = &decoded_audio {
                let out_type = pick_aac_output_type(decoded).map_err(|e| format!("This file's audio can't be encoded for playback: {}", to_err(e)))?;
                let idx = writer.AddStream(&out_type).map_err(|e| format!("This file's audio can't be encoded for playback: {}", to_err(e)))?;
                writer.SetInputMediaType(idx, decoded, None).map_err(to_err)?;
                audio_out = Some(idx);
            }

            writer.BeginWriting().map_err(to_err)?;

            let (mut video_done, mut audio_done) = (video_out.is_none(), audio_out.is_none());
            while !video_done || !audio_done {
                let mut actual_index = 0u32;
                let mut flags = 0u32;
                let mut timestamp = 0i64;
                let mut sample: Option<IMFSample> = None;
                reader
                    .ReadSample(
                        MF_SOURCE_READER_ANY_STREAM.0 as u32,
                        0,
                        Some(&mut actual_index),
                        Some(&mut flags),
                        Some(&mut timestamp),
                        Some(&mut sample),
                    )
                    .map_err(to_err)?;
                if flags & (MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                    if Some(actual_index) == video_idx {
                        video_done = true;
                    }
                    if Some(actual_index) == audio_idx {
                        audio_done = true;
                    }
                    continue;
                }
                let Some(sample) = sample else { continue };
                let target = if Some(actual_index) == video_idx { video_out } else if Some(actual_index) == audio_idx { audio_out } else { None };
                if let Some(target) = target {
                    writer.WriteSample(target, &sample).map_err(to_err)?;
                }
            }

            writer.Finalize().map_err(|e| format!("The converted file couldn't be finished: {}", to_err(e)))?;
        }
        Ok(())
    }

    /// A plain, fixed bitrate scaled by the decoded frame's own pixel area (bigger video, more bits) — not
    /// tuned per-content, just enough to keep a small file watchable and a large one from ballooning.
    fn video_bitrate(decoded: &IMFMediaType) -> u32 {
        let size = unsafe { decoded.GetUINT64(&MF_MT_FRAME_SIZE) }.unwrap_or(1920u64 << 32 | 1080);
        let (width, height) = ((size >> 32) as u64, (size & 0xffff_ffff) as u64);
        let pixels = width.max(1) * height.max(1);
        // Roughly 0.1 bits per pixel per frame at a nominal 30fps, clamped to a sane range.
        ((pixels as f64 * 0.1 * 30.0) as u32).clamp(1_000_000, 20_000_000)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Found live: `fs_scope.rs` hands back `std::fs::canonicalize`'s own extended-length form, which
        /// Media Foundation's URL parser misreads as a UNC share ("The network path was not found" for a file
        /// that plainly exists) unless the `\\?\` prefix is stripped first.
        #[test]
        fn the_extended_length_prefix_is_stripped_before_building_the_url() {
            assert_eq!(hstring_url(Path::new(r"\\?\C:\Temp\a.mkv")).to_string(), r"C:\Temp\a.mkv");
            assert_eq!(hstring_url(Path::new(r"\\?\UNC\server\share\a.mkv")).to_string(), r"\\server\share\a.mkv");
            assert_eq!(hstring_url(Path::new(r"C:\Temp\a.mkv")).to_string(), r"C:\Temp\a.mkv", "an already-plain path is left alone");
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::path::Path;

    pub fn convert(_input: &Path, _output: &Path) -> Result<(), String> {
        Err("Converting a video for compatible playback isn't available on this platform yet.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_paths_are_unique_per_root_and_path_and_change_with_the_file() {
        let dir = Path::new("v");
        let a = cache_path(dir, "user", "a.mkv", 100, 1000);
        let b = cache_path(dir, "user", "b.mkv", 100, 1000);
        let c = cache_path(dir, "picked-root", "a.mkv", 100, 1000);
        let d = cache_path(dir, "user", "a.mkv", 200, 1000);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
        assert_eq!(a, cache_path(dir, "user", "a.mkv", 100, 1000), "the same file names the same cache entry");
    }

    #[test]
    fn only_this_modules_own_cache_file_shape_is_accepted_for_serving() {
        let dir = Path::new("v");
        let real = cache_path(dir, "user", "a.mkv", 100, 1000);
        assert!(is_cache_file_name(real.file_name().unwrap().to_str().unwrap()));
        assert!(!is_cache_file_name("../../admin/data.db"));
        assert!(!is_cache_file_name("not-a-cache-file.mp4"));
        assert!(!is_cache_file_name("deadbeefdeadbeefdeadbeef.1000-100.txt"), "must end .mp4");
        assert!(!is_cache_file_name("short.1000-100.mp4"), "the hash must be the real length");
    }

    /// Not run by a plain `cargo test --lib` — a real, several-minute conversion of a real file, driven
    /// directly rather than through the Tauri command stack, for a fast iteration loop while getting the
    /// Media Foundation pipeline itself right. `cargo test --lib video_transcode -- --ignored --nocapture`,
    /// with `CSDRIVE_TEST_VIDEO` pointing at a real local file.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn real_file_conversion() {
        let input = std::env::var("CSDRIVE_TEST_VIDEO").expect("set CSDRIVE_TEST_VIDEO to a real video file's path");
        let input = Path::new(&input);
        let output = std::env::temp_dir().join("csdrive-video-transcode-test.mp4");
        let _ = std::fs::remove_file(&output);
        let started = std::time::Instant::now();
        let result = platform::convert(input, &output);
        println!("conversion took {:?}: {:?}", started.elapsed(), result);
        result.expect("conversion failed");
        let meta = std::fs::metadata(&output).expect("output file should exist");
        println!("output is {} bytes", meta.len());
        assert!(meta.len() > 0, "the output file is empty");
    }
}
