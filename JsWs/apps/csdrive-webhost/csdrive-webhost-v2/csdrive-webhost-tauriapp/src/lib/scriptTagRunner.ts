/** Runs a string of JavaScript by inserting it as a real `<script>` element — the JS Playground's one
 * execution primitive (`system/js-playground/JsPlaygroundApp.tsx`), shared by the Run button, a profile's
 * own auto-run-on-open code, and the `<ayran>.jsPlayground.run(...)` global (a property of the shared, admin-
 * renameable `ayran` namespace object — see `lib/ayranGlobalName.ts` — not a bare global of its own) any of
 * that code can call back into to run more code from a string (its own "similar to `eval`" primitive — see
 * CLAUDE.md's "JS Playground"). No `eval`, no `Function` constructor, no separate realm: the code runs with
 * this window's own, ordinary rights.
 *
 * **A `blob:`-sourced script, not an inline one with literal `textContent`** — found live, not by inspection,
 * reported as "I executed the sample code… but it doesn't print anything": a page served over `tauri://`
 * (every system app, this one included) carries a CSP whose `script-src` has `'unsafe-inline'` *and* a long
 * list of `'sha256-…'` hashes — Tauri's own CSP injection, computed from the admin-app's own inline bootstrap
 * scripts and (confirmed directly, via the exact same header value on this page) applied to *every*
 * `tauri://`-served page, not recomputed per file. Per the CSP spec, the mere *presence* of a hash-source in
 * a directive makes the browser **ignore `'unsafe-inline'` for that whole directive**, hash match or not —
 * so an inline, `textContent`-based script (this module's own first version) was silently blocked outright. A
 * real `securitypolicyviolation` event, captured live on this exact page, confirmed it:
 * `{directive: "script-src-elem", blockedURI: "inline", sourceFile: ".../js-playground-*.js"}` — and only
 * ever showed up testing the *embedded*, bundled frontend (`cargo run --features tauri/custom-protocol`, the
 * same serving path the real installer uses), never `cargo tauri dev`'s own Vite dev server, which is why
 * every earlier live-verification pass in this session's history missed it: the dev server's own pages never
 * get this hash injection at all (Tauri has no html to scan — it never serves them). A dynamic code's content
 * can't be hashed in advance (it's arbitrary, typed a moment ago), so no `'sha256-…'`/nonce-source could ever
 * cover it — the fix is `blob:`, added to `script-src` in `tauri.conf.json` (both `csp` and `devCsp`, for
 * consistency, though only the embedded one was ever actually missing it): a scheme-source is independent of
 * `'unsafe-inline'`'s own fate, so it's allowed regardless of whatever hashes happen to be sitting beside it.
 *
 * **One real behavioural difference from the original, inline version — a src'd script, even a `blob:` one,
 * executes once its "fetch" resolves, not synchronously the instant it's inserted** (true of any classic
 * script that names a `src`, unlike a bare inline one) — in practice this resolves within the same tick far
 * more often than not, but it is no longer a hard guarantee. Nothing in this module (or its callers) depends
 * on the script having already run by the time `runScript` returns, so this costs nothing in practice; it's
 * recorded here because it's the one thing that *did* change, not because anything broke from it.
 *
 * **Every call replaces whatever script element (and blob URL) the *previous* call inserted**, instead of
 * appending a new one each time — `currentScript`/`currentBlobUrl` are module-level (not React refs) because
 * there's exactly one such slot for the whole page, shared across every caller, not one per caller. Removing
 * the old element doesn't interrupt anything already executing from it (whatever it scheduled with
 * `setTimeout`/a promise keeps running regardless of whether the element, or its blob URL, still exist) —
 * that's what makes it safe to call this recursively from *within* code it is itself currently running. The
 * previous call's own blob URL is also revoked at this same point (`URL.revokeObjectURL`) — not on every
 * single run forever uncollected, the same "clean up what the one before it left, not what it itself just
 * made" shape the DOM replacement already has. */

let currentScript: HTMLScriptElement | null = null
let currentBlobUrl: string | null = null

export function runScript(code: string): void {
  if (currentScript && currentScript.parentNode) currentScript.remove()
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl)

  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  const script = document.createElement('script')
  script.src = url
  currentScript = script
  currentBlobUrl = url
  document.body.appendChild(script)
}
