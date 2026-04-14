import { useRef, useState, useCallback } from 'react'
import { NOTE_CODES } from '../../constants/piano'
import { useKeySize } from '../../hooks/useKeySize'
import { usePianoInput } from '../../hooks/usePianoInput'
import { PianoKey } from './PianoKey'
import './PianoKeyboard.css'

export function PianoKeyboard() {
  const size = useKeySize()
  const pressedKeysRef = useRef<Set<string>>(new Set())
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set())

  const handleKeysChange = useCallback((keys: Set<string>) => {
    setPressedKeys(new Set(keys))
  }, [])

  const { onPointerDown, onPointerUp, onPointerEnter } = usePianoInput(
    pressedKeysRef,
    handleKeysChange
  )

  return (
    <div className="piano-keyboard" style={{ touchAction: 'none' }}>
      {NOTE_CODES.map(noteCode => (
        <PianoKey
          key={noteCode}
          noteCode={noteCode}
          size={size}
          pressed={pressedKeys.has(noteCode)}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerEnter={onPointerEnter}
        />
      ))}
    </div>
  )
}
