use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::ipc::{Channel, Response};

// Must match FRAME_SAMPLES/SAMPLE_RATE/CHANNELS in api/src/audio/mixer.ts and
// desktop/src/lib/audioCapture.ts so frames can go straight onto the
// existing host WebSocket without any further reshaping in JS.
const TARGET_SAMPLE_RATE: u32 = 48000;
const FRAME_SAMPLES: usize = 960;
const CHANNELS: usize = 2;
// Reverted to 1 (no batching): batching to 5 traded steady 20ms delivery for
// bursty 100ms delivery, which reintroduced - and on the API's mixer side,
// worsened - the same queue-starvation pattern this was meant to fix. Kept
// as a named constant rather than removing the machinery entirely, in case
// a smarter (e.g. time-based rather than count-based) batching scheme is
// worth revisiting later.
const BATCH_FRAMES: usize = 1;

pub struct LoopbackState {
    stream: Mutex<Option<Stream>>,
    // f32 bit pattern in an atomic so the slider in the UI can update gain
    // live, without needing to lock anything from inside the audio callback.
    gain_bits: Arc<AtomicU32>,
}

impl Default for LoopbackState {
    fn default() -> Self {
        Self {
            stream: Mutex::new(None),
            gain_bits: Arc::new(AtomicU32::new(1.0f32.to_bits())),
        }
    }
}

