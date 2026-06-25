use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};
use std::sync::Mutex;
use tauri::ipc::Channel;

// Must match FRAME_SAMPLES/SAMPLE_RATE in api/src/audio/mixer.ts and
// desktop/src/lib/audioCapture.ts so frames can go straight onto the
// existing host WebSocket without any further reshaping in JS.
const TARGET_SAMPLE_RATE: u32 = 48000;
const FRAME_SAMPLES: usize = 960;

#[derive(Default)]
pub struct LoopbackState(Mutex<Option<Stream>>);

/// Downmixes interleaved multi-channel f32 samples to mono, linearly resamples
/// to TARGET_SAMPLE_RATE, quantizes to i16, and emits fixed-size frames.
struct Pipeline {
    input_rate: u32,
    channels: usize,
    mono_buffer: Vec<f32>,
    pcm_buffer: Vec<i16>,
}

impl Pipeline {
    fn new(input_rate: u32, channels: usize) -> Self {
        Self {
            input_rate,
            channels: channels.max(1),
            mono_buffer: Vec::new(),
            pcm_buffer: Vec::new(),
        }
    }

    fn push(&mut self, data: &[f32], on_frame: &Channel<Vec<u8>>) {
        for frame in data.chunks(self.channels) {
            let sum: f32 = frame.iter().sum();
            self.mono_buffer.push(sum / frame.len() as f32);
        }

        // Need at least two samples to interpolate between; otherwise wait for more.
        if self.mono_buffer.len() < 2 {
            return;
        }

        let ratio = self.input_rate as f64 / TARGET_SAMPLE_RATE as f64;
        let usable = (self.mono_buffer.len() - 1) as f64;
        let mut cursor = 0f64;

        while cursor < usable {
            let idx = cursor.floor() as usize;
            let frac = (cursor - idx as f64) as f32;
            let s0 = self.mono_buffer[idx];
            let s1 = self.mono_buffer[idx + 1];
            let sample = s0 + (s1 - s0) * frac;
            self.pcm_buffer.push((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
            cursor += ratio;
        }

        let consumed = (cursor.floor() as usize).min(self.mono_buffer.len());
        self.mono_buffer.drain(0..consumed);

        while self.pcm_buffer.len() >= FRAME_SAMPLES {
            let frame: Vec<i16> = self.pcm_buffer.drain(0..FRAME_SAMPLES).collect();
            let mut bytes = Vec::with_capacity(FRAME_SAMPLES * 2);
            for sample in frame {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            let _ = on_frame.send(bytes);
        }
    }
}

#[tauri::command]
pub fn start_loopback_capture(
    state: tauri::State<LoopbackState>,
    on_frame: Channel<Vec<u8>>,
) -> Result<(), String> {
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

    let pipeline = Mutex::new(Pipeline::new(input_rate, channels));
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

    *state.0.lock().unwrap() = Some(stream);
    Ok(())
}

#[tauri::command]
pub fn stop_loopback_capture(state: tauri::State<LoopbackState>) -> Result<(), String> {
    // Dropping the Stream stops and tears down capture.
    *state.0.lock().unwrap() = None;
    Ok(())
}
