/** Turns the arguments of a `console.log`/`warn`/`error`/… call into one plain-text line, the way a
 * browser's own devtools console roughly does — for the JS Playground's output pane (`JsPlaygroundApp.tsx`),
 * which has no devtools of its own to lean on. Pure, no DOM, so it's testable without a browser. */

/** One value, stringified: a string as itself, an `Error` as its stack (or `name: message` with none),
 * a circular or otherwise unstringifiable object falls back to `String(value)` rather than throwing. */
export function formatConsoleValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return value.toString()
  if (typeof value === 'symbol') return value.toString()
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  const seen = new WeakSet<object>()
  try {
    const json = JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === 'bigint') return `${v}n`
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]'
          seen.add(v)
        }
        return v
      },
      2,
    )
    // `JSON.stringify` answers `undefined` (not the string "undefined") for a value it can't represent at
    // all (a bare function or symbol never reaches here, but e.g. `JSON.stringify(Symbol())` does) — fall
    // back to `String` for that case too, same as the catch below.
    return json ?? String(value)
  } catch {
    return String(value)
  }
}

/** A whole `console.*` call's arguments, space-joined — the same convention the real console uses. */
export function formatConsoleArgs(args: unknown[]): string {
  return args.map(formatConsoleValue).join(' ')
}
