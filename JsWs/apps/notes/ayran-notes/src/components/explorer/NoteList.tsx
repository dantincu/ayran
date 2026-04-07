import React, { useState } from 'react';
import {
  FlatList,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NoteMetadata } from '../../types/note.types';
import { NoteListItem } from './NoteListItem';
import { useTheme } from '../../hooks/useTheme';

interface NoteListProps {
  notes: NoteMetadata[];
  loading: boolean;
  parentTitle?: string;
  onCreateNote: (title: string) => void;
  onDeleteNote: (notePath: string) => void;
  onRenameNote: (notePath: string, newTitle: string) => void;
  onStarNote: (notePath: string, starred: boolean) => void;
  onLabelColorNote: (notePath: string, color: string | null) => void;
  onNormalizeIndexes: () => void;
  headerComponent?: React.ReactElement;
  onScroll?: (event: any) => void;
}

export function NoteList({
  notes,
  loading,
  parentTitle,
  onCreateNote,
  onDeleteNote,
  onRenameNote,
  onStarNote,
  onLabelColorNote,
  onNormalizeIndexes,
  headerComponent,
  onScroll,
}: NoteListProps) {
  const theme = useTheme();
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ notePath: string; currentTitle: string } | null>(null);
  const [renameText, setRenameText] = useState('');

  const handleCreateSubmit = () => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    onCreateNote(trimmed);
    setNewTitle('');
    setShowCreate(false);
  };

  const handleRenameSubmit = () => {
    if (!renameTarget) return;
    const trimmed = renameText.trim();
    if (!trimmed) return;
    onRenameNote(renameTarget.notePath, trimmed);
    setRenameTarget(null);
    setRenameText('');
  };

  const openRename = (notePath: string, currentTitle: string) => {
    setRenameTarget({ notePath, currentTitle });
    setRenameText(currentTitle);
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <FlatList
        data={notes}
        keyExtractor={(item) => item.notePath}
        renderItem={({ item }) => (
          <NoteListItem
            note={item}
            onStar={onStarNote}
            onLabelColor={onLabelColorNote}
            onDelete={onDeleteNote}
            onRename={openRename}
          />
        )}
        ListHeaderComponent={headerComponent}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="document-text-outline" size={64} color={theme.colors.border} />
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
              {parentTitle ? `No notes in "${parentTitle}" yet` : 'Create your first note'}
            </Text>
            <TouchableOpacity
              onPress={() => setShowCreate(true)}
              style={[styles.createFirstBtn, { backgroundColor: theme.colors.primary }]}
            >
              <Text style={{ color: theme.colors.primaryForeground, fontWeight: '600' }}>
                + New Note
              </Text>
            </TouchableOpacity>
          </View>
        }
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={notes.length === 0 ? styles.emptyContent : undefined}
      />

      {/* Create note FAB */}
      {notes.length > 0 && (
        <TouchableOpacity
          onPress={() => setShowCreate(true)}
          style={[styles.fab, { backgroundColor: theme.colors.primary }]}
          accessibilityLabel="Create new note"
        >
          <Ionicons name="add" size={28} color={theme.colors.primaryForeground} />
        </TouchableOpacity>
      )}

      {/* Create note input */}
      {showCreate && (
        <View style={[styles.inputOverlay, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.inputLabel, { color: theme.colors.text }]}>New note title</Text>
          <TextInput
            value={newTitle}
            onChangeText={setNewTitle}
            placeholder="Enter title..."
            placeholderTextColor={theme.colors.textSecondary}
            style={[styles.textInput, { color: theme.colors.text, borderColor: theme.colors.border }]}
            autoFocus
            onSubmitEditing={handleCreateSubmit}
            returnKeyType="done"
          />
          <View style={styles.inputActions}>
            <TouchableOpacity onPress={() => setShowCreate(false)} style={styles.cancelBtn}>
              <Text style={{ color: theme.colors.textSecondary }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleCreateSubmit}
              style={[styles.confirmBtn, { backgroundColor: theme.colors.primary }]}
            >
              <Text style={{ color: theme.colors.primaryForeground }}>Create</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Rename input */}
      {renameTarget && (
        <View style={[styles.inputOverlay, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.inputLabel, { color: theme.colors.text }]}>Rename note</Text>
          <TextInput
            value={renameText}
            onChangeText={setRenameText}
            placeholder="New title..."
            placeholderTextColor={theme.colors.textSecondary}
            style={[styles.textInput, { color: theme.colors.text, borderColor: theme.colors.border }]}
            autoFocus
            onSubmitEditing={handleRenameSubmit}
            returnKeyType="done"
          />
          <View style={styles.inputActions}>
            <TouchableOpacity onPress={() => setRenameTarget(null)} style={styles.cancelBtn}>
              <Text style={{ color: theme.colors.textSecondary }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleRenameSubmit}
              style={[styles.confirmBtn, { backgroundColor: theme.colors.primary }]}
            >
              <Text style={{ color: theme.colors.primaryForeground }}>Rename</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContent: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    gap: 16,
  },
  emptyText: {
    fontSize: 16,
    textAlign: 'center',
  },
  createFirstBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  inputOverlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 20,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  inputActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 12,
  },
  cancelBtn: {
    padding: 8,
  },
  confirmBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
});
