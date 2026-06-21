# Measurements

Live record of measurement-grounded decisions. New entries append at the bottom; older entries stay readable so future-us can see what the call was, who made it, and what would re-open it.

This file is the source of truth for "what number did we pick and why" until FEAT-50 lifts the relevant rows into `OPERATIONS.md`.

---

## 2026-05-20 — `pg-pool` size and Fly machine class (FEAT-08)

**Estimated, not measured.** This entry records a deliberate skip of the synthetic load run the original FEAT-08 spec describes. The decision rests on the asymmetry between failure modes and a household-scale workload, and falls back on the revisit triggers in DEC-71 if reality contradicts it.

### Why we skipped the load run

- The household workload ceiling is two concurrent users on two devices each — single-digit concurrent requests at the genuine peak.
- `health.ping` (FEAT-03) doesn't touch the database yet, so the only thing a load run could measure right now is the Node + Fastify + tRPC baseline. The numbers we'd really want — RSS under real `pg-pool` allocation, queue behaviour, connection-exhaustion thresholds — only become observable after FEAT-09 wires the pool to actual queries.
- DEC-71's revisit triggers (memory pressure, connection-exhaustion errors, machine class change) already cover the failure modes that would invalidate the estimate. Measurement at this point would mostly confirm headroom that the runtime image footprint already implies (FEAT-05's session note records the prod image at 229MB total, on a 512MB machine).

If FEAT-09 reveals the estimate is wrong, the load script the original spec describes is still cheap to run later.

### Chosen pool size: **10** (max; min stays at pg-pool's default of 0)

- DEC-71's expected range is **5–10** for the smallest machine class. We're on 512MB rather than the implied 256MB baseline, so the upper end is the safe pick.
- Worst-case concurrent in-flight DB work at household scale: two users × two tabs × 1–2 connections per tRPC procedure ≈ 4–8 in-flight at peak. **10 gives ~25% headroom over that worst plausible peak.**
- The cost asymmetry favours the upper bound. Connection-exhaustion is a correctness failure (requests fail outright or queue indefinitely); a pool slightly too large is just a few extra idle sockets. Picking 5 to save the difference would be optimising the cheap side at the expense of the expensive one.
- Cold-start (DEC-64) is unaffected. With `min: 0` left at pg-pool's default, connections are created lazily on first use — `max: 10` doesn't pre-allocate ten sockets at boot. Cross-cutting concern #18's pool-↔-cold-start link binds via `min`, not `max`.
- Postgres-side memory (~10MB per connection × 10 = ~100MB) is borne by the Fly Postgres machine, not the app machine, and fits comfortably within Fly Postgres's smallest tier.

### Chosen machine class: **`shared-cpu-1x@512mb`** (unchanged from `fly.toml`)

- FEAT-05's session note records the prod image at 229MB total — Node, the esbuild bundle, and the Alpine base fit comfortably with room to spare.
- 512MB leaves headroom for FEAT-09's real `pg-pool` allocations, V8 heap growth, request buffers, and the Pino → Axiom transport that lands in FEAT-43.
- Downgrading to 256MB is plausible (and the original FEAT-08 example), but premature: doing it now means re-measuring twice (now with no DB, again after FEAT-09 wires the pool). Wait for real DB load before reclaiming the headroom.
- Cost difference between 256MB and 512MB on `shared-cpu-1x` is negligible at auto-stop scale (DEC-64 — machine sleeps when idle).

### Cross-cutting concern #18 — interactions

Pool size, machine class, and cold-start are linked. The link is mediated through pg-pool's `min` setting, not `max`: a non-zero `min` would pre-allocate connections at boot and extend cold-start latency proportionally. With `min: 0` (default), `max: 10` only allocates connections on demand, so cold-start cost stays at the Node + Fastify boot path (DEC-64's 3-second budget). FEAT-51's cold-start work measures this empirically; if `min` ever changes, this entry is the thing to re-read.

### Revisit triggers

From DEC-71, verbatim:

- Memory pressure or connection-exhaustion errors appear in Phase 6 observability (FEAT-43 logging / FEAT-44 error tracking / FEAT-45 health surfaces).
- Fly machine class is upgraded (or downgraded).

FEAT-08-specific addendum:

- FEAT-09 ships, real traffic exercises `pg-pool`, and any burst shows **peak RSS > 70% of the machine's memory ceiling** on the Fly dashboard's Metrics chart, *or* **sustained `pg-pool` queue depth > 0** in the logs. Either is the cue to actually run the load script the original FEAT-08 spec describes and confirm the estimate empirically.

---

## 2026-06-21 — Log volume baseline (FEAT-44)

**To be filled after the first week of production traffic.** Stub committed alongside the Pino → Axiom transport so the slot exists when the first numbers arrive.

### What to record once data exists

- Daily event count to Axiom (`stats('count')` over a 24h window in the Axiom dataset, on a representative day — not a deploy day, not the first day after launch).
- 95th-percentile event size in bytes (the Axiom free tier silently drops oversized events; this is the leading indicator that an `info`-level log call is borderline).
- Share of events at `info`, `warn`, `error`. A drift to >10% non-`info` is either a real signal (page someone) or noise to suppress at the call site.
- Estimated days of retention available given Axiom's 30-day rolling window and current ingest rate. If projected retention falls below 25 days at the current ingest rate, that's the cue to either drop noisy logs or revisit DEC-75 (see "Revisit when" there).

### Why a stub rather than a synthetic load run

- Two-user household traffic is shaped almost entirely by real usage patterns (when meals get planned, when the shopping list is opened). Synthetic load doesn't approximate it usefully.
- The actual measurement requires the deployed transport (FEAT-44) and a representative day of real requests — neither of which can be faked locally with value.
- The transport ships as plumbing; this row is the agreement that we will measure it within the first month of meaningful usage, not later.

### Revisit triggers

- Axiom's "events ingested" panel shows a step change (>2× the baseline once established) without a corresponding feature shipping.
- The Axiom dashboard surfaces dropped events (per-event size cap exceeded).
- DEC-75's "revisit when" fires: an incident requires logs older than the rolling window, or Axiom pricing changes.
