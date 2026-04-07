import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../../src/hooks/useTheme';
import { AppHeader } from '../../../src/components/layout/AppHeader';
import { Animated } from 'react-native';

export default function NoteFilesPage() {
  const params = useLocalSearchParams<{ params: string[] }>();
  const theme = useTheme();
  // params format: [notePath, filePath] encoded in segments
  const allParams = Array.isArray(params.params) ? params.params : [];
  const notePath = allParams[0] ? decodeURIComponent(allParams[0]) : '';

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <AppHeader title="Note Files" opacity={new Animated.Value(1)} icon="attach-outline" />
      <View style={styles.center}>
        <Text style={{ color: theme.colors.textSecondary }}>
          Files attached to note: {notePath}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
});
