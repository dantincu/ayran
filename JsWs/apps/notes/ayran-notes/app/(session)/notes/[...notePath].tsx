import React from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useScrollFade } from '../../../src/hooks/useScrollFade';
import { useTheme } from '../../../src/hooks/useTheme';
import { useNoteList } from '../../../src/hooks/useNoteList';
import { NoteList } from '../../../src/components/explorer/NoteList';
import { AppHeader } from '../../../src/components/layout/AppHeader';
import { TopToolbar } from '../../../src/components/layout/TopToolbar';
import { AppFooter } from '../../../src/components/layout/AppFooter';

export default function ChildNotesPage() {
  const params = useLocalSearchParams<{ notePath: string[] }>();
  const router = useRouter();
  const theme = useTheme();
  const { headerOpacity, footerOpacity, onScroll } = useScrollFade();

  // notePath is an array of path segments
  const notePath = Array.isArray(params.notePath)
    ? params.notePath.join('/')
    : (params.notePath ?? '');

  const {
    notes,
    loading,
    handleCreateNote,
    handleDeleteNote,
    handleRenameNote,
    handleStarNote,
    handleLabelColor,
    refresh,
  } = useNoteList(notePath);

  // Derive a display title from the last path segment
  const segments = notePath.split('/').filter(Boolean);
  const pageTitle = `Notes · #${segments[segments.length - 1] ?? ''}`;

  const goToParent = () => {
    const parentSegments = segments.slice(0, -1);
    if (parentSegments.length === 0) {
      router.push('/');
    } else {
      router.push(`/notes/${parentSegments.map(encodeURIComponent).join('/')}`);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <AppHeader title={pageTitle} opacity={headerOpacity} icon="folder-open-outline" />
      <TopToolbar
        opacity={headerOpacity}
        showGoToParent
        onGoToParent={goToParent}
      />
      <NoteList
        notes={notes}
        loading={loading}
        onCreateNote={handleCreateNote}
        onDeleteNote={handleDeleteNote}
        onRenameNote={handleRenameNote}
        onStarNote={handleStarNote}
        onLabelColorNote={handleLabelColor}
        onNormalizeIndexes={refresh}
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
