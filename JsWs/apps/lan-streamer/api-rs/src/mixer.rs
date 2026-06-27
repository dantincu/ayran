use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::mpsc::UnboundedSender;
use tokio::task::AbortHandle;

use crate::config::{LIMITER_ATTACK_SECONDS, LIMITER_RELEASE_SECONDS};
use crate::store::Store;

pub const SAMPLE_RATE: u32 = 48000;
pub const FRAME_SAMPLES: usize = 960; // 20ms at 48kHz, per channel
pub const CHANNELS: usize = 2;
pub const BYTES_PER_FRAME: usize = FRAME_SAMPLES * CHANNELS * 2; // 16-bit PCM, interleaved [L0,R0,L1,R1,...]

const TICK_MS: u64 = 20;

/// One-pole envelope smoothing for the per-device limiter: fast attack so a
/// loud transient is caught almost immediately, slower release so gain eases
/// back up smoothly afterward instead of snapping (which is what produces an
/// audible "pop").
fn limiter_coeffs() -> (f64, f64) {
    let attack = (-1.0 / (SAMPLE_RATE as f64 * LIMITER_ATTACK_SECONDS)).exp();
    let release = (-1.0 / (SAMPLE_RATE as f64 * LIMITER_RELEASE_SECONDS)).exp();
    (attack, release)
}

/// One outgoing audio frame, sent by reference-counted clone to each
/// listener's forwarding channel rather than copied per-listener up front.
pub type Frame = Arc<[u8]>;

struct HostConnection {
    queue: Vec<Vec<u8>>,
    account_id: i64,
    /// current smoothed limiter gain (1 == no reduction), persists across frames/ticks
    limiter_gain: f64,
    /// diagnostics: how many consecutive ticks this connection's queue has been empty
    empty_streak: u32,
}

struct MergedStreamState {
    // keyed per host *connection* (not per account) so that multiple
    // windows/devices under the same Filen account can stream into the same
    // stream simultaneously and have their audio mixed together rather than
    // colliding on one queue.
    host_queues: HashMap<String, HostConnection>,
    listeners: HashMap<String, UnboundedSender<Frame>>,
    /// diagnostics: wall-clock time of the previous tick, to detect the mixer's own timer lagging
    last_tick_at: Instant,
    // Reused every tick instead of allocating fresh - matches the same fix
    // applied to the Node version (per-tick allocation was enough GC/alloc
    // pressure to land the tick timer noticeably behind schedule).
    accumulator: Vec<i32>,
    output: Vec<u8>,
    tick_task: AbortHandle,
}

struct SimpleStreamState {
    listeners: HashMap<String, UnboundedSender<Frame>>,
    limiter_gain: f64,
}

struct RawStreamState {
    listeners: HashMap<String, UnboundedSender<Frame>>,
}

pub struct ExclusiveHost {
    pub connection_id: String,
    pub close: tokio::sync::mpsc::UnboundedSender<()>,
}

pub struct Mixer {
    store: Arc<Store>,
    merged: Mutex<HashMap<String, MergedStreamState>>,
    simple: Mutex<HashMap<String, SimpleStreamState>>,
    raw: Mutex<HashMap<String, RawStreamState>>,
    pub active_simple_hosts: Mutex<HashMap<String, ExclusiveHost>>,
    pub active_raw_hosts: Mutex<HashMap<String, ExclusiveHost>>,
    limiter_attack_coeff: f64,
    limiter_release_coeff: f64,
}

impl Mixer {
    pub fn new(store: Arc<Store>) -> Self {
        let (attack, release) = limiter_coeffs();
        Self {
            store,
            merged: Mutex::new(HashMap::new()),
            simple: Mutex::new(HashMap::new()),
            raw: Mutex::new(HashMap::new()),
            active_simple_hosts: Mutex::new(HashMap::new()),
            active_raw_hosts: Mutex::new(HashMap::new()),
            limiter_attack_coeff: attack,
            limiter_release_coeff: release,
        }
    }

    // ---- merged ----

    pub fn register_host(self: &Arc<Self>, stream_id: &str, connection_id: &str, account_id: i64) {
        let mut merged = self.merged.lock().unwrap();
        let state = ensure_merged(self, &mut merged, stream_id);
        state.host_queues.entry(connection_id.to_string()).or_insert_with(|| HostConnection {
            queue: Vec::new(),
            account_id,
            limiter_gain: 1.0,
            empty_streak: 0,
        });
    }

    pub fn unregister_host(&self, stream_id: &str, connection_id: &str) {
        let mut merged = self.merged.lock().unwrap();
        if let Some(state) = merged.get_mut(stream_id) {
            state.host_queues.remove(connection_id);
            maybe_teardown_merged(&mut merged, stream_id);
        }
    }

