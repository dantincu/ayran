import { useState, useCallback, useEffect, useRef } from 'react'

interface UseResizableOptions {
  storageKey: string
  defaultPct: number
  minPct: number
  maxPct: number
}

export function useResizable({ storageKey, defaultPct, minPct, maxPct }: UseResizableOptions) {
  const [pct, setPct] = useState<number>(() => {
    const s = localStorage.getItem(storageKey)
    if (s) {
      const n = parseFloat(s)
      if (!isNaN(n)) return Math.min(maxPct, Math.max(minPct, n))
    }
    return defaultPct
  })

  const isDragging = useRef(false)
  const startX = useRef(0)
  const startPct = useRef(0)
  const containerPx = useRef(0)

  // containerWidth: total px of the reference container for this panel's percentage
  const onMouseDown = useCallback(
    (e: React.MouseEvent, containerWidth: number) => {
      e.preventDefault()
      isDragging.current = true
      startX.current = e.clientX
      startPct.current = pct
      containerPx.current = containerWidth
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [pct]
  )

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const deltaPct = ((e.clientX - startX.current) / containerPx.current) * 100
      setPct(Math.min(maxPct, Math.max(minPct, startPct.current + deltaPct)))
    }

    const onMouseUp = () => {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setPct((p) => { localStorage.setItem(storageKey, String(p)); return p })
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [storageKey, minPct, maxPct])

  return { pct, onMouseDown }
}
