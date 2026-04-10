// Login screen — first screen the user sees.
// SETUP REQUIRED: set the three OAuth client IDs below.
//   - Create OAuth credentials in Google Cloud Console (or Firebase Console).
//   - Add your Expo redirect URI to the "Authorized redirect URIs" in Google Cloud.
//     It looks like: https://auth.expo.io/@your-username/ayran-baby-sitter

import React, { useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { GoogleAuthProvider, signInWithCredential } from 'firebase/auth';
import { auth } from '../src/firebase/config';
import { useAuth } from '../src/context/AuthContext';

WebBrowser.maybeCompleteAuthSession();

const EXPO_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID;
const IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;

export default function LoginScreen() {
  const { user, loading } = useAuth();

  const [request, response, promptAsync] = Google.useAuthRequest({
    clientId: EXPO_CLIENT_ID,
    iosClientId: IOS_CLIENT_ID,
    androidClientId: ANDROID_CLIENT_ID,
  });

  useEffect(() => {
    if (user) {
      router.replace('/home');
    }
  }, [user]);

  useEffect(() => {
    if (response?.type === 'success') {
      const idToken = response.params.id_token;
      if (idToken) {
        const credential = GoogleAuthProvider.credential(idToken);
        signInWithCredential(auth, credential).catch((err) =>
          console.error('Firebase sign-in failed', err),
        );
      }
    }
  }, [response]);

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#4285F4" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>👶</Text>
      <Text style={styles.title}>Ayran Baby Sitter</Text>
      <Text style={styles.subtitle}>Monitor your little one from anywhere</Text>

      <TouchableOpacity
        style={[styles.googleButton, !request && styles.disabled]}
        onPress={() => promptAsync()}
        disabled={!request}
        activeOpacity={0.85}
      >
        <Text style={styles.googleButtonText}>Sign in with Google</Text>
      </TouchableOpacity>

      {response?.type === 'error' && (
        <Text style={styles.errorText}>Sign-in failed. Please try again.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 32,
  },
  emoji: {
    fontSize: 64,
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#333',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 56,
    lineHeight: 22,
  },
  googleButton: {
    backgroundColor: '#4285F4',
    paddingHorizontal: 36,
    paddingVertical: 14,
    borderRadius: 10,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  disabled: {
    opacity: 0.5,
  },
  googleButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  errorText: {
    marginTop: 16,
    color: '#E53935',
    fontSize: 14,
  },
});
