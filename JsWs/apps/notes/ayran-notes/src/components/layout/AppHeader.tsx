import React from 'react';
import {
  Animated,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../hooks/useTheme';
import { useSessionStore } from '../../store/session.store';
import { useTabStore } from '../../store/tab.store';

interface AppHeaderProps {
  title: string;
  opacity: Animated.Value;
  icon?: keyof typeof Ionicons.glyphMap;
}

export function AppHeader({ title, opacity, icon }: AppHeaderProps) {
  const theme = useTheme();
  const router = useRouter();
  const session = useSessionStore((s) => s.getCurrentSession());
  const tabCount = session?.tabs.length ?? 0;
  const removeTab = useTabStore((s) => s.removeTab);
  const currentTabId = session?.currentTabId;

  const canClose = tabCount > 1;

  const handleClose = () => {
    if (!currentTabId) return;
    removeTab(currentTabId);
    router.back();
  };

  return (
    <Animated.View
      style={[
        styles.header,
        { backgroundColor: theme.colors.headerBackground, opacity },
        Platform.OS !== 'web' && styles.headerShadow,
      ]}
    >
      <View style={styles.left}>
        {icon ? (
          <Ionicons name={icon} size={20} color={theme.colors.primaryForeground} style={styles.icon} />
        ) : null}
        <Text style={[styles.title, { color: theme.colors.primaryForeground }]} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <View style={styles.right}>
        {canClose && (
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
            <Ionicons name="close" size={22} color={theme.colors.primaryForeground} />
          </TouchableOpacity>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 56,
    paddingHorizontal: 16,
    zIndex: 100,
  },
  headerShadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: 8,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    flex: 1,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  closeBtn: {
    padding: 4,
  },
});
