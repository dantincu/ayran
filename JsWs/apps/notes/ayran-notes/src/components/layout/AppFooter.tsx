import React from 'react';
import { Animated, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../hooks/useTheme';

interface AppFooterProps {
  opacity: Animated.Value;
  hoveredLink?: string | null;
  onOpenLinkInCurrentTab?: () => void;
  onOpenLinkInNewTab?: () => void;
  onOpenLinkInNewTabBackground?: () => void;
}

export function AppFooter({
  opacity,
  hoveredLink,
  onOpenLinkInCurrentTab,
  onOpenLinkInNewTab,
  onOpenLinkInNewTabBackground,
}: AppFooterProps) {
  const theme = useTheme();

  if (!hoveredLink) {
    return (
      <Animated.View
        style={[styles.footer, { backgroundColor: theme.colors.footerBackground, opacity }]}
      />
    );
  }

  return (
    <Animated.View
      style={[styles.footer, { backgroundColor: theme.colors.footerBackground, opacity }]}
    >
      <Text
        style={[styles.linkText, { color: theme.colors.primary }]}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {hoveredLink}
      </Text>
      <View style={styles.linkActions}>
        <TouchableOpacity
          onPress={onOpenLinkInCurrentTab}
          style={styles.actionBtn}
          accessibilityLabel="Open in current tab"
        >
          <Ionicons name="arrow-redo-outline" size={18} color={theme.colors.primaryForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onOpenLinkInNewTab}
          style={styles.actionBtn}
          accessibilityLabel="Open in new tab"
        >
          <Ionicons name="add-outline" size={18} color={theme.colors.primaryForeground} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onOpenLinkInNewTabBackground}
          style={styles.actionBtn}
          accessibilityLabel="Open in background tab"
        >
          <Ionicons name="copy-outline" size={18} color={theme.colors.primaryForeground} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    paddingHorizontal: 12,
    gap: 8,
  },
  linkText: {
    flex: 1,
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  linkActions: {
    flexDirection: 'row',
    gap: 4,
  },
  actionBtn: {
    padding: 4,
  },
});
