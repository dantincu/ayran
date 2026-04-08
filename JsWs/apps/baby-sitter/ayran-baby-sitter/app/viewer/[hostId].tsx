import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import StreamView from '../../src/components/StreamView';
import { useAuth } from '../../src/context/AuthContext';
import { getDeviceId } from '../../src/services/device';
import { connectToHost, ClientConnectionManager } from '../../src/services/webrtc';

type ConnectionStatus = 'connecting' | 'connected' | 'error';

export default function ViewerScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const { user } = useAuth();
  const [remoteStream, setRemoteStream] = useState<any | null>(null);
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoHidden, setVideoHidden] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [errorMessage, setErrorMessage] = useState('');
  const managerRef = useRef<ClientConnectionManager | null>(null);

  useEffect(() => {
    if (!user || !hostId) return;

    let mounted = true;

    async function init() {
      const deviceId = await getDeviceId();
      if (!mounted) return;

      connectToHost(
        hostId as string,
        deviceId,
        (stream) => {
          if (!mounted) return;
          setRemoteStream(stream);
          setStatus('connected');
        },
        (err) => {
          if (!mounted) return;
          setErrorMessage(err.message);
          setStatus('error');
        },
      ).then((manager) => {
        if (!mounted) {
          manager.cleanup();
          return;
        }
        managerRef.current = manager;
      });
    }

    init();

    return () => {
      mounted = false;
      managerRef.current?.cleanup();
    };
  }, [user, hostId]);

  function toggleAudio() {
    const next = !audioMuted;
    setAudioMuted(next);
    remoteStream?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
  }

  function handleBack() {
    managerRef.current?.cleanup();
    router.back();
  }

  const showVideo = remoteStream && !videoHidden && status === 'connected';

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />

      {/* Video area */}
      <View style={styles.videoArea}>
        {showVideo ? (
          <StreamView stream={remoteStream} style={styles.fill} />
        ) : (
          <View style={styles.placeholder}>
            {status === 'connecting' && (
              <>
                <ActivityIndicator size="large" color="#fff" />
                <Text style={styles.statusText}>Connecting to host…</Text>
              </>
            )}
            {status === 'error' && (
              <>
                <Ionicons name="warning-outline" size={56} color="#E53935" />
                <Text style={styles.errorText}>{errorMessage || 'Connection failed'}</Text>
                <TouchableOpacity style={styles.retryBtn} onPress={handleBack}>
                  <Text style={styles.retryText}>Go Back</Text>
                </TouchableOpacity>
              </>
            )}
            {status === 'connected' && videoHidden && (
              <>
                <Ionicons name="videocam-off-outline" size={56} color="#555" />
                <Text style={styles.statusText}>Video hidden</Text>
              </>
            )}
            {status === 'connected' && !videoHidden && !remoteStream && (
              <>
                <ActivityIndicator size="large" color="#fff" />
                <Text style={styles.statusText}>Waiting for stream…</Text>
              </>
            )}
          </View>
        )}

        {/* Connection badge */}
        {status === 'connected' && (
          <View style={styles.connectedBadge}>
            <View style={styles.connectedDot} />
            <Text style={styles.connectedText}>Live</Text>
          </View>
        )}
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.controlBtn, audioMuted && styles.controlBtnOff]}
          onPress={toggleAudio}
        >
          <Ionicons
            name={audioMuted ? 'volume-mute' : 'volume-high'}
            size={26}
            color="#fff"
          />
          <Text style={styles.controlLabel}>{audioMuted ? 'Unmute' : 'Mute'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.controlBtn, videoHidden && styles.controlBtnOff]}
          onPress={() => setVideoHidden((v) => !v)}
        >
          <Ionicons
            name={videoHidden ? 'videocam-off' : 'videocam'}
            size={26}
            color="#fff"
          />
          <Text style={styles.controlLabel}>{videoHidden ? 'Show Video' : 'Hide Video'}</Text>
        </TouchableOpacity>
      </View>

      {/* Back button */}
      <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
        <Ionicons name="arrow-back" size={22} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  videoArea: {
    flex: 1,
    position: 'relative',
  },
  fill: {
    flex: 1,
  },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111',
    gap: 16,
  },
  statusText: {
    color: '#aaa',
    fontSize: 15,
    marginTop: 8,
  },
  errorText: {
    color: '#E53935',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#333',
    borderRadius: 8,
  },
  retryText: {
    color: '#fff',
    fontWeight: '600',
  },
  connectedBadge: {
    position: 'absolute',
    top: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(67,160,71,0.85)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 6,
  },
  connectedDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#fff',
  },
  connectedText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
    letterSpacing: 0.8,
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 32,
    paddingVertical: 22,
    backgroundColor: '#111',
  },
  controlBtn: {
    alignItems: 'center',
    backgroundColor: '#1E88E5',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 20,
    minWidth: 110,
  },
  controlBtnOff: {
    backgroundColor: '#444',
  },
  controlLabel: {
    color: '#fff',
    fontSize: 11,
    marginTop: 5,
    fontWeight: '500',
  },
  backBtn: {
    position: 'absolute',
    top: 52,
    left: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 20,
    padding: 8,
  },
});
