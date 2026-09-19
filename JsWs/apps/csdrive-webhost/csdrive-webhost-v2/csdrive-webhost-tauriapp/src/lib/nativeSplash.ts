/** Android only: a native spinner (`MainActivity.kt`) covers the screen from the moment the app
 * starts, because until the Rust side is up there is no page to show one. The admin-app calls
 * this when its first screen is ready to take over. Everywhere else `CsdriveSplash` doesn't
 * exist and this does nothing. (It also hides itself after 10 s, whatever the page does.) */
export function hideNativeSplash(): void {
  try {
    ;(window as unknown as { CsdriveSplash?: { hide(): void } }).CsdriveSplash?.hide()
  } catch {
    // nothing to hide
  }
}
