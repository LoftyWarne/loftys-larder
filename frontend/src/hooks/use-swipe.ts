import { useEffect, useRef } from 'react';

// Horizontal swipe for cook mode (DEC-116). Touches that start near a screen
// edge are left alone so iOS's and Android's edge-swipe Back still work, and
// a mostly vertical gesture is a scroll, not a swipe.
export const SWIPE_EDGE_PX = 24;
export const SWIPE_MIN_PX = 50;

interface SwipeHandlers {
  enabled: boolean;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
}

export function useSwipe({
  enabled,
  onSwipeLeft,
  onSwipeRight,
}: SwipeHandlers): void {
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      start.current = null;
      return;
    }
    function onTouchStart(event: TouchEvent): void {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        start.current = null;
        return;
      }
      const nearEdge =
        touch.clientX < SWIPE_EDGE_PX ||
        touch.clientX > window.innerWidth - SWIPE_EDGE_PX;
      start.current = nearEdge ? null : { x: touch.clientX, y: touch.clientY };
    }
    function onTouchEnd(event: TouchEvent): void {
      const from = start.current;
      const touch = event.changedTouches[0];
      start.current = null;
      if (!from || !touch) return;
      const dx = touch.clientX - from.x;
      const dy = touch.clientY - from.y;
      if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) {
        return;
      }
      if (dx < 0) onSwipeLeft();
      else onSwipeRight();
    }
    function onTouchCancel(): void {
      start.current = null;
    }
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [enabled, onSwipeLeft, onSwipeRight]);
}
