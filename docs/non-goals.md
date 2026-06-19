# Non-Goals — Lofty's Larder

Companion to `plan.md`. Captures the negative space of v1: things considered and rejected, quality bars deliberately held at a level, decisions deferred until a real signal arrives, and adjacent territory that isn't part of this project. Each entry states what it is, why it's out, and what would force a revisit.

Entries flagged `[→ decision log]` correspond to a deferred or contested decision that should be cross-referenced in the design-decisions log when that document is written.

---

## 1. Features Considered and Explicitly Not Built

### Drag-and-drop slot assignment on viewports below `lg` (phones and small portrait tablets)
What it is: dragging recipe cards from the sidebar onto planner slots, or assigned slots onto other slots, on phone-sized and small-tablet screens.
Why not: the primary use is one-handed on a phone in a kitchen. Click-to-assign (or, below `md`, the slot-editor sheet — see DEC-85) is faster for bulk planning, works identically with touch / mouse / keyboard, and satisfies WCAG 2.1 AA without dedicated DnD a11y machinery on the tightest screens. The plan treats touch-first as a load-bearing constraint on those viewports, not a nice-to-have.
Scope: DnD *is* enabled on `lg+` viewports (desktops, touchscreen laptops, tablets in landscape, iPad Pro in portrait) per **DEC-84** and **FEAT-40**, alongside click-to-assign. This non-goal binds only below `lg`.
Revisit: only if usability testing shows click-to-assign / editor-flow confuses or slows users on phones in practice. Desktop-power-user feedback alone is not a sufficient trigger.
`[→ decision log]`

### Recipe snapshotting at slot assignment
What it is: copying recipe contents into the slot at assignment time so later recipe edits don't mutate past plans.
Why not: copy-on-assign adds storage overhead and substantial complexity to every ingredient-mutation path, for a problem (post-hoc plant-points drift, mid-shop quantity changes) that nobody at household scale is asking about. The shopping-list quantity-bound check reset covers the only mid-shop surprise case.
Revisit: if past-plan integrity is ever required for an external reason (regulatory, sharing, public archive — none currently in scope).
`[→ decision log]`

### Multi-unit-per-ingredient support
What it is: letting an ingredient be expressed in grams in one recipe and tablespoons in another.
Why not: the single-unit invariant makes shopping-list aggregation a pure sum with no conversion table to maintain or get wrong. Accepted as a UX cost paid by the data-entry user, not by the cooking user.
Revisit: only if entry friction from manual conversion (e.g., recipes habitually published in oz vs g) becomes a real adoption barrier — which it cannot be at household scale.
`[→ decision log]`

### Per-serving recipe ingredient entry
What it is: storing recipe quantities as "X per serving" rather than "X for `baseServings` servings".
Why not: recipes in the wild are written "serves 4," not per-portion. Whole-recipe entry matches source material, lowers data-entry friction, and lets `baseServings` be a single denominator for shopping-list scaling.
Revisit: not anticipated; would be a foundational data-model change.

### Nested base recipes
What it is: a batch-version recipe being itself the base for another batch recipe.
Why not: two levels covers every real-world cooking pattern the household has surfaced (base → accompaniments). Allowing nesting introduces cycle-detection, recursive plant-points traversal, and ambiguous shopping-list aggregation paths for no observed use case.
Revisit: if a real meal pattern needs three-deep composition (a stock that feeds a sauce that feeds a meal). Re-evaluation should include whether the right answer is nesting vs. a "prep step" abstraction distinct from recipes.

### Rich text in user-generated content
What it is: markdown, formatting controls, or HTML in recipe names, descriptions, methods, or comments.
Why not: plain text + React's default escaping is the XSS mitigation, and the project has zero `dangerouslySetInnerHTML`. Introducing rich text expands the attack surface materially (sanitiser dependency, CSP implications, render parity across surfaces) for an aesthetic gain.
Revisit: if method steps become structurally hard to parse without bold/italic emphasis — which two cooks sharing one dataset can negotiate verbally instead.

### Password authentication
What it is: traditional email + password sign-in alongside or instead of magic links.
Why not: passwordless removes credential management entirely — no hashing, no reset flow, no breach surface, no password-strength UX. Cross-device magic links match the cross-device autosave story for the recipe editor.
Revisit: if Resend deliverability degrades persistently and Postmark migration also fails — at which point password fallback becomes a recovery mechanism, not a primary path.
`[→ decision log]`

