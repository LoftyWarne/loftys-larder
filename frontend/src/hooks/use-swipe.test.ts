import { fireEvent, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SWIPE_EDGE_PX, SWIPE_MIN_PX, useSwipe } from './use-swipe.ts';

const onSwipeLeft = vi.fn();
const onSwipeRight = vi.fn();

function swipe(
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  fireEvent.touchStart(window, {
    touches: [{ clientX: from.x, clientY: from.y }],
  });
  fireEvent.touchEnd(window, {
    changedTouches: [{ clientX: to.x, clientY: to.y }],
  });
}

beforeEach(() => {
  onSwipeLeft.mockReset();
  onSwipeRight.mockReset();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 400,
  });
});

describe('useSwipe', () => {
  it('calls the handler for a horizontal swipe each way', () => {
    renderHook(() => {
      useSwipe({ enabled: true, onSwipeLeft, onSwipeRight });
    });

    swipe({ x: 300, y: 200 }, { x: 100, y: 220 });
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);

    swipe({ x: 100, y: 200 }, { x: 300, y: 180 });
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it('ignores a short or mostly vertical gesture', () => {
    renderHook(() => {
      useSwipe({ enabled: true, onSwipeLeft, onSwipeRight });
    });

    swipe({ x: 200, y: 200 }, { x: 200 - (SWIPE_MIN_PX - 1), y: 200 });
    swipe({ x: 200, y: 100 }, { x: 140, y: 300 });

    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('leaves touches from the screen edges to the system Back gesture', () => {
    renderHook(() => {
      useSwipe({ enabled: true, onSwipeLeft, onSwipeRight });
    });

    swipe({ x: SWIPE_EDGE_PX - 1, y: 200 }, { x: 300, y: 200 });
    swipe({ x: 400 - SWIPE_EDGE_PX + 1, y: 200 }, { x: 100, y: 200 });

    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('ignores a multi-touch gesture', () => {
    renderHook(() => {
      useSwipe({ enabled: true, onSwipeLeft, onSwipeRight });
    });

    fireEvent.touchStart(window, {
      touches: [
        { clientX: 300, clientY: 200 },
        { clientX: 200, clientY: 200 },
      ],
    });
    fireEvent.touchEnd(window, {
      changedTouches: [{ clientX: 100, clientY: 200 }],
    });

    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it('does nothing while disabled, and stops listening on unmount', () => {
    const { rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => {
        useSwipe({ enabled, onSwipeLeft, onSwipeRight });
      },
      { initialProps: { enabled: false } },
    );
    swipe({ x: 300, y: 200 }, { x: 100, y: 200 });
    expect(onSwipeLeft).not.toHaveBeenCalled();

    rerender({ enabled: true });
    unmount();
    swipe({ x: 300, y: 200 }, { x: 100, y: 200 });
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });
});
