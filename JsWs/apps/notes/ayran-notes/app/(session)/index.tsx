import React from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { useNotebookStore } from '../../src/store/notebook.store';
import { useScrollFade } from '../../src/hooks/useScrollFade';
import { useTheme } from '../../src/hooks/useTheme';
import { useNoteList } from '../../src/hooks/useNoteList';
import { NoteList } from '../../src/components/explorer/NoteList';
import { AppHeader } from '../../src/components/layout/AppHeader';
import { TopToolbar } from '../../src/components/layout/TopToolbar';
import { AppFooter } from '../../src/components/layout/AppFooter';
import { normalizeNoteIndexes } from '../../src/notebook/NoteNormalizer';

export default function RootNotesPage() {
  const theme = useTheme();
  const notebookMeta = useNotebookStore((s) => s.metadata);
  const { headerOpacity, footerOpacity, onScroll } = useScrollFade();

  const {
    notes,
    loading,
    handleCreateNote,
    handleDeleteNote,
    handleRenameNote,
    handleStarNote,
    handleLabelColor,
    refresh,
  } = useNoteList('');

  const title = notebookMeta?.title ?? 'Ayran Notes';

  const handleNormalizeIndexes = async () => {
    // For root notes, normalize regular category
    refresh();
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <AppHeader title={title} opacity={headerOpacity} icon="book-outline" />
      <TopToolbar
        opacity={headerOpacity}
        contextMenuItems={[
          {
            label: 'Normalize indexes',
            icon: 'git-merge-outline',
            onPress: handleNormalizeIndexes,
          },
        ]}
      />
      <NoteList
        notes={notes}
        loading={loading}
        onCreateNote={handleCreateNote}
        onDeleteNote={handleDeleteNote}
        onRenameNote={handleRenameNote}
        onStarNote={handleStarNote}
        onLabelColorNote={handleLabelColor}
        onNormalizeIndexes={handleNormalizeIndexes}
        onScroll={onScroll}
      />
      <Animated.View style={{ opacity: footerOpacity }}>
        <AppFooter opacity={footerOpacity} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
