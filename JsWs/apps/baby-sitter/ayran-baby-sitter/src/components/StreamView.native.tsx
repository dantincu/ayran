import { StyleProp, ViewStyle } from 'react-native';
import { RTCView } from 'react-native-webrtc';

interface Props {
  stream: any; // react-native-webrtc MediaStream
  style?: StyleProp<ViewStyle>;
  mirror?: boolean;
}

export default function StreamView({ stream, style, mirror = false }: Props) {
  if (!stream) return null;
  return (
    <RTCView
      streamURL={stream.toURL()}
      style={style as any}
      objectFit="cover"
      mirror={mirror}
    />
  );
}
