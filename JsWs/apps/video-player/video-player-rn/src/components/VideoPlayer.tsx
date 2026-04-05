import { useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import { VideoView } from 'expo-video'
import type { VideoView as VideoViewRef } from 'expo-video'
import { MaterialIcons } from '@expo/vector-icons'
import type { FileNode } from '../types'
import { useVideoPlayer } from '../hooks/useVideoPlayer'
import { C } from '../colors'

interface Props {
  file: FileNode | null
  initialPosition: number
  onSavePosition: (path: string, position: number) => Promise<void>
  onMarkWatched: (path: string) => Promise<void>
}

export function VideoPlayer({ file, initialPosition, onSavePosition, onMarkWatched }: Props) {
  const videoRef = useRef<VideoViewRef>(null)
  const { player, isLoading, loadError } = useVideoPlayer({
    file,
    initialPosition,
    onSavePosition,
    onMarkWatched,
  })

  if (!file) {
    return (
      <View style={[styles.player, styles.playerEmpty]}>
        <Text style={styles.emptyIcon}>▶</Text>
        <Text style={styles.emptyText}>Select a video to play</Text>
        <Text style={styles.emptyHint}>Choose a file from the library</Text>
      </View>
    )
  }

  return (
    <View style={styles.player}>
      <View style={styles.titlebar}>
        <Text style={styles.filename} numberOfLines={1}>{file.name}</Text>
        <TouchableOpacity
          style={styles.fsBtn}
          onPress={() => videoRef.current?.enterFullscreen()}
          activeOpacity={0.7}
        >
          <MaterialIcons name="fullscreen" size={20} color={C.textMuted} />
        </TouchableOpacity>
      </View>

      <View style={styles.stage}>
        <VideoView
          ref={videoRef}
          player={player}
          nativeControls
          contentFit="contain"
          allowsFullscreen
          style={styles.video}
        />

        {isLoading && (
          <View style={styles.overlay} pointerEvents="none">
            <ActivityIndicator size="large" color={C.accent} />
          </View>
        )}

        {!!loadError && (
          <View style={[styles.overlay, styles.overlayError]} pointerEvents="none">
            <MaterialIcons name="warning" size={32} color={C.danger} />
            <Text style={styles.errorMsg}>{loadError}</Text>
          </View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  player: {
    flex: 1,
    backgroundColor: '#000',
  },
  playerEmpty: {
    backgroundColor: C.bgPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  emptyIcon: {
    fontSize: 48,
    color: C.border,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '500',
    color: C.textSecondary,
  },
  emptyHint: {
    fontSize: 13,
    color: C.textMuted,
  },
  titlebar: {
    height: C.headerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingLeft: 16,
    backgroundColor: C.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap: 8,
  },
  filename: {
    flex: 1,
    fontSize: 13,
    color: C.textSecondary,
  },
  fsBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  stage: {
    flex: 1,
    backgroundColor: '#000',
  },
  video: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    zIndex: 10,
  },
  overlayError: {
    backgroundColor: 'rgba(0,0,0,0.85)',
    gap: 12,
  },
  errorMsg: {
    fontSize: 13,
    color: C.textSecondary,
    maxWidth: 280,
    textAlign: 'center',
  },
})
