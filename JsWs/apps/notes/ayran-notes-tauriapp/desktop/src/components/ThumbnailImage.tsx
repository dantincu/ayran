import { useState, useEffect } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { acquireThumbnailSlot } from '../lib/thumbnailQueue';
import config from '../config.json';

const MAX_FILE_BYTES = config.thumbnailMaxFileSizeMB * 1024 * 1024;

interface Props {
  accountId: string;
  itemId: string;
  size?: number | null;
}

export default function ThumbnailImage({ accountId, itemId, size }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const tooLarge = size != null && size > MAX_FILE_BYTES;

  useEffect(() => {
    if (tooLarge) return;
    let cancelled = false;
    setSrc(null);
    setFailed(false);

    const byteSize = size ?? 0;
    let release: (() => void) | null = null;

    acquireThumbnailSlot(byteSize).then((rel) => {
      release = rel;
      if (cancelled) { rel(); return; }
      return invoke<string>('get_thumbnail', { accountId, itemId });
    }).then((path) => {
      if (path && !cancelled) setSrc(convertFileSrc(path));
    }).catch(() => {
      if (!cancelled) setFailed(true);
    }).finally(() => {
      release?.();
      release = null;
    });

    return () => {
      cancelled = true;
      release?.();
      release = null;
    };
  }, [accountId, itemId, size]);

  if (tooLarge || failed) {
    return (
      <div className="w-20 h-20 flex items-center justify-center text-3xl text-gray-300 dark:text-gray-600">🖼</div>
    );
  }
  if (!src) {
    return <div className="w-20 h-20 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />;
  }
  return (
    <img src={src} alt="" className="w-20 h-20 object-cover rounded" draggable={false} />
  );
}
