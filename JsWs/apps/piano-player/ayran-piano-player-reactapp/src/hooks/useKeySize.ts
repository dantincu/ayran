import { useState, useEffect, useCallback } from 'react'
import { KEY_SIZE_MIN, KEY_SIZE_MAX, TOTAL_KEYS } from '../constants/piano'
import { useSettingsStore } from '../store/useSettingsStore'

// Toolbar height estimate — keys area is the remaining viewport height
const TOOLBAR_HEIGHT = 52
const GAP = 1        // gap between keys in px
const H_PADDING = 16 // horizontal padding inside the keyboard container (left+right = 2*8px)
// keyboard container padding: 8px top + 8px bottom = 16px
const V_PADDING = 16

/**
 * Find the largest key size in [KEY_SIZE_MIN, KEY_SIZE_MAX] such that
 * all 88 keys wrap into rows that fit within the available viewport height.
 */
function calcAutoSize(windowWidth: number, windowHeight: number): number {
  const availableWidth = windowWidth - H_PADDING
  const availableHeight = windowHeight - TOOLBAR_HEIGHT - V_PADDING

  for (let size = KEY_SIZE_MAX; size >= KEY_SIZE_MIN; size--) {
    const keysPerRow = Math.floor(availableWidth / (size + GAP))
    if (keysPerRow < 1) continue
    const numRows = Math.ceil(TOTAL_KEYS / keysPerRow)
    const totalHeight = numRows * (size + GAP) - GAP
    if (totalHeight <= availableHeight) return size
  }

  return KEY_SIZE_MIN
}

export function useKeySize(): number {
  const activeSize = useSettingsStore(s => s.activeSize)
  const [autoSize, setAutoSize] = useState(() =>
    calcAutoSize(window.innerWidth, window.innerHeight)
  )

  const handleResize = useCallback(() => {
    setAutoSize(calcAutoSize(window.innerWidth, window.innerHeight))
  }, [])

  useEffect(() => {
    if (activeSize !== 'default') return
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [activeSize, handleResize])

  return activeSize === 'default' ? autoSize : activeSize
}
