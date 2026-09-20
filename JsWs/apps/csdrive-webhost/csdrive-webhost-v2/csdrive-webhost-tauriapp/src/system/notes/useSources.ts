import { useCallback, useEffect, useState } from 'react'
import { getUserRoot, loadSavedRoots, type FileRoot } from '../../lib/fileRoots'
import { listFilenAccounts } from '../../lib/filen'
import type { FilenAccountInfo, FileSource } from './sources'
import { resolveSource } from './notebooks'

/** The places the Notes app can work in — the user folder and the folders the person added, and the connected Filen
 * accounts — loaded once. (The file manager loads its own copy; a folder added here is added for good, in the backend.) */
export function useNotesSources() {
  const [roots, setRoots] = useState<FileRoot[]>([])
  const [accounts, setAccounts] = useState<FilenAccountInfo[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    Promise.all([getUserRoot(), loadSavedRoots().catch(() => [] as FileRoot[]), listFilenAccounts().catch(() => [] as FilenAccountInfo[])]).then(
      ([user, saved, filen]) => {
        if (!alive) return
        setRoots([user, ...saved])
        setAccounts(filen)
        setReady(true)
      },
    )
    return () => {
      alive = false
    }
  }, [])

  const addRoot = useCallback((root: FileRoot) => setRoots((current) => (current.some((r) => r.id === root.id) ? current : [...current, root])), [])
  const sourceOf = useCallback((sourceId: string): FileSource | null => resolveSource(sourceId, roots, accounts), [roots, accounts])

  return { roots, accounts, ready, addRoot, sourceOf }
}
