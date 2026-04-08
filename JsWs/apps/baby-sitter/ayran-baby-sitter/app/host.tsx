import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  StatusBar,
} from 'react-native';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../src/context/AuthContext';
import StreamView from '../src/components/StreamView';
import { getDeviceId } from '../src/services/device';
import { createHostSession, deactivateHostSession, updateHostSession } from '../src/services/signaling';
import { startHostMode, HostConnectionManager } from '../src/services/webrtc';

export default function HostScreen() {
  const { user } = useAuth();
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [localStream, setLocalStream] = useState<any | null>(null);
  const [streamKey, setStreamKey] = useState(0); // Forces StreamView to remount on stream change
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const managerRef = useRef<HostConnectionManager | null>(null);
  const deviceIdRef = useRef<string>('');

  useEffect(() => {
    getDeviceId().then((id) => {
      deviceIdRef.current = id;
    });
    return () => {
      managerRef.current?.cleanup();
      if (user) {
        deactivateHostSession(user.uid).catch(() => {});
      }
    };
  }, []);

  async function startStreaming() {
    if (!user) return;
    try {
      await createHostSession(user.uid, deviceIdRef.current);
      const manager = await startHostMode(
        user.uid,
        deviceIdRef.current,
        (stream) => {
          setLocalStream(stream);
          setStreamKey((k) => k + 1);
        },
        (err) => Alert.alert('Stream Error', err.message),
      );
      managerRef.current = manager;
      setIsStreaming(true);
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Could not start streaming.');
    }
  }

  async function stopStreaming() {
    if (!user) return;
    managerRef.current?.cleanup();
    managerRef.current = null;
    await deactivateHostSession(user.uid).catch(() => {});
    setIsStreaming(false);
    setLocalStream(null);
    setCameraEnabled(false);
  }

  async function toggleMic() {
    const next = !micEnabled;
    setMicEnabled(next);
    managerRef.current?.setMicEnabled(next);
    if (user && isStreaming) {
      await updateHostSession(user.uid, { micEnabled: next }).catch(() => {});
    }
  }

  async function toggleCamera() {
    if (!cameraEnabled && !cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) return;
    }
    const next = !cameraEnabled;
    setCameraEnabled(next);
    await managerRef.current?.setCameraEnabled(next);
    if (user && isStreaming) {
      await updateHostSession(user.uid, { cameraEnabled: next }).catch(() => {});
    }
  }

  async function handleBack() {
    await stopStreaming();
    router.back();
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#111" />

      {/* Camera preview — shows local stream via StreamView when streaming,
          or expo-camera CameraView as a preview before streaming starts */}
      <View style={styles.previewArea}>
        {isStreaming && localStream && cameraEnabled ? (
          <StreamView key={streamKey} stream={localStream} style={styles.fill} />
        ) : cameraEnabled && !isStreaming ? (
          <CameraView style={styles.fill} facing="back" />
        ) : (
          <View style={styles.noCamera}>
            <Ionicons name="camera-off-outline" size={64} color="#444" />
            <Text style={styles.noCameraText}>Camera is off</Text>
          </View>
        )}

        {/* Streaming indicator badge */}
        {isStreaming && (
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
        )}
      </View>

      {/* Status bar */}
      <View style={[styles.statusBar, isStreaming ? styles.statusActive : styles.statusInactive]}>
        <Text style={styles.statusText}>
          {isStreaming ? 'Broadcasting — clients can now connect' : 'Not broadcasting'}
        </Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.controlBtn, !micEnabled && styles.controlBtnOff]}
          onPress={toggleMic}
        >
          <Ionicons name={micEnabled ? 'mic' : 'mic-off'} size={26} color="#fff" />
          <Text style={styles.controlLabel}>{micEnabled ? 'Mic On' : 'Mic Off'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.mainBtn, isStreaming ? styles.stopBtn : styles.startBtn]}
          onPress={isStreaming ? stopStreaming : startStreaming}
        >
          <Ionicons
            name={isStreaming ? 'stop-circle' : 'radio-button-on'}
            size={40}
            color="#fff"
          />
          <Text style={styles.mainBtnText}>{isStreaming ? 'Stop' : 'Start'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.controlBtn, !cameraEnabled && styles.controlBtnOff]}
          onPress={toggleCamera}
        >
          <Ionicons name={cameraEnabled ? 'videocam' : 'videocam-off'} size={26} color="#fff" />
          <Text style={styles.controlLabel}>{cameraEnabled ? 'Cam On' : 'Cam Off'}</Text>
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
    backgroundColor: '#111',
  },
  previewArea: {
    flex: 1,
    position: 'relative',
  },
  fill: {
    flex: 1,
  },
  noCamera: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1e1e1e',
    gap: 12,
  },
  noCameraText: {
    color: '#444',
    fontSize: 16,
  },
  liveBadge: {
    position: 'absolute',
    top: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(229,57,53,0.88)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 6,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#fff',
  },
  liveText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
    letterSpacing: 1,
  },
  statusBar: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  statusActive: {
    backgroundColor: '#2e7d32',
  },
  statusInactive: {
    backgroundColor: '#333',
  },
  statusText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 20,
    backgroundColor: '#111',
  },
  controlBtn: {
    alignItems: 'center',
    backgroundColor: '#1E88E5',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    minWidth: 82,
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
  mainBtn: {
    alignItems: 'center',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 18,
    minWidth: 82,
  },
  startBtn: {
    backgroundColor: '#43A047',
  },
  stopBtn: {
    backgroundColor: '#E53935',
  },
  mainBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    marginTop: 4,
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
