import { useState, useEffect, useRef, useCallback } from 'react'
import type { AppPhase, AppState, FileNode, StoredConfig } from '../types'
import { defaultAppState } from '../types'
import {
  saveRootHandle, getRootHandle,
  saveConfig, getConfig,
  clearAll, verifyPermission,
  readAppState, writeAppState,
} from '../utils/storage'
import {
  getOrCreateDataFolder, buildFileTree, findNodeByPath,
} from '../utils/fileSystem'

export interface AppInitResult {
  phase: AppPhase
  config: StoredConfig | null
  appState: AppState
  tree: FileNode[]
  currentFile: FileNode | null
  errorMessage: string | null
  warnings: string[]
  onSetupComplete: (rootHandle: FileSystemDirectoryHandle, dataFolderPath: string) => Promise<void>
  onOpenLibrary: () => Promise<void>
  onSelectFile: (node: FileNode) => void
  onSavePosition: (path: string, position: number) => Promise<void>
  onMarkWatched: (path: string) => Promise<void>
  onRefresh: () => Promise<void>
  onReset: () => Promise<void>
  onDismissWarnings: () => void
}

export function useAppInit(): AppInitResult {
  const [phase, setPhase] = useState<AppPhase>('initializing')
  const [config, setConfig] = useState<StoredConfig | null>(null)
  const [appState, setAppState] = useState<AppState>(defaultAppState)
  const [tree, setTree] = useState<FileNode[]>([])
  const [currentFile, setCurrentFile] = useState<FileNode | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const rootHandleRef = useRef<FileSystemDirectoryHandle | null>(null)
  const dataFolderRef = useRef<FileSystemDirectoryHandle | null>(null)

  // ---- helpers ----

  function toError(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  const loadLibrary = useCallback(async (
    rootHandle: FileSystemDirectoryHandle,
    cfg: StoredConfig,
  ) => {
    setPhase('loading')
    setWarnings([])
    try {
      const dataFolder = await getOrCreateDataFolder(rootHandle, cfg.dataFolderPath)
      dataFolderRef.current = dataFolder

      const topLevelDataName = cfg.dataFolderPath.split('/')[0]
      const skipped: string[] = []
      const [state, fileTree] = await Promise.all([
        readAppState(dataFolder),
        buildFileTree(rootHandle, '', topLevelDataName, 0, (path, err) => {
          skipped.push(`${path}: ${err.message}`)
        }),
      ])
      if (skipped.length > 0) setWarnings(skipped)

      setAppState(state)
      setTree(fileTree)
      setPhase('ready')

      // Restore last played file
      if (state.lastPlayedPath) {
        const lastNode = findNodeByPath(fileTree, state.lastPlayedPath)
        if (lastNode) setCurrentFile(lastNode)
      }
    } catch (e) {
      setErrorMessage(toError(e))
      setPhase('error')
    }
  }, [])

  // ---- initial load from IDB ----
  useEffect(() => {
    async function init() {
      try {
        const [handle, cfg] = await Promise.all([getRootHandle(), getConfig()])
        if (!handle || !cfg) {
          setPhase('setup')
          return
        }
        rootHandleRef.current = handle
        setConfig(cfg)
        setPhase('restoring')
      } catch {
        setPhase('setup')
      }
    }
    void init()
  }, [])

  // ---- public actions ----

  const onSetupComplete = useCallback(async (
    rootHandle: FileSystemDirectoryHandle,
    dataFolderPath: string,
  ) => {
    const cfg: StoredConfig = { rootDirName: rootHandle.name, dataFolderPath }
    rootHandleRef.current = rootHandle
    await saveRootHandle(rootHandle)
    await saveConfig(cfg)
    setConfig(cfg)
    await loadLibrary(rootHandle, cfg)
  }, [loadLibrary])

  const onOpenLibrary = useCallback(async () => {
    const handle = rootHandleRef.current
    if (!handle || !config) return
    const granted = await verifyPermission(handle)
    if (!granted) {
      setErrorMessage('Permission denied. Please reload and try again.')
      setPhase('error')
      return
    }
    await loadLibrary(handle, config)
  }, [config, loadLibrary])

  const onSelectFile = useCallback((node: FileNode) => {
    setCurrentFile(node)
    setAppState(prev => {
      const next = { ...prev, lastPlayedPath: node.path }
      if (dataFolderRef.current) {
        void writeAppState(dataFolderRef.current, next)
      }
      return next
    })
  }, [])

  const onSavePosition = useCallback(async (path: string, position: number) => {
    setAppState(prev => {
      const next = {
        ...prev,
        positions: { ...prev.positions, [path]: position },
      }
      if (dataFolderRef.current) {
        void writeAppState(dataFolderRef.current, next)
      }
      return next
    })
  }, [])

  const onMarkWatched = useCallback(async (path: string) => {
    setAppState(prev => {
      if (prev.watched[path]) return prev
      const next = { ...prev, watched: { ...prev.watched, [path]: true as const } }
      if (dataFolderRef.current) {
        void writeAppState(dataFolderRef.current, next)
      }
      return next
    })
  }, [])

  const onRefresh = useCallback(async () => {
    const handle = rootHandleRef.current
    if (!handle || !config) return
    const topLevelDataName = config.dataFolderPath.split('/')[0]
    const skipped: string[] = []
    const newTree = await buildFileTree(handle, '', topLevelDataName, 0, (path, err) => {
      skipped.push(`${path}: ${err.message}`)
    })
    setTree(newTree)
    setWarnings(skipped)
  }, [config])

  const onDismissWarnings = useCallback(() => setWarnings([]), [])

  const onReset = useCallback(async () => {
    await clearAll()
    rootHandleRef.current = null
    dataFolderRef.current = null
    setConfig(null)
    setAppState(defaultAppState())
    setTree([])
    setCurrentFile(null)
    setErrorMessage(null)
    setPhase('setup')
  }, [])

  return {
    phase,
    config,
    appState,
    tree,
    currentFile,
    errorMessage,
    warnings,
    onSetupComplete,
    onOpenLibrary,
    onSelectFile,
    onSavePosition,
    onMarkWatched,
    onRefresh,
    onReset,
    onDismissWarnings,
  }
}