    pub fn push_host_frame(&self, stream_id: &str, connection_id: &str, frame: Vec<u8>) {
        let mut merged = self.merged.lock().unwrap();
        if let Some(state) = merged.get_mut(stream_id) {
            if let Some(conn) = state.host_queues.get_mut(connection_id) {
                conn.queue.push(frame);
                // bound queue depth to avoid unbounded memory growth on slow consumers
                while conn.queue.len() > 25 {
                    conn.queue.remove(0);
                }
            }
        }
    }

    pub fn register_listener(self: &Arc<Self>, stream_id: &str, connection_id: String, sender: UnboundedSender<Frame>) {
        let mut merged = self.merged.lock().unwrap();
        let state = ensure_merged(self, &mut merged, stream_id);
        state.listeners.insert(connection_id, sender);
    }

    pub fn unregister_listener(&self, stream_id: &str, connection_id: &str) {
        let mut merged = self.merged.lock().unwrap();
        if let Some(state) = merged.get_mut(stream_id) {
            state.listeners.remove(connection_id);
            maybe_teardown_merged(&mut merged, stream_id);
        }
    }

    fn tick(&self, stream_id: &str) {
        let mut merged = self.merged.lock().unwrap();
        let Some(state) = merged.get_mut(stream_id) else { return };

        // Diagnostics: if the mixer's own timer fires noticeably late, that
        // points at server-side load (scheduler congestion, etc.) rather
        // than the host failing to produce/send audio.
        let now = Instant::now();
        let since_last_tick = now.duration_since(state.last_tick_at).as_millis() as u64;
        state.last_tick_at = now;
        if since_last_tick > TICK_MS * 2 {
            eprintln!("[mixer] stream {stream_id}: tick fired {since_last_tick}ms after the previous one (expected ~{TICK_MS}ms) - mixer is running behind");
        }

        if state.listeners.is_empty() {
            return;
        }

        state.accumulator.fill(0);
        let mut any_contribution = false;

        for (connection_id, conn) in state.host_queues.iter_mut() {
            let Some(frame) = (!conn.queue.is_empty()).then(|| conn.queue.remove(0)) else {
                conn.empty_streak += 1;
                if conn.empty_streak == 1 {
                    eprintln!("[mixer] stream {stream_id}: host {connection_id} produced no frame for this tick (queue empty)");
                }
                continue;
            };
            if conn.empty_streak > 1 {
                eprintln!(
                    "[mixer] stream {stream_id}: host {connection_id} resumed after {}ms with no frames",
                    conn.empty_streak as u64 * TICK_MS
                );
            }
            conn.empty_streak = 0;
            any_contribution = true;

            let settings = self.store.get_account_settings(conn.account_id);
            accumulate_limited(&frame, settings.max_device_amplitude, conn, &mut state.accumulator, self.limiter_attack_coeff, self.limiter_release_coeff);
        }

        if !any_contribution {
            return;
        }

        for (i, sample) in state.accumulator.iter().enumerate() {
            let clamped = (*sample).clamp(-32768, 32767) as i16;
            state.output[i * 2..i * 2 + 2].copy_from_slice(&clamped.to_le_bytes());
        }

        let frame: Frame = Arc::from(state.output.as_slice());
        state.listeners.retain(|_, sender| sender.send(frame.clone()).is_ok());
    }

    // ---- simple ----

    pub fn register_simple_listener(&self, stream_id: &str, connection_id: String, sender: UnboundedSender<Frame>) {
        let mut simple = self.simple.lock().unwrap();
        simple.entry(stream_id.to_string()).or_insert_with(|| SimpleStreamState { listeners: HashMap::new(), limiter_gain: 1.0 }).listeners.insert(connection_id, sender);
    }

    pub fn unregister_simple_listener(&self, stream_id: &str, connection_id: &str) {
        let mut simple = self.simple.lock().unwrap();
        if let Some(state) = simple.get_mut(stream_id) {
            state.listeners.remove(connection_id);
            if state.listeners.is_empty() {
                simple.remove(stream_id);
            }
        }
    }

