import { useState } from 'react'
import {
  View, Text, TouchableOpacity, ActivityIndicator,
  StyleSheet, ScrollView,
} from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import { MaterialIcons } from '@expo/vector-icons'
import { C } from '../colors'

const SAF = FileSystem.StorageAccessFramework

interface Props {
  onComplete: (
    rootDirUri: string,
    rootDirName: string,
    dataFolderUri: string | null,
    dataFolderName: string | null,
  ) => Promise<void>
}

function dirNameFromUri(uri: string): string {
  const decoded = decodeURIComponent(uri)
  const treePart = decoded.split('/tree/').pop() ?? decoded
  return treePart.split(':').pop() ?? treePart
}

export function SetupScreen({ onComplete }: Props) {
  const [pickedUri, setPickedUri] = useState<string | null>(null)
  const [pickedName, setPickedName] = useState('')
  const [dataUri, setDataUri] = useState<string | null>(null)
  const [dataName, setDataName] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  async function pickDirectory() {
    try {
      const result = await SAF.requestDirectoryPermissionsAsync()
      if (result.granted) {
        setPickedUri(result.directoryUri)
        setPickedName(dirNameFromUri(result.directoryUri))
        setError('')
      }
    } catch {
      setError('Could not open the directory picker. Please try again.')
    }
  }

  async function pickDataDirectory() {
    try {
      const result = await SAF.requestDirectoryPermissionsAsync()
      if (result.granted) {
        setDataUri(result.directoryUri)
        setDataName(dirNameFromUri(result.directoryUri))
        setError('')
      }
    } catch {
      setError('Could not open the directory picker. Please try again.')
    }
  }

  async function handleConfirm() {
    if (!pickedUri) return
    setIsLoading(true)
    setError('')
    try {
      await onComplete(pickedUri, pickedName, dataUri, dataUri ? dataName : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred.')
      setIsLoading(false)
    }
  }

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.dialog}>
        <Text style={styles.icon}>▶</Text>
        <Text style={styles.title}>Video Player</Text>
        <Text style={styles.subtitle}>
          Choose a folder containing your video files to get started.
        </Text>

        {/* ── Content folder ── */}
        <View style={styles.field}>
          <Text style={styles.label}>Video library folder</Text>
          <TouchableOpacity
            style={[styles.pickBtn, pickedUri ? styles.pickBtnChosen : null]}
            onPress={pickDirectory}
            disabled={isLoading}
            activeOpacity={0.7}
          >
            {pickedUri ? (
              <>
                <Text style={styles.pickCheck}>✓</Text>
                <Text style={styles.pickName} numberOfLines={1}>{pickedName}</Text>
                <Text style={styles.pickChange}>Change</Text>
              </>
            ) : (
              <Text style={styles.pickBtnText}>Choose Folder…</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* ── Data folder (optional) ── */}
        <View style={styles.field}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>App data folder</Text>
            <Text style={styles.optional}> — optional</Text>
          </View>
          <Text style={styles.fieldHint}>
            Where to save your watch history and resume positions.
            Defaults to device storage when not set.
          </Text>

          {dataUri ? (
            <View style={styles.dataRow}>
              <TouchableOpacity
                style={[styles.pickBtn, styles.pickBtnChosen, styles.flex1]}
                onPress={pickDataDirectory}
                disabled={isLoading}
                activeOpacity={0.7}
              >
                <Text style={styles.pickCheck}>✓</Text>
                <Text style={styles.pickName} numberOfLines={1}>{dataName}</Text>
                <Text style={styles.pickChange}>Change</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.clearBtn}
                onPress={() => { setDataUri(null); setDataName('') }}
                disabled={isLoading}
                activeOpacity={0.7}
              >
                <MaterialIcons name="close" size={16} color={C.textMuted} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.pickBtn}
              onPress={pickDataDirectory}
              disabled={isLoading}
              activeOpacity={0.7}
            >
              <Text style={styles.pickBtnText}>Choose Folder…</Text>
            </TouchableOpacity>
          )}
        </View>

        {!!error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity
          style={[styles.confirmBtn, (!pickedUri || isLoading) ? styles.confirmBtnDisabled : null]}
          onPress={handleConfirm}
          disabled={!pickedUri || isLoading}
          activeOpacity={0.8}
        >
          {isLoading
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.confirmBtnText}>Open Library</Text>
          }
        </TouchableOpacity>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: C.bgPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  dialog: {
    backgroundColor: C.bgSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 36,
    width: '100%',
    maxWidth: 440,
    gap: 20,
  },
  icon: {
    fontSize: 32,
    color: C.accent,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: C.textPrimary,
    marginTop: -8,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 14,
    color: C.textSecondary,
    lineHeight: 21,
    marginTop: -8,
  },
  field: {
    gap: 8,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: C.textSecondary,
  },
  optional: {
    fontSize: 12,
    color: C.textMuted,
  },
  fieldHint: {
    fontSize: 12,
    color: C.textMuted,
    lineHeight: 17,
    marginTop: -4,
  },
  pickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: C.bgElevated,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  pickBtnChosen: {
    borderColor: 'rgba(74, 158, 255, 0.4)',
  },
  pickBtnText: {
    color: C.textSecondary,
    fontSize: 14,
  },
  pickCheck: {
    color: C.watched,
    fontSize: 14,
  },
  pickName: {
    flex: 1,
    color: C.textPrimary,
    fontSize: 14,
  },
  pickChange: {
    color: C.accent,
    fontSize: 12,
  },
  dataRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  flex1: {
    flex: 1,
  },
  clearBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bgElevated,
  },
  errorText: {
    fontSize: 13,
    color: C.danger,
    backgroundColor: 'rgba(224, 92, 92, 0.1)',
    borderRadius: 6,
    padding: 10,
  },
  confirmBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    backgroundColor: C.accent,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 4,
  },
  confirmBtnDisabled: {
    opacity: 0.4,
  },
  confirmBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
})
