import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registerSWMock = vi.fn();

vi.mock('virtual:pwa-register', () => ({
  registerSW: registerSWMock,
}));

async function loadFresh(): Promise<typeof import('../sw-register.ts')> {
  vi.resetModules();
  return await import('../sw-register.ts');
}

describe('registerServiceWorker', () => {
  beforeEach(() => {
    registerSWMock.mockReset();
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      serviceWorker: { register: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('no-ops in dev mode so HMR is not shadowed by a stale SW', async () => {
    vi.stubEnv('PROD', false);
    const { registerServiceWorker } = await loadFresh();
    registerServiceWorker();
    // Give any (unintended) dynamic import a few microtasks to fire.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(registerSWMock).not.toHaveBeenCalled();
  });

  it('registers in prod when navigator.serviceWorker is available', async () => {
    vi.stubEnv('PROD', true);
    const { registerServiceWorker } = await loadFresh();
    registerServiceWorker();
    await vi.waitFor(() => {
      expect(registerSWMock).toHaveBeenCalledTimes(1);
    });
    expect(registerSWMock).toHaveBeenCalledWith({ immediate: true });
  });

  it('does nothing when serviceWorker API is missing (e.g. some older WebViews)', async () => {
    vi.stubEnv('PROD', true);
    vi.stubGlobal('navigator', { userAgent: 'test' });
    const { registerServiceWorker } = await loadFresh();
    expect(() => {
      registerServiceWorker();
    }).not.toThrow();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(registerSWMock).not.toHaveBeenCalled();
  });
});
