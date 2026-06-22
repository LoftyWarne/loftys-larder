# OPERATIONS

Runbook for production operations. Expanded as features ship.

## Rate limits

`@fastify/rate-limit` (`backend/src/plugins/rate-limit.ts`) applies three buckets:

| Scope | Limit | Window | Key |
|---|---|---|---|
| Unauthenticated traffic | 100 requests | 1 minute | `ip:<client IP>` (Cloudflare's forwarded IP) |
| Authenticated traffic | 300 requests | 1 minute | `session:<session id>` |
| Magic-link send (`POST /api/auth/sign-in/magic-link`) | 5 requests | 1 hour | `magic-email:<lowercased email>` (falls back to `magic-ip:<ip>` if the body has no email) |

`/api/health` is exempt — Fly's liveness probe hits it on a tight cadence.

A blocked request returns HTTP `429` with the body:

```json
{ "error": "TooManyRequests", "code": "RATE_LIMITED", "retryAfterSeconds": <n> }
```

and a `Retry-After` header. The body is an HTTP-level envelope, not a tRPC one — the rate-limit hook runs before the tRPC adapter, so even tRPC URLs see this shape on 429.

**Operational notes:**

- Store is in-memory. The single Fly machine in `lhr` plus auto-stop (DEC-63 / DEC-64) means counters reset whenever the machine wakes from sleep. Accepted v1 trade-off — if scaled out, plug Redis via the plugin's `redis` option.
- Limits sized for household traffic, not adversarial scale (`docs/non-goals.md`). If Cloudflare's edge surfaces patterns that suggest these are wrong in either direction, revisit.
