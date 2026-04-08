// NOTE: react-native-webrtc requires a native dev build. It does NOT work with Expo Go.
// Build with: npx expo run:android  or  npx expo run:ios

import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
  MediaStream,
} from 'react-native-webrtc';
import * as Signaling from './signaling';
import { IceCandidateData, SdpData } from '../types';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ---- HOST ----

export interface HostConnectionManager {
  setMicEnabled: (enabled: boolean) => void;
  setCameraEnabled: (enabled: boolean) => Promise<void>;
  cleanup: () => void;
}

export async function startHostMode(
  userId: string,
  deviceId: string,
  onStreamUpdate: (stream: MediaStream | null) => void,
  onError: (err: Error) => void,
): Promise<HostConnectionManager> {
  // eslint-disable-next-line prefer-const
  let localStream: MediaStream | null = null;
  const peerConnections = new Map<string, RTCPeerConnection>();
  const answeredClients = new Set<string>();
  const clientCandidateCursor = new Map<string, number>();

  try {
    localStream = (await mediaDevices.getUserMedia({ audio: true, video: false })) as MediaStream;
    onStreamUpdate(localStream);
  } catch (err) {
    onError(err as Error);
  }

  async function handleClient(clientDeviceId: string, offer: SdpData) {
    if (answeredClients.has(clientDeviceId)) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConnections.set(clientDeviceId, pc);

    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream as MediaStream));
    }

    (pc as any).onicecandidate = async (event: any) => {
      if (event.candidate) {
        const c: IceCandidateData = {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        };
        await Signaling.addHostCandidate(userId, clientDeviceId, c).catch(() => {});
      }
    };

    (pc as any).onconnectionstatechange = () => {
      const state = (pc as any).connectionState as string;
      if (state === 'failed' || state === 'closed') {
        peerConnections.delete(clientDeviceId);
        answeredClients.delete(clientDeviceId);
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer as any));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer as any);
      answeredClients.add(clientDeviceId);
      await Signaling.writeAnswer(userId, clientDeviceId, {
        type: answer.type,
        sdp: (answer as any).sdp ?? '',
      });
    } catch (err) {
      onError(err as Error);
      pc.close();
      peerConnections.delete(clientDeviceId);
    }
  }

  const unsubscribeRtc = Signaling.subscribeToAllRtcSessions(userId, async (sessions) => {
    for (const { id: clientDeviceId, session } of sessions) {
      if (!session.offer) continue;

      if (!answeredClients.has(clientDeviceId)) {
        await handleClient(clientDeviceId, session.offer);
      }

      const pc = peerConnections.get(clientDeviceId);
      if (!pc) continue;
      const cursor = clientCandidateCursor.get(clientDeviceId) ?? 0;
      const newCandidates = session.clientCandidates.slice(cursor);
      for (const c of newCandidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(c as any));
        } catch (_) {}
      }
      clientCandidateCursor.set(clientDeviceId, cursor + newCandidates.length);
    }
  });

  function setMicEnabled(enabled: boolean) {
    localStream?.getAudioTracks().forEach((t) => { t.enabled = enabled; });
  }

  async function setCameraEnabled(enabled: boolean) {
    const existingVideoTrack = localStream?.getVideoTracks()[0] ?? null;

    if (enabled && !existingVideoTrack) {
      const videoStream = (await mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'environment' },
      })) as MediaStream;
      const videoTrack = videoStream.getVideoTracks()[0];
      if (videoTrack && localStream) {
        localStream.addTrack(videoTrack);
        onStreamUpdate(localStream);
      }
    } else if (existingVideoTrack) {
      existingVideoTrack.enabled = enabled;
      onStreamUpdate(localStream);
    }
  }

  function cleanup() {
    unsubscribeRtc();
    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    onStreamUpdate(null);
  }

  return { setMicEnabled, setCameraEnabled, cleanup };
}

// ---- CLIENT ----

export interface ClientConnectionManager {
  cleanup: () => void;
}

export async function connectToHost(
  userId: string,
  clientDeviceId: string,
  onRemoteStream: (stream: MediaStream) => void,
  onError: (err: Error) => void,
): Promise<ClientConnectionManager> {
  const remoteStream = new MediaStream(undefined as any);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  let answerApplied = false;
  let hostCandidateCursor = 0;

  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });

  (pc as any).ontrack = (event: any) => {
    remoteStream.addTrack(event.track);
    onRemoteStream(remoteStream);
  };

  (pc as any).onicecandidate = async (event: any) => {
    if (event.candidate) {
      const c: IceCandidateData = {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      };
      await Signaling.addClientCandidate(userId, clientDeviceId, c).catch(() => {});
    }
  };

  await Signaling.createRtcSession(userId, clientDeviceId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer as any);
  await Signaling.writeOffer(userId, clientDeviceId, {
    type: offer.type,
    sdp: (offer as any).sdp ?? '',
  });

  const unsubscribeRtc = Signaling.subscribeToRtcSession(userId, clientDeviceId, async (session) => {
    if (!session) return;

    if (!answerApplied && session.answer) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(session.answer as any));
        answerApplied = true;
      } catch (err) {
        onError(err as Error);
      }
    }

    const newCandidates = session.hostCandidates.slice(hostCandidateCursor);
    for (const c of newCandidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c as any));
      } catch (_) {}
    }
    hostCandidateCursor += newCandidates.length;
  });

  function cleanup() {
    unsubscribeRtc();
    pc.close();
    remoteStream.getTracks().forEach((t) => t.stop());
    Signaling.deleteRtcSession(userId, clientDeviceId).catch(() => {});
  }

  return { cleanup };
}
