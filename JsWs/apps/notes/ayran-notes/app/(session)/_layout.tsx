import { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSessionStore } from '../../src/store/session.store';
import { useScrollFade } from '../../src/hooks/useScrollFade';
import { useTheme } from '../../src/hooks/useTheme';
import { ModalStack } from '../../src/components/modals/ModalStack';

export default function SessionLayout() {
  const router = useRouter();
  const session = useSessionStore((s) => s.getCurrentSession());
  const theme = useTheme();

  useEffect(() => {
    if (!session) {
      router.replace('/onboarding/storage-setup');
    }
  }, [session]);

  if (!session) return null;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['top', 'left', 'right']}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="notes/[...notePath]" />
        <Stack.Screen name="note/[...notePath]" />
        <Stack.Screen name="files/[...filePath]" />
        <Stack.Screen name="note-files/[...params]" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="manage-session" />
        <Stack.Screen name="manage-notebook" />
      </Stack>
      <ModalStack />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