    /// Forwards one frame from the currently-active host straight to a
    /// simple stream's listeners, applying the same account-wide volume cap
    /// as merged streams but with no mixing/buffering tick involved.
    pub fn forward_simple_frame(&self, stream_id: &str, account_id: i64, frame: &[u8]) {
        let mut simple = self.simple.lock().unwrap();
        let Some(state) = simple.get_mut(stream_id) else { return };
        if state.listeners.is_empty() {
            return;
        }

        let settings = self.store.get_account_settings(account_id);
        let ceiling = settings.max_device_amplitude * 32767.0;
        let mut output = vec![0u8; BYTES_PER_FRAME];
        for i in 0..FRAME_SAMPLES {
            let left = i16::from_le_bytes([frame[i * CHANNELS * 2], frame[i * CHANNELS * 2 + 1]]) as f64;
            let right = i16::from_le_bytes([frame[(i * CHANNELS + 1) * 2], frame[(i * CHANNELS + 1) * 2 + 1]]) as f64;
            let magnitude = left.abs().max(right.abs());
            let target_gain = if magnitude > ceiling { ceiling / magnitude } else { 1.0 };
            let coeff = if target_gain < state.limiter_gain { self.limiter_attack_coeff } else { self.limiter_release_coeff };
            state.limiter_gain = state.limiter_gain * coeff + target_gain * (1.0 - coeff);
            let l = (left * state.limiter_gain).round() as i16;
            let r = (right * state.limiter_gain).round() as i16;
            output[i * CHANNELS * 2..i * CHANNELS * 2 + 2].copy_from_slice(&l.to_le_bytes());
            output[(i * CHANNELS + 1) * 2..(i * CHANNELS + 1) * 2 + 2].copy_from_slice(&r.to_le_bytes());
        }

        let frame: Frame = Arc::from(output.as_slice());
        state.listeners.retain(|_, sender| sender.send(frame.clone()).is_ok());
    }

    // ---- raw ----

    pub fn register_raw_listener(&self, stream_id: &str, connection_id: String, sender: UnboundedSender<Frame>) {
        let mut raw = self.raw.lock().unwrap();
        raw.entry(stream_id.to_string()).or_insert_with(|| RawStreamState { listeners: HashMap::new() }).listeners.insert(connection_id, sender);
    }

    pub fn unregister_raw_listener(&self, stream_id: &str, connection_id: &str) {
        let mut raw = self.raw.lock().unwrap();
        if let Some(state) = raw.get_mut(stream_id) {
            state.listeners.remove(connection_id);
            if state.listeners.is_empty() {
                raw.remove(stream_id);
            }
        }
    }

    /// Forwards a frame completely unprocessed - no volume cap, no limiter.
    /// For anyone who wants bit-exact passthrough with none of the safety
    /// processing the other two modes apply.
    pub fn forward_raw_frame(&self, stream_id: &str, frame: &[u8]) {
        let raw = self.raw.lock().unwrap();
        let Some(state) = raw.get(stream_id) else { return };
        if state.listeners.is_empty() {
            return;
        }
        let frame: Frame = Arc::from(frame);
        for sender in state.listeners.values() {
            let _ = sender.send(frame.clone());
        }
    }
}

/// Limits a device stream's peak amplitude to `ceiling_amplitude` (fraction
/// of full-scale) and adds the result directly into `accumulator`, easing
/// the gain reduction in/out via an envelope follower rather than
/// hard-clipping, to avoid an audible "pop".
///
/// Stereo is "linked": both channels of a sample pair share one gain value
/// derived from whichever channel is louder, instead of being limited
/// independently - independent per-channel limiting would shrink whichever
/// channel happens to be louder at any instant, smearing the stereo image
/// left/right as the signal moves.
fn accumulate_limited(frame: &[u8], ceiling_amplitude: f64, conn: &mut HostConnection, accumulator: &mut [i32], attack_coeff: f64, release_coeff: f64) {
    let ceiling = ceiling_amplitude * 32767.0;
    for i in 0..FRAME_SAMPLES {
        let left = i16::from_le_bytes([frame[i * CHANNELS * 2], frame[i * CHANNELS * 2 + 1]]) as f64;
        let right = i16::from_le_bytes([frame[(i * CHANNELS + 1) * 2], frame[(i * CHANNELS + 1) * 2 + 1]]) as f64;
        let magnitude = left.abs().max(right.abs());
        let target_gain = if magnitude > ceiling { ceiling / magnitude } else { 1.0 };
        let coeff = if target_gain < conn.limiter_gain { attack_coeff } else { release_coeff };
        conn.limiter_gain = conn.limiter_gain * coeff + target_gain * (1.0 - coeff);
        accumulator[i * CHANNELS] += (left * conn.limiter_gain).round() as i32;
        accumulator[i * CHANNELS + 1] += (right * conn.limiter_gain).round() as i32;
    }
}

fn ensure_merged<'a>(mixer: &Arc<Mixer>, merged: &'a mut HashMap<String, MergedStreamState>, stream_id: &str) -> &'a mut MergedStreamState {
    if !merged.contains_key(stream_id) {
        let mixer = mixer.clone();
        let id = stream_id.to_string();
        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(TICK_MS));
            loop {
                interval.tick().await;
                mixer.tick(&id);
            }
        });
        merged.insert(
            stream_id.to_string(),
            MergedStreamState {
                host_queues: HashMap::new(),
                listeners: HashMap::new(),
                last_tick_at: Instant::now(),
                accumulator: vec![0i32; FRAME_SAMPLES * CHANNELS],
                output: vec![0u8; BYTES_PER_FRAME],
                tick_task: handle.abort_handle(),
            },
        );
    }
    merged.get_mut(stream_id).unwrap()
}

