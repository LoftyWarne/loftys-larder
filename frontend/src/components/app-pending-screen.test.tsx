import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppPendingScreen,
  WAKING_HINT_DELAY_MS,
} from './app-pending-screen.tsx';

describe('AppPendingScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a generic loading status initially', () => {
    render(<AppPendingScreen />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('switches to the waking-up hint once the delay elapses', () => {
    render(<AppPendingScreen />);

    act(() => {
      vi.advanceTimersByTime(WAKING_HINT_DELAY_MS - 1);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Waking up the larder…',
    );
  });
});
