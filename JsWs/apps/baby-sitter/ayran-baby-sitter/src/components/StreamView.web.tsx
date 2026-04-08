import { useEffect, useRef, CSSProperties } from 'react';

interface Props {
  stream: MediaStream | null;
  style?: CSSProperties;
  mirror?: boolean;
}

export default function StreamView({ stream, style, mirror = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  if (!stream) return null;

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      style={{
        ...style,
        objectFit: 'cover',
        transform: mirror ? 'scaleX(-1)' : undefined,
      }}
    />
  );
}
