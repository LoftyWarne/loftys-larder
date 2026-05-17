// Type-only re-export of the backend tRPC router. No runtime code crosses the
// boundary — `import type` / `export type` are erased at compile time. The
// frontend imports `AppRouter` from `@loftys-larder/shared` to stay typed
// without pulling backend runtime into its bundle.
export type { AppRouter } from '../../backend/src/trpc/router.ts';
