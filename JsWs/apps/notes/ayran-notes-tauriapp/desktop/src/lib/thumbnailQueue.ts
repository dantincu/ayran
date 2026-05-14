import config from '../config.json';

const MAX_CONCURRENT = config.thumbnailMaxConcurrent;
const MAX_BYTES = config.thumbnailMaxTotalMB * 1024 * 1024;

interface Waiter {
  size: number;
  resolve: () => void;
}

let activeConcurrent = 0;
let activeTotalBytes = 0;
const waiters: Waiter[] = [];

function tryDrain() {
  while (waiters.length > 0) {
    const next = waiters[0];
    if (activeConcurrent >= MAX_CONCURRENT) break;
    // Allow a single oversized file through when the queue is idle to avoid deadlock
    if (activeConcurrent > 0 && activeTotalBytes + next.size > MAX_BYTES) break;
    waiters.shift();
    activeConcurrent++;
    activeTotalBytes += next.size;
    next.resolve();
  }
}

export async function acquireThumbnailSlot(size: number): Promise<() => void> {
  const canStart =
    activeConcurrent < MAX_CONCURRENT &&
    (activeConcurrent === 0 || activeTotalBytes + size <= MAX_BYTES);

  if (!canStart) {
    await new Promise<void>((resolve) => { waiters.push({ size, resolve }); });
  } else {
    activeConcurrent++;
    activeTotalBytes += size;
  }

  return () => {
    activeConcurrent--;
    activeTotalBytes = Math.max(0, activeTotalBytes - size);
    tryDrain();
  };
}
