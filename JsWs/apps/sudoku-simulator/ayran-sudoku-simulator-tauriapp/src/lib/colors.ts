export const PREDEFINED_DARK_COLORS: { name: string; hex: string }[] = [
  { name: "Slate", hex: "#334155" },
  { name: "Charcoal", hex: "#1f2937" },
  { name: "Navy", hex: "#1e3a5f" },
  { name: "Forest", hex: "#14532d" },
  { name: "Maroon", hex: "#7f1d1d" },
  { name: "Plum", hex: "#4c1d95" },
  { name: "Teal", hex: "#134e4a" },
  { name: "Brown", hex: "#451a03" },
];

export const LABEL_COLORS: { name: string; hex: string }[] = [
  { name: "Red", hex: "#ef4444" },
  { name: "Orange", hex: "#f97316" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Green", hex: "#22c55e" },
  { name: "Teal", hex: "#14b8a6" },
  { name: "Blue", hex: "#3b82f6" },
  { name: "Violet", hex: "#8b5cf6" },
  { name: "Pink", hex: "#ec4899" },
];

/** Picks readable text color (black/white) for a given background hex. */
export function contrastTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#111827" : "#f9fafb";
}

/** WCAG relative luminance of a hex color (sRGB gamma-corrected). */
export function relativeLuminance(hex: string): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors, from 1 (no contrast) to 21 (max). */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA minimum contrast ratio for normal-sized text. */
export const MIN_THEME_CONTRAST_RATIO = 4.5;

export function meetsMinimumContrast(foreground: string, background: string): boolean {
  return contrastRatio(foreground, background) >= MIN_THEME_CONTRAST_RATIO;
}
