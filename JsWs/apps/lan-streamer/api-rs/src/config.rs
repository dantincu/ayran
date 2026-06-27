/// Default ceiling for a single device stream's peak amplitude, as a fraction
/// of full-scale 16-bit PCM (1.0 == 32767). Applied per host connection before
/// mixing, to protect listeners from a sudden loud transient on any one
/// device stream regardless of how many streams get summed together.
///
/// 0.85 leaves ~1.4dB of headroom below full scale - audible level is barely
/// affected for normal program material, but a sudden spike gets caught
/// before it can reach full-scale-and-clip territory.
pub const DEFAULT_MAX_DEVICE_AMPLITUDE: f64 = 0.85;

pub const MIN_MAX_DEVICE_AMPLITUDE: f64 = 0.1;
pub const MAX_MAX_DEVICE_AMPLITUDE: f64 = 1.0;

/// Limiter envelope time constants. Fast attack so a loud transient is caught
/// almost immediately (minimal added "delay" in the sense of audible latency,
/// since this is not a look-ahead limiter); slower release so the gain eases
/// back up smoothly afterward instead of snapping back and re-triggering on
/// the next loud sample, which is what produces an audible "pop".
pub const LIMITER_ATTACK_SECONDS: f64 = 0.005;
pub const LIMITER_RELEASE_SECONDS: f64 = 0.15;