fn maybe_teardown_merged(merged: &mut HashMap<String, MergedStreamState>, stream_id: &str) {
    if let Some(state) = merged.get(stream_id) {
        if state.host_queues.is_empty() && state.listeners.is_empty() {
            state.tick_task.abort();
            merged.remove(stream_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AccountSettings;
    use std::time::Duration;

    fn make_frame(left: i16, right: i16) -> Vec<u8> {
        let mut buf = vec![0u8; BYTES_PER_FRAME];
        for i in 0..FRAME_SAMPLES {
            buf[i * CHANNELS * 2..i * CHANNELS * 2 + 2].copy_from_slice(&left.to_le_bytes());
            buf[(i * CHANNELS + 1) * 2..(i * CHANNELS + 1) * 2 + 2].copy_from_slice(&right.to_le_bytes());
        }
        buf
    }

    fn read_sample(frame: &[u8], index: usize) -> i16 {
        i16::from_le_bytes([frame[index * 2], frame[index * 2 + 1]])
    }

    fn test_store() -> Arc<Store> {
        Arc::new(Store::new(std::env::temp_dir().join(format!("lan-streamer-test-{}", uuid::Uuid::new_v4()))))
    }

    #[tokio::test]
    async fn merged_sums_two_hosts_per_channel() {
        let store = test_store();
        store.set_account_settings(1, AccountSettings { max_device_amplitude: 1.0 }).await;
        let mixer = Arc::new(Mixer::new(store));
        let stream_id = "regress-merged-sum";

        mixer.register_host(stream_id, "conn-a", 1);
        mixer.register_host(stream_id, "conn-b", 1);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        mixer.register_listener(stream_id, "listener-1".into(), tx);

        mixer.push_host_frame(stream_id, "conn-a", make_frame(1000, 2000));
        mixer.push_host_frame(stream_id, "conn-b", make_frame(3000, -500));

        let frame = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await.expect("timed out").expect("channel closed");
        assert_eq!(read_sample(&frame, 0), 4000, "left channels should sum");
        assert_eq!(read_sample(&frame, 1), 1500, "right channels should sum");

        mixer.unregister_host(stream_id, "conn-a");
        mixer.unregister_host(stream_id, "conn-b");
        mixer.unregister_listener(stream_id, "listener-1");
    }

    #[tokio::test]
    async fn merged_limiter_preserves_stereo_ratio_while_capping() {
        let store = test_store();
        store.set_account_settings(2, AccountSettings { max_device_amplitude: 0.5 }).await;
        let mixer = Arc::new(Mixer::new(store));
        let stream_id = "regress-merged-limiter";

        mixer.register_host(stream_id, "conn-a", 2);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        mixer.register_listener(stream_id, "listener-1".into(), tx);

        // Full-scale left, 10%-amplitude right - ratio must survive limiting.
        for _ in 0..50 {
            mixer.push_host_frame(stream_id, "conn-a", make_frame(32767, 3277));
            let frame = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.expect("timed out").expect("channel closed");
            let l = read_sample(&frame, 0) as f64;
            let r = read_sample(&frame, 1) as f64;
            if l.abs() > 1.0 {
                let ratio = r / l;
                assert!((ratio - 0.1).abs() < 0.01, "L/R ratio should stay ~0.1, got {ratio}");
            }
        }

        mixer.unregister_host(stream_id, "conn-a");
        mixer.unregister_listener(stream_id, "listener-1");
    }

    #[tokio::test]
    async fn simple_forward_applies_cap_but_raw_does_not() {
        let store = test_store();
        store.set_account_settings(3, AccountSettings { max_device_amplitude: 0.1 }).await;
        let mixer = Mixer::new(store);

        let (tx_simple, mut rx_simple) = tokio::sync::mpsc::unbounded_channel();
        mixer.register_simple_listener("regress-simple", "l1".into(), tx_simple);
        mixer.forward_simple_frame("regress-simple", 3, &make_frame(32000, -32000));
        let simple_frame = rx_simple.recv().await.expect("no frame");
        let capped = read_sample(&simple_frame, 0);
        assert!(capped.abs() < 32000, "simple mode should cap toward the 10% ceiling, got {capped}");

        let (tx_raw, mut rx_raw) = tokio::sync::mpsc::unbounded_channel();
        mixer.register_raw_listener("regress-raw", "l1".into(), tx_raw);
        mixer.forward_raw_frame("regress-raw", &make_frame(32000, -32000));
        let raw_frame = rx_raw.recv().await.expect("no frame");
        assert_eq!(read_sample(&raw_frame, 0), 32000, "raw mode must bypass the cap entirely");
        assert_eq!(read_sample(&raw_frame, 1), -32000);
    }
}
