import { useCallback, useEffect, useState } from 'react'
import { api, errorText, type Entry } from './api'
import { ListView } from './ListView'
import { TrainView } from './TrainView'

/** `#/` is the list, `#/train/<id>` a password's training view (so Android's back button returns to the list). */
function routeId(): string | null {
  const m = /^#\/train\/(.+)$/.exec(window.location.hash)
  return m ? decodeURIComponent(m[1]) : null
}

export function App() {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [trainId, setTrainId] = useState<string | null>(routeId)

  useEffect(() => {
    api.list().then(setEntries, (e) => setLoadError(errorText(e)))
    const onHash = () => setTrainId(routeId())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const openTraining = useCallback((id: string) => {
    window.location.hash = `#/train/${encodeURIComponent(id)}`
  }, [])
  const backToList = useCallback(() => {
    if (window.history.length > 1 && routeId()) window.history.back()
    else window.location.hash = '#/'
  }, [])

  if (loadError) {
    return (
      <main className="page">
        <p className="error">{loadError}</p>
      </main>
    )
  }
  if (!entries) return <main className="page" />

  const training = trainId ? entries.find((e) => e.id === trainId) : undefined
  if (trainId && training) return <TrainView entry={training} onBack={backToList} />

  return <ListView entries={entries} setEntries={setEntries} onOpen={openTraining} />
}
