import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FileStat } from '../../types/storage.types';
import { useTheme } from '../../hooks/useTheme';
import { LongPressLink } from '../common/LongPressLink';

interface FileListItemProps {
  item: FileStat;
  onOpen: (item: FileStat) => void;
  onDelete?: (item: FileStat) => void;
  onRename?: (item: FileStat) => void;
}

function getFileIcon(name: string, isDirectory: boolean): keyof typeof Ionicons.glyphMap {
  if (isDirectory) return 'folder-outline';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
    md: 'document-text-outline',
    txt: 'document-text-outline',
    html: 'code-outline',
    json: 'code-slash-outline',
    pdf: 'document-outline',
    png: 'image-outline',
    jpg: 'image-outline',
    jpeg: 'image-outline',
    gif: 'image-outline',
    svg: 'image-outline',
    mp3: 'musical-note-outline',
    mp4: 'videocam-outline',
    zip: 'archive-outline',
  };
  return icons[ext] ?? 'document-outline';
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileListItem({ item, onOpen, onDelete, onRename }: FileListItemProps) {
  const theme = useTheme();
  const [showMenu, setShowMenu] = useState(false);

  const icon = getFileIcon(item.name, item.isDirectory);
  const href = item.isDirectory ? `/files/${encodeURIComponent(item.path)}` : `/files/${encodeURIComponent(item.path)}`;

  return (
    <>
      <LongPressLink href={href} navigateOnPress={false}>
        <TouchableOpacity
          onPress={() => onOpen(item)}
          style={[styles.row, { borderBottomColor: theme.colors.border }]}
        >
          <Ionicons name={icon} size={22} color={item.isDirectory ? theme.colors.primary : theme.colors.textSecondary} />
          <View style={styles.info}>
            <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>{item.name}</Text>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
              {item.isDirectory ? 'Folder' : formatSize(item.size)}
              {item.modifiedAt ? ` · ${new Date(item.modifiedAt).toLocaleDateString()}` : ''}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setShowMenu(true)} style={styles.moreBtn}>
            <Ionicons name="ellipsis-vertical" size={18} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        </TouchableOpacity>
      </LongPressLink>

      <Modal visible={showMenu} transparent animationType="fade" onRequestClose={() => setShowMenu(false)}>
        <Pressable style={styles.overlay} onPress={() => setShowMenu(false)}>
          <View style={[styles.menu, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
            <Text style={[styles.menuTitle, { color: theme.colors.text }]} numberOfLines={1}>{item.name}</Text>
            {onRename && (
              <TouchableOpacity style={styles.menuItem} onPress={() => { setShowMenu(false); onRename(item); }}>
                <Ionicons name="pencil-outline" size={18} color={theme.colors.text} />
                <Text style={[styles.menuText, { color: theme.colors.text }]}>Rename</Text>
              </TouchableOpacity>
            )}
            {onDelete && (
              <TouchableOpacity style={styles.menuItem} onPress={() => {
                setShowMenu(false);
                Alert.alert('Delete', `Delete "${item.name}"?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => onDelete(item) },
                ]);
              }}>
                <Ionicons name="trash-outline" size={18} color={theme.colors.danger} />
                <Text style={[styles.menuText, { color: theme.colors.danger }]}>Delete</Text>
              </TouchableOpacity>
            )}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  info: { flex: 1 },
  name: { fontSize: 15 },
  meta: { fontSize: 12, marginTop: 2 },
  moreBtn: { padding: 4 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  menu: { borderRadius: 12, borderWidth: 1, padding: 8, minWidth: 220 },
  menuTitle: { fontSize: 14, fontWeight: '600', padding: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(0,0,0,0.1)', marginBottom: 4 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8, gap: 10 },
  menuText: { fontSize: 15 },
});
