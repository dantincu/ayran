/** A size as a person reads it: `29 B`, `12.3 KB`, and — for details — the exact byte count beside it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** `12.3 KB (12,592 bytes)`. */
export function formatBytesExact(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${formatBytes(bytes)} (${bytes.toLocaleString()} bytes)`
}
