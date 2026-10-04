import { useEffect, useState } from 'react';

// Whether the browser thinks it's online, from `navigator.onLine` and the
// window's `online` / `offline` events. `navigator.onLine` can lie under
// captive portals, so callers still handle a request that fails.

function readOnlineFlag(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(readOnlineFlag);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    function handleOnline(): void {
      setIsOnline(true);
    }
    function handleOffline(): void {
      setIsOnline(false);
    }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
