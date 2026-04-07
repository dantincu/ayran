import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, TouchableOpacity, Text, StyleSheet, Animated, ActivityIndicator, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../src/hooks/useTheme';
import { useScrollFade } from '../../../src/hooks/useScrollFade';
import { useSessionStore } from '../../../src/store/session.store';
import { useNotebookStore } from '../../../src/store/notebook.store';
import { getStorageProvider } from '../../../src/storage/StorageProviderFactory';
import { FileStat } from '../../../src/types/storage.types';
import { FileListItem } from '../../../src/components/explorer/FileListItem';
import { AppHeader } from '../../../src/components/layout/AppHeader';
import { TopToolbar } from '../../../src/components/layout/TopToolbar';
import { AppFooter } from '../../../src/components/layout/AppFooter';

export default function FileExplorerPage() {
  const params = useLocalSearchParams<{ filePath: string[] }>();
  const router = useRouter();
  const theme = useTheme();
  const { headerOpacity, footerOpacity, onScroll } = useScrollFade();

  const filePath = Array.isArray(params.filePath)
    ? decodeURIComponent(params.filePath.join('/'))
    : decodeURIComponent(params.filePath ?? '');

  const session = useSessionStore((s) => s.getCurrentSession());
  const notebookMeta = useNotebookStore((s) => s.metadata);

  const [items, setItems] = useState<FileStat[]>([]);
  const [loading, setLoading] = useState(true);

  const getProvider = useCallback(() => {
    if (!session) return null;
    return getStorageProvider(session.storageProviderId) ?? null;
  }, [session]);

  const loadDir = useCallback(async () => {
    const provider = getProvider();
    if (!provider) return;
    setLoading(true);
    try {
      const dirPath = filePath || (notebookMeta?.rootPath ?? '');
      const list = await provider.listDir(dirPath);
      setItems(list.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      }));
    } catch (err) {
      Alert.alert('Error', 'Failed to load directory');
    } finally {
      setLoading(false);
    }
  }, [getProvider, filePath, notebookMeta]);

  useEffect(() => { loadDir(); }, [loadDir]);

  const handleOpen = (item: FileStat) => {
    if (item.isDirectory) {
      router.push(`/files/${encodeURIComponent(item.path)}`);
    } else {
      // Open file — could be text, image, etc.
      router.push(`/files/${encodeURIComponent(item.path)}`);
    }
  };

  const handleDelete = async (item: FileStat) => {
    const provider = getProvider();
    if (!provider) return;
    try {
      if (item.isDirectory) {
        await provider.deleteDir(item.path, true);
      } else {
        await provider.deleteFile(item.path);
      }
      await loadDir();
    } catch (err) {
      Alert.alert('Error', 'Failed to delete');
    }
  };

  const pathSegments = filePath.split('/').filter(Boolean);
  const dirName = pathSegments[pathSegments.length - 1] ?? 'Files';

  const goToParent = () => {
    if (pathSegments.length <= 1) {
      router.push('/');
    } else {
      const parentPath = pathSegments.slice(0, -1).join('/');
      router.push(`/files/${encodeURIComponent(parentPath)}`);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <AppHeader title={dirName} opacity={headerOpacity} icon="folder-open-outline" />
      <TopToolbar
        opacity={headerOpacity}
        showGoToParent
        onGoToParent={goToParent}
      />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.path}
          renderItem={({ item }) => (
            <FileListItem
              item={item}
              onOpen={handleOpen}
              onDelete={handleDelete}
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="folder-open-outline" size={64} color={theme.colors.border} />
              <Text style={{ color: theme.colors.textSecondary, marginTop: 16 }}>Empty folder</Text>
            </View>
          }
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={items.length === 0 ? styles.emptyContent : undefined}
        />
      )}
      <Animated.View style={{ opacity: footerOpacity }}>
        <AppFooter opacity={footerOpacity} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyContent: { flex: 1 },
});
