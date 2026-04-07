import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert } from 'react-native';
import { useTheme } from '../../src/hooks/useTheme';
import { useNotebookStore } from '../../src/store/notebook.store';
import { useSessionStore } from '../../src/store/session.store';
import { getStorageProvider } from '../../src/storage/StorageProviderFactory';
import { updateNotebookTitle } from '../../src/notebook/NotebookWriter';
import { AppHeader } from '../../src/components/layout/AppHeader';
import { Animated } from 'react-native';

export default function ManageNotebookPage() {
  const theme = useTheme();
  const notebookMeta = useNotebookStore((s) => s.metadata);
  const setNotebook = useNotebookStore((s) => s.setNotebook);
  const session = useSessionStore((s) => s.getCurrentSession());
  const updateSession = useSessionStore((s) => s.updateSession);

  const [title, setTitle] = useState(notebookMeta?.title ?? '');
  const [editingTitle, setEditingTitle] = useState(false);

  const getProvider = () => {
    if (!session) return null;
    return getStorageProvider(session.storageProviderId) ?? null;
  };

  const handleSaveTitle = async () => {
    const provider = getProvider();
    if (!provider || !notebookMeta) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await updateNotebookTitle(provider, notebookMeta.rootPath, trimmed);
      setNotebook({ ...notebookMeta, title: trimmed });
      if (session?.syncNameWithNotebook) {
        updateSession(session.id, { name: trimmed });
      }
      setEditingTitle(false);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to update title');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <AppHeader title="Manage Notebook" opacity={new Animated.Value(1)} icon="book-outline" />

      <View style={[styles.section, { borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>NOTEBOOK INFO</Text>
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Title</Text>
          {editingTitle ? (
            <View style={styles.editRow}>
              <TextInput
                value={title}
                onChangeText={setTitle}
                style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.border }]}
                autoFocus
                onSubmitEditing={handleSaveTitle}
              />
              <TouchableOpacity onPress={handleSaveTitle} style={[styles.saveBtn, { backgroundColor: theme.colors.primary }]}>
                <Text style={{ color: theme.colors.primaryForeground }}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setEditingTitle(false); setTitle(notebookMeta?.title ?? ''); }}>
                <Text style={{ color: theme.colors.textSecondary }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={() => setEditingTitle(true)}>
              <Text style={[styles.value, { color: theme.colors.primary }]}>
                {notebookMeta?.title ?? '–'} ✎
              </Text>
            </TouchableOpacity>
          )}
        </View>
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Storage</Text>
          <Text style={[styles.value, { color: theme.colors.textSecondary }]}>
            {session?.storageProviderType ?? '–'}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Root path</Text>
          <Text style={[styles.value, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {notebookMeta?.rootPath ?? '–'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  section: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8 },
  sectionTitle: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5, margin: 16, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  label: { fontSize: 15 },
  value: { fontSize: 15, flex: 1, textAlign: 'right' },
  editRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  saveBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
});
