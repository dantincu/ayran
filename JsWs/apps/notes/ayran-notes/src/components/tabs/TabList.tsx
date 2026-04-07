import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Modal,
  Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '../../hooks/useTheme';
import { useSessionStore } from '../../store/session.store';
import { useTabStore } from '../../store/tab.store';
import { AppTab } from '../../types/session.types';

interface TabListProps {
  visible: boolean;
  onClose: () => void;
}

export function TabList({ visible, onClose }: TabListProps) {
  const theme = useTheme();
  const router = useRouter();
  const session = useSessionStore((s) => s.getCurrentSession());
  const setCurrentTab = useTabStore((s) => s.setCurrentTab);
  const removeTab = useTabStore((s) => s.removeTab);
  const addTab = useTabStore((s) => s.addTab);
  const getPreviousTabId = useTabStore((s) => s.getPreviousTabId);

  if (!session) return null;

  const currentTabId = session.currentTabId;
  const previousTabId = getPreviousTabId();

  const handleSelectTab = (tab: AppTab) => {
    setCurrentTab(tab.id);
    router.push(tab.uri as any);
    onClose();
  };

  const handleCloseTab = (tabId: string) => {
    if (session.tabs.length <= 1) return;
    removeTab(tabId);
  };

  const handleNewTab = () => {
    addTab('/');
    router.push('/');
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border },
          ]}
        >
          <View style={styles.sheetHeader}>
            <Text style={[styles.heading, { color: theme.colors.text }]}>
              Tabs ({session.tabs.length})
            </Text>
            <View style={styles.headerActions}>
              <TouchableOpacity onPress={handleNewTab} style={styles.iconBtn}>
                <Ionicons name="add" size={22} color={theme.colors.primary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
                <Ionicons name="close" size={22} color={theme.colors.text} />
              </TouchableOpacity>
            </View>
          </View>

          <FlatList
            data={session.tabs}
            keyExtractor={(t) => t.id}
            renderItem={({ item: tab }) => {
              const isCurrent = tab.id === currentTabId;
              const isPrevious = tab.id === previousTabId;
              const hasMinimized = tab.minimizedModalStacks.length > 0;

              return (
                <TouchableOpacity
                  onPress={() => handleSelectTab(tab)}
                  style={[
                    styles.tabRow,
                    { borderBottomColor: theme.colors.border },
                    isCurrent && { backgroundColor: theme.colors.surfaceVariant },
                  ]}
                >
                  {hasMinimized && (
                    <Ionicons name="layers-outline" size={14} color={theme.colors.primary} style={{ marginRight: 4 }} />
                  )}
                  <View style={styles.tabInfo}>
                    <Text
                      style={[
                        styles.tabLabel,
                        { color: isCurrent ? theme.colors.primary : theme.colors.text },
                        isCurrent && { fontWeight: '700' },
                        isPrevious && { fontStyle: 'italic' },
                      ]}
                      numberOfLines={1}
                    >
                      {tab.label ?? tab.uri}
                    </Text>
                    <Text style={[styles.tabUri, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                      {tab.uri}
                    </Text>
                  </View>
                  {isCurrent && (
                    <View style={[styles.currentDot, { backgroundColor: theme.colors.primary }]} />
                  )}
                  {session.tabs.length > 1 && (
                    <TouchableOpacity
                      onPress={() => handleCloseTab(tab.id)}
                      style={styles.closeTabBtn}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                  )}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    borderTopWidth: 1,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '70%',
    minHeight: 200,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  heading: {
    fontSize: 16,
    fontWeight: '600',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 4,
  },
  iconBtn: {
    padding: 4,
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  tabInfo: {
    flex: 1,
  },
  tabLabel: {
    fontSize: 14,
  },
  tabUri: {
    fontSize: 11,
    marginTop: 2,
  },
  currentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  closeTabBtn: {
    padding: 4,
  },
});
