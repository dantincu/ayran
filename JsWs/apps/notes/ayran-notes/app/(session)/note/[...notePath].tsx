import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, StyleSheet, Alert, Animated } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../../../src/hooks/useTheme';
import { useScrollFade } from '../../../src/hooks/useScrollFade';
import { useSessionStore } from '../../../src/store/session.store';
import { useNotebookStore } from '../../../src/store/notebook.store';
import { useSettingsStore } from '../../../src/store/settings.store';
import { getStorageProvider } from '../../../src/storage/StorageProviderFactory';
import { readNoteJson, readNoteMarkdown } from '../../../src/notebook/NoteReader';
import { saveNoteMarkdown } from '../../../src/notebook/NoteWriter';
import { buildMdFileName } from '../../../src/notebook/NoteFileNaming';
import { exportNote } from '../../../src/notebook/NoteExporter';
import { MonacoEditor } from '../../../src/components/editor/MonacoEditor';
import { AppHeader } from '../../../src/components/layout/AppHeader';
import { TopToolbar } from '../../../src/components/layout/TopToolbar';
import { AppFooter } from '../../../src/components/layout/AppFooter';
import { HtmlPreview } from '../../../src/components/preview/HtmlPreview';
import { DockingLayout } from '../../../src/components/layout/DockingLayout';

export default function NoteEditorPage() {
  const params = useLocalSearchParams<{ notePath: string[] }>();
  const router = useRouter();
  const theme = useTheme();
  const { headerOpacity, footerOpacity, onScroll } = useScrollFade();

  const notePath = Array.isArray(params.notePath)
    ? params.notePath.join('/')
    : (params.notePath ?? '');

  const session = useSessionStore((s) => s.getCurrentSession());
  const notebookMeta = useNotebookStore((s) => s.metadata);
  const darkMode = useSettingsStore((s) => s.darkMode);
  const customStylesheet = useSettingsStore((s) => s.customStylesheet);

  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [mdFileName, setMdFileName] = useState('');
  const [title, setTitle] = useState('');
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [isDockingMode, setIsDockingMode] = useState(false);
  const [hoveredLink, setHoveredLink] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isDirty = content !== savedContent;

  const segments = notePath.split('/').filter(Boolean);
  const parentNotePath = segments.slice(0, -1).join('/');

  const getProvider = useCallback(() => {
    if (!session) return null;
    return getStorageProvider(session.storageProviderId) ?? null;
  }, [session]);

  const getShortFolderPath = useCallback(() => {
    if (!notebookMeta) return null;
    const provider = getProvider();
    if (!provider) return null;
    return provider.joinPath(notebookMeta.rootPath, ...segments);
  }, [notebookMeta, segments, getProvider]);

  // Load note
  useEffect(() => {
    (async () => {
      const provider = getProvider();
      const shortPath = getShortFolderPath();
      if (!provider || !shortPath) return;

      try {
        const noteJson = await readNoteJson(provider, shortPath);
        const fileName = buildMdFileName(noteJson.Title);
        setMdFileName(fileName);
        setTitle(noteJson.Title);

        const md = await readNoteMarkdown(provider, shortPath, fileName);
        const initial = md ?? `# ${noteJson.Title}\n`;
        setContent(initial);
        setSavedContent(initial);
      } catch (err) {
        Alert.alert('Error', 'Failed to load note');
      }
    })();
  }, [notePath]);

  const handleSave = useCallback(async () => {
    const provider = getProvider();
    const shortPath = getShortFolderPath();
    if (!provider || !shortPath || isSaving) return;

    setIsSaving(true);
    try {
      const finalContent = content;
      const currentMdFileName = mdFileName;

      // Save markdown
      await saveNoteMarkdown(provider, shortPath, currentMdFileName, finalContent);

      // Export to HTML and PDF
      const isDark = darkMode === 'dark' || (darkMode === 'system' && theme.isDark);
      await exportNote(provider, shortPath, currentMdFileName, finalContent, isDark, customStylesheet);

      setSavedContent(finalContent);
    } catch (err) {
      Alert.alert('Save failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSaving(false);
    }
  }, [content, mdFileName, getProvider, getShortFolderPath, isSaving, darkMode, theme.isDark, customStylesheet]);

  const goToParent = () => {
    if (parentNotePath) {
      router.push(`/notes/${parentNotePath.split('/').map(encodeURIComponent).join('/')}`);
    } else {
      router.push('/');
    }
  };

  const editorEl = (
    <MonacoEditor
      content={content}
      onChange={(newContent) => {
        setContent(newContent);
      }}
    />
  );

  const previewEl = (
    <HtmlPreview
      markdownContent={content}
      notePath={notePath}
      notebookRootPath={notebookMeta?.rootPath ?? ''}
      darkMode={darkMode === 'dark' || (darkMode === 'system' && theme.isDark)}
      customCss={customStylesheet}
      onHoverLink={setHoveredLink}
    />
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <AppHeader
        title={title || 'Note'}
        opacity={headerOpacity}
        icon="document-text-outline"
      />
      <TopToolbar
        opacity={headerOpacity}
        showGoToParent
        onGoToParent={goToParent}
        showSave
        onSave={handleSave}
        showEditPreview
        isPreviewMode={isPreviewMode}
        onTogglePreview={() => setIsPreviewMode((p) => !p)}
        contextMenuItems={[
          {
            label: isDockingMode ? 'Disable split view' : 'Enable split view',
            icon: 'tablet-landscape-outline',
            onPress: () => setIsDockingMode((d) => !d),
          },
        ]}
      />

      {isDockingMode ? (
        <DockingLayout left={editorEl} right={previewEl} />
      ) : isPreviewMode ? (
        previewEl
      ) : (
        editorEl
      )}

      <Animated.View style={{ opacity: footerOpacity }}>
        <AppFooter
          opacity={footerOpacity}
          hoveredLink={hoveredLink}
          onOpenLinkInCurrentTab={() => hoveredLink && router.push(hoveredLink as any)}
          onOpenLinkInNewTab={() => {}}
          onOpenLinkInNewTabBackground={() => {}}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
