import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, errorText, type Entry } from './api'
import { IconBack, IconCheck, IconX } from './icons'
import { PasswordInput } from './PasswordInput'

type Result = { ok: boolean } | { error: string } | null

/** Type the password from memory, then check it against the stored hash. */
export function TrainView({ entry, onBack }: { entry: Entry; onBack: () => void }) {
  const [attempt, setAttempt] = useState('')
  const [result, setResult] = useState<Result>(null)
  const [checking, setChecking] = useState(false)
  const [stats, setStats] = useState({ tries: 0, hits: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  const check = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!attempt || checking) return
    setChecking(true)
    try {
      const ok = await api.check(entry.id, attempt)
      setResult({ ok })
      setStats((s) => ({ tries: s.tries + 1, hits: s.hits + (ok ? 1 : 0) }))
      // A correct answer starts the next round with an empty field.
      if (ok) setAttempt('')
    } catch (err) {
      setResult({ error: errorText(err) })
    } finally {
      setChecking(false)
      inputRef.current?.focus()
    }
  }

  return (
    <main className="page train">
      <header className="bar">
        <button className="icon ghost" onClick={onBack} aria-label="Back to the list" title="Back">
          <IconBack />
        </button>
        <h1 className="train-title">{entry.label}</h1>
      </header>

      <form className="attempt" onSubmit={check}>
        <PasswordInput ref={inputRef} value={attempt} placeholder="Type the password"
          ariaLabel={`Password for ${entry.label}`}
          onChange={(e) => { setAttempt(e.target.value); setResult(null) }} />
        <button type="submit" className="icon primary big" disabled={!attempt || checking}
          aria-label="Check the password" title="Check">
          <IconCheck />
        </button>
      </form>

      <div className="result" aria-live="polite">
        {checking && <p className="muted">Checking…</p>}
        {!checking && result && 'ok' in result && (
          result.ok
            ? <p className="ok"><IconCheck /> Correct!</p>
            : <p className="wrong"><IconX /> That's not it. Try again.</p>
        )}
        {!checking && result && 'error' in result && <p className="error">{result.error}</p>}
      </div>

      {stats.tries > 0 && (
        <p className="muted stats">This session: {stats.hits} correct out of {stats.tries}</p>
      )}
    </main>
  )
}
