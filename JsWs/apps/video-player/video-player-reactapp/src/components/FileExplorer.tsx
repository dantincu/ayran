import { useState } from 'react'
import type { AppState, FileNode } from '../types'
import './FileExplorer.css'

interface Props {
  tree: FileNode[]
  appState: AppState
  currentFilePath: string | null
  onSelectFile: (node: FileNode) => void
  onRefresh: () => Promise<void>
}

function formatPosition(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function FileItem({
  node,
  depth,
  appState,
  currentFilePath,
  onSelectFile,
}: {
  node: FileNode
  depth: number
  appState: AppState
  currentFilePath: string | null
  onSelectFile: (node: FileNode) => void
}) {
  const [open, setOpen] = useState(depth < 2)

  if (node.kind === 'directory') {
    return (
      <div className="tree-dir">
        <button
          className="tree-dir-row"
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => setOpen(o => !o)}
        >
          <span className={`tree-arrow ${open ? 'tree-arrow--open' : ''}`}>&#9658;</span>
          <span className="tree-dir-icon">&#128193;</span>
          <span className="tree-dir-name">{node.name}</span>
        </button>
        {open && node.children && (
          <div className="tree-children">
            {node.children.map(child => (
              <FileItem
                key={child.path}
                node={child}
                depth={depth + 1}
                appState={appState}
                currentFilePath={currentFilePath}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const isWatched = Boolean(appState.watched[node.path])
  const position = appState.positions[node.path]
  const hasPosition = position !== undefined && position > 0 && !isWatched
  const isCurrent = node.path === currentFilePath

  return (
    <button
      className={`tree-file-row ${isCurrent ? 'tree-file-row--active' : ''}`}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      onClick={() => onSelectFile(node)}
      title={node.path}
    >
      <span className="tree-file-indicator">
        {isCurrent ? (
          <span className="tree-indicator tree-indicator--playing">&#9654;</span>
        ) : isWatched ? (
          <span className="tree-indicator tree-indicator--watched">&#10003;</span>
        ) : hasPosition ? (
          <span className="tree-indicator tree-indicator--resume">&#9679;</span>
        ) : (
          <span className="tree-indicator tree-indicator--none" />
        )}
      </span>
      <span className="tree-file-name">{node.name}</span>
      {hasPosition && (
        <span className="tree-file-pos">{formatPosition(position)}</span>
      )}
    </button>
  )
}

export function FileExplorer({ tree, appState, currentFilePath, onSelectFile, onRefresh }: Props) {
  const [refreshing, setRefreshing] = useState(false)

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="explorer">
      <div className="explorer-header">
        <span className="explorer-title">Library</span>
        <button
          className={`explorer-refresh ${refreshing ? 'explorer-refresh--spinning' : ''}`}
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh"
        >
          &#8635;
        </button>
      </div>

      <div className="explorer-tree">
        {tree.length === 0 ? (
          <p className="explorer-empty">No video files found.</p>
        ) : (
          tree.map(node => (
            <FileItem
              key={node.path}
              node={node}
              depth={0}
              appState={appState}
              currentFilePath={currentFilePath}
              onSelectFile={onSelectFile}
            />
          ))
        )}
      </div>
    </div>
  )
}
