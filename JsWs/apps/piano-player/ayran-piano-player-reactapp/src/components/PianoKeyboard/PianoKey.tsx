import { memo } from 'react'
import { isBlackKey } from '../../constants/piano'
import './PianoKey.css'

interface PianoKeyProps {
  noteCode: string
  size: number
  pressed: boolean
  onPointerDown: (noteCode: string, pointerId: number) => void
  onPointerUp: (pointerId: number) => void
  onPointerEnter: (noteCode: string, pointerId: number) => void
}

export const PianoKey = memo(function PianoKey({
  noteCode,
  size,
  pressed,
  onPointerDown,
  onPointerUp,
  onPointerEnter
}: PianoKeyProps) {
  const black = isBlackKey(noteCode)

  return (
    <div
      className={`piano-key ${black ? 'piano-key--black' : 'piano-key--white'} ${pressed ? 'piano-key--pressed' : ''}`}
      style={{ width: size, height: size, fontSize: Math.max(7, size * 0.18) }}
      data-note={noteCode}
      onPointerDown={e => {
        e.preventDefault()
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        onPointerDown(noteCode, e.pointerId)
      }}
      onPointerUp={e => {
        e.preventDefault()
        onPointerUp(e.pointerId)
      }}
      onPointerEnter={e => {
        e.preventDefault()
        onPointerEnter(noteCode, e.pointerId)
      }}
      onPointerCancel={e => {
        onPointerUp(e.pointerId)
      }}
    >
      <span className="piano-key__label">{noteCode}</span>
    </div>
  )
})
