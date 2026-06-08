import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-client.ts', () => ({
  useSession: vi.fn(),
}));

import { useSession } from '@/lib/auth-client.ts';
import { ThemeProvider } from './theme-provider.tsx';

const useSessionMock = useSession as unknown as ReturnType<typeof vi.fn>;

interface MockMediaQuery {
  matches: boolean;
  listeners: Set<(event: MediaQueryListEvent) => void>;
  fire(matches: boolean): void;
}

function installMatchMedia(initialMatches: boolean): MockMediaQuery {
  const mql: MockMediaQuery = {
    matches: initialMatches,
    listeners: new Set(),
    fire(next: boolean) {
      this.matches = next;
      for (const listener of this.listeners) {
        listener({ matches: next } as MediaQueryListEvent);
      }
    },
  };

  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() {
      return mql.matches;
    },
    addEventListener: (
      _: string,
      handler: (event: MediaQueryListEvent) => void,
    ) => {
      mql.listeners.add(handler);
    },
    removeEventListener: (
      _: string,
      handler: (event: MediaQueryListEvent) => void,
    ) => {
      mql.listeners.delete(handler);
    },
  }));

  return mql;
}

function setSessionPreference(preference: string | undefined): void {
  useSessionMock.mockReturnValue({
    data: preference ? { user: { themePreference: preference } } : null,
  });
}

beforeEach(() => {
  document.documentElement.classList.remove('dark');
  useSessionMock.mockReset();
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('ThemeProvider', () => {
  it('removes the dark class when preference is light', () => {
    document.documentElement.classList.add('dark');
    installMatchMedia(true);
    setSessionPreference('light');

    render(
      <ThemeProvider>
        <div>child</div>
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('adds the dark class when preference is dark', () => {
    installMatchMedia(false);
    setSessionPreference('dark');

    render(
      <ThemeProvider>
        <div>child</div>
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('follows the system query when preference is system (dark OS)', () => {
    installMatchMedia(true);
    setSessionPreference('system');

    render(
      <ThemeProvider>
        <div>child</div>
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('follows the system query when preference is system (light OS)', () => {
    installMatchMedia(false);
    setSessionPreference('system');

    render(
      <ThemeProvider>
        <div>child</div>
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('updates live when the system preference changes', () => {
    const mql = installMatchMedia(false);
    setSessionPreference('system');

    render(
      <ThemeProvider>
        <div>child</div>
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => {
      mql.fire(true);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      mql.fire(false);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('removes the matchMedia listener on unmount', () => {
    const mql = installMatchMedia(false);
    setSessionPreference('system');

    const { unmount } = render(
      <ThemeProvider>
        <div>child</div>
      </ThemeProvider>,
    );

    expect(mql.listeners.size).toBeGreaterThan(0);
    unmount();
    expect(mql.listeners.size).toBe(0);
  });

  it('defaults to system when there is no session', () => {
    installMatchMedia(true);
    setSessionPreference(undefined);

    render(
      <ThemeProvider>
        <div>child</div>
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('honours an explicit preference prop override', () => {
    installMatchMedia(true);
    setSessionPreference('dark');

    render(
      <ThemeProvider preference="light">
        <div>child</div>
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
