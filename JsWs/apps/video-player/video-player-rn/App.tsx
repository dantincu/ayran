import { useWindowDimensions, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { MaterialIcons } from '@expo/vector-icons'
import { useAppInit } from './src/hooks/useAppInit'
import { SetupScreen } from './src/components/SetupScreen'
import { FileExplorer } from './src/components/FileExplorer'
import { VideoPlayer } from './src/components/VideoPlayer'
import { C } from './src/colors'

function AppContent() {
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const isLandscape = width > height

  const {
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
  } = useAppInit()

  const initialPosition = currentFile
    ? (appState.positions[currentFile.path] ?? 0)
    : 0

  const rootStyle = [
    styles.root,
    { paddingTop: insets.top, paddingBottom: insets.bottom },
  ]

  // ── Initializing ──────────────────────────────────────────────────────────
  if (phase === 'initializing') {
    return (
      <View style={[rootStyle, styles.center]}>
        <ActivityIndicator size="large" color={C.accent} />
      </View>
    )
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  if (phase === 'setup') {
    return (
      <View style={rootStyle}>
        <SetupScreen onComplete={onSetupComplete} />
      </View>
    )
  }

  // ── Restoring ─────────────────────────────────────────────────────────────
  if (phase === 'restoring') {
    return (
      <View style={[rootStyle, styles.center]}>
        <View style={styles.card}>
          <Text style={styles.cardIcon}>▶</Text>
          <Text style={styles.cardTitle}>Video Player</Text>
          {config && (
            <Text style={styles.cardSub}>
              Library: <Text style={styles.cardSubBold}>{config.rootDirName}</Text>
            </Text>
          )}
          <TouchableOpacity style={styles.btnPrimary} onPress={onOpenLibrary} activeOpacity={0.8}>
            <Text style={styles.btnPrimaryText}>Open Library</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnGhost} onPress={onReset} activeOpacity={0.8}>
            <Text style={styles.btnGhostText}>Choose Different Folder</Text>
          </TouchableOpacity>
        </View>
      </View>
    )
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <View style={[rootStyle, styles.center]}>
        <View style={styles.card}>
          <MaterialIcons name="warning" size={36} color={C.danger} />
          <Text style={styles.errorMsg}>{errorMessage ?? 'An unexpected error occurred.'}</Text>
          <TouchableOpacity style={styles.btnPrimary} onPress={onReset} activeOpacity={0.8}>
            <Text style={styles.btnPrimaryText}>Start Over</Text>
          </TouchableOpacity>
        </View>
      </View>
    )
  }

  // ── Loading / Ready ───────────────────────────────────────────────────────
  return (
    <View style={rootStyle}>
      {/* Main split layout: row in landscape, column in portrait */}
      <View style={[styles.appLayout, isLandscape ? styles.row : styles.column]}>

        {/* Sidebar / top panel */}
        <View style={[
          styles.sidebar,
          isLandscape
            ? { width: C.sidebarWidth, borderRightWidth: 1, borderRightColor: C.border }
            : { flex: 2, borderBottomWidth: 1, borderBottomColor: C.border },
        ]}>
          {phase === 'loading' ? (
            <View style={styles.sidebarLoading}>
              <ActivityIndicator size="small" color={C.accent} />
              <Text style={styles.sidebarLoadingText}>Loading library…</Text>
            </View>
          ) : (
            <FileExplorer
              tree={tree}
              appState={appState}
              currentFilePath={currentFile?.path ?? null}
              onSelectFile={onSelectFile}
              onRefresh={onRefresh}
            />
          )}
        </View>

        {/* Main area: topbar + warnings + player */}
        <View style={[styles.main, isLandscape ? styles.flex1 : { flex: 3 }]}>
          <View style={styles.topbar}>
            <Text style={styles.topbarTitle} numberOfLines={1}>
              {config?.rootDirName ?? ''}
            </Text>
            <TouchableOpacity style={styles.topbarBtn} onPress={onReset} activeOpacity={0.7}>
              <MaterialIcons name="settings" size={14} color={C.textMuted} />
              <Text style={styles.topbarBtnText}>Change Folder</Text>
            </TouchableOpacity>
          </View>

          {warnings.length > 0 && (
            <View style={styles.warnings}>
              <View style={styles.warningsHeader}>
                <Text style={styles.warningsText} numberOfLines={2}>
                  ⚠ {warnings.length} file{warnings.length > 1 ? 's' : ''} could not be read and were skipped
                </Text>
                <TouchableOpacity onPress={onDismissWarnings} style={styles.warningsDismiss}>
                  <MaterialIcons name="close" size={16} color={C.resume} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          <VideoPlayer
            file={currentFile}
            initialPosition={initialPosition}
            onSavePosition={onSavePosition}
            onMarkWatched={onMarkWatched}
          />
        </View>
      </View>
    </View>
  )
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AppContent />
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bgPrimary,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  // Split layout
  appLayout: {
    flex: 1,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
  },
  column: {
    flexDirection: 'column',
  },
  flex1: {
    flex: 1,
  },
  sidebar: {
    backgroundColor: C.bgSecondary,
    overflow: 'hidden',
  },
  sidebarLoading: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  sidebarLoadingText: {
    fontSize: 13,
    color: C.textMuted,
  },
  main: {
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  topbar: {
    height: C.headerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    backgroundColor: C.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  topbarTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: C.textMuted,
    marginRight: 8,
  },
  topbarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  topbarBtnText: {
    fontSize: 12,
    color: C.textMuted,
  },
  warnings: {
    backgroundColor: 'rgba(245, 166, 35, 0.1)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(245, 166, 35, 0.3)',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  warningsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  warningsText: {
    flex: 1,
    fontSize: 12,
    color: C.resume,
    fontWeight: '500',
  },
  warningsDismiss: {
    padding: 2,
  },
  // Cards (restore / error)
  card: {
    backgroundColor: C.bgSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 36,
    alignItems: 'center',
    gap: 16,
    width: '100%',
    maxWidth: 360,
  },
  cardIcon: {
    fontSize: 36,
    color: C.accent,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: C.textPrimary,
    marginTop: -8,
  },
  cardSub: {
    fontSize: 14,
    color: C.textSecondary,
    marginTop: -8,
  },
  cardSubBold: {
    color: C.textPrimary,
    fontWeight: '600',
  },
  errorMsg: {
    fontSize: 14,
    color: C.textSecondary,
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: 300,
  },
  btnPrimary: {
    paddingVertical: 11,
    paddingHorizontal: 20,
    backgroundColor: C.accent,
    borderRadius: 8,
    width: '100%',
    alignItems: 'center',
  },
  btnPrimaryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  btnGhost: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    width: '100%',
    alignItems: 'center',
  },
  btnGhostText: {
    color: C.textSecondary,
    fontSize: 14,
  },
})
