import { useState } from 'react'
import {
  View, Text, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator,
} from 'react-native'
import { MaterialIcons } from '@expo/vector-icons'
import type { AppState, FileNode } from '../types'
import { C } from '../colors'

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
  node, depth, appState, currentFilePath, onSelectFile,
}: {
  node: FileNode
  depth: number
  appState: AppState
  currentFilePath: string | null
  onSelectFile: (node: FileNode) => void
}) {
  const [open, setOpen] = useState(depth < 2)
  const indent = 8 + depth * 16

  if (node.kind === 'directory') {
    return (
      <View>
        <TouchableOpacity
          style={[styles.dirRow, { paddingLeft: indent }]}
          onPress={() => setOpen(o => !o)}
          activeOpacity={0.6}
        >
          <MaterialIcons
            name={open ? 'keyboard-arrow-down' : 'keyboard-arrow-right'}
            size={16}
            color={C.textMuted}
          />
          <MaterialIcons name="folder" size={14} color={C.textMuted} style={styles.folderIcon} />
          <Text style={styles.dirName} numberOfLines={1}>{node.name}</Text>
        </TouchableOpacity>

        {open && node.children && (
          <View>
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
          </View>
        )}
      </View>
    )
  }

  const isWatched = Boolean(appState.watched[node.path])
  const position = appState.positions[node.path]
  const hasPosition = position !== undefined && position > 0 && !isWatched
  const isCurrent = node.path === currentFilePath

  return (
    <TouchableOpacity
      style={[styles.fileRow, isCurrent && styles.fileRowActive, { paddingLeft: indent }]}
      onPress={() => onSelectFile(node)}
      activeOpacity={0.6}
    >
      <View style={styles.indicator}>
        {isCurrent ? (
          <MaterialIcons name="play-arrow" size={11} color={C.accent} />
        ) : isWatched ? (
          <MaterialIcons name="check" size={13} color={C.watched} />
        ) : hasPosition ? (
          <MaterialIcons name="fiber-manual-record" size={8} color={C.resume} />
        ) : null}
      </View>

      <Text
        style={[styles.fileName, isCurrent && styles.fileNameActive]}
        numberOfLines={1}
      >
        {node.name}
      </Text>

      {hasPosition && (
        <Text style={styles.filePos}>{formatPosition(position)}</Text>
      )}
    </TouchableOpacity>
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
    <View style={styles.explorer}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Library</Text>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={handleRefresh}
          disabled={refreshing}
          activeOpacity={0.6}
        >
          {refreshing
            ? <ActivityIndicator size="small" color={C.textMuted} />
            : <MaterialIcons name="refresh" size={20} color={C.textMuted} />
          }
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.tree} contentContainerStyle={styles.treeContent}>
        {tree.length === 0 ? (
          <Text style={styles.emptyText}>No video files found.</Text>
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
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  explorer: {
    flex: 1,
    backgroundColor: C.bgSecondary,
    borderColor: C.border,
  },
  header: {
    height: C.headerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    color: C.textMuted,
  },
  refreshBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  tree: {
    flex: 1,
  },
  treeContent: {
    paddingVertical: 6,
  },
  emptyText: {
    paddingVertical: 24,
    paddingHorizontal: 16,
    fontSize: 13,
    color: C.textMuted,
    textAlign: 'center',
  },
  // Directory row
  dirRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingRight: 12,
    gap: 4,
  },
  folderIcon: {
    marginLeft: 2,
  },
  dirName: {
    flex: 1,
    fontSize: 13,
    color: C.textSecondary,
  },
  // File row
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingRight: 12,
    gap: 6,
  },
  fileRowActive: {
    backgroundColor: C.bgActive,
  },
  indicator: {
    width: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileName: {
    flex: 1,
    fontSize: 13,
    color: C.textSecondary,
  },
  fileNameActive: {
    color: C.accent,
  },
  filePos: {
    fontSize: 11,
    color: C.resume,
    fontVariant: ['tabular-nums'],
  },
})
