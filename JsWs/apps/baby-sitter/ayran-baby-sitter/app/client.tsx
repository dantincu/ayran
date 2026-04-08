import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../src/context/AuthContext';
import { subscribeToHostSession } from '../src/services/signaling';
import { HostSession } from '../src/types';

export default function ClientScreen() {
  const { user } = useAuth();
  const [hostSession, setHostSession] = useState<HostSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    // Both host and client use the same Google account.
    // The client looks for an active host session under their shared userId.
    const unsubscribe = subscribeToHostSession(user.uid, (session) => {
      setHostSession(session?.active ? session : null);
      setLoading(false);
    });
    return unsubscribe;
  }, [user]);

  function connectToHost() {
    if (!user) return;
    // Pass the userId as the hostId — the viewer uses it to find the signaling docs
    router.push(`/viewer/${user.uid}`);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#333" />
        </TouchableOpacity>

        <Text style={styles.title}>Available Hosts</Text>
        <Text style={styles.subtitle}>Devices streaming on your account</Text>

        {loading ? (
          <ActivityIndicator size="large" color="#1E88E5" style={{ marginTop: 48 }} />
        ) : hostSession ? (
          <TouchableOpacity style={styles.hostCard} onPress={connectToHost} activeOpacity={0.8}>
            <View style={styles.hostCardLeft}>
              <View style={styles.activeDot} />
              <View>
                <Text style={styles.hostName}>Baby Monitor</Text>
                <Text style={styles.hostDetail}>
                  {hostSession.micEnabled ? '🎙 Mic On' : '🔇 Mic Off'}
                  {'   '}
                  {hostSession.cameraEnabled ? '📷 Camera On' : '📵 Camera Off'}
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#bbb" />
          </TouchableOpacity>
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="radio-outline" size={72} color="#ccc" />
            <Text style={styles.emptyTitle}>No Active Host</Text>
            <Text style={styles.emptyDesc}>
              Start Host Mode on the device near your baby, then come back here.
            </Text>
          </View>
        )}
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
    paddingTop: 16,
  },
  backBtn: {
    alignSelf: 'flex-start',
    padding: 6,
    marginBottom: 20,
    marginTop: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#222',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    marginBottom: 28,
  },
  hostCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 5,
  },
  hostCardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    flex: 1,
  },
  activeDot: {
    width: 11,
    height: 11,
    borderRadius: 5.5,
    backgroundColor: '#43A047',
  },
  hostName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#222',
  },
  hostDetail: {
    fontSize: 12,
    color: '#888',
    marginTop: 3,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
    paddingBottom: 64,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#555',
  },
  emptyDesc: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    paddingHorizontal: 32,
    lineHeight: 20,
  },
});
