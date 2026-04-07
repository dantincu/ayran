import React, { useState } from 'react';
import {
  Animated,
  View,
  TouchableOpacity,
  StyleSheet,
  Text,
  Modal,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../hooks/useTheme';
import { useSessionStore } from '../../store/session.store';
import { useModalStore } from '../../store/modal.store';
import { TabList } from '../tabs/TabList';
import { MinimizedModals } from '../modals/MinimizedModals';

interface TopToolbarProps {
  opacity: Animated.Value;
  showGoToParent?: boolean;
  onGoToParent?: () => void;
  showSave?: boolean;
  onSave?: () => void;
  showEditPreview?: boolean;
  isPreviewMode?: boolean;
  onTogglePreview?: () => void;
  contextMenuItems?: ContextMenuItem[];
}

export interface ContextMenuItem {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  danger?: boolean;
}

export function TopToolbar({
  opacity,
  showGoToParent,
  onGoToParent,
  showSave,
  onSave,
  showEditPreview,
  isPreviewMode,
  onTogglePreview,
  contextMenuItems = [],
}: TopToolbarProps) {
  const theme = useTheme();
  const router = useRouter();
  const session = useSessionStore((s) => s.getCurrentSession());
  const tabCount = session?.tabs.length ?? 0;
  const minimizedStacks = useModalStore((s) => s.getMinimizedStacks());

  const [showContextMenu, setShowContextMenu] = useState(false);
  const [showTabList, setShowTabList] = useState(false);
  const [showMinimized, setShowMinimized] = useState(false);

  return (
    <>
      <Animated.View
        style={[
          styles.toolbar,
          {
            backgroundColor: theme.colors.toolbarBackground,
            borderBottomColor: theme.colors.border,
            opacity,
          },
        ]}
      >
        {/* Back */}
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.text} />
        </TouchableOpacity>

        {/* Go to parent */}
        {showGoToParent && onGoToParent && (
          <TouchableOpacity onPress={onGoToParent} style={styles.iconBtn}>
            <Ionicons name="arrow-up" size={22} color={theme.colors.text} />
          </TouchableOpacity>
        )}

        {/* Save */}
        {showSave && onSave && (
          <TouchableOpacity onPress={onSave} style={styles.iconBtn}>
            <Ionicons name="save-outline" size={22} color={theme.colors.primary} />
          </TouchableOpacity>
        )}

        {/* Edit / Preview toggle */}
        {showEditPreview && onTogglePreview && (
          <TouchableOpacity onPress={onTogglePreview} style={styles.iconBtn}>
            <Ionicons
              name={isPreviewMode ? 'create-outline' : 'eye-outline'}
              size={22}
              color={theme.colors.text}
            />
          </TouchableOpacity>
        )}

        <View style={styles.spacer} />

        {/* Minimized modal stacks indicator */}
        {minimizedStacks.length > 0 && (
          <TouchableOpacity onPress={() => setShowMinimized(true)} style={styles.iconBtn}>
            <Ionicons name="layers-outline" size={22} color={theme.colors.primary} />
            <Text style={[styles.badge, { backgroundColor: theme.colors.primary, color: theme.colors.primaryForeground }]}>
              {minimizedStacks.length}
            </Text>
          </TouchableOpacity>
        )}

        {/* Tab list */}
        {tabCount > 1 && (
          <TouchableOpacity onPress={() => setShowTabList(true)} style={styles.iconBtn}>
            <Ionicons name="copy-outline" size={22} color={theme.colors.text} />
            <Text style={[styles.badge, { backgroundColor: theme.colors.textSecondary, color: '#fff' }]}>
              {tabCount}
            </Text>
          </TouchableOpacity>
        )}

        {/* Options */}
        <TouchableOpacity onPress={() => setShowContextMenu(true)} style={styles.iconBtn}>
          <Ionicons name="ellipsis-vertical" size={22} color={theme.colors.text} />
        </TouchableOpacity>
      </Animated.View>

      {/* Context menu modal */}
      <Modal
        visible={showContextMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowContextMenu(false)}
      >
        <Pressable style={styles.menuOverlay} onPress={() => setShowContextMenu(false)}>
          <View
            style={[
              styles.contextMenu,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
          >
            {/* Nav icon row */}
            <View style={styles.contextMenuRow}>
              {[
                { icon: 'home-outline' as const, href: '/' },
                { icon: 'settings-outline' as const, href: '/settings' },
                { icon: 'albums-outline' as const, href: '/manage-session' },
                { icon: 'book-outline' as const, href: '/manage-notebook' },
              ].map(({ icon, href }) => (
                <TouchableOpacity
                  key={href}
                  style={styles.contextMenuIcon}
                  onPress={() => { setShowContextMenu(false); router.push(href as any); }}
                >
                  <Ionicons name={icon} size={22} color={theme.colors.text} />
                </TouchableOpacity>
              ))}
            </View>

            {contextMenuItems.length > 0 && (
              <View style={[styles.contextDivider, { backgroundColor: theme.colors.border }]} />
            )}

            {contextMenuItems.map((item, idx) => (
              <TouchableOpacity
                key={idx}
                style={styles.contextMenuEntry}
                onPress={() => { setShowContextMenu(false); item.onPress(); }}
              >
                <Ionicons
                  name={item.icon}
                  size={18}
                  color={item.danger ? theme.colors.danger : theme.colors.text}
                  style={{ marginRight: 10 }}
                />
                <Text style={{ color: item.danger ? theme.colors.danger : theme.colors.text }}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Tab list sheet */}
      <TabList visible={showTabList} onClose={() => setShowTabList(false)} />

      {/* Minimized modals popover */}
      <MinimizedModals visible={showMinimized} onClose={() => setShowMinimized(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    zIndex: 99,
  },
  iconBtn: {
    padding: 8,
    position: 'relative',
  },
  spacer: { flex: 1 },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    fontSize: 10,
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: 2,
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 96,
    paddingRight: 8,
  },
  contextMenu: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    minWidth: 200,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
  contextMenuRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 4,
  },
  contextMenuIcon: { padding: 8 },
  contextDivider: { height: 1, marginVertical: 4 },
  contextMenuEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
});
