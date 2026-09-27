import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

// Warm loads resolve in ~50 ms and never reach this screen; anything still
// pending past this point is almost certainly a Fly cold start (DEC-64).
export const WAKING_HINT_DELAY_MS = 1500;

export function AppPendingScreen(): React.ReactElement {
  const [showWakingHint, setShowWakingHint] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowWakingHint(true);
    }, WAKING_HINT_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-muted-foreground"
    >
      <Loader2 aria-hidden="true" className="size-8 animate-spin" />
      <p className="text-sm">
        {showWakingHint ? 'Waking up the larder…' : 'Loading…'}
      </p>
    </div>
  );
}
