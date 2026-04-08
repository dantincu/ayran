import React, { useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../src/context/AuthContext';
import { signOut } from '../src/services/auth';

export default function HomeScreen() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/');
    }
  }, [user, loading]);

  if (!user) return null;

  const firstName = user.displayName?.split(' ')[0] ?? 'Parent';

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.greeting}>Hello, {firstName} 👋</Text>
          <TouchableOpacity onPress={signOut} style={styles.signOutBtn}>
            <Ionicons name="log-out-outline" size={22} color="#E53935" />
          </TouchableOpacity>
        </View>

        <Text style={styles.title}>Ayran Baby Sitter</Text>
        <Text style={styles.subtitle}>Choose how you want to use this device</Text>

        <TouchableOpacity
          style={[styles.modeCard, styles.hostCard]}
          onPress={() => router.push('/host')}
          activeOpacity={0.88}
        >
          <Ionicons name="home" size={52} color="#fff" />
          <Text style={styles.modeTitle}>Host Mode</Text>
          <Text style={styles.modeDesc}>
            Place this device near your baby to record sounds and video
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.modeCard, styles.clientCard]}
          onPress={() => router.push('/client')}
          activeOpacity={0.88}
        >
          <Ionicons name="headset" size={52} color="#fff" />
          <Text style={styles.modeTitle}>Client Mode</Text>
          <Text style={styles.modeDesc}>
            Listen to and watch your baby from another room or location
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  container: {
    flex: 1,
    padding: 24,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 32,
  },
  greeting: {
    fontSize: 17,
    color: '#555',
    fontWeight: '500',
  },
  signOutBtn: {
    padding: 6,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#222',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 15,
    color: '#777',
    marginBottom: 32,
  },
  modeCard: {
    borderRadius: 18,
    padding: 28,
    marginBottom: 16,
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
  },
  hostCard: {
    backgroundColor: '#43A047',
  },
  clientCard: {
    backgroundColor: '#1E88E5',
  },
  modeTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#fff',
    marginTop: 14,
    marginBottom: 8,
  },
  modeDesc: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.88)',
    textAlign: 'center',
    lineHeight: 20,
  },
});
