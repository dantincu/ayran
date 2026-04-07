import React, { useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Modal, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '../../hooks/useTheme';
import { useTabStore } from '../../store/tab.store';

interface LongPressLinkProps {
  children: React.ReactNode;
  href: string;
  /** Whether to navigate immediately on press (without long press) */
  navigateOnPress?: boolean;
}

export function LongPressLink({ children, href, navigateOnPress = true }: LongPressLinkProps) {
  const theme = useTheme();
  const router = useRouter();
  const addTab = useTabStore((s) => s.addTab);
  const [showMenu, setShowMenu] = useState(false);

  const navigateInCurrentTab = () => {
    router.push(href as any);
    setShowMenu(false);
  };

  const openInNewTab = () => {
    addTab(href);
    setShowMenu(false);
  };

  const openInNewTabBackground = () => {
    addTab(href);
    // Don't navigate
    setShowMenu(false);
  };

  return (
    <>
      <Pressable
        onPress={navigateOnPress ? navigateInCurrentTab : undefined}
        onLongPress={() => setShowMenu(true)}
        delayLongPress={400}
      >
        {children}
      </Pressable>

      <Modal visible={showMenu} transparent animationType="fade" onRequestClose={() => setShowMenu(false)}>
        <Pressable style={styles.overlay} onPress={() => setShowMenu(false)}>
          <View style={[styles.menu, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
            <Text style={[styles.menuTitle, { color: theme.colors.textSecondary }]} numberOfLines={2}>
              {href}
            </Text>
            <TouchableOpacity style={styles.menuItem} onPress={navigateInCurrentTab}>
              <Ionicons name="arrow-redo-outline" size={18} color={theme.colors.text} />
              <Text style={[styles.menuText, { color: theme.colors.text }]}>Open in current tab</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={openInNewTab}>
              <Ionicons name="add-circle-outline" size={18} color={theme.colors.text} />
              <Text style={[styles.menuText, { color: theme.colors.text }]}>Open in new tab</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={openInNewTabBackground}>
              <Ionicons name="copy-outline" size={18} color={theme.colors.text} />
              <Text style={[styles.menuText, { color: theme.colors.text }]}>Open in background tab</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
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
    fontSize: 12,
    padding: 8,
    borderBottomWidth: 1,
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
});
