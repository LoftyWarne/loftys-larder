// A tRPC-shaped 404 body for unrouted `/api/*` requests.
//
// Fastify's default not-found body — `{ error: 'Not Found' }` — cannot be
// decoded by the tRPC client. `httpBatchLink` maps a non-array response onto
// every batched op and runs `transformResult`, which only accepts an error
// payload whose `code` is the *numeric* tRPC wire code; a bare string throws
// the opaque "Unable to transform response from server" instead of surfacing a
// usable message (see the 2026-07-08 session note). Emitting a real envelope
// means a genuine future 404 arrives as a `TRPCClientError` carrying `message`.

// tRPC wire code for NOT_FOUND (from `TRPC_ERROR_CODES_BY_KEY`). Part of tRPC's
// stable JSON-RPC-style protocol — not exported as a runtime value, so it's
// pinned here and guarded by `not-found.test.ts`.
const TRPC_NOT_FOUND_WIRE_CODE = -32004;

// Cap the echoed path so a pathological request (e.g. an over-long batched
// procedure list) can't bloat the error body.
const MAX_ECHOED_PATH = 256;

export interface TrpcNotFoundBody {
  error: {
    message: string;
    code: number;
    data: {
      code: 'NOT_FOUND';
      httpStatus: number;
      path: string;
    };
  };
}

export function trpcNotFoundBody(
  method: string,
  url: string,
): TrpcNotFoundBody {
  // Drop the query string: it carries the tRPC `input`, which we don't want to
  // echo back into an error body, and it's noise for a routing miss.
  const path = (url.split('?', 1)[0] ?? url).slice(0, MAX_ECHOED_PATH);
  return {
    error: {
      message: `No route matched ${method} ${path}`,
      code: TRPC_NOT_FOUND_WIRE_CODE,
      data: {
        code: 'NOT_FOUND',
        httpStatus: 404,
        path,
      },
    },
  };
}
