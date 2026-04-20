interface ResizeHandleProps {
  onMouseDown: (e: React.MouseEvent) => void
}

export function ResizeHandle({ onMouseDown }: ResizeHandleProps) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 flex-shrink-0 cursor-col-resize bg-gray-100 hover:bg-primary-300 active:bg-primary-400 transition-colors group relative"
      title="Drag to resize"
    >
      {/* Visual dot indicator in the centre */}
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-gray-300 group-hover:bg-primary-400 transition-colors" />
    </div>
  )
}
