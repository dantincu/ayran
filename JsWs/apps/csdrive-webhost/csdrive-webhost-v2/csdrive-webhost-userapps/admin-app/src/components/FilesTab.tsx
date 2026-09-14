import { useCallback, useEffect, useState } from 'react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { readFile as readAbsoluteFile, writeFile as writeAbsoluteFile } from '@tauri-apps/plugin-fs'
import {
  copyUserPath,
  type DirEntry,
  joinRelative,
  listUserDir,
  mkdirUser,
  readUserFile,
  readUserTextFile,
  removeUserPath,
  renameUserPath,
  statUserPath,
  uniqueUserName,
  userPathExists,
  writeUserFile,
  writeUserTextFile,
} from '../lib/localFs'
import { openNewSecondaryWindow } from '../lib/secondaryWindows'

function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

interface EntryRow extends DirEntry {
  size?: number
}

interface ClipboardItem {
  mode: 'copy' | 'cut'
  sourcePath: string
  name: string
  isDirectory: boolean
}

function isSameOrWithin(ancestor: string, candidate: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`)
}

export default function FilesTab() {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ path: string; content: string; dirty: boolean } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listUserDir(path)
      const withSizes = await Promise.all(
        list.map(async (e) => {
          if (e.isDirectory) return { ...e }
          try {
            const info = await statUserPath(joinRelative(path, e.name))
            return { ...e, size: info.size }
          } catch {
            return { ...e }
          }
        }),
      )
      setEntries(withSizes)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [path])

  useEffect(() => {
    refresh()
  }, [refresh])

  const breadcrumbs = ['', ...path.split('/').filter(Boolean)]

  async function openEntry(entry: EntryRow) {
    const rel = joinRelative(path, entry.name)
    if (entry.isDirectory) {
      setPath(rel)
      return
    }
    try {
      const content = await readUserTextFile(rel)
      setEditing({ path: rel, content, dirty: false })
    } catch (e) {
      setError(String(e))
    }
  }

  async function saveEditing() {
    if (!editing) return
    try {
      await writeUserTextFile(editing.path, editing.content)
      setEditing({ ...editing, dirty: false })
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  async function createFolder() {
    const name = window.prompt('New folder name:')
    if (!name) return
    try {
      await mkdirUser(joinRelative(path, name))
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  async function createFile() {
    const name = window.prompt('New file name:', 'untitled.txt')
    if (!name) return
    try {
      const rel = joinRelative(path, name)
      if (await userPathExists(rel)) {
        setError(`"${name}" already exists.`)
        return
      }
      await writeUserTextFile(rel, '')
      await refresh()
      setEditing({ path: rel, content: '', dirty: false })
    } catch (e) {
      setError(String(e))
    }
  }

  async function deleteEntry(entry: EntryRow) {
    if (!window.confirm(`Delete "${entry.name}"? This cannot be undone.`)) return
    try {
      await removeUserPath(joinRelative(path, entry.name), entry.isDirectory)
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  function startRename(entry: EntryRow) {
    setRenaming(entry.name)
    setRenameValue(entry.name)
  }

  async function commitRename(oldName: string) {
    const newName = renameValue.trim()
    setRenaming(null)
    if (!newName || newName === oldName) return
    try {
      await renameUserPath(joinRelative(path, oldName), joinRelative(path, newName))
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  function copyEntry(entry: EntryRow) {
    setClipboard({ mode: 'copy', sourcePath: joinRelative(path, entry.name), name: entry.name, isDirectory: entry.isDirectory })
  }

  function cutEntry(entry: EntryRow) {
    setClipboard({ mode: 'cut', sourcePath: joinRelative(path, entry.name), name: entry.name, isDirectory: entry.isDirectory })
  }

  async function paste() {
    if (!clipboard) return
    setError(null)
    try {
      if (clipboard.isDirectory && isSameOrWithin(clipboard.sourcePath, path)) {
        throw new Error('Cannot move or copy a folder into itself or one of its subfolders.')
      }

      if (clipboard.mode === 'cut') {
        const destPath = joinRelative(path, clipboard.name)
        if (destPath === clipboard.sourcePath) {
          setClipboard(null)
          return
        }
        const destName = (await userPathExists(destPath)) ? await uniqueUserName(path, clipboard.name) : clipboard.name
        await renameUserPath(clipboard.sourcePath, joinRelative(path, destName))
        setClipboard(null)
      } else {
        const destName = (await userPathExists(joinRelative(path, clipboard.name)))
          ? await uniqueUserName(path, clipboard.name)
          : clipboard.name
        await copyUserPath(clipboard.sourcePath, joinRelative(path, destName))
      }
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  async function uploadFiles() {
    try {
      const selected = await openDialog({ multiple: true })
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : []
      for (const absPath of paths) {
        const name = absPath.split(/[\\/]/).pop() ?? 'file'
        const data = await readAbsoluteFile(absPath)
        await writeUserFile(joinRelative(path, name), data)
      }
      if (paths.length) await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  async function openAsWebApp(entry: EntryRow) {
    try {
      await openNewSecondaryWindow(joinRelative(path, entry.name))
    } catch (e) {
      setError(String(e))
    }
  }

  async function downloadEntry(entry: EntryRow) {
    try {
      const dest = await saveDialog({ defaultPath: entry.name })
      if (!dest) return
      const data = await readUserFile(joinRelative(path, entry.name))
      await writeAbsoluteFile(dest, data)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="tab-panel files-tab">
      <div className="toolbar">
        <div className="breadcrumbs">
          {breadcrumbs.map((seg, i) => {
            const target = breadcrumbs.slice(1, i + 1).join('/')
            return (
              <span key={i}>
                {i > 0 && <span className="crumb-sep">/</span>}
                <button className="link-button" onClick={() => setPath(target)}>
                  {i === 0 ? 'user' : seg}
                </button>
              </span>
            )
          })}
        </div>
        <div className="toolbar-actions">
          <button onClick={createFile}>New file</button>
          <button onClick={createFolder}>New folder</button>
          <button onClick={uploadFiles}>Upload…</button>
          {clipboard && (
            <button onClick={paste} title={clipboard.sourcePath}>
              Paste "{clipboard.name}"
            </button>
          )}
          <button onClick={refresh}>Refresh</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="muted">Loading…</div>}

      {!loading && (
        <table className="file-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  This folder is empty.
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.name}>
                <td>
                  {renaming === entry.name ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(entry.name)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(entry.name)
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                    />
                  ) : (
                    <button className="link-button entry-name" onClick={() => openEntry(entry)}>
                      {entry.isDirectory ? '📁' : '📄'} {entry.name}
                    </button>
                  )}
                </td>
                <td className="muted">{!entry.isDirectory && entry.size != null ? formatBytes(entry.size) : ''}</td>
                <td className="row-actions">
                  {!entry.isDirectory && isHtmlFile(entry.name) && (
                    <button onClick={() => openAsWebApp(entry)}>Open as web app</button>
                  )}
                  {!entry.isDirectory && <button onClick={() => downloadEntry(entry)}>Export</button>}
                  <button onClick={() => copyEntry(entry)}>Copy</button>
                  <button onClick={() => cutEntry(entry)}>Cut</button>
                  <button onClick={() => startRename(entry)}>Rename</button>
                  <button onClick={() => deleteEntry(entry)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div className="editor-overlay">
          <div className="editor-panel">
            <div className="editor-header">
              <strong>{editing.path}</strong>
              <div>
                <button onClick={saveEditing} disabled={!editing.dirty}>
                  Save
                </button>
                <button onClick={() => setEditing(null)}>Close</button>
              </div>
            </div>
            <textarea
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value, dirty: true })}
              spellCheck={false}
            />
          </div>
        </div>
      )}
    </div>
  )
}