### Cascade delete on user account removal
What it is: deleting a user removing their recipes, comments, ratings, and slot attributions.
Why not: this is a shared household dataset. A leaving user shouldn't be able to take their roommate's recipe library with them. Tombstoning preserves data integrity at the cost of carrying nullable `addedBy` / `createdBy` / `chefUser` columns — a price already paid in the schema.
Revisit: only if data-protection requirements change such that the user's right-to-erasure must include content they authored (currently arguable; the tombstoning approach is consistent with shared-workspace norms).

### One-click GDPR data export
What it is: a user-initiated "download my data" flow producing a portable archive.
Why not: at two users, manual `pg_dump` filtered by `user_id` handles any realistic access request. Building a self-serve export means designing a stable export format, UI affordance, and rate-limited generation path for a request that may never arrive.
Revisit: on the first formal access request, or if the user count grows past the point manual handling stays cheap.
`[→ decision log]`

### Cooked-base shelf-life tracking
What it is: separate shelf-life accounting for cooked dishes (typically shorter raw, much longer when frozen).
Why not: raw-ingredient shelf life from purchase covers the shopping-side decisions. Cooked-base shelf life only matters if batch-cooking patterns regularly stretch consumption past safe limits — an empirical question the plan can't answer yet.
Revisit: when real cooking patterns produce a slot more than N days past the base cook and the household notices something has gone off. Trigger condition: explicit feedback from either cook that consumption windows have caused waste.
`[→ decision log]`

### Multi-shop shelf-life planning
What it is: modelling multiple shopping dates per plan and recomputing warnings against the relevant shop.
Why not: v1 assumes one shop on plan start date. Most weeks this matches reality; when it doesn't, the warning surfaces the latest-needed date so the cook can plan a top-up.
Revisit: if top-up shops become routine enough that warnings are noise rather than signal. Implementation path: add `shop_date` to plans (the plan already names this).
`[→ decision log]`

### Backend proxying of image uploads
What it is: the Fastify app receiving image bytes and forwarding them to Cloudinary.
Why not: signed direct-to-Cloudinary uploads with constrained presets keep binary data off the API path entirely. The Fly machine's memory budget and request lifetime are reserved for typed RPC, not for shovelling MB-scale uploads.
Revisit: only if Cloudinary's signed-upload model changes such that constraints can no longer be enforced at signing time.

### Per-user timezone
What it is: storing each user's timezone and computing "today"-relative logic against it.
Why not: both cooks live on Europe/London time. Hardcoding it eliminates a class of edge cases (plan-overlap rules, shelf-life dates, day boundaries) for zero current cost. The choice is centralised in one date utility module, so a future change is bounded.
Revisit: if either cook moves abroad, or if the app ever serves households outside the UK.

### Session replay in Sentry
What it is: video-like reconstruction of user sessions on error.
Why not: adds a meaningful PII surface and would require a cookie-consent banner for GDPR compliance. The PII/consent cost outweighs the debugging value at two-user scale, where the affected user can be asked directly.
Revisit: if multi-household / multi-user-per-household ever ships, at which point the PII vs. debug-value calculus changes.

### Staging environment
What it is: a separate Fly app + Postgres mirroring prod for pre-deploy migration / smoke testing.
Why not: doubles infra cost and operational surface (drift, seeding, secret rotation across two environments). Mitigation is Testcontainers integration tests that exercise the actual SQL Drizzle emits, plus rehearsed restore drills.
Revisit: when migration mistakes against prod become a real cost — even one production data-loss incident is a sufficient trigger.
`[→ decision log]`

