/** Coalesces a stream of requests so that **at most one is ever running at a time** — a request made while the
 * previous one is still in flight is not queued behind it (and *not* queued behind any request after that,
 * either): only the most recently made one is ever remembered, and it's the one sent the instant the current one
 * finishes. Used by `CodeEditor.tsx`'s `useBackgroundHighlighted` to drive the background re-highlighting Worker
 * on every keystroke (see its own doc comment for why this replaced the earlier debounce-after-a-pause
 * approach): a person typing faster than one highlight pass takes should never make the Worker fall further and
 * further behind a growing backlog — it should do exactly the *latest* text, once, the moment it's free, and the
 * raw keystroke itself (`request`) is never blocked waiting for any of this.
 *
 * `run` is injected (not a Worker directly) so this is testable with a plain async function — no Worker, no DOM,
 * no `self.postMessage` needed. A rejection from `run` is swallowed rather than left to crash the next request:
 * this class exists purely to keep the pipeline moving, not to report errors (the caller's `onResult` is simply
 * never called for that one request, same as if the text had never changed). */
export class HighlightScheduler<Req, Res> {
  private running = false
  private pending: Req | null = null
  private run: (req: Req) => Promise<Res>
  private onResult: (res: Res, req: Req) => void

  constructor(run: (req: Req) => Promise<Res>, onResult: (res: Res, req: Req) => void) {
    this.run = run
    this.onResult = onResult
  }

  /** Asks for `req` to be run. If something is already running, `req` replaces whatever was pending (there is
   * never more than one request waiting) and is picked up the moment the current run finishes. */
  request(req: Req): void {
    if (this.running) {
      this.pending = req
      return
    }
    this.start(req)
  }

  private start(req: Req): void {
    this.running = true
    this.run(req)
      .then((res) => this.onResult(res, req))
      .catch(() => {})
      .finally(() => {
        this.running = false
        const next = this.pending
        this.pending = null
        if (next !== null) this.start(next)
      })
  }
}