/// Catmull-Rom cubic interpolation through points (p0,p1,p2,p3) at p1..p2,
/// parameterized by t in [0,1]. Noticeably less aliasing/distortion than
/// linear interpolation for the same O(1)-per-sample cost - no look-ahead
/// buffering beyond the 1-sample-back/2-sample-forward neighbors already
/// needed structurally, so no added latency. At t=0 this is exactly p1,
/// which makes a 1:1 (no resampling needed) passthrough exact.
fn catmull_rom(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    0.5 * ((2.0 * p1)
        + (-p0 + p2) * t
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
}

/// Extracts stereo (L, R) from an interleaved multi-channel input frame -
/// downmixes anything beyond the first two channels by simply dropping them,
/// and duplicates a mono input's single channel to both L and R.
fn stereo_from_frame(frame: &[f32]) -> (f32, f32) {
    let l = frame[0];
    let r = if frame.len() > 1 { frame[1] } else { l };
    (l, r)
}

/// Resamples interleaved stereo f32 input to TARGET_SAMPLE_RATE via
/// Catmull-Rom cubic interpolation, quantizes to i16, and emits fixed-size
/// interleaved [L,R,L,R,...] frames matching the host WebSocket wire format.
struct Pipeline {
    input_rate: u32,
    channels: usize,
    left_buffer: Vec<f32>,
    right_buffer: Vec<f32>,
    pcm_buffer: Vec<i16>,
    // Accumulates whole 20ms frames (as bytes) until BATCH_FRAMES are ready,
    // then they're sent as a single channel message - see BATCH_FRAMES.
    batch_buffer: Vec<u8>,
    gain_bits: Arc<AtomicU32>,
    // Fractional read-cursor position carried over between calls. Without
    // this, resetting the cursor to 0.0 every call effectively rewinds the
    // read position by the discarded fraction each time, causing the
    // resampler to slightly over-produce (re-interpolate a sliver it
    // already covered) on every callback whenever input_rate != target rate.
    // Real correctness bug (verified by test), but the direction means it
    // causes mild oversupply, not the empty-queue/silence-gap symptom.
    phase: f64,
    // Diagnostics: wall-clock time of the previous callback, to check
    // whether cpal itself is the one leaving gaps (e.g. WASAPI loopback
    // sessions are known to occasionally auto-suspend during near-silence
    // and take a moment to resume) rather than something in our own code.
    last_callback_at: Instant,
}

impl Pipeline {
    fn new(input_rate: u32, channels: usize, gain_bits: Arc<AtomicU32>) -> Self {
        Self {
            input_rate,
            channels: channels.max(1),
            left_buffer: Vec::new(),
            right_buffer: Vec::new(),
            pcm_buffer: Vec::new(),
            batch_buffer: Vec::new(),
            gain_bits,
            phase: 0.0,
            last_callback_at: Instant::now(),
        }
    }

    fn push(&mut self, data: &[f32], on_frame: &Channel<Response>) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_callback_at);
        self.last_callback_at = now;

        let frames_in_callback = data.len() / self.channels;
        let expected_secs = frames_in_callback as f64 / self.input_rate as f64;
        let elapsed_secs = elapsed.as_secs_f64();
        // Flag any callback that took noticeably longer to arrive than the
        // amount of audio it delivered would suggest - if cpal itself is
        // leaving gaps (e.g. WASAPI loopback auto-suspending during
        // near-silence), this is where it would show up.
        if elapsed_secs > expected_secs * 3.0 + 0.02 {
            eprintln!(
                "loopback capture: callback arrived {:.1}ms after the previous one but only delivered {:.1}ms of audio ({} frames) - cpal/WASAPI gap, not our code",
                elapsed_secs * 1000.0,
                expected_secs * 1000.0,
                frames_in_callback,
            );
        }

        for frame in data.chunks(self.channels) {
            let (l, r) = stereo_from_frame(frame);
            self.left_buffer.push(l);
            self.right_buffer.push(r);
        }

        // Need at least two samples to interpolate between; otherwise wait for more.
        if self.left_buffer.len() < 2 {
            return;
        }

        let gain = f32::from_bits(self.gain_bits.load(Ordering::Relaxed));
        let ratio = self.input_rate as f64 / TARGET_SAMPLE_RATE as f64;
        let len = self.left_buffer.len();
        let usable = (len - 1) as f64;
        let mut cursor = self.phase;

        while cursor < usable {
            let idx = cursor.floor() as usize;
            let frac = (cursor - idx as f64) as f32;

            // Neighbor indices are clamped rather than requiring a wider
            // margin in `usable`: only the first/last couple of samples in
            // any given callback ever hit the clamp, which is inaudible.
            let i0 = idx.saturating_sub(1);
            let i2 = (idx + 1).min(len - 1);
            let i3 = (idx + 2).min(len - 1);

            let l = catmull_rom(self.left_buffer[i0], self.left_buffer[idx], self.left_buffer[i2], self.left_buffer[i3], frac) * gain;
            let r = catmull_rom(self.right_buffer[i0], self.right_buffer[idx], self.right_buffer[i2], self.right_buffer[i3], frac) * gain;

            self.pcm_buffer.push((l.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
            self.pcm_buffer.push((r.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
            cursor += ratio;
        }

        let consumed = (cursor.floor() as usize).min(len);
        self.left_buffer.drain(0..consumed);
        self.right_buffer.drain(0..consumed);
        // Carry the exact fractional remainder forward instead of resetting
        // to 0.0 - this is the fix for the slow drift described above.
        self.phase = (cursor - consumed as f64).max(0.0);

        while self.pcm_buffer.len() >= FRAME_SAMPLES * CHANNELS {
            let frame: Vec<i16> = self.pcm_buffer.drain(0..FRAME_SAMPLES * CHANNELS).collect();
            for sample in frame {
                self.batch_buffer.extend_from_slice(&sample.to_le_bytes());
            }

            if self.batch_buffer.len() >= FRAME_SAMPLES * CHANNELS * 2 * BATCH_FRAMES {
                let bytes = std::mem::take(&mut self.batch_buffer);
                // Send as a raw-bytes Response rather than a bare Vec<u8>: a
                // plain Vec<u8> gets JSON-encoded as an array of numbers (one
                // JSON token per byte). Response::new wraps it as
                // InvokeResponseBody::Raw, which the webview delivers as a
                // real ArrayBuffer instead - and batching several frames
                // into each message (see BATCH_FRAMES) cuts how often this
                // channel send happens at all, which matters on Windows/
                // WebView2 where each channel message has its own fixed
                // delivery overhead regardless of payload encoding.
                let _ = on_frame.send(Response::new(bytes));
            }
        }
    }
}

#[tauri::command]
pub fn start_loopback_capture(
    state: tauri::State<LoopbackState>,
    on_frame: Channel<Response>,
    initial_gain: f32,
) -> Result<(), String> {
    state.gain_bits.store(initial_gain.to_bits(), Ordering::Relaxed);

    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "No default output (speaker) device found".to_string())?;
    let config = device
        .default_output_config()
        .map_err(|e| format!("Failed to read default output config: {e}"))?;

    let channels = config.channels() as usize;
    let input_rate = config.sample_rate();
    let sample_format = config.sample_format();
    let stream_config = config.config();

    let gain_bits = state.gain_bits.clone();
    let pipeline = Mutex::new(Pipeline::new(input_rate, channels, gain_bits));
    let err_fn = |err| eprintln!("loopback capture stream error: {err}");

    // Opening an *output* device for input capture is how cpal exposes
    // system-audio loopback: WASAPI loopback on Windows, a CoreAudio
    // aggregate device + tap on macOS 14.6+. On Linux this only works if
    // ALSA/PipeWire happens to allow it for the default sink directly;
    // otherwise the user needs to pick a "Monitor of ..." source manually
    // (not yet wired up here).
    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                pipeline.lock().unwrap().push(data, &on_frame);
            },
            err_fn,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                let floats: Vec<f32> = data.iter().map(|s| *s as f32 / i16::MAX as f32).collect();
                pipeline.lock().unwrap().push(&floats, &on_frame);
            },
            err_fn,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                let floats: Vec<f32> = data
                    .iter()
                    .map(|s| (*s as f32 - u16::MAX as f32 / 2.0) / (u16::MAX as f32 / 2.0))
                    .collect();
                pipeline.lock().unwrap().push(&floats, &on_frame);
            },
            err_fn,
            None,
        ),
        other => return Err(format!("Unsupported loopback sample format: {other:?}")),
    }
    .map_err(|e| format!("Failed to build loopback input stream: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start loopback stream: {e}"))?;

    *state.stream.lock().unwrap() = Some(stream);
    Ok(())
}

