/** Runs a string of JavaScript by inserting it as a real `<script>` element — the JS Playground's one
 * execution primitive (`system/js-playground/JsPlaygroundApp.tsx`), shared by the Run button, a profile's
 * own auto-run-on-open code, and the `<ayran>.jsPlayground.run(...)` global (a property of the shared, admin-
 * renameable `ayran` namespace object — see `lib/ayranGlobalName.ts` — not a bare global of its own) any of
 * that code can call back into to run more code from a string (its own "similar to `eval`" primitive — see
 * CLAUDE.md's "JS Playground"). No `eval`, no `Function` constructor, no separate realm: the code runs with
 * this window's own, ordinary rights.
 *
 * **Every call replaces whatever script element the *previous* call inserted**, instead of appending a new
 * one each time — `currentScript` is module-level (not a React ref) because there's exactly one such slot
 * for the whole page, shared across every caller, not one per caller. Removing the old element doesn't
 * interrupt anything already executing from it: a classic, `src`-less `<script>`'s own top-level code runs
 * synchronously, in one go, the instant it's inserted — by the time a *later* call removes it, that code has
 * already finished running (whatever it scheduled with `setTimeout`/a promise keeps running regardless of
 * whether the element is still in the DOM). That's what makes it safe to call this recursively from *within*
 * code it is itself currently running: the removal only ever discards a DOM node nothing still needs. */

let currentScript: HTMLScriptElement | null = null

export function runScript(code: string): void {
  if (currentScript && currentScript.parentNode) currentScript.remove()
  const script = document.createElement('script')
  script.textContent = code
  currentScript = script
  document.body.appendChild(script)
}
