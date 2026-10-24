import { useEffect, useState } from 'react';

export type WakeLockStatus = 'pending' | 'held' | 'unavailable';

// Keeps the screen on while the calling component is mounted (DEC-116). The
// browser drops the lock whenever the page is hidden, so it's taken again on
// becoming visible. A missing API or a refused request both read as
// `unavailable`: the page works the same, the screen may just sleep.
export function useWakeLock(): WakeLockStatus {
  const wakeLock = (navigator as Partial<Navigator>).wakeLock;
  const [status, setStatus] = useState<WakeLockStatus>(
    wakeLock === undefined ? 'unavailable' : 'pending',
  );

  useEffect(() => {
    if (wakeLock === undefined) return;
    let sentinel: WakeLockSentinel | null = null;
    let isActive = true;

    async function acquire(api: WakeLock): Promise<void> {
      if (document.visibilityState !== 'visible') return;
      if (sentinel !== null && !sentinel.released) return;
      try {
        const next = await api.request('screen');
        if (!isActive) {
          void next.release();
          return;
        }
        sentinel = next;
        setStatus('held');
      } catch {
        if (isActive) setStatus('unavailable');
      }
    }

    function onVisibilityChange(): void {
      if (wakeLock !== undefined) void acquire(wakeLock);
    }

    void acquire(wakeLock);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      isActive = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (sentinel !== null && !sentinel.released) void sentinel.release();
    };
  }, [wakeLock]);

  return status;
}