### Optimistic concurrency control
What it is: row-version columns or row-level locking to detect and reject conflicting writes.
Why not: two cooks rarely edit the same row simultaneously. LWW is the cheapest correct-enough answer per concrete collision surface (recipes, slots, shopping-list checks). The plan explicitly accepts "last device to sync wins" as the MVP shopping-list trade-off.
Revisit: if shopping-list conflicts become user-visible (an item the user just checked re-appearing unchecked because the partner's offline queue replayed an older state). CRDT-lite design is named in the plan as the upgrade path.
`[→ decision log]`

### Aggressive PWA caching with versioned API contracts
What it is: cache-first PWA strategy across more than the shopping list, with a versioning protocol to handle backend procedure-shape changes.
Why not: v1 caches the last-fetched shopping list only, network-first. If the deployed PWA falls behind, the failed call prompts a refresh — visible failure, recoverable in one tap. A graceful versioning strategy is real engineering work that costs more than the failure mode does at this scale.
Revisit: when the failure mode is observed in practice and the refresh prompt becomes too costly (e.g., happens mid-shop). The plan flags this as an open question.
`[→ decision log]`

### Cloudinary orphan cleanup job
What it is: a scheduled job deleting Cloudinary assets whose `public_id` doesn't appear on any recipe.
Why not: storage cost at household-scale upload volume is negligible. Building, scheduling, and monitoring a destructive job carries its own risk (wrong predicate, soft-deleted recipes).
Revisit: when storage cost or asset clutter becomes visible in the Cloudinary dashboard.
`[→ decision log]`

---

## 2. Quality Bars Deliberately Held

### Test coverage is not a target
Where it's held: behaviour-focused tests on the highest-value surfaces (aggregation math, plant-points traversal, shelf-life warnings, date-overlap rules, base-cook contributions). No `--coverage` threshold enforced.
Why not higher: coverage as a metric rewards uniform test density across code regardless of its risk profile. The plan names the high-value surfaces explicitly; pushing coverage past those creates ceremonial tests that slow iteration without finding bugs.
Why not lower: the named surfaces would have insufficient cases to catch the real edge conditions (duplicate ingredient lines, batch-version no-double-count rule, soft-deleted-base hidden from picker).
Revisit: only if a real regression sneaks through in a code path that "should have had a test" — at which point the question is whether to test that one path, not to globally lift coverage.

### WCAG 2.1 AA, spot-checked
Where it's held: AA conformance on primary flows, validated via `axe-core` in Playwright against both themes. Not AAA. Not a full manual audit. Not screen-reader-tested across every component.
Why not higher: AAA materially constrains design choices (contrast ratios, language requirements) for marginal gain on a two-user app. Full manual audit is professional-services money.
Why not lower: keyboard navigation, contrast, and focus management are non-negotiable for a touch-first app whose users include anyone using assistive tech now or in future. AA is the floor.
Revisit: if the app is ever made publicly accessible to users with disabilities at any scale.

### Cold-start budget of 3 seconds
Where it's held: auto-stop enabled; cold-start measured in Phase 6; reconsider always-on (~$5/month) only if the budget is exceeded.
Why this level: auto-stop turns a single-region two-user app from "compute idle 23 hours a day" to "compute paid only when used." Three seconds is roughly the threshold at which "did it load?" becomes "did I tap right?".
Revisit: Phase 6 measurement is the decision point. Also revisit if the household notices the lag in practice — measured budgets and lived experience aren't always aligned.
`[→ decision log]`

### Rate limits sized for household traffic, not adversarial scale
Where it's held: 100 req/min unauth, 300 req/min auth, 5 magic-link requests per email per hour.
Why not higher: nobody legitimate hits 300 req/min from a single session. Higher limits just expand the abuse surface.
Why not lower: the planner with optimistic updates can fire bursts of slot-assignment mutations during bulk planning; 300/min keeps that comfortable.
Revisit: if Cloudflare's edge sees patterns that suggest these are wrong in either direction.

### Log retention at 30 days (Axiom free tier)
Where it's held: 30-day rolling window in Axiom.
Why not longer: incidents at this scale either get noticed within hours or never. 30 days covers the realistic incident-response window plus a comfortable margin.
Why not shorter: less than 30 days starts losing intermittent-pattern visibility (a weekly cron, a once-a-fortnight workflow).
Revisit: if an incident requires logs older than the window and the answer is materially different from "we'll know next time."

### Sentry alerts at absolute thresholds, not percentages
Where it's held: >5 errors per 5 minutes.
Why this level: percentage-based thresholds page constantly at low traffic — a single flaky request becomes 100% error rate. Absolute thresholds align noise with real signal.
Revisit: if traffic ever grows past the point where 5 errors is invisibly small noise relative to volume.

### `pg-pool` size committed once in Phase 1 (estimated, not measured)
Where it's held: a single static pool size in the 5–10 range, committed at FEAT-08 against the workload's ceiling and the runtime image footprint rather than a synthetic-load measurement (`health.ping` doesn't touch the DB yet, so there's nothing real to measure). See `docs/measurements.md`.
Why not dynamic: dynamic pool sizing introduces tuning surface and observability needs for a workload whose ceiling is two concurrent users.
Revisit: if memory pressure or connection-exhaustion errors appear in Phase 6 observability. Also if Fly machine class is upgraded. FEAT-09 traffic with peak RSS > 70% or sustained `pg-pool` queue depth > 0 is the cue to run the synthetic-load procedure captured in `docs/measurements.md`.

### Single-region deployment (`lhr`)
Where it's held: one Fly region, one Postgres cluster co-located.
Why not multi-region: both users are in the UK. Multi-region adds replication topology, eventual-consistency reasoning, and meaningful cost for zero latency benefit.
Why not elsewhere: `lhr` is the lowest-latency region for the household.
Revisit: only if the user base ever leaves the UK.

---

## 3. Architectural Decisions Deferred

### Multi-tenancy mechanism
What's deferred: the actual mechanism — Postgres RLS, subdomain routing, a `household_memberships` join table, a scope-resolver pattern, or some combination.
Why deferred: the data model is multi-tenancy-ready (`household_id` FKs on domain tables, `CURRENT_HOUSEHOLD_ID` as a config constant). Choosing the mechanism now means designing against an imagined access pattern. The right mechanism depends on what multi-tenancy *means* when it arrives (households inviting each other? recipe sharing across households? a SaaS product?).
Trigger: a concrete second-household requirement, with stated semantics. Until then, no scope-resolver, no membership joins, no `getCurrentScope()`.
`[→ decision log]`

### Shopping-list conflict resolution beyond LWW
What's deferred: CRDT-lite or version-vector design for check-state with offline queueing.
Trigger: real-world reports of an item the user just checked re-appearing unchecked because the partner's offline queue replayed older state. Synthetic concern alone isn't enough.
`[→ decision log]`

### PWA cache versioning protocol
What's deferred: a graceful handshake between the deployed PWA and a backend whose procedure shapes have changed.
Trigger: the deployed PWA falling behind in a way that breaks more than a recoverable single call. The plan's current answer is "the call fails, the user refreshes" — deferral lasts only as long as that remains acceptable.
`[→ decision log]`

### Search upgrade path beyond ILIKE + `pg_trgm`
What's deferred: full-text search (`tsvector` + `tsquery`) or an external search service.
Trigger: substring + trigram search becoming visibly inadequate — ranking complaints, language-specific stemming needs, cross-field weighted search. None expected at household scale.

### Email-provider fallback
What's deferred: a Postmark integration as backup for Resend.
Trigger: Resend deliverability issues that affect magic-link receipt. Status-page monitoring is the early-warning system. Implementation cost is bounded — Better Auth's provider abstraction makes the swap a configuration change.
`[→ decision log]`

### Better Auth migration path
What's deferred: any concrete planning for moving off Better Auth to Lucia or a roll-your-own session table.
Trigger: Better Auth becoming unmaintained, suffering an unresolved security issue, or breaking its API in a way that's costlier to follow than to leave. The plan acknowledges this as a young-library risk and notes the migration is bounded.
`[→ decision log]`

### Always-on vs. auto-stop
What's deferred: the choice between auto-stop with cold-starts and always-on (~$5/month).
Trigger: cold-start measurement in Phase 6 exceeding 3 seconds.
`[→ decision log]`

---

## 4. Scope Boundaries — Adjacent but Not Part of This Project

### Pantry / inventory tracking
What it would be: tracking what's already in the cupboard / fridge / freezer and netting it against the shopping list.
Why not part of this: requires constant manual upkeep to be useful (or barcode scanning, smart-shelf hardware, etc.). The shopping list aggregates *what the plan needs*, not *what the household lacks*. The cooks reconcile against the cupboard at shopping time — a 30-second human task that doesn't repay weeks of engineering.
Adjacency note: a future "starting inventory" field on a plan could subtract from the list. That's a feature for a different product spec, not a v1 extension.

### Recipe import from URLs
What it would be: pasting a recipe URL and having the app scrape it into the editor.
Why not part of this: scrapers break constantly, ingredient unit-and-quantity parsing is the hard part of recipe data, and the single-unit invariant means imports would need conversion review anyway. Manual entry is the unglamorous correct answer for a household whose recipe sources are unpredictable.
Adjacency note: `source_url` is stored, but only as a reference link. No parsing.

### AI / LLM features
What it would be: meal-plan suggestions, recipe recommendations, ingredient substitution advice, "what can I cook with X."
Why not part of this: scope, cost, and the fact that two cooks know what they want to eat better than any model does. The plan is a tool for cooks who already cook, not a recommender.
Adjacency note: not a stylistic objection to AI features in general — a stylistic objection to bolting them onto a tool whose value is structured deterministic data.

### Recipe / meal-plan sharing across households
What it would be: exporting a recipe (or a whole plan) for another household to import, or a discoverable public library.
Why not part of this: presupposes multi-tenancy and a sharing model neither of which exist. Single-household scope.
Adjacency note: copy-paste recipe text into a message works fine for the rare ad-hoc share.

### Grocery delivery / supermarket API integration
What it would be: sending the shopping list directly to Tesco, Sainsbury's, Ocado, etc.
Why not part of this: each integration is a separate API contract, auth flow, SKU-mapping problem, and maintenance burden. The shopping list as a printable PWA checklist works for any shop, in-store or online.
Adjacency note: the list is structured data and can be exported in future if a single supermarket becomes the household default.

### Dietary filters and allergen tracking
What it would be: tagging recipes vegan / vegetarian / gluten-free / nut-free, filtering the recipe picker by tag, warning on planned exposures.
Why not part of this: two cooks know each other's dietary needs. Tagging is upkeep work that pays off only when the dataset is browsed by people who don't already know the recipes.
Adjacency note: `is_plant` exists on ingredients and is computed into plant-points. That's a specific decision in service of a specific tracked metric, not the start of a tagging framework.

### Cost optimisation and price tracking
What it would be: comparing ingredient prices across stores, tracking price history, suggesting cheaper substitutes, optimising the shopping list against a budget.
Why not part of this: `estimated_cost_per_serving` exists as a recipe field for informational display. Price intelligence requires price data the app doesn't have and wouldn't pay for at this scale.
Adjacency note: the field is stored, not computed. Manual entry only.

### Cook-mode / step-by-step / timer integration
What it would be: a kitchen mode that walks through method steps with built-in timers, screen-wake-lock, hands-free advance.
Why not part of this: method is rendered as plain text steps. Cook-mode is a real product opportunity but a different product. The plan's offline shopping-list mode is the kitchen-use feature that earned its way in.
Adjacency note: revisitable as a Phase-7+ feature against real cooking-with-the-app behaviour, not against imagined demand.

### Calendar / external integrations
What it would be: pushing the meal plan to Google Calendar, Apple Calendar, Notion, etc.
Why not part of this: the meal plan is consulted in the app at shopping time and at the moment of cooking. External calendar duplication isn't a workflow either cook has asked for.
Adjacency note: a read-only iCal feed would be a small project. Not in v1.

### Multi-language / internationalisation
What it would be: i18n framework, translated UI strings, locale-aware date / number formatting.
Why not part of this: two English-speaking cooks in the UK.
Adjacency note: not a hostile decision — just a YAGNI one. If the app is ever opened up beyond the household, this becomes table stakes.

### Nutrition tracking against goals
What it would be: setting macro / calorie targets, tracking planned and actual intake, surfacing variance.
Why not part of this: the plan stores per-serving macros for display. It does not store targets, does not compute against targets, does not track adherence. Nutrition tracking is a category of app, not a meal-planner feature.
Adjacency note: plant-points are a specific, deliberately-narrow nutrition signal (variety, not adherence). Keeping the line drawn there is intentional.

### Photo recognition / OCR of cookbooks
What it would be: snapping a photo of a cookbook page and extracting a recipe.
Why not part of this: see "Recipe import from URLs." The hard problem is structured ingredient parsing, not text extraction.

---

## How to use this document

When a feature request, refactor proposal, or "wouldn't it be nice if…" arrives, check whether it appears here. If it does, either the trigger condition has been met (in which case promote the decision out of this document and into the plan) or it hasn't (in which case the answer is "not now, and here's why"). If a real situation isn't covered by any entry here, that's a signal the scope has shifted and this document needs an update before the plan does.
