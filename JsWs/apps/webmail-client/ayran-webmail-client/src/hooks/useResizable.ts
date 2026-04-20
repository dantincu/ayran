import { useState, useCallback, useEffect, useRef } from 'react'

interface UseResizableOptions {
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
}

export function useResizable({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
}: UseResizableOptions) {
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(storageKey)
    if (stored) {
      const n = parseInt(stored)
      if (!isNaN(n)) return Math.min(maxWidth, Math.max(minWidth, n))
    }
    return defaultWidth
  })

  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      startX.current = e.clientX
      startWidth.current = width
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [width]
  )

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = e.clientX - startX.current
      const next = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta))
      setWidth(next)
    }

    const onMouseUp = () => {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Persist after drag ends
      setWidth((w) => {
        localStorage.setItem(storageKey, String(w))
        return w
      })
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [storageKey, minWidth, maxWidth])

  return { width, onMouseDown }
}
