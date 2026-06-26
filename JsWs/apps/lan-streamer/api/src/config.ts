/**
 * Default ceiling for a single device stream's peak amplitude, as a fraction
 * of full-scale 16-bit PCM (1.0 == 32767). Applied per host connection before
 * mixing, to protect listeners from a sudden loud transient on any one
 * device stream regardless of how many streams get summed together.
 *
 * 0.85 leaves ~1.4dB of headroom below full scale - audible level is barely
 * affected for normal program material, but a sudden spike gets caught
 * before it can reach full-scale-and-clip territory.
 */
export const DEFAULT_MAX_DEVICE_AMPLITUDE = 0.85;

export const MIN_MAX_DEVICE_AMPLITUDE = 0.1;
export const MAX_MAX_DEVICE_AMPLITUDE = 1;

/**
 * Limiter envelope time constants. Fast attack so a loud transient is caught
 * almost immediately (minimal added "delay" in the sense of audible latency,
 * since this is not a look-ahead limiter); slower release so the gain eases
 * back up smoothly afterward instead of snapping back and re-triggering on
 * the next loud sample, which is what produces an audible "pop".
 */
export const LIMITER_ATTACK_SECONDS = 0.005;
export const LIMITER_RELEASE_SECONDS = 0.15;
