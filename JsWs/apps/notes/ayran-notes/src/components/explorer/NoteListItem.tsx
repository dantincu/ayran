import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Pressable,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NoteMetadata } from '../../types/note.types';
import { useTheme } from '../../hooks/useTheme';
import { LongPressLink } from '../common/LongPressLink';
import { ColorPicker } from '../common/ColorPicker';

interface NoteListItemProps {
  note: NoteMetadata;
  onStar: (notePath: string, starred: boolean) => void;
  onLabelColor: (notePath: string, color: string | null) => void;
  onDelete: (notePath: string) => void;
  onRename: (notePath: string, currentTitle: string) => void;
}

export function NoteListItem({ note, onStar, onLabelColor, onDelete, onRename }: NoteListItemProps) {
  const theme = useTheme();
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const noteHref = `/note/${encodeURIComponent(note.notePath)}`;
  const createdDate = new Date(note.createdAt).toLocaleDateString();

  const handleDelete = () => {
    setShowContextMenu(false);
    Alert.alert(
      'Delete Note',
      `Are you sure you want to delete "${note.title}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => onDelete(note.notePath),
        },
      ],
    );
  };

  return (
    <>
      <LongPressLink href={noteHref} navigateOnPress={true}>
        <View
          style={[
            styles.item,
            { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.border },
            note.labelColor ? { borderLeftColor: note.labelColor, borderLeftWidth: 4 } : null,
          ]}
        >
          <View style={styles.main}>
            <Ionicons name="document-text-outline" size={20} color={theme.colors.textSecondary} />
            <View style={styles.textBlock}>
              <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={2}>
                {note.title}
              </Text>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
                #{note.index} · {createdDate}
              </Text>
            </View>
          </View>
          <View style={styles.actions}>
            {note.starred && (
              <Ionicons name="star" size={16} color={theme.colors.star} />
            )}
            <TouchableOpacity
              onPress={() => setShowContextMenu(true)}
              style={styles.moreBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="ellipsis-vertical" size={18} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>
      </LongPressLink>

      {/* Context menu */}
      <Modal
        visible={showContextMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowContextMenu(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setShowContextMenu(false)}>
          <View style={[styles.menu, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
            <Text style={[styles.menuTitle, { color: theme.colors.text }]} numberOfLines={1}>
              {note.title}
            </Text>

            <TouchableOpacity style={styles.menuItem} onPress={() => { setShowContextMenu(false); onStar(note.notePath, !note.starred); }}>
              <Ionicons name={note.starred ? 'star' : 'star-outline'} size={18} color={theme.colors.star} />
              <Text style={[styles.menuText, { color: theme.colors.text }]}>
                {note.starred ? 'Remove star' : 'Add star'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuItem} onPress={() => { setShowContextMenu(false); setShowColorPicker(true); }}>
              <View style={[styles.colorDot, { backgroundColor: note.labelColor ?? theme.colors.border }]} />
              <Text style={[styles.menuText, { color: theme.colors.text }]}>Label color</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuItem} onPress={() => { setShowContextMenu(false); onRename(note.notePath, note.title); }}>
              <Ionicons name="pencil-outline" size={18} color={theme.colors.text} />
              <Text style={[styles.menuText, { color: theme.colors.text }]}>Rename</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuItem} onPress={handleDelete}>
              <Ionicons name="trash-outline" size={18} color={theme.colors.danger} />
              <Text style={[styles.menuText, { color: theme.colors.danger }]}>Delete</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* Color picker */}
      <Modal
        visible={showColorPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowColorPicker(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setShowColorPicker(false)}>
          <View style={styles.colorPickerWrapper}>
            <ColorPicker
              value={note.labelColor}
              onChange={(color) => onLabelColor(note.notePath, color)}
              onDismiss={() => setShowColorPicker(false)}
            />
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  textBlock: {
    flex: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: '500',
  },
  meta: {
    fontSize: 12,
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  moreBtn: {
    padding: 4,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  menu: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 8,
    minWidth: 240,
    maxWidth: 320,
  },
  menuTitle: {
    fontSize: 14,
    fontWeight: '600',
    padding: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.1)',
    marginBottom: 4,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    gap: 10,
  },
  menuText: {
    fontSize: 15,
  },
  colorDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  colorPickerWrapper: {
    maxWidth: 320,
    width: '90%',
  },
});
