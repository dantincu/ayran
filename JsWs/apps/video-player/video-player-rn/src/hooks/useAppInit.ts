import { useState, useEffect, useCallback, useRef } from 'react'
import * as FileSystem from 'expo-file-system/legacy'
import type { AppPhase, AppState, FileNode, StoredConfig } from '../types'
import { defaultAppState } from '../types'
import { saveConfig, getConfig, clearAll, readAppState, writeAppState, initStateFile } from '../utils/storage'
import { buildFileTree, findNodeByPath } from '../utils/fileSystem'

const SAF = FileSystem.StorageAccessFramework

export interface AppInitResult {
  phase: AppPhase
  config: StoredConfig | null
  appState: AppState
  tree: FileNode[]
  currentFile: FileNode | null
  errorMessage: string | null
  warnings: string[]
  onSetupComplete: (
    rootDirUri: string,
    rootDirName: string,
    dataFolderUri: string | null,
    dataFolderName: string | null,
  ) => Promise<void>
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

  const stateFileUriRef = useRef<string | null>(null)

  function toError(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  const loadLibrary = useCallback(async (cfg: StoredConfig) => {
    setPhase('loading')
    setWarnings([])
    try {
      await SAF.readDirectoryAsync(cfg.rootDirUri)

      // Resolve the SAF state file only when the user chose a data folder.
      // Otherwise fall back to device storage (documentDirectory).
      let stateFileUri = cfg.stateFileUri
      if (!stateFileUri && cfg.dataFolderUri) {
        stateFileUri = await initStateFile(cfg.dataFolderUri)
        if (stateFileUri) {
          const updatedCfg = { ...cfg, stateFileUri }
          setConfig(updatedCfg)
          await saveConfig(updatedCfg)
          cfg = updatedCfg
        }
      }
      stateFileUriRef.current = stateFileUri

      const skipped: string[] = []
      const [state, fileTree] = await Promise.all([
        readAppState(stateFileUri),
        buildFileTree(cfg.rootDirUri, '', 0, (path, err) => {
          skipped.push(`${path}: ${err.message}`)
        }),
      ])

      if (skipped.length > 0) setWarnings(skipped)
      setAppState(state)
      setTree(fileTree)
      setPhase('ready')

      if (state.lastPlayedPath) {
        const lastNode = findNodeByPath(fileTree, state.lastPlayedPath)
        if (lastNode) setCurrentFile(lastNode)
      }
    } catch (e) {
      setErrorMessage(toError(e))
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    async function init() {
      try {
        const cfg = await getConfig()
        if (!cfg) {
          setPhase('setup')
          return
        }
        setConfig(cfg)
        setPhase('restoring')
      } catch {
        setPhase('setup')
      }
    }
    void init()
  }, [])

  const onSetupComplete = useCallback(async (
    rootDirUri: string,
    rootDirName: string,
    dataFolderUri: string | null,
    dataFolderName: string | null,
  ) => {
    const cfg: StoredConfig = {
      rootDirUri,
      rootDirName,
      dataFolderUri,
      dataFolderName,
      stateFileUri: null,
    }
    await saveConfig(cfg)
    setConfig(cfg)
    await loadLibrary(cfg)
  }, [loadLibrary])

  const onOpenLibrary = useCallback(async () => {
    if (!config) return
    await loadLibrary(config)
  }, [config, loadLibrary])

  const onSelectFile = useCallback((node: FileNode) => {
    setCurrentFile(node)
    setAppState(prev => {
      const next = { ...prev, lastPlayedPath: node.path }
      void writeAppState(next, stateFileUriRef.current)
      return next
    })
  }, [])

  const onSavePosition = useCallback(async (path: string, position: number) => {
    setAppState(prev => {
      const next = { ...prev, positions: { ...prev.positions, [path]: position } }
      void writeAppState(next, stateFileUriRef.current)
      return next
    })
  }, [])

  const onMarkWatched = useCallback(async (path: string) => {
    setAppState(prev => {
      if (prev.watched[path]) return prev
      const next = { ...prev, watched: { ...prev.watched, [path]: true as const } }
      void writeAppState(next, stateFileUriRef.current)
      return next
    })
  }, [])

  const onRefresh = useCallback(async () => {
    if (!config) return
    setWarnings([])
    const skipped: string[] = []
    const newTree = await buildFileTree(config.rootDirUri, '', 0, (path, err) => {
      skipped.push(`${path}: ${err.message}`)
    })
    setTree(newTree)
    setWarnings(skipped)
  }, [config])

  const onDismissWarnings = useCallback(() => setWarnings([]), [])

  const onReset = useCallback(async () => {
    await clearAll()
    stateFileUriRef.current = null
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
