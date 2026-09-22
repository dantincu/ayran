/** The undo/redo history of a text editor (`components/CodeEditor.tsx`). Plain logic, no DOM: the editor records each new
 * text with where the caret was, and asks for the text before or after the current one.
 *
 * Why the editor keeps its own history instead of leaving it to the browser: the box is a controlled one, whose text is
 * also replaced from outside (the clipboard menu's paste, a file read again), and the browser's own history is neither the
 * same in every webview nor reachable from a button — Android's on-screen keyboard has no Ctrl+Z.
 *
 * Typing is **coalesced**: edits that follow each other within `GROUP_MS` are one step, so undo takes back a burst of typing
 * and not a letter. The history is bounded (`MAX_STEPS` steps and `MAX_CHARS` characters in all — the oldest steps go first),
 * so a big file edited for a long time can't take the memory. */

export interface Snapshot {
  value: string
  /** The caret (or the selection) after this text was made. */
  start: number
  end: number
}

export const GROUP_MS = 800
export const MAX_STEPS = 500
export const MAX_CHARS = 16 * 1024 * 1024

export class UndoHistory {
  private steps: Snapshot[]
  private at = 0
  private lastEdit = 0
  private chars: number

  constructor(initial: string) {
    this.steps = [{ value: initial, start: initial.length, end: initial.length }]
    this.chars = initial.length
  }

  /** The text the history stands at. */
  get current(): Snapshot {
    return this.steps[this.at]
  }

  get canUndo(): boolean {
    return this.at > 0
  }

  get canRedo(): boolean {
    return this.at < this.steps.length - 1
  }

  /** Forgets everything: the text was replaced from outside (a file was opened or read again). */
  reset(value: string): void {
    this.steps = [{ value, start: value.length, end: value.length }]
    this.at = 0
    this.lastEdit = 0
    this.chars = value.length
  }

  /** A new text made by the person. `now` is a time in milliseconds. */
  record(value: string, start: number, end: number, now: number): void {
    if (value === this.current.value) {
      this.steps[this.at] = { value, start, end }
      return
    }
    // Something was undone and now something else is typed: what could have been redone is gone.
    if (this.canRedo) {
      for (const dropped of this.steps.slice(this.at + 1)) this.chars -= dropped.value.length
      this.steps.length = this.at + 1
    }
    const joins = this.at > 0 && this.lastEdit !== 0 && now - this.lastEdit < GROUP_MS
    if (joins) {
      this.chars += value.length - this.current.value.length
      this.steps[this.at] = { value, start, end }
    } else {
      this.steps.push({ value, start, end })
      this.chars += value.length
      this.at = this.steps.length - 1
    }
    this.lastEdit = now
    this.trim()
  }

  /** Goes one step back; the text to show, or null at the start. */
  undo(): Snapshot | null {
    if (!this.canUndo) return null
    this.at -= 1
    this.lastEdit = 0
    return this.current
  }

  /** Goes one step forward; the text to show, or null at the end. */
  redo(): Snapshot | null {
    if (!this.canRedo) return null
    this.at += 1
    this.lastEdit = 0
    return this.current
  }

  private trim(): void {
    while (this.steps.length > 1 && this.at > 0 && (this.steps.length > MAX_STEPS || this.chars > MAX_CHARS)) {
      this.chars -= this.steps[0].value.length
      this.steps.shift()
      this.at -= 1
    }
  }
}
