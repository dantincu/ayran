import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet } from 'react-native';
import { useSessionStore } from '../src/store/session.store';

export default function RootLayout() {
  const legalAccepted = useSessionStore((s) => s.legalAccepted);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }}>
        {!legalAccepted ? (
          <Stack.Screen name="onboarding/legal" options={{ animation: 'none' }} />
        ) : (
          <>
            <Stack.Screen name="(session)" options={{ animation: 'none' }} />
            <Stack.Screen name="onboarding/storage-setup" />
          </>
        )}
        <Stack.Screen name="+not-found" />
      </Stack>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
