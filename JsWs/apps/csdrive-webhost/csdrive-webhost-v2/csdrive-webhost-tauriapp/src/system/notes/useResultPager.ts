import { useCallback, useEffect, useRef, useState } from 'react'
import { newContext, ResultPager, type SearchContext } from './search'

export interface PagedResults<T> {
  /** The page shown (from 0) and its results. */
  page: number
  items: T[]
  /** A page is being looked for. */
  searching: boolean
  /** The whole tree was looked at: `known` is then the total. */
  done: boolean
  /** How many results have been found so far. */
  known: number
  /** What the search has looked at (folders, entries, files it could not search). */
  stats: SearchContext['stats']
  /** There may be a page after this one. */
  hasNext: boolean
  next: () => void
  previous: () => void
  goTo: (page: number) => void
  error: string | null
}

const zero = () => ({ folders: 0, examined: 0, skipped: 0, failed: 0 })

/** Runs a search and pulls its results **a page at a time** (see `ResultPager`): only the page on screen and a few before it are ever
 * held. `make` starts the search (a generator); it runs again — and the page goes back to the first — whenever one of `deps` changes. */
export function useResultPager<T>(make: (ctx: SearchContext) => AsyncGenerator<T>, pageSize: number, deps: unknown[]): PagedResults<T> {
  const pager = useRef<ResultPager<T> | null>(null)
  const context = useRef<SearchContext>(newContext())
  const latest = useRef(0)
  const [page, setPage] = useState(0)
  const [items, setItems] = useState<T[]>([])
  const [searching, setSearching] = useState(true)
  const [done, setDone] = useState(false)
  const [known, setKnown] = useState(0)
  const [stats, setStats] = useState(zero())
  const [error, setError] = useState<string | null>(null)

  const show = useCallback(async (wanted: number) => {
    const current = pager.current
    if (!current) return
    const request = ++latest.current
    setSearching(true)
    try {
      const found = await current.load(wanted)
      if (request !== latest.current) return
      // Past the end: nothing there; stay where we were.
      if (found.length === 0 && wanted > 0) {
        setDone(current.done)
        setKnown(current.known)
        return
      }
      setPage(wanted)
      setItems(found)
      setDone(current.done)
      setKnown(current.known)
      setError(null)
    } catch (e) {
      if (request === latest.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (request === latest.current) setSearching(false)
    }
  }, [])

  useEffect(() => {
    const ctx = newContext()
    context.current = ctx
    const created = new ResultPager<T>(() => {
      Object.assign(ctx.stats, zero()) // (a search that starts again counts from nothing)
      return make(ctx)
    }, pageSize)
    pager.current = created
    setItems([])
    setPage(0)
    setDone(false)
    setKnown(0)
    setStats(zero())
    void show(0)
    const timer = window.setInterval(() => setStats({ ...ctx.stats }), 400)
    return () => {
      ctx.aborted = true
      window.clearInterval(timer)
      void created.dispose()
      latest.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, ...deps])

  // The counts one last time when the search stops.
  useEffect(() => {
    if (done) setStats({ ...context.current.stats })
  }, [done])

  return {
    page,
    items,
    searching,
    done,
    known,
    stats,
    hasNext: !done || (pager.current?.known ?? 0) > (page + 1) * pageSize,
    next: () => void show(page + 1),
    previous: () => void show(Math.max(0, page - 1)),
    goTo: (wanted) => void show(Math.max(0, wanted)),
    error,
  }
}
