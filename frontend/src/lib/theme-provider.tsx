import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  themePreferenceSchema,
  type ThemePreference,
} from '@loftys-larder/shared';
import { useSession } from '@/lib/auth-client.ts';

type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readSystemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function applyDarkClass(active: boolean): void {
  document.documentElement.classList.toggle('dark', active);
}

function resolvePreference(value: unknown): ThemePreference {
  const parsed = themePreferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : 'system';
}

export interface ThemeProviderProps {
  children: ReactNode;
  // Overrides the session-derived preference. Primarily for tests.
  preference?: ThemePreference;
}

export function ThemeProvider({
  children,
  preference: override,
}: ThemeProviderProps): React.ReactElement {
  const session = useSession();
  const sessionPreference = resolvePreference(
    session.data?.user.themePreference,
  );
  const preference = override ?? sessionPreference;

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    readSystemTheme(),
  );

  useEffect(() => {
    if (preference !== 'system') return;
    const mql = window.matchMedia(DARK_QUERY);
    const handler = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };
    setSystemTheme(mql.matches ? 'dark' : 'light');
    mql.addEventListener('change', handler);
    return () => {
      mql.removeEventListener('change', handler);
    };
  }, [preference]);

  const resolved: ResolvedTheme =
    preference === 'system' ? systemTheme : preference;

  useEffect(() => {
    applyDarkClass(resolved === 'dark');
  }, [resolved]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved }),
    [preference, resolved],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return value;
}
