import { useEffect, useRef, useState } from 'react'
import { getAppState, setAppState } from './appState'

/** A piece of a tab page's navigation (which folder it is in, which database is open…) that is kept
 * across switching to another tab page and across restarts.
 *
 * Every tab page saves under keys of its own (`filesTab.…`, `sqliteTab.…`), in `data.db` like the rest
 * of the app's state (see appState.ts), so each page's navigation lives on independently of the
 * others'. What was saved is only trusted after `valid` has looked at it — a folder or database may be
 * gone by the next visit — and `valid` returns the value to use, or `undefined` to start from
 * `initial`. A page that needs to check the value against what it then finds (a folder that no longer
 * exists) does so itself once it has loaded, and can tell when that is from the third element: whether
 * the saved value has been read yet.
 *
 * Returns `[value, setValue, loaded]`. */
export function usePersistedState<T>(key: string, initial: T, valid: (raw: unknown) => T | undefined) {
  const [value, setValue] = useState<T>(initial)
  const [loaded, setLoaded] = useState(false)
  const validRef = useRef(valid)
  validRef.current = valid

  useEffect(() => {
    let cancelled = false
    getAppState<unknown>(key).then(
      (raw) => {
        if (cancelled) return
        const restored = raw === undefined ? undefined : validRef.current(raw)
        if (restored !== undefined) setValue(restored)
        setLoaded(true)
      },
      () => !cancelled && setLoaded(true),
    )
    return () => {
      cancelled = true
    }
  }, [key])

  useEffect(() => {
    if (loaded) setAppState(key, value).catch(() => {})
  }, [loaded, key, value])

  return [value, setValue, loaded] as const
}

export const isString = (v: unknown): v is string => typeof v === 'string'
export const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