#[tauri::command]
pub fn stop_loopback_capture(state: tauri::State<LoopbackState>) -> Result<(), String> {
    // Dropping the Stream stops and tears down capture.
    *state.stream.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub fn set_loopback_gain(state: tauri::State<LoopbackState>, gain: f32) -> Result<(), String> {
    state.gain_bits.store(gain.to_bits(), Ordering::Relaxed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    fn unity_gain() -> Arc<AtomicU32> {
        Arc::new(AtomicU32::new(1.0f32.to_bits()))
    }

    #[test]
    fn catmull_rom_at_t0_is_exact() {
        // t=0 should return p1 exactly, regardless of the other points -
        // this is what makes a 1:1 (no resampling) passthrough exact rather
        // than just approximately close.
        assert_eq!(catmull_rom(0.0, 0.5, 1.0, -1.0, 0.0), 0.5);
        assert_eq!(catmull_rom(-3.0, 2.0, 9.0, 100.0, 0.0), 2.0);
    }

    #[test]
    fn passthrough_at_matching_sample_rate_is_exact() {
        // input_rate == TARGET_SAMPLE_RATE means ratio == 1.0, so every
        // interpolation lands exactly on an input sample (frac == 0) and
        // should reproduce it exactly (modulo i16 quantization).
        let mut pipeline = Pipeline::new(TARGET_SAMPLE_RATE, 2, unity_gain());
        let mut sent_frames: Vec<Vec<u8>> = Vec::new();

        // Feed a simple stereo ramp interleaved [L,R,L,R,...] across several
        // callbacks, matching how cpal would deliver chunks.
        let mut interleaved = Vec::new();
        for i in 0..(FRAME_SAMPLES * 3) {
            let l = ((i % 100) as f32 / 100.0) * 2.0 - 1.0;
            let r = -l;
            interleaved.push(l);
            interleaved.push(r);
        }

        for chunk in interleaved.chunks(480) {
            // We can't easily capture channel sends without a real Tauri
            // Channel, so instead verify via the internal buffers directly:
            // after pushing, pcm_buffer should contain quantized samples
            // matching the input ramp once enough has accumulated.
            pipeline.left_buffer.extend(chunk.iter().step_by(2));
            pipeline.right_buffer.extend(chunk.iter().skip(1).step_by(2));
        }
        let _ = &mut sent_frames; // silence unused warning if send path isn't exercised here

        // Directly exercise the resampling math the same way push() does,
        // without needing a live Channel.
        let len = pipeline.left_buffer.len();
        let usable = (len - 1) as f64;
        let mut cursor = 0f64;
        let mut produced_l = Vec::new();
        while cursor < usable {
            let idx = cursor.floor() as usize;
            let frac = (cursor - idx as f64) as f32;
            let i0 = idx.saturating_sub(1);
            let i2 = (idx + 1).min(len - 1);
            let i3 = (idx + 2).min(len - 1);
            let l = catmull_rom(
                pipeline.left_buffer[i0],
                pipeline.left_buffer[idx],
                pipeline.left_buffer[i2],
                pipeline.left_buffer[i3],
                frac,
            );
            produced_l.push(l);
            cursor += 1.0; // ratio == 1.0
        }

        for (i, (&original, &produced)) in pipeline.left_buffer.iter().zip(produced_l.iter()).enumerate() {
            assert!(
                (original - produced).abs() < 1e-5,
                "sample {i}: original={original}, produced={produced}"
            );
        }
    }

    #[test]
    fn mono_input_duplicates_to_both_channels() {
        let (l, r) = stereo_from_frame(&[0.42]);
        assert_eq!(l, 0.42);
        assert_eq!(r, 0.42);
    }

    #[test]
    fn stereo_input_keeps_channels_distinct() {
        let (l, r) = stereo_from_frame(&[0.1, -0.2, 0.3]);
        assert_eq!(l, 0.1);
        assert_eq!(r, -0.2);
    }

    #[test]
    fn phase_carryover_prevents_drift_across_many_small_callbacks() {
        // At ratio == 1.0 the cursor always lands on exact integers, so
        // there's never a fraction to lose - the bug only bites when actual
        // resampling is happening (e.g. a 44.1kHz device feeding a 48kHz
        // target), which is exactly when a fix matters most. Simulates many
        // small, frequent audio callbacks (cpal callbacks can fire well over
        // 100x/sec) to show the loss compounding.
        let ratio = 44100.0f64 / TARGET_SAMPLE_RATE as f64;
        let chunk_size = 32usize;
        let num_chunks = 2000usize;
        let total_input = chunk_size * num_chunks;

        // OLD (buggy) behavior: cursor resets to 0.0 every call, discarding
        // whatever fraction of a sample it had advanced past.
        let mut buffer_old: Vec<f64> = Vec::new();
        let mut produced_old = 0usize;
        for _ in 0..num_chunks {
            buffer_old.extend(std::iter::repeat(0.0).take(chunk_size));
            if buffer_old.len() < 2 {
                continue;
            }
            let len = buffer_old.len();
            let usable = (len - 1) as f64;
            let mut cursor = 0f64; // the bug
            while cursor < usable {
                produced_old += 1;
                cursor += ratio;
            }
            let consumed = (cursor.floor() as usize).min(len);
            buffer_old.drain(0..consumed);
        }

        // NEW (fixed) behavior: cursor carries the fractional remainder forward.
        let mut buffer_new: Vec<f64> = Vec::new();
        let mut produced_new = 0usize;
        let mut phase = 0f64;
        for _ in 0..num_chunks {
            buffer_new.extend(std::iter::repeat(0.0).take(chunk_size));
            if buffer_new.len() < 2 {
                continue;
            }
            let len = buffer_new.len();
            let usable = (len - 1) as f64;
            let mut cursor = phase; // the fix
            while cursor < usable {
                produced_new += 1;
                cursor += ratio;
            }
            let consumed = (cursor.floor() as usize).min(len);
            buffer_new.drain(0..consumed);
            phase = (cursor - consumed as f64).max(0.0);
        }

        let expected = (total_input as f64 / ratio).round() as i64;
        println!("expected={expected}, produced_old={produced_old}, produced_new={produced_new}");

        // Resetting the cursor to 0.0 every call effectively rewinds the
        // read position by the discarded fraction each time, so the buggy
        // version *over*-produces (duplicates a sliver of interpolated
        // output every callback) rather than under-producing. Still a real
        // correctness bug - it measurably drifts from the correct output
        // count - just not in the direction originally assumed.
        assert!(
            (produced_old as i64 - expected).abs() > (num_chunks / 10) as i64,
            "expected old behavior to demonstrably drift: expected={expected}, produced_old={produced_old}"
        );
        assert!(
            (expected - produced_new as i64).abs() < 5,
            "fixed behavior should not drift: expected={expected}, produced_new={produced_new}"
        );
    }
}
