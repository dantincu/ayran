import type { ReactNode } from 'react'

/** Small inline icons (stroke = currentColor), so the app needs no icon font or extra request. */
type P = { size?: number }

const svg = (size: number, children: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const IconCheck = ({ size = 22 }: P) => svg(size, <path d="M20 6 9 17l-5-5" />)
export const IconUp = ({ size = 20 }: P) => svg(size, <path d="m18 15-6-6-6 6" />)
export const IconDown = ({ size = 20 }: P) => svg(size, <path d="m6 9 6 6 6-6" />)
export const IconPlus = ({ size = 20 }: P) => svg(size, <path d="M12 5v14M5 12h14" />)
export const IconBack = ({ size = 22 }: P) => svg(size, <path d="m15 18-6-6 6-6" />)
export const IconEdit = ({ size = 18 }: P) =>
  svg(size, <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>)
export const IconTrash = ({ size = 20 }: P) =>
  svg(size, <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>)
export const IconGrip = ({ size = 20 }: P) =>
  svg(size, <>{[5, 12, 19].map((y) => <g key={y}><circle cx="9" cy={y} r="1" /><circle cx="15" cy={y} r="1" /></g>)}</>)
export const IconX = ({ size = 22 }: P) => svg(size, <path d="M18 6 6 18M6 6l12 12" />)
