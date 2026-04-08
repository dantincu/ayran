import {
  doc,
  setDoc,
  onSnapshot,
  updateDoc,
  arrayUnion,
  serverTimestamp,
  collection,
  deleteDoc,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { HostSession, RtcSession, SdpData, IceCandidateData } from '../types';

// ---- Firestore path helpers ----

function hostSessionRef(userId: string) {
  return doc(db, 'users', userId, 'session', 'host');
}

function rtcSessionRef(userId: string, clientDeviceId: string) {
  return doc(db, 'users', userId, 'rtcSessions', clientDeviceId);
}

// ---- Host session ----

export async function createHostSession(userId: string, deviceId: string): Promise<void> {
  await setDoc(hostSessionRef(userId), {
    active: true,
    deviceId,
    micEnabled: true,
    cameraEnabled: false,
    updatedAt: serverTimestamp(),
  });
}

export async function updateHostSession(
  userId: string,
  update: Partial<Pick<HostSession, 'active' | 'micEnabled' | 'cameraEnabled'>>,
): Promise<void> {
  await updateDoc(hostSessionRef(userId), { ...update, updatedAt: serverTimestamp() });
}

export async function deactivateHostSession(userId: string): Promise<void> {
  await setDoc(hostSessionRef(userId), { active: false, updatedAt: serverTimestamp() }, { merge: true });
}

export function subscribeToHostSession(
  userId: string,
  callback: (session: HostSession | null) => void,
): () => void {
  return onSnapshot(hostSessionRef(userId), (snap) => {
    callback(snap.exists() ? (snap.data() as HostSession) : null);
  });
}

// ---- RTC sessions (one per client device) ----

export async function createRtcSession(userId: string, clientDeviceId: string): Promise<void> {
  await setDoc(rtcSessionRef(userId, clientDeviceId), {
    offer: null,
    answer: null,
    hostCandidates: [],
    clientCandidates: [],
    createdAt: serverTimestamp(),
  });
}

export async function writeOffer(userId: string, clientDeviceId: string, offer: SdpData): Promise<void> {
  await updateDoc(rtcSessionRef(userId, clientDeviceId), { offer });
}

export async function writeAnswer(userId: string, clientDeviceId: string, answer: SdpData): Promise<void> {
  await updateDoc(rtcSessionRef(userId, clientDeviceId), { answer });
}

export async function addHostCandidate(
  userId: string,
  clientDeviceId: string,
  candidate: IceCandidateData,
): Promise<void> {
  await updateDoc(rtcSessionRef(userId, clientDeviceId), {
    hostCandidates: arrayUnion(candidate),
  });
}

export async function addClientCandidate(
  userId: string,
  clientDeviceId: string,
  candidate: IceCandidateData,
): Promise<void> {
  await updateDoc(rtcSessionRef(userId, clientDeviceId), {
    clientCandidates: arrayUnion(candidate),
  });
}

export function subscribeToRtcSession(
  userId: string,
  clientDeviceId: string,
  callback: (session: RtcSession | null) => void,
): () => void {
  return onSnapshot(rtcSessionRef(userId, clientDeviceId), (snap) => {
    callback(snap.exists() ? (snap.data() as RtcSession) : null);
  });
}

export async function deleteRtcSession(userId: string, clientDeviceId: string): Promise<void> {
  await deleteDoc(rtcSessionRef(userId, clientDeviceId));
}

// Host subscribes to all client RTC sessions to respond to each one
export function subscribeToAllRtcSessions(
  userId: string,
  callback: (sessions: Array<{ id: string; session: RtcSession }>) => void,
): () => void {
  const collRef = collection(db, 'users', userId, 'rtcSessions');
  return onSnapshot(collRef, (snap) => {
    const sessions = snap.docs.map((d) => ({
      id: d.id,
      session: d.data() as RtcSession,
    }));
    callback(sessions);
  });
}
