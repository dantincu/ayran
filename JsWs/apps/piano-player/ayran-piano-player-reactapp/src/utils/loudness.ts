import { NOTE_CODES, noteCodeToFrequency } from "../constants/piano";

/**
 * A-weighting function (linear scale, not dB).
 * Models the relative sensitivity of human hearing at each frequency.
 * High value = ear is more sensitive = note sounds louder at the same amplitude.
 */
function aWeightLinear(f: number): number {
  const f2 = f * f;
  return (
    (12200 ** 2 * f2 * f2) /
    ((f2 + 20.6 ** 2) *
      Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) *
      (f2 + 12200 ** 2))
  );
}

// Pre-compute A-weights for all 88 piano notes
const A_WEIGHTS: number[] = NOTE_CODES.map((note) =>
  aWeightLinear(noteCodeToFrequency(note)),
);

console.log("A-weights for piano notes:", A_WEIGHTS);

// The most A-weighted (most sensitive) note in the piano range — around 3 kHz
const MAX_A = Math.max(...A_WEIGHTS);

// The most sensitive note will play at this gain; less sensitive notes scale up toward 1.0
const PEAK_GAIN = 0.65;

/**
 * Returns the gain to apply to a note so all notes have equal perceived loudness.
 * Uses inverse A-weighting: notes the ear is most sensitive to get reduced gain;
 * notes the ear is least sensitive to get higher gain (capped at 1.0).
 */
export function getLoudnessGain(noteCode: string): number {
  const idx = NOTE_CODES.indexOf(noteCode);
  if (idx < 0) return PEAK_GAIN;
  const a = A_WEIGHTS[idx];
  // Inverse compensation relative to the peak sensitivity note
  return Math.min(1.0, (PEAK_GAIN * MAX_A) / a / 20);
}
