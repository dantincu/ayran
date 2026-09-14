import { useEffect, useRef } from 'react';

const INITIAL_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 100; // 10/sec

/**
 * Fires `onFire` once immediately on press, then (after an initial delay,
 * so a quick tap doesn't double-fire) repeatedly at 10/sec while held.
 */
export function useHoldRepeat(onFire: () => void) {
  const onFireRef = useRef(onFire);
  useEffect(() => {
    onFireRef.current = onFire;
  });
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const stop = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const start = () => {
    stop();
    onFireRef.current();
    timeoutRef.current = window.setTimeout(() => {
      intervalRef.current = window.setInterval(() => onFireRef.current(), REPEAT_INTERVAL_MS);
    }, INITIAL_DELAY_MS);
  };

  useEffect(() => stop, []);

  return { start, stop };
}
