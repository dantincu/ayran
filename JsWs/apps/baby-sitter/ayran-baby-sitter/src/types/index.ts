export interface HostSession {
  active: boolean;
  deviceId: string;
  micEnabled: boolean;
  cameraEnabled: boolean;
  updatedAt: unknown; // Firestore Timestamp
}

export interface RtcSession {
  offer: SdpData | null;
  answer: SdpData | null;
  hostCandidates: IceCandidateData[];
  clientCandidates: IceCandidateData[];
  createdAt: unknown;
}

export interface SdpData {
  type: string;
  sdp: string;
}

export interface IceCandidateData {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}
