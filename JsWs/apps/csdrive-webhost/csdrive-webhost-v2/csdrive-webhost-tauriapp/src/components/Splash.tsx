/** The loading indicator shown while the app starts. `index.html` contains the very same
 * markup inside `#root`, so the spinner is on screen from the first paint — before any
 * script has run — and stays there while the backend answers the first few calls; this
 * component takes over from it without a gap. Styles: `.app-splash` in `App.css`. */
export default function Splash() {
  return (
    <div className="app-splash" role="status" aria-label="Loading">
      <div className="app-spinner" />
    </div>
  )
}
