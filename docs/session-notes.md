# Session notes

Rolling working doc. Pending questions, in-flight context, and drift-from-plan notes worth carrying into future sessions. Older entries can be pruned once the context they hold is no longer load-bearing.

---

## 2026-06-13 — FEAT-21 (Recipe Editor UI + SearchableCombobox primitive)

**Status:** implementation complete; not yet committed. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across all three workspaces. Frontend: 100/100 tests pass across 19 files (8 new files, 36 new tests: `searchable-combobox` 8, `header-fields` 6, `ingredient-list` 7, `method-editor` 5, `image-uploader` 3, `recipe-new-page` 2, `recipe-edit-page` 5). Backend: 49/49 recipes-procedures tests pass (5 new — 3 for `recipes.references` + 2 for cross-household source rejection). The whole-workspace backend run had the same pre-existing 1ms-race flake in `user-procedures.test.ts > updateProfile > bumps updatedAt via $onUpdate` documented in FEAT-19 / FEAT-20 entries. Testcontainers ran via the established Colima socket workaround. DoD boxes in `docs/feature-specs.md §FEAT-21` left unticked — human action. Manual gate check (create-new-recipe end-to-end with image, appears on browse + detail; edit one field on existing recipe and confirm only that field changes) owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Single Zod resolver across `create` and `edit` modes — the form always carries every header field.** Started by switching the resolver between `createRecipeInputSchema` and `updateRecipeHeaderInputSchema.shape.patch` per mode. Walked it back: in edit mode RHF still has every field populated from server data, so the patch-shape `.refine("Provide at least one field")` is benign. One schema, one shape — and the page does the diff into a patch before calling `updateHeader`. The `isBase` checkbox visibility is the only mode-difference in the form itself.
- **Header diff happens at the page, not the section component.** `HeaderFields` just submits the full `HeaderFormValues`. `recipe-edit-page.tsx` has a `PATCH_KEYS` array + `diffHeader()` that produces the minimal patch. Keeps the section dumb and testable; keeps the diff logic next to the mutation call where it's read together. If the patch is empty the page short-circuits with a "Saved." notice and no network call.
- **Plain aria-live "Saved." instead of a toast library.** Spec said "non-blocking toast"; no `sonner` / `react-hot-toast` in `package.json`. Per-section `<p role="status">Saved.</p>` keyed on a `savedNoticeKey: number` (re-renders on each save). Lighter than adding a dep. Worth carrying: if a second consumer needs cross-section notifications, that's when `sonner` earns its place.
- **Up/down buttons + remove for method reordering, no DnD.** Spec explicitly OK'd this ("full DnD a11y not needed"). Buttons disable at boundaries (`index === 0` for up, `index === steps.length - 1` for down). No new dep.
- **`HeaderFields` accepts `mode: 'create' | 'edit'`; the only gated UI is the `isBase` checkbox.** `isBase` is on `createRecipeInputSchema` but excluded from `updateRecipeHeaderInputSchema.shape.patch`. FEAT-23 will add `isBase` / `baseRecipeId` / `pairedRecipeId` to the edit page via a separate `batch-fields.tsx` component (per the spec), keeping `header-fields.tsx` stable.
- **Server-line errors map by `ingredientId` lookup, not by raw index.** When `replaceIngredients` returns `RECIPE_INGREDIENT_UNIT_MISMATCH` or `RECIPE_INGREDIENT_NOT_FOUND` (cause `{ ingredientId }`), the page finds the matching draft line and surfaces "Wrong unit for this ingredient" or "Ingredient not available" inline. Robust against re-ordering, but assumes one bad line per response (matches the server's pre-flight: throws on first hit). Worth carrying: if the server starts returning *all* bad lines at once, the mapping needs to extend.
- **Quantity stays a string at every layer.** `recipeQuantitySchema` is regex-based; `numeric(10,3)` round-trips as a string out of Postgres; the form binds an `<input type="text" inputMode="decimal">` to a string. No `Number()` coercion → no precision loss → what the user typed is what comes back. The unit display next to the qty input is read-only (from the picked ingredient's `defaultUnitId` / `defaultUnitName`) because of DEC-18.
- **Cloudinary multipart body is built with snake_case keys.** Per the trap documented in FEAT-18 session notes ("snake_case is the wire side; the signature is computed over those exact names"). `image-uploader.test.tsx` asserts each snake_case field is present and that camelCase aliases (`apiKey`, `allowedFormats`) are NOT. Regression test for the most likely client-side mistake.
- **`max_file_size` is NOT signed and NOT sent to Cloudinary.** New trap discovered during gate-check: the first upload returned `401 Invalid Signature` with Cloudinary's error body showing its "String to sign" omitted `max_file_size`. Cloudinary lists `max_file_size` as a documented upload param but it is **Pro-plan-only**; lower-tier accounts strip the param before signature verification, producing a deterministic 401 whenever the server signs over it. **Fix:** removed `max_file_size` from both `signUploadParams` in `backend/src/trpc/procedures/uploads.ts` and the client `FormData` in `image-uploader.tsx`. The cap is enforced **client-side** instead — the credentials still carry `maxFileSize`, and the uploader rejects `file.size > creds.maxFileSize` before opening `fetch`. New test in `image-uploader.test.tsx` asserts (a) `body.get('max_file_size')` is null and (b) the oversized-file path surfaces the inline error and never calls `fetch`. The backend `uploads-procedures.test.ts` "signs the bundle..." test was updated to expect a signature over the four-param set (no `max_file_size`). Worth carrying: **if a future upload param is added, verify Cloudinary's `error.message` "String to sign" matches what the server signed BEFORE relying on it.** Their error body is the source of truth, not the docs.

### Drift from kick-off plan

1. **`recipes.references` opportunistically scopes `recipe_sources` to `CURRENT_HOUSEHOLD_ID`, and `create`/`updateHeader` now reject a foreign-household `sourceId` with `NOT_FOUND`.** Plan flagged it as a confirm-or-defer Q1. I went ahead — it closes the DEC-17 hole called out in this doc (FEAT-18 entry "Open hole: `recipe_sources` cross-household") and the cost was one helper `assertSourceInHousehold` + two extra integration tests. Backend test coverage now seeds a foreign-household source row and asserts it is not returned by `references` AND that `create` / `updateHeader` reject it. If a future feature introduces source CRUD, household-scope is already enforced at the write boundary.
2. **TanStack Router file convention forced a route restructure mid-implementation.** Original plan: `routes/_authed/recipes/$recipeId.edit.tsx` as a sibling to the existing `$recipeId.tsx`. Reality: the dot syntax makes `edit.tsx` a *nested child* of `$recipeId.tsx`, which renders `RecipeDetailPage` with no `<Outlet />` — so visiting `/recipes/:id/edit` matched the route tree but the editor never had anywhere to render. **Fix that worked:** renamed `$recipeId.tsx` → `$recipeId.index.tsx`, updated `createFileRoute('/_authed/recipes/$recipeId/')` (trailing slash now required), updated the `useParams({ from: '/_authed/recipes/$recipeId/' })` literal in `recipe-detail-page.tsx`. Both routes are now siblings under `AuthedRoute`. **Worth carrying as a trap row:** future "sibling routes off a param" pairs (e.g. FEAT-22 draft view at `/recipes/:id/draft`, planner edit views) must use `$param.index.tsx` + `$param.X.tsx`, never `$param.tsx` + `$param.X.tsx`.
3. **Added `@radix-ui/react-popover` dependency.** Stop-and-ask item in the plan; approved via plan approval. Sibling to the existing `@radix-ui/react-dialog`; ESM-native. Used as the listbox portal in `SearchableCombobox` — gives correct positioning + outside-click handling for free. No other consumer yet.
4. **Toast surface decision documented above became "use aria-live instead."** Not a deviation in spirit (acceptance criterion was "non-blocking toast" → "shows a transient confirmation"), but worth flagging since the literal noun changed.

### Implementation details worth carrying

- **`SearchableCombobox` is the cross-cutting #6 primitive.** Generic over `T extends { id: number; label: string }`, parameterised by `searchQuery: (q: string) => Promise<readonly T[]> | readonly T[]`. Debounce default 200ms, override per consumer. Keyboard nav: `ArrowUp`/`ArrowDown` wrap, `Enter` commits, `Escape` closes without committing, mouse-down on options uses `preventDefault` so the input doesn't blur first. Listbox is portalled via Radix Popover with `--radix-popover-trigger-width` matching the input. The `searchQuery` effect only fires when the listbox is `open` AND the debounced query changed; closed→typed-then-blurred does nothing. **First consumer is the ingredient picker in `ingredient-list.tsx`.** Future consumers per the plan: FEAT-23 base + pair pickers, FEAT-26 related-recipes, FEAT-31 slot recipe picker, FEAT-32 base picker. Build them by passing a different `searchQuery` — do not fork.
- **Debounce test had a subtle race.** First version asserted "last call after typing 'Ap' is 'Ap'". Failed intermittently because `waitFor`'s ~50ms poll caught the state mid-debounce. **Pattern that worked:** `await waitFor(() => expect(search).toHaveBeenCalledWith('Ap'))` — wait for the specific call, then assert every recorded call's argument is a prefix of `'Ap'` (no partial-then-undone state). Worth carrying for any future debounced-input test.
- **TanStack file-based routing: `$recipeId.tsx` makes child files nest, not sibling.** Documented above as drift #2. Trap row to add to AGENTS.md (next time it's edited): "Create sibling routes off a path param using `$param.index.tsx` + `$param.foo.tsx`, never `$param.tsx` + `$param.foo.tsx`. The latter nests `foo` inside `$param` and needs an `<Outlet />` to render." Until then, this entry is the only memory of the trap.
- **Header `name` validation comes from the Zod schema, not RHF rules.** The acceptance-criteria test for "empty name surfaces inline" hits `recipeNameSchema`'s `min(1, 'Name is required')` literal. If that string changes in `/shared`, the test breaks loudly — that's the design (one source of truth for the message).
- **`HeaderFormValues` is `CreateRecipeInput` aliased.** Fine because `updateRecipeHeaderInputSchema.shape.patch` is a strict subset (no `isBase`). The page's `diffHeader` only emits keys in the `PATCH_KEYS` array (which excludes `isBase`), so the patch shape stays clean even though the form values type carries the extra field.
- **`HeaderFields` `useEffect(() => form.reset(defaultValues), [defaultValues, form])`** — re-syncs the form when the server data changes after a save (`utils.recipes.get.invalidate` → refetch → new `defaultValues` → form reset → dirty state cleared). Worth carrying: any future RHF-driven section that hydrates from a tRPC query needs this reset effect, otherwise post-save the form keeps showing the user's pre-save state.
- **`recipe-edit-page.tsx` does not use the optimistic-update hook.** Per the kick-off plan: `useOptimisticSlotUpdate` (cross-cutting #7) arrives in FEAT-31, generalised for slot writes. For now: `await mutation.mutateAsync(...)` → `await utils.recipes.get.invalidate({ id })` → success notice. Plain, no rollback machinery. Future drift to watch: if optimistic updates land on header saves (cheap and obvious — header writes are scalar), the hook should be the entry point, not a hand-rolled `onMutate`.
- **`fetchCredentials` in the edit page wraps a disabled-by-default tRPC query (`enabled: false`) + `refetch()` on demand.** The credentials query is a `query` (FEAT-18 session-notes line 135) but should only fire when the user actually picks a file. `useQuery({ enabled: false })` + `refetch()` is the canonical way to do on-demand fetching with full caching semantics in @tanstack/react-query. Worth carrying for any "credential-style" lazy query.
- **Image deletion: `onUploaded(null)` → `updateHeader({ imageUrl: null })`.** No Cloudinary destroy call. Matches the DEC-50 "direct browser → Cloudinary, no backend proxy" stance — the asset stays in the bucket, the recipe just forgets it. Cleanup is a separate cron / cost concern, not an MVP one.
- **Backend test had to insert `recipeSources` via inline `db.insert(...).returning(...)`** (no `insertSource` helper existed). I kept the inserts inline in the new `describe('references')` block + the new cross-household tests; if a future FEAT needs source seeding repeatedly, hoist an `insertSource` to match `insertIngredient` / `insertRecipe`.
- **Test mocks for the edit page are deep.** `vi.hoisted(() => ({...}))` returning ~12 mock fns covering `recipes.get`, `recipes.references`, `recipes.updateHeader` / `replaceIngredients` / `replaceMethod`, `uploads.getRecipeImageCredentials`, `useUtils().recipes.get.invalidate`, `useUtils().ingredients.list.fetch`. Pattern is identical to the existing `recipe-detail-page.test.tsx` mock shape — just more surfaces. If a section is added (FEAT-23 batch-fields, FEAT-22 draft hook), extend this mock map rather than fork the file.
- **Filenames and `describe()` strings don't reference "FEAT-21" anywhere.** Memory-pinned rule observed.

### Spec ambiguities resolved here (don't re-litigate)

- **Source create-on-the-fly: NO for v1.** Sources are picker-only; if `references.sources` is empty the source `<select>` is hidden and recipes save with `sourceId = null` and an optional plain `sourceUrl`. A future source-CRUD FEAT (none currently listed in `docs/feature-specs.md`) would add the create surface.
- **Method step ordering is via up/down buttons, not DnD.** Spec OK'd either; chose up/down for a11y + no new dep.
- **`isBase` toggle only on the new page.** Edit-page batch fields wait for FEAT-23.

### Closes the DEC-17 hole flagged earlier in this doc

Per the FEAT-18 entry's "Open hole: `recipe_sources` cross-household" — `updateHeader` accepted a `sourceId` and let the FK confirm existence without checking household ownership. **Closed in this session** via `assertSourceInHousehold` in `backend/src/trpc/procedures/recipes.ts`, applied in `create` and `updateHeader`. Both have explicit integration tests against a seeded foreign-household source row. Single-household MVP didn't strictly require this, but the discipline is now consistent across all `sourceId`-accepting procedures.

### What FEAT-22 / FEAT-23 / FEAT-26 / FEAT-31 will consume from here

- **FEAT-22 (recipe draft autosave)** plugs `useRecipeDraft` into the editor. Each section already has a clean `defaultValues` + `onSubmit` boundary, so the draft hook can wrap `defaultValues` (merge draft over server) and the submit handlers (delete the draft on success).
- **FEAT-23 (batch model)** adds `frontend/src/components/recipe-editor/batch-fields.tsx` and an `isBase` toggle on the edit page. `HeaderFields` already accepts `mode='edit'`; the batch fields land as a new section component next to it. The base picker is a `SearchableCombobox<RecipeListItem>` with a `searchQuery` filtered to `isBase = true` via the picker helper.
- **FEAT-26 (related recipes)** is another `SearchableCombobox` consumer — same shape, different `searchQuery`.
- **FEAT-31 (slot editor recipe picker)** is another consumer. Worth carrying: each consumer should pass a `searchQuery` that calls a `pickable-recipes` helper variant, never re-implement the "what's pickable?" filter inline.
- **The `recipes.references` shape (`{ units, prepTypes, sources }`)** is now a query the editor relies on; future fields (e.g. categories) extend the shape additively. Don't rename.

---

## 2026-06-13 — FEAT-20 (Recipe write procedures: create, updateHeader, replaceIngredients, replaceMethod, softDelete, restore)

**Status:** implementation complete; not yet committed (this session commits it). `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across all three workspaces. Backend: 205/206 tests pass (27 new in `recipes-procedures.test.ts`, all green; 44/44 in the recipes file pass). The single failure is the pre-existing `user-procedures.test.ts > updateProfile > bumps updatedAt via $onUpdate` millisecond-race flake on `$onUpdate(() => new Date())` granularity — same flake documented in the FEAT-19 entry; not touched by this work. Testcontainers ran via the FEAT-17/18/19 Colima socket workaround: `DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock` + `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Definition-of-done boxes in `docs/feature-specs.md §FEAT-20` left unticked — human action. The manual gate check (create-edit-delete-restore cycle end-to-end via a probe; soft-deleted recipe still renders in a historical plan context after FEAT-31) is owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **`isBase` accepted on `create` (optional, default `false`); explicitly rejected by `updateHeader`.** Spec listed the `updateHeader` field set as "name, description, image_url, base_servings, macros, time fields, source_id, source_url" — no mention of `isBase` / `baseRecipeId` / `pairedRecipeId`. FEAT-23 owns those: pair-symmetry is a transaction that touches two rows + a XOR check against `is_base`. Allowing `isBase` on create lets a household mark a recipe as a base from the start without bouncing through FEAT-23's editor; allowing it on `updateHeader` would let the user create a state that needs FEAT-23's symmetry handling to clean up. Q2 of the kick-off Ask block; user confirmed.
- **Unit enforcement uses both `unitId` AND `ingredientId` from the client; server validates equality with the ingredient's `default_unit_id`.** Spec line 826 ("per-line `unit_id` must equal the ingredient's `default_unit_id` — otherwise `BAD_REQUEST`") implied clients send `unitId` despite DEC-18's "one unit per ingredient" making it derivable. We took the spec literally because the boundary check is the integrity guarantee — the editor's form validation in FEAT-21 is UX, not authority. A client that drifts out of sync with the ingredient's enforced unit (stale cache, e.g.) gets caught at the procedure boundary instead of silently writing the wrong unit. Q3 of kick-off; user confirmed.
- **Method step numbers are server-authoritative — clients send an ordered `instruction[]`, server numbers them 1..N.** The DB has a `UNIQUE (recipe_id, step_number)`; if clients sent `stepNumber`, a duplicate would surface as a constraint violation instead of a clean re-numbering. The editor (FEAT-21) is "send the list in display order"; the server "writes them in that order with fresh step numbers." Cheaper and safer than per-row diff. Q4 of kick-off; confirmed.
- **`null` clears a nullable column on `updateHeader`; `undefined` leaves it alone.** Mirrors the `ingredients.update` pattern from FEAT-17. The patch schema uses Zod `.partial()` on a base that has explicit `.nullable()` columns, so `null` is a valid client value (typed) and gets written through verbatim. `undefined` keys are absent from the patch object and the per-key `if (patch.X !== undefined)` guard skips them. Q5 of kick-off; confirmed.
- **`softDelete` is unconditional — a base recipe with live batch-versions can still be soft-deleted.** DEC-23 / FEAT-23's picker helper (`includePickerHidden`) is the place that excludes batch-versions-of-deleted-bases from new contexts. FEAT-20 doesn't gate the delete; the visibility consequences are the picker's. Q6 of kick-off; confirmed.
- **`estimatedCostPerServing` is in the `updateHeader` patch set.** Spec's "macros, time fields" list didn't enumerate it but the spirit is "every editable header column." Included to avoid the editor having to round-trip through `create` to set cost. Q7 of kick-off; confirmed.
- **`pairedRecipeId` is *not* accepted as input on any of these procedures.** Spec gotcha line 842 said so explicitly; FEAT-23 owns the pair-symmetry transaction. Confirmed.
- **`withTransaction` constructed inline via `makeWithTransaction(ctx.db)`** in `replaceIngredients` and `replaceMethod`. The alternative was adding `withTransaction` to `AppContext` + decorating it on Fastify + threading it through every test's `makeContext()` — 4 test files would have grown a required field for the second time this quarter (FEAT-18 already added `cloudinary`). Both paths preserve the audit guarantee ("audit-grep for `db.transaction(` should hit only `withTransaction.ts`"), so I chose the smaller-blast-radius option. Worth carrying: if a third procedure-side write needs the helper, *then* it's time to put `withTransaction` on the context.
- **Pre-flight validation outside the transaction.** `replaceIngredients` runs the household + unit checks before opening `withTransaction`. The transaction then only contains the DELETE + INSERT pair, which is the smallest possible critical section. Cheaper read paths stay outside locks; user-visible errors are still raised synchronously.

### Drift from kick-off plan

1. **Added `RECIPE_INGREDIENT_NOT_FOUND` alongside the planned `RECIPE_INGREDIENT_UNIT_MISMATCH`.** Kick-off plan named only the unit-mismatch code. While wiring the household-scope check on the ingredient lookup, I needed a distinct signal for "the line points at an ingredient that doesn't exist or belongs to another household" vs "the unit is wrong." Same `cause`-channel shape, same status (`BAD_REQUEST`); two codes so the editor (FEAT-21) can render distinct error messages. Net add: one item in `DOMAIN_ERROR_CODES`. Not scope creep — it's an error-shape refinement inside the FEAT-20 surface.
2. **Procedure file path: `backend/src/trpc/procedures/recipes.ts`** (spec said `routers/recipes.ts`). Same drift as FEAT-15/16/17/18/19. Codebase convention.
3. **Test count: 27 new tests, vs kick-off plan's "behaviours" listing of ~22.** Extra tests came from idempotency probes on `softDelete` / `restore`, regression guards confirming `list` still hides + `get` still returns a soft-deleted recipe, and an explicit "rejects empty instruction" boundary test. All within the FEAT-20 surface — no new behaviour introduced, just more coverage of stated criteria.

### Implementation details worth carrying

- **`makeWithTransaction(ctx.db)` is a one-line factory** (`(fn) => db.transaction(fn)`); calling it per request is free. The pattern is "construct at call site, never import `db.transaction(...)` directly." If a procedure ends up needing the helper twice in one body, hoist it to a local `const withTransaction = …` so the two calls share. Worth carrying as the procedure-level pattern until a transactional helper layer needs to exist.
- **Drizzle's `quantity: numeric(10,3)` round-trips as a string.** Tests asserted on `'10.000'`, `'200.000'`, `'111.000'` — Postgres pads the trailing zeros to the column's scale. Input regex in the schema is `^\d+(\.\d{1,3})?$` (accept 1–3 decimals); output is the padded form. Same for `estimatedCostPerServing` (`numeric(10,2)`, padded to `.00`). If a future field uses `numeric` and the test asserts on un-padded input strings, the test will fail — pad to scale or compare with `Number(...)`.
- **`updateHeader` returns `{ id }` only.** The procedure is "did the write happen for this id"; callers refetch via `recipes.get` if they need the new state. The `ingredients.update` procedure (FEAT-17) returns the full row; the asymmetry is intentional — recipe header reads are joined (sourceName, plant points), and re-deriving them on every patch is wasteful. Pattern for the editor (FEAT-21): optimistic update via `setQueryData`, fire `updateHeader`, on success invalidate `recipes.get` rather than reading the response.
- **`replaceIngredients` allows the same `ingredientId` twice with different `prepTypeId`.** Tested explicitly. DB has no unique constraint on `(recipe_id, ingredient_id)` for this reason (plan.md line 219). The editor (FEAT-21) needs to mirror this — don't dedupe by ingredient id in the list editor.
- **In-transaction rollback test uses a non-existent `prepTypeId` (99999) to trigger an FK violation *inside* the INSERT.** Pre-flight validates the ingredient FK + unit; to test the rollback path, you need a failure that fires *after* the DELETE has run. `prepTypeId` works because it's optional / unvalidated up front. Worth carrying: if you add pre-flight checks that include prep types, the rollback test will need a different failure vector.
- **`makeContext()` in the test file was NOT extended.** I considered adding `withTransaction` to `AppContext` but chose the inline factory instead (see kick-off decisions); the existing 4 test files' `makeContext` shapes are unchanged. Future read: if FEAT-21+ ever centralises transaction access on the context, those test files will all need one new field.
- **Filenames and `describe()` strings don't reference "FEAT-20" anywhere.** Memory-pinned rule observed.
- **The fixture-update tax from FEAT-18 didn't re-fire this session.** Adding new procedures to `recipesRouter` doesn't change `AppContext` or `Config`, so the test scaffolding stayed identical. Worth carrying as a positive signal: extending an existing router is the cheapest surface to grow.

### Spec ambiguities resolved here (don't re-litigate)

- **`isBase` allowed at create, not at update.** See decisions.
- **`baseRecipeId` and `pairedRecipeId` not in any FEAT-20 input.** See decisions.
- **`estimatedCostPerServing` in the `updateHeader` patch set.** Q7 of kick-off.
- **Unit mismatch is `BAD_REQUEST` with structured `cause`, not `CONFLICT`.** Spec said `BAD_REQUEST` literally; tRPC code + domain code on cause is the FEAT-17 pattern.
- **Method step numbering is server-side 1..N.** Q4 of kick-off.
- **`null` clears, `undefined` skips.** Q5 of kick-off.
- **`softDelete` doesn't check for dependent batch-versions.** Q6 of kick-off; FEAT-23 owns the visibility rule.

### Open items for downstream FEATs

- **FEAT-21 (Recipe Editor UI)** consumes these mutations directly. Section saves: header → `updateHeader`; ingredient list → `replaceIngredients`; method → `replaceMethod`; image upload → Cloudinary direct (FEAT-18) → `updateHeader({ imageUrl })`. The unit enforcement at the procedure boundary is the safety net; the editor's per-line unit display + form validation is the UX. The "discard draft" flow (FEAT-22) needs to know that `replaceIngredients([])` clears the list — same semantics as a saved-empty recipe.
- **FEAT-22 (Recipe draft autosave)** can rely on `recipes.create` returning `{ id }` to flip the draft from `(user, NULL)` keyed to `(user, recipeId)` keyed. The draft's `version` field needs to track the editor's field set; today the FEAT-20 surface is the union of the writable header columns + the two replace lists.
- **FEAT-23 (batch-cooking model)** will extend two surfaces touched here:
  1. Reopen `updateHeader` to accept `isBase` / `baseRecipeId`, and add a parallel "set pairing" procedure (probably `setPairedRecipe`) that owns the symmetry transaction. The XOR CHECK (`NOT (is_base AND base_recipe_id IS NOT NULL)`) will catch malformed combos; the transaction handles the case of repairing A→B as A→C.
  2. The `pickable-recipes` helper's `includePickerHidden` flag becomes operational — soft-deleted bases hide their batch-versions from new pickers.
  - Don't ship FEAT-23 without re-reading the FEAT-20 schema: the writable header shape today *excludes* `isBase`/`baseRecipeId` by design, and the `updateHeader` test pins that rejection. FEAT-23 will reshape both.
- **FEAT-24 (recipe deletion + restore UI)** wires `softDelete` / `restore` to the editor's delete affordance and a "trash"-like view via `recipes.list({ includeDeleted: true })`. No procedure change expected.
- **Open hole: `recipe_sources` cross-household.** `updateHeader` accepts a `sourceId` and lets the FK confirm existence — it does *not* verify the source row belongs to `CURRENT_HOUSEHOLD_ID`. A motivated caller could pin another household's source row to one of their recipes. Low risk in single-household MVP but a real DEC-17 hole. Likely fix: whichever FEAT introduces source management (probably FEAT-21's source picker, or a dedicated source-CRUD FEAT) adds a household scope check. Captured here so it isn't lost; called out at task completion.
- **`addedByUserId` is set on `create` from `ctx.user.id` and never written by `updateHeader`.** That matches DEC-17 ("`addedBy`/`createdBy` are informational — never authorisation predicates"). If a future FEAT thinks it needs to "transfer ownership," it should think hard about whether that's a household-level concern (rejected by DEC-17's single-household scope) before adding a write path.
- **Unit-mismatch domain code is consumable by the editor.** Domain error path: `TRPCError.code === 'BAD_REQUEST'` + `cause.code === 'RECIPE_INGREDIENT_UNIT_MISMATCH'` + `cause.expectedUnitId` / `cause.providedUnitId` / `cause.ingredientId`. FEAT-21's per-line error rendering can read those keys to compose "expected `g`, got `piece`" inline. The `getDomainErrorCode` helper in `lib/domain-error.ts` (FEAT-17) is the entry point.

---

## 2026-06-09 — FEAT-19 (Recipe read procedures + browse view)

**Status:** implementation complete; not yet committed. `pnpm -r typecheck`, `pnpm -r lint` clean across all three workspaces. Frontend: 12 files / 64 tests pass (8 new in `recipes-page.test.tsx`, 4 new in `recipe-detail-page.test.tsx`). Backend: 178/179 tests pass (17 new in `recipes-procedures.test.ts`, all green). The one failing test — `user-procedures.test.ts > updateProfile > bumps updatedAt via $onUpdate` — is a pre-existing millisecond-race flake on `$onUpdate(() => new Date())` granularity (not touched by FEAT-19; reproducible by running that file alone). Testcontainers ran via the same Colima socket workaround as FEAT-17/18: `DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock` + `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Definition-of-done boxes in `docs/feature-specs.md §FEAT-19` left unticked — human action. The manual gate check (load `/recipes` after `pnpm --filter backend seed`, search, click a card, verify `is_deleted = true` row disappears from the list but renders on the detail page) is owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **`recipes.search` folded into `recipes.list`, not a separate procedure.** The FEAT-19 Goal sentence names three procedures (`list`, `get`, `search`); the acceptance criteria describe only two (`list` with a `search?` filter, `get`). One trigram-backed `list` query serves both browse and picker contexts, avoiding a parallel code path that would drift. Captured as Q2 of the kick-off Ask block; user confirmed.
- **`includePickerHidden` accepted on the input schema today as a no-op.** The batch-version-of-soft-deleted-base rule lives in FEAT-23. Defining the flag now means FEAT-23 fills in the rule without reshaping `listRecipesInputSchema` (which is type-exported and consumed across the workspace boundary via `AppRouter`). The helper `pickableRecipesWhere` accepts the option and currently ignores it — `void options.includePickerHidden` documents the intentional skip and prevents an unused-import lint flake.
- **`pickable-recipes` helper exposes a Drizzle WHERE fragment, not a full subquery.** `pickableRecipesWhere(options): SQL` returns an `and(...)` that callers AND into their own WHERE — keeps the helper composable with cursor pagination, search, and any future per-call predicate. Caller still owns `from(recipes)` and the ORDER BY. Worth carrying: when FEAT-23 adds `isBase` and the picker-hidden rule, neither needs the caller's query shape to change.
- **Keyset pagination over `(lower(name), id)`, not offset.** Same ordering as the ORDER BY, so cursor comparison is exact. Cursor shape is `{ lowerName: string; id: number }` — fetch `limit + 1` to learn whether `nextCursor` should be non-null without a second `count(*)` round-trip. UI doesn't surface a page control yet; the wire shape is there so the recipe-bank (FEAT-31) and the slot-editor picker (FEAT-31/32) can grow into it without a procedure version bump. Confirmed at kick-off Q4.
- **Plant-points helper lives in `backend/src/lib/plant-points.ts` and exposes both a correlated SQL fragment and a standalone evaluator.** `recipePlantPointsExpr(outerRecipeIdSql)` for inline use in the list / get SELECT; `selectRecipePlantPoints(db, recipeId)` for tests + one-off reads (and the day/plan composition in FEAT-40 will compose the fragment, not the helper). FEAT-40's traversal layer (batch-version meals + base-cook union + dedup) is *new*; this helper is the building block, kept pure and small per cross-cutting concern #10.
- **Recipe DTO split into `recipeListItemSchema` and `recipeSchema`** in `shared/src/schemas/recipes.ts`. The list shape is what every picker / browse / recipe-bank consumer reads; the detail shape extends it with macros, source name, joined ingredients + method, and rating aggregates. Adding fields is cheap, restructuring is invasive — calling out the boundary now (cross-cutting concern #9) saves the editor (FEAT-21), the planner sidebar (FEAT-31), the related-recipes UI (FEAT-26), the base picker (FEAT-32), and the shopping-list aggregation (FEAT-36) from each redefining their own DTO. `plantPointsCount` lives on the list DTO because it's cheap server-side and useful on cards; ratings stay on `get` only (Q4 of kick-off).
- **Detail read view shipped (`/_authed/recipes/$recipeId`), not stubbed.** Spec said "no editor yet — show a read view or stub". A real read view exercises `recipes.get` end-to-end before FEAT-21 lands; it also surfaces the NOT_FOUND flow against the route. Plain-text everywhere (DEC-49). No rating UI, no edit affordances — FEAT-21/27/29 fill those.
- **Dev fixtures split into `runDevSeeds` so tests keep using `runSeeds` unchanged.** `runSeeds` (household + reference) is what tests share; `runDevSeeds` (sample ingredients + 2 recipes) is invoked only from `scripts/seed.ts`. Tests would have collided on the seeded `Onion` ingredient otherwise (`recipes-schema.test.ts` builds its own `Onion`). Cleaner than gating on `NODE_ENV` inside the seed body.
- **Procedure file path: `backend/src/trpc/procedures/recipes.ts`.** Spec text said `routers/recipes.ts`; same drift as FEAT-15/16/17/18. Followed codebase convention.

### Drift from kick-off plan

1. **Dropped `dateAdded` / `dateLastUpdated` from the DTOs after a typecheck failure.** I drafted both schemas with `z.coerce.date()`, expecting tRPC's default (transformer-free) serializer to round-trip the JS `Date` from Drizzle's `date(mode: 'date')` column. It doesn't — the wire payload is a string, but the Zod output type is `Date`, and the frontend type from `AppRouter` got `Date` while the runtime value was a string. Two fixes were on the table: (a) add a superjson transformer to tRPC (substantive, threads through every procedure + every cache rule) or (b) drop the date fields, since nothing in FEAT-19's surfaces actually uses them. Took (b). If a downstream FEAT needs created/updated timestamps (e.g. the recipe-bank's "recently added" sort) we'll either add a transformer then or type the fields as ISO strings end-to-end (cheaper, narrower change). Avoiding the transformer also keeps the PWA cache (FEAT-41) honest — its rules match on JSON, not superjson envelopes.
2. **Plant-points subquery hit "column reference \"id\" is ambiguous" first.** Inside a `sql` template literal, Drizzle renders column references *bare* (no `table.` prefix), so the join condition `${ingredients.id} = ${recipeIngredients.ingredientId}` became `"id" = "ingredient_id"` — three `id` columns in scope (outer `recipes`, inner `recipe_ingredients`, inner `ingredients`). Fix: spell out `<table>.<column>` literally inside the template, and require the outer-recipe id reference to be a qualified SQL fragment (callers now pass `sql\`recipes.id\``, not `recipes.id`). Captured in a comment on `recipePlantPointsExpr`. Worth carrying: **inside `sql\`...\`` templates, treat Drizzle column references as bare identifiers and qualify them yourself.** This will bite anyone writing correlated subqueries; the safe rule is "if your subquery joins more than one table, every column in the template is a string-literal."
3. **`recipes.list` returns a paginated *result envelope* (`{ items, nextCursor }`) rather than a bare array.** `recipes.list.useQuery` consumers must read `data?.items ?? []`. `ingredients.list` returns a bare array; that asymmetry is intentional (ingredients is small enough not to need cursors and the helper signature would have been overkill) but worth flagging because mental-model spillover is easy.
4. **Nav placement: "Recipes" sits between "Home" and "Ingredients" in `authed-layout.tsx`.** Plan said "between Home and Ingredients"; landed there. No tests on the nav directly — the existing `authed-layout.test.tsx` doesn't exhaustively enumerate links. If we want a regression guard against accidental nav removal, that test is the place — defer until we add a fourth link.

### Implementation details worth carrying

- **Drizzle `count(...)` static type is `number` but runtime is `string` (Postgres bigint).** Casting to `Number(row.count)` trips `@typescript-eslint/no-unnecessary-type-conversion`. The fix is a `sql<number>\`count(...)::int\`` cast at the SQL level, making the runtime value match the static type. The avg() column carries the `string | null` type honestly, so `Number(row.avg)` is fine and lint passes. Pattern worth carrying to any future aggregate procedure.
- **`avg(rating)` returns `string | null` from Drizzle**; `null` when there are no rows. The DTO surfaces `averageRating: number | null` — test "returns null aggregates when there are no ratings" + "aggregates ratings and surfaces the caller's own rating" both pin this behaviour.
- **`yourRating` uses a `max(case when ... then rating end)` over the same aggregate query.** Avoids a second round-trip. Postgres returns the value as a number (since `rating` is `smallint`); the DTO carries it as `1..5 | null`. Tested by inserting two raters and switching the caller via `makeContext({ userId: OTHER_USER_ID })`.
- **The four-way `get` parallel queries (header + ingredients + method + rating aggregate)** are independent; `Promise.all` keeps total latency to the slowest single query. Worth carrying: future write procedures (FEAT-20) won't parallelise like this — they'll use `withTransaction` — but read procedures should default to "fan out independent queries, then assemble."
- **TanStack Router's auto-code-split plugin requires route files under `routes/*.tsx` to export only `Route`.** I created both `recipes/index.tsx` (browse) and `recipes/$recipeId.tsx` (detail) as thin shells; the page components and any future `beforeLoad` live in `routes/-components/`. Re-confirms the AGENTS.md rule.
- **Frontend tests mock `@tanstack/react-router`'s `Link` and `useParams` rather than rendering a real router.** Mirroring this pattern lets the page component tests stay focused on data flow / rendering instead of router setup. Captured in `recipes-page.test.tsx` and `recipe-detail-page.test.tsx`.
- **`TRPCClientError.data?.code` reads as `any` under strict-type-checked ESLint.** Worked around with a small `isNotFoundError(error: unknown)` helper that does the `instanceof` check + a narrow `as { data?: { code?: unknown } }` cast. Same trick the existing `lib/trpc.ts` link uses; lint accepts the typed-cast version but not the inline accessor. If a third surface needs this, fold the helper into `lib/domain-error.ts` (it already houses the related `getDomainErrorCode`).
- **`Number.parseInt` on the route param + a positive-integer guard.** The route is `/recipes/$recipeId` (string param); the procedure expects a positive int. The detail page treats any non-positive-integer param as NOT_FOUND without firing the query (`enabled: idIsValid`). Worth carrying for FEAT-21's editor route (`/recipes/$recipeId/edit`).
- **Filenames and `describe()` strings don't reference "FEAT-19" anywhere.** Memory-pinned rule observed.

### Spec ambiguities resolved here (don't re-litigate)

- **Procedure surface: `list` + `get`** (no separate `search`). See decisions.
- **`includePickerHidden` accepted but no-op until FEAT-23.** See decisions.
- **Detail read view: real route, not a stub.** Q4 of kick-off.
- **Pagination: keyset cursor over `(lower(name), id)`, no UI control yet.** Q4 of kick-off.
- **`plantPointsCount` on the list DTO.** Q4 of kick-off.
- **Dev recipe seed: 2 fixtures (Tomato pasta, Roast chicken with veg).** Q4 of kick-off.
- **Date fields: not on the DTOs** (see drift item 1). Reopen only if a downstream FEAT actually needs them; pair with the superjson decision.

### Open items for downstream FEATs

- **FEAT-20 (write procedures) consumes the same file** — `backend/src/trpc/procedures/recipes.ts`. The spec already says "extends FEAT-19 file." `create`, `updateHeader`, `replaceIngredients`, `replaceMethod`, `softDelete`, `restore` land there; all multi-statement work goes through `withTransaction` per cross-cutting #4. The unit-mismatch boundary check on `replaceIngredients` (per-line `unit_id` must equal the ingredient's `default_unit_id`) is the integrity guarantee — the editor's form validation in FEAT-21 is UX, not authority.
- **FEAT-21 (Recipe Editor) consumes `recipes.get` for hydration** and the FEAT-20 mutations for partial saves. The detail page shipped here renders the same DTO the editor will read — no shape change expected. The image upload flow established in FEAT-18 plugs into `header.imageUrl` via `recipes.updateHeader` (FEAT-20). Direct browser→Cloudinary, then `updateHeader({ imageUrl })` once Cloudinary returns `secure_url`.
- **FEAT-23 (batch-cooking model)** will:
  1. Extend `pickableRecipesWhere` with the batch-version-of-deleted-base rule (use `includePickerHidden`).
  2. Accept the `isBase` parameter on the helper (use the picker for `is_base = true` only).
  3. Possibly add `baseRecipeId` / `pairedRecipeId` aggregates on the list DTO if pickers need them. Today both fields are returned plainly.
- **FEAT-26 (related recipes)** reuses the same picker helper for the "what can I link to?" query — no new helper needed.
- **FEAT-31 (planner sidebar / recipe bank)** consumes `recipes.list` directly. The keyset cursor shape is the contract; if the recipe bank needs a virtualised infinite list, `useInfiniteQuery` over `{ cursor, limit }` is the path. No procedure change expected.
- **FEAT-40 (day + plan plant points)** composes `recipePlantPointsExpr` at the day/plan level with the batch-traversal rules (FEAT-23). Keep this helper pure (no household scoping, no date logic) — that's the contract the day/plan computation relies on.
- **Superjson / date-on-the-wire decision is deferred.** If two downstream FEATs need real `Date` types over the wire (recipe-bank "recently added" sort + planner created-at filter, say), the cheapest change is to type those fields as ISO strings in the DTO and add a single `parseISO()` at the consumer. Adding a transformer to tRPC is a substantive change (every cache rule, every test fixture) and we should defer it until the cost of NOT having it is concrete. Open question; capture before FEAT-31 or FEAT-34.
- **`pickable-recipes` helper has no test file of its own** — its behaviour is exercised through `recipes.list` (includes-deleted and excludes-deleted assertions). If FEAT-23's extensions get gnarly enough, peel out `pickable-recipes.test.ts` and exercise the WHERE in isolation; the helper is small enough today that a procedure-level test is the right tool.

---

## 2026-06-08 — FEAT-18 (Cloudinary signed-upload procedure)

**Status:** implementation complete; commit `d07395e` on `main`. `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across all three workspaces. Backend: 39/39 non-container tests pass (6 new in `cloudinary-sign.test.ts`, 4 new in `uploads-procedures.test.ts`, plus the inherited `config` + `server` suites). The 7 Testcontainer suites didn't run in this session (Colima socket couldn't bind-mount into the Ryuk reaper — same env caveat as FEAT-17's session note); rerun locally with `DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock` + `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock` to confirm no regressions. Definition-of-done boxes in `docs/feature-specs.md §FEAT-18` left unticked — human action. The manual gate check (real `curl` POST to `api.cloudinary.com/v1_1/<cloud>/image/upload` with returned credentials, plus a >5 MB and a `.gif` rejection probe) is owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Hand-rolled SHA-1 signer over the official `cloudinary` SDK.** The package is CJS-only (no `"type": "module"`, no `exports.import`), which is a DEC-01 stop-and-ask. The signing surface we need is ~15 LOC against Node's `crypto.createHash('sha1')`; pulling in the SDK would buy us upload/admin helpers we don't use and break the ESM-only constraint. The SDK door is still ajar if a later FEAT needs admin operations (asset deletion, transformations), but the signer alone doesn't justify the dep. Captured in the implementation: `backend/src/lib/cloudinary.ts` is dep-free.
- **Cloudinary creds threaded through Fastify `decorate` → `AppContext`, mirroring the `db` pattern.** Second consumer of the decorate-and-augment pattern established in FEAT-16. `app.decorate('cloudinary', { cloudName, apiKey, apiSecret })` in `server.ts`; `req.server.cloudinary` read in `createContext`; `FastifyInstance` + `AppContext` augmented in `trpc/context.ts`. Alternatives considered: (a) lazy `loadConfig()` at module top of `uploads.ts` à la `db/index.ts` — rejected because it makes procedure tests env-var-coupled at import time; (b) router-factory `createUploadsRouter(config)` — rejected because it cascades through every `appRouter` import site. Decoration keeps the test context plain-object-shaped: tests build `AppContext` with mock `cloudinary` and call `appRouter.createCaller(ctx)` exactly as for `db`.
- **Locked constants live in `shared/src/schemas/uploads.ts`, exported as constants AND used as Zod `z.literal()`s.** `RECIPE_IMAGE_FOLDER`, `RECIPE_IMAGE_MAX_FILE_SIZE`, `RECIPE_IMAGE_ALLOWED_FORMATS`, `RECIPE_IMAGE_EAGER_TRANSFORMATION`. The procedure imports the constants to build the signed payload AND the test re-derives the signature using the same constants — so any drift in the locked values breaks the test, not just the wire shape. The schema's `z.literal()` walls mean the frontend can't accidentally claim a wider contract than what's signed.
- **`getRecipeImageCredentials` is a `query`, not a `mutation`.** Side-effect-free at our boundary (no DB write, no external API call) — minting a signed string is pure. Cloudinary considers the credential "used" only when a real upload arrives, and even then the constraint is the `timestamp` window (~1h tolerance), not "single use." Marking it a query also lets TanStack Query auto-refetch on stale (relevant once FEAT-21's editor mounts), which is the desired behaviour: the credentials should be fresh when the user actually clicks "upload."
- **`folder = loftys-larder/recipes` and `eager = c_fill,w_1200,h_900,q_auto,f_auto`.** Folder name is the project slug under Cloudinary's default root; eager transformation pre-generates a 4:3 1200×900 crop with auto quality/format. The eager value is somewhat arbitrary (the spec said "a fixed eager transformation" without dictating dimensions); 4:3 was picked because recipe cards in FEAT-19 will be card-shaped, not square. Changeable later — but the constraint is that **changing the eager value won't retroactively re-derive existing assets**; new uploads only. If the recipe card layout shifts in FEAT-19, decide before users have uploaded enough to make a re-upload painful.
- **No `CLOUDINARY_UPLOAD_PRESET` env var.** The FEAT-18 spec said "or signed params" — we chose signed params. The preset path would put the constraints in the Cloudinary dashboard (operator action, not code); the signed-params path keeps the constraints in the repo and the signing path. Signed params win on transparency; preset wins only if we wanted ops to flip constraints without a deploy, which we don't.
- **Procedure test skips the Testcontainer.** The procedure does zero DB I/O, so spinning up Postgres just to assert auth gating + signature shape would inflate the suite for no signal. The `makeContext` helper still mirrors `user-procedures.test.ts` line-for-line (same session/user shape) — only `db` is `{} as AppContext['db']` since it's never read. Worth carrying: container-free procedure tests are valid when the procedure provably doesn't touch the db; default is still container-backed.

### Drift from kick-off plan

1. **Fixture sprawl: five test files needed CLOUDINARY env vars / context fields added.** `config.test.ts`, `auth.test.ts`, and `server.test.ts` build `Config` literals (now requires three more strings); `user-procedures.test.ts` and `ingredient-procedures.test.ts` build `AppContext` literals (now requires `cloudinary`). Plan listed three test files; reality was five. Mechanical follow-on of adding a required field to `Config` and `AppContext`. Worth recording because every subsequent FEAT that extends either type will pay the same fixture-update tax — if a third consumer of `AppContext` lands (say, a per-request feature flag), consider whether to keep extending the literals or to introduce a `makeAppContext({ overrides })` factory in a shared test helper.
2. **`UNSIGNED_PARAMS` set is the canonical list of exclusions.** Spec only named `file`; Cloudinary's signing rules actually exclude five: `file`, `cloud_name`, `resource_type`, `api_key`, `signature`. The unit test asserts all five are stripped — surfaced during test design, not implementation. Reference: https://cloudinary.com/documentation/signatures. Don't trim this set.
3. **Frontend untouched.** Not drift from the FEAT-18 plan (FEAT-18 is backend-only) but worth flagging: the frontend has no consumer of `appRouter.uploads.*` yet. The `AppRouter` type re-export will pick it up automatically once FEAT-21 lands. No frontend chunk size change expected.

### Implementation details worth carrying

- **Cloudinary signing algorithm, codified.** Take every param the client will POST except `file`, `cloud_name`, `resource_type`, `api_key`, `signature`; sort keys alphabetically; join as `k=v&k=v` (no URL-encoding); append the API secret directly (no separator); SHA-1 hex digest. Reference vector in `cloudinary-sign.test.ts` should survive any future SDK swap.
- **Cloudinary's wire-side param names are snake_case** (`allowed_formats`, `max_file_size`, `folder`, `eager`, `timestamp`) — the signature is computed over those exact names. Our tRPC wire shape is camelCase (`allowedFormats`, `maxFileSize`, …) because that's the project convention (DEC-15). **FEAT-21's frontend uploader must re-snake the field names when building the multipart body** — `formData.append('allowed_formats', allowedFormats.join(','))`, etc. — or the signature will mismatch and Cloudinary will 401 every upload. This is the most likely client-side trap; trap-worthy of an AGENTS.md row once FEAT-21 lands.
- **Cloudinary `timestamp` is Unix seconds at UTC**, not domain time. `Math.floor(Date.now() / 1000)` is the right call. The procedure has a one-line comment explaining why `dateUtils` (Europe/London, DEC-33) doesn't apply — pre-empts the future linter pass that searches for `Date.now()` in backend code.
- **`AppContext` now has a required `cloudinary` field that wasn't there before this FEAT.** Plus the augmented `FastifyInstance`. Any future test scaffolding that constructs an `AppContext` literal must include `cloudinary: { cloudName, apiKey, apiSecret }`. TS catches missed sites at typecheck; the failure mode is `Property 'cloudinary' is missing in type '…' but required in type 'AppContext'`. Don't fix that with `as AppContext` casts — fill the field.
- **`pnpm prettier --write` is the cleanup path after `Write`.** Two newly-written test files tripped `format:check`; one `pnpm prettier --write <files>` fixed both. Husky's `lint-staged` would have caught this at commit time anyway, but pre-commit cycles are slow; run `format:check` proactively after creating files.
- **`z.tuple([z.literal(...), ...])` for `allowedFormats`** locks not just the items but the *count and order*. If a future FEAT adds `avif` or `heic`, the constants AND the schema tuple both need updating in lockstep — that lockstep is the feature, not a maintenance burden.

### Spec ambiguities resolved here (don't re-litigate)

- **"Use Cloudinary's official SDK helper if available" vs hand-rolled** — chose hand-rolled (CJS dep + ESM-only constraint, see decisions).
- **"or signed params" vs `CLOUDINARY_UPLOAD_PRESET`** — chose signed params; no preset env var.
- **Eager transformation value** — fixed at `c_fill,w_1200,h_900,q_auto,f_auto` (see decisions). Revisitable in FEAT-19 if the card layout dictates otherwise; revisitable becomes painful once recipe images accumulate.
- **Folder namespace** — fixed at `loftys-larder/recipes`. If FEAT-21 ever introduces a second image type (e.g. user avatars), use a sibling folder under the same prefix (`loftys-larder/users`) and a sibling procedure (`uploads.getUserImageCredentials`) — don't overload this one.
- **Output procedure type** — `query`, not `mutation` (see decisions).
- **Folder/procedure file name** — `procedures/uploads.ts` (codebase convention) over the spec's `routers/uploads.ts`. Same drift as FEAT-15/16/17.

### Open items for downstream FEATs

- **FEAT-20 will persist `image_url` on the recipe row via `recipes.update`.** Cloudinary's upload response returns `secure_url` (HTTPS-only) — that's the field to store, not `url`. The PWA cache rules (FEAT-41) match `res.cloudinary.com` for `img-src` (DEC-46 CSP already includes it), so served images won't need any further wiring.
- **FEAT-21 (Recipe Editor) consumes `uploads.getRecipeImageCredentials`.** The flow: call the query → POST `multipart/form-data` to `https://api.cloudinary.com/v1_1/<cloudName>/image/upload` with fields `{ file, api_key, timestamp, signature, folder, allowed_formats, max_file_size, eager }` — **snake_case keys** (see implementation note). Cloudinary's response is JSON with `secure_url`; pass that to `recipes.update`. No proxying through the backend (DEC-50). Direct browser → Cloudinary keeps the Fly machine's request-body budget intact.
- **Orphan cleanup is a non-goal in v1** (DEC-50). If a user gets credentials, uploads, then abandons the recipe edit, the asset sits in Cloudinary forever. Free-tier storage covers household-scale; revisit only if Cloudinary's billing or asset-clutter gets visible. If we ever build the cleanup job, it'd be a nightly worker that diffs Cloudinary's asset list against `recipes.image_url` — but it's a non-goal so don't.
- **Better Auth `protectedProcedure` is the only auth surface here.** No rate-limit on credential minting yet. FEAT-45's `@fastify/rate-limit` should cover `uploads.*` alongside the magic-link endpoint — a credential mint isn't expensive, but it costs Cloudinary if a misbehaving client floods uploads, so a modest per-user limit (10/min?) is a defensive default. Not enabled now.
- **`AppContext.cloudinary` is the second consumer of the decorate-and-augment pattern.** If a third arrives (e.g. a feature-flag client, a Sentry-tagged logger, a per-request `dateUtils.now()` injection), consider whether to keep adding to `AppContext` directly or introduce a `services` namespace (`ctx.services.cloudinary`, `ctx.services.flags`, …). At two consumers it's fine flat; at four it'd benefit from grouping. Just don't reach for the namespace until the third consumer makes the case.
- **Operator action before next prod deploy.** Three new env vars are required (no defaults); the next deploy after this PR merges will crashloop without them. Set in Fly:

  ```sh
  flyctl secrets set \
    CLOUDINARY_CLOUD_NAME="<your-cloud-name>" \
    CLOUDINARY_API_KEY="<your-api-key>" \
    CLOUDINARY_API_SECRET="<your-api-secret>" \
    --app loftys-larder-prod
  ```

  Sandbox a separate Cloudinary account for dev/CI — don't share the prod API secret. The free tier gives 25GB storage + 25GB bandwidth/month, easily comfortable for household scale.

---

## 2026-06-08 — FEAT-17 (Ingredient CRUD + Dictionary view)

**Status:** implementation complete; `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean. Frontend tests 52 / 52 (18 new across `ingredients-page`, `ingredient-form`, `domain-error`). Backend tests 151 / 152 — 23 new ingredient-procedure cases all pass; the one failure is the pre-existing `user-procedures > bumps updatedAt via $onUpdate` timing flake, **not** introduced here (recurs across sessions; tracked but not blocking). Definition-of-done boxes in `docs/feature-specs.md §FEAT-17` left unticked — human action. Manual gate check (add → edit → search → delete with `INGREDIENT_IN_USE` surface against an active recipe and again against a soft-deleted recipe) owed by the human; agent cannot drive a browser.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Domain-error mapper lives in `frontend/src/lib/domain-error.ts`, not inside the tRPC link.** Cross-cutting #11 reads "add to the error link a single mapper to a typed UI error." Rewrapping inside the link interferes with TanStack Query's error caching (the cached error shape would diverge from what `mutateAsync` rethrows). The accessor pattern — `getDomainErrorCode(error)` → `DomainErrorCode | null` — gives the same typed surface at the consumer call-site without touching the request pipeline. Form/page consumers branch on the returned code; the link stays a pure transport.
- **Cause shape surfaced via `errorFormatter` in `backend/src/trpc/init.ts`.** Default tRPC strips `cause` from the wire payload. The formatter validates `error.cause` against `domainErrorCauseSchema` and, if it parses, copies it onto `shape.data.cause`. This is the *only* place the cause crosses the boundary; the frontend helper reads from this exact path. If the cause doesn't parse (e.g. accidentally non-domain error), the formatter no-ops and the default shape goes through. Adds zero overhead on the success path.
- **Uniqueness constraint chosen over pre-flight `SELECT`.** `(household_id, lower(name))` `UNIQUE` (migration `0003_glorious_silvermane.sql`). Race-safe by construction; pre-flight check could lose to a concurrent insert. Procedures catch PG SQLSTATE `23505` and translate to `CONFLICT + INGREDIENT_NAME_TAKEN`. Two households can each have an "Onion" — uniqueness scopes to the household, matching DEC-17.
- **Cause-chain walk on PG-error detection.** Drizzle wraps driver errors in `DrizzleQueryError`; the original pg error sits on `.cause`. `isUniqueViolation` walks up to 5 cause levels checking `code === '23505'` + matching `constraint`. Inspecting just the top error misses the wrap and silently falls back to `INTERNAL_SERVER_ERROR`. (Found this in test — first run failed the rename-collision case until the unwrap landed.)
- **In-use check joins `recipe_ingredients` with no `is_deleted` filter on `recipes`.** Soft-deleted recipes still pin the ingredient — past meal plans reference them (DEC-21, cross-cutting #5, #19). Implementation is a single `SELECT 1 FROM recipe_ingredients WHERE ingredient_id = $1 LIMIT 1` — no join needed because `recipe_ingredients` rows can't outlive their recipe under the current FK (restrict on both sides), so any reference at all is a conflict.
- **shadcn `Dialog` (Radix) added as the first Radix dep.** Stop-and-ask threshold cleared because the acceptance criterion explicitly requires "add-new dialog, edit dialog, delete with confirm". Native `<dialog>` + `window.confirm` were considered and rejected: the delete-confirm needs to *keep the dialog open* and re-render with the `INGREDIENT_IN_USE` message inline, which `window.confirm` can't do. One Dialog primitive covers all three use cases; `AlertDialog` was *not* added — the delete dialog is just a `Dialog` with destructive button styling.
- **No shadcn `Select`.** Category + unit dropdowns are native `<select>` styled with Tailwind. Same calculus as FEAT-16's radios: avoid `@radix-ui/react-select` until a FEAT genuinely needs combobox behaviour (FEAT-21's searchable combobox primitive is the right place).
- **Backend procedures live in `procedures/ingredients.ts`, not `routers/ingredients.ts`.** Spec said `routers/` but the project established `procedures/` in FEAT-15/16. Codebase convention wins; if we ever do migrate this directory, one rename PR, not piecemeal.
- **List response is *flat* denormalised** (`{ categoryId, categoryName, defaultUnitId, defaultUnitName, ... }`), not nested. Easier to render in a table, fewer wrapper objects in test assertions. The denormalisation is server-side — a single query with two `innerJoin`s — so the wire payload doesn't pay for it on render.
- **`getDomainErrorCode` reads `error.shape.data.cause` directly.** Could have used `error.data` (the tRPC client mirror of `data`), but `shape` is the canonical envelope. Documenting because it looks like indirection — it isn't.

### Drift from kick-off plan

1. **Added `ingredients.references` query (returns `{ categories, units }`).** Not in the FEAT-17 spec. Form dropdowns need the full list of categories + units; there's no existing reference endpoint. Two options were live: add a separate `references` router (clean but out-of-scope) or bundle into ingredients (small surface, in-scope). Chose the bundle. When FEAT-21 (recipe editor) wants the same data + `preparation_types`, promote to a dedicated `reference` router — that's the right time, not now.
2. **Nav link added in `authed-layout.tsx`.** Layout was a bare `<Outlet />` before; now it renders a top nav with Home / Ingredients / Settings. FEAT-16's session-notes flagged "settings page is URL-only" as an open item — partially closed here, but the proper navigation shell is still owed to a later FEAT (PWA shell or similar). Treat this nav as scaffolding, not the final IA.
3. **Frontend `lib/trpc.ts` not modified.** Spec listed it as a file to touch ("extend the error link to surface domain codes"). The domain-code mapper lives in `lib/domain-error.ts` instead (see kick-off decision). `trpc.ts` keeps the `httpBatchLink` URL shape untouched (cross-cutting #16) and the `unauthorizedRedirectLink` unchanged.
4. **Two test files use non-null array destructuring instead of `!`.** ESLint config forbids `@typescript-eslint/no-non-null-assertion`. Pattern: `const [a, b] = arr; if (!a || !b) throw new Error('seed failed'); …` — works around the rule cleanly and gives a real error message when seeding breaks. Copy this for any future Testcontainers test that needs a known-non-empty `.returning()`.
5. **Form's `nameError` prop is a separate channel from RHF errors.** RHF owns client-side validation; the page-level mutation handler catches `INGREDIENT_NAME_TAKEN` and pushes the message in via a `nameError` prop. The form's `useEffect` calls `form.setError('name', { type: 'server', message })`. This is the pattern for any future form that needs to surface a server-side field-scoped conflict.

### Implementation details worth carrying

- **Pattern for `CURRENT_HOUSEHOLD_ID` scoping established here.** Every read: `eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID)` in the `where` clause. Every write that targets an id: include both `eq(ingredients.id, id)` AND the household clause — that's how cross-household ids get treated as `NOT_FOUND` rather than 200 OK. Copy this exact shape for every domain procedure from FEAT-19 onward. (DEC-17, cross-cutting #3.)
- **`domainConflict(code, message, metadata?)` helper.** Returns a `TRPCError` with `code: 'CONFLICT'` and `cause: { code, ...metadata }`. Five-line helper, but it's the convention for every later domain conflict (`SLOT_OCCUPIED`, `DUPLICATE_PAIRING`, etc.). Lifting to `shared/` would create a cycle; leave it inlined where it's used until a third caller appears.
- **`DOMAIN_ERROR_CODES` is a string-literal `as const` array, paired with a `z.enum(...)` schema.** Adding a new code is a one-line append. Both ends (server `cause.code`, frontend `getDomainErrorCode` return type) update in lockstep because the union flows from the same constant.
- **Test seed: insert categories + units inline per `beforeEach`** rather than calling `seedReference`. Lets the test pin specific IDs (`categoryId`, `otherCategoryId`) for cross-household and rename scenarios. The full `seedReference` would seed nine categories + nine units — overkill, and you'd lose the `[cat0, cat1]` destructure pattern.
- **Search query: lower input in TS, use `sql\`lower(${col}) like ${'%' + lowered + '%'}\``.** Both sides lowered — the `pg_trgm` GIN index hits. Drizzle's `ilike` would technically work but doesn't reuse the lower()-functional index. AGENTS.md "common gotchas" called this out; encoded here.
- **`vi.hoisted` mock pattern carried from FEAT-16.** Six mocks for the ingredients page (`references.useQuery`, `list.useQuery`, three mutations, `useUtils`). The `vi.hoisted` block defines them as constants before `vi.mock` runs; the factory closes over them. Reset all six in `beforeEach`. Pattern scales.
- **Form-level `key={editTarget.id}`** on `IngredientForm` inside the Edit dialog. Without it, switching from edit-A → close → edit-B reuses the form state from A; the `defaultValues` change wouldn't reset the inputs. The `key` forces React to remount the form on target change, picking up the new defaults cleanly.
- **`document.documentElement.classList.toggle('dark', active)`** still applies (carried from FEAT-16); ingredient pages inherit the theme automatically via the top-level `dark:` Tailwind variants. No theme work needed per-page.
- **TanStack Router auto-code-split** emitted `ingredients-*.js` chunk at 43.51 kB gzipped to 14.97 kB. The thin route convention earns its keep again — the page component + RHF + dialog all sit in the lazy chunk; the root bundle is unaffected.

### Spec ambiguities resolved here (don't re-litigate)

- **"Joined to category and default unit (denormalised for the dictionary view)"** — interpreted as flat fields, not nested objects (see kick-off decision).
- **"Cap shelf life"** — spec said "optional positive int"; resolved at 3650 days (~10 years) in `ingredientShelfLifeSchema`. Negotiable if a real use-case appears; 0 and `null` are the meaningful sentinels, the high bound is just a sanity cap.
- **"Establish the cause shape (`{ code: string, ...metadata }`) in FEAT-17"** — codified as `domainErrorCauseSchema = z.object({ code: domainErrorCodeSchema }).loose()`. The `.loose()` (Zod 4 alias of `.passthrough()`) keeps arbitrary metadata travelling alongside the code.
- **"Pickable recipes" helper** — out of scope for FEAT-17; the in-use check doesn't filter on `is_deleted`. The helper lands in FEAT-19 (`backend/src/lib/pickable-recipes.ts`).
- **Backend procedures directory naming** (`procedures/` not `routers/`) — see drift item; already established.

### Open items for downstream FEATs

- **`ingredients.references` will outgrow its router.** When FEAT-21 needs `preparation_types` (and possibly `meal_occasions` for the planner), promote to `procedures/reference.ts` with `reference.categories`, `reference.units`, `reference.preparationTypes`, `reference.mealOccasions`. Keep the bundle endpoint (`reference.all`) for forms that need everything in one call. Don't extend `ingredients.references` further.
- **First `INGREDIENT_NAME_TAKEN`-style conflict pattern is now codified.** When FEAT-21 adds recipes, expect parallels: `RECIPE_NAME_TAKEN` (uniqueness on `(household_id, lower(name))` for recipes? or accept duplicates? — open question, lives with FEAT-19/20). FEAT-23's batch-pairing will need `RECIPE_ALREADY_PAIRED`. Same `{ code, ...metadata }` shape, same `domainConflict` helper, same `getDomainErrorCode` on the consumer side.
- **`backend/test/user-procedures.test.ts:197` `bumps updatedAt via $onUpdate` flake.** Recurred again this session. Race: `$onUpdate(() => new Date())` and the surrounding awaits can land in the same millisecond. Fix candidates: bump the `setTimeout` from 20ms → 50ms; or assert `>=` instead of `>` with a separate "different timestamp" assertion; or use `vi.useFakeTimers` to make the gap deterministic. Don't ignore forever; it's eroding signal on every test run.
- **First Radix dep is in.** `@radix-ui/react-dialog`. The FEAT-16 prediction ("account deletion may finally justify the first Radix dep") was beaten by FEAT-17; the calculus shifts slightly — the threshold for the *next* Radix component (`AlertDialog`, `Select`, `RadioGroup`, …) is now lower because the patterns are established. Still stop-and-ask, but the slope is less steep.
- **shadcn `Dialog` component template in `components/ui/dialog.tsx`** is the canonical install. Future shadcn additions (`select`, `dropdown-menu`, `alert-dialog`, …) follow the same pattern: copy the template, swap `ElementRef` for `ComponentRef` (the new React 19 type — old shadcn templates still use the deprecated form; ESLint catches it).
- **Testcontainers env vars on Colima:** `DOCKER_HOST=unix:///Users/conorwarne/.colima/default/docker.sock` + `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Without the second, the Ryuk reaper container fails to bind-mount the host socket and *every* Testcontainers suite fails fast. Document in CONTRIBUTING when that file lands; until then, this entry is the source of truth.
- **Auto-code-split warning at 500kB.** Main `index-*.js` chunk is 516.83 kB minified (159.46 kB gzipped). Not actionable yet; carry the number for trend. Watch how it grows as FEAT-21/26/31 land — the planner + recipe editor will be the biggest entrants.
- **`.claude/settings.json` exists now** (created by `/fewer-permission-prompts` this session). Project-shared allowlist covers the pnpm test/typecheck/lint/format:check matrix + docker read-only. The accumulated `settings.local.json` can be pruned of duplicates at the user's discretion; this entry just notes that the shared file is now the source of truth.

---

## 2026-06-08 — FEAT-16 (Profile settings: name + theme + ThemeProvider)

**Status:** implementation complete; `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format:check` clean across all three workspaces. `pnpm --filter frontend test` green — 34 / 34 (15 new: 8 `theme-provider.test.tsx` + 7 `settings-page.test.tsx`). `pnpm --filter backend test` — the 9 new `user-procedures.test.ts` Testcontainers cases were authored but **not run in this session** because the local Docker daemon wasn't up; the two non-Docker backend test files (`config`, `server`) still pass 29 / 29 with no regressions. Definition-of-done boxes in `docs/feature-specs.md §FEAT-16` left unticked — human action. The manual gate check (toggle theme → refresh → still dark; change name → refresh → persists; system + OS appearance flip → UI follows live) is owed by the human.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Read path: extend Better Auth `user.additionalFields` instead of going through `trpc.user.getMe` only.** `themePreference` is now typed on `ctx.user` (server) and on `session.user` (client). The alternative — keep Better Auth narrow, fetch via `getMe` — would have added a cold-load round-trip and split the read path in two. Cross-cutting #17 ("keep the auth boundary small") is honoured by setting `input: false` so Better Auth's sign-up/update payloads can't write the field: domain writes still flow through `trpc.user.updateProfile` only. Captures the spirit of DEC-42 without the cost.
- **Client-side mirroring via `inferAdditionalFields({ user: { themePreference: ... } })`** in `lib/auth-client.ts`. The other documented option — `inferAdditionalFields<typeof auth>()` — would have introduced a frontend → backend runtime back-edge for the sake of a type. The inline schema is three lines and stays in sync by hand; the typed runtime payload is the same either way.
- **Pre-paint guard in `index.html` over accepting the flash.** DEC-54's downside is the "system + dark-OS + first paint" flash. A six-line inline `<script>` reads `matchMedia('(prefers-color-scheme: dark)').matches` and applies `dark` to `<html>` before React mounts. No localStorage shadow (would contradict the cross-device promise); the authed preference wins on mount as the ThemeProvider's effect runs.
- **`ThemeProvider` reads from `useSession()`, not from `trpc.user.getMe.useQuery()`.** Once the additional-field is in the session, that's the cheapest read on the client. The settings page itself uses `trpc.user.getMe` because it needs `name` too (which is not on the session payload by default — adding it as an `additionalField` made no sense; `name` is already on Better Auth's base user).
- **Native `<input type="radio">` + native `<label>` for the theme picker, not shadcn `RadioGroup` / `Label`.** Each shadcn primitive would have added a new Radix dep (`@radix-ui/react-radio-group`, `@radix-ui/react-label`), which is a stop-and-ask trigger per AGENTS.md. The native pattern matches `sign-in-page.tsx`'s minimalism, keeps the Tailwind styling latitude, and preserves a11y (`role="radiogroup"`, `htmlFor` bindings, real focus management).
- **No toast primitive.** Save feedback is inline (`role="status"` "Saved." + `role="alert"` error message), matching `sign-in-page.tsx`'s state-machine pattern. A toast/sonner primitive belongs to whichever later FEAT first has a genuine need (e.g. async background mutations elsewhere on screen).
- **`db` threaded through the tRPC context via Fastify `decorate`.** First procedure that needs the DB. `app.decorate('db', db)` in `server.ts`; `createContext` reads `req.server.db`; `AppContext` and `FastifyInstance` augmented in `trpc/context.ts`. Tests can still inject their own db via `buildApp({ db })` overrides — the existing FEAT-14 test ergonomics survive untouched.
- **DTO shape for `getMe`: `{ id, email, name, themePreference }` only.** Tight surface, easy to extend. Returning the full row (`image`, `emailVerified`, `createdAt`, `updatedAt`) would have leaked Better-Auth-shaped internals into domain code with no consumer.
- **Diff-only patch in the settings form.** `updateProfile` only receives keys that *changed*: if the user only touches the radio, the mutation payload is `{ themePreference }`. Plays nicely with the Zod `.refine` that requires at least one field, makes test assertions tight (`expect(mutateAsync).toHaveBeenCalledWith({ name: 'New Name' })`), and minimises the `updatedAt` churn on no-op submits.

### Drift from kick-off plan

1. **No shadcn `RadioGroup` / `Label` primitives added** (see decisions above). Plan said add them; reality said new deps = stop-and-ask, so native radios + native labels instead. Worth carrying: the first FEAT that genuinely needs a Radix primitive will pay the dep cost — until then, the form library is "native HTML + Tailwind + shadcn `Button` / `Input`."
2. **Relative import from `backend/src/trpc/procedures/user.ts` to `../../../../shared/src/schemas/user.ts`,** not `@loftys-larder/shared`. First backend runtime import from `/shared` (FEAT-15's session-notes anticipated this would Just Work; it didn't). Cause: `shared/src/router-type.ts` type-only-re-exports the backend router, so shared's tsc walks into backend code; with the backend code importing `@loftys-larder/shared` by package name, shared's compile tried to resolve its own package against a non-existent `shared/dist/index.d.ts`. The relative import sidesteps the cycle entirely without needing `paths` mappings or a `shared/dist` build step. Frontend keeps its `@loftys-larder/shared` import — its `tsconfig` has `paths` already (DEC-80) and frontend isn't in the cycle.
3. **`backend/tsconfig.json` `rootDir`: `"."` → `".."`.** Needed for (2) above so the relative import doesn't trip `TS6059: not under rootDir`. Aligns backend with shared and frontend (both already `".."`). Zero emit impact — backend is `noEmit: true`; esbuild is its bundler. Worth noting because it's a tsconfig change and tsconfig changes deserve scrutiny.
4. **`AppContext` gained `db: Db`** and `FastifyInstance` was module-augmented with `db`. Plan assumed the access pattern but didn't spell out the plumbing. Threaded via `app.decorate('db', db)`; the auth test's protected-procedure probe context literal had to gain `db: {} as AppContext['db']` to satisfy the new shape — only one call site needed updating.
5. **Mock pattern: `vi.hoisted` for the trpc mock in `settings-page.test.tsx`.** The `@typescript-eslint/unbound-method` rule fires on `trpc.useUtils as ReturnType<typeof vi.fn>` because `useUtils` is typed as a method on the tRPC client. `vi.hoisted(() => ({ useUtilsMock: vi.fn() }))` declares the mock fns before the `vi.mock` factory runs, captures them as constants, and references them by name inside the factory. Cleaner than the cast pattern; worth copying for any future test that needs to mock a top-level method on a real-typed export.

### Implementation details worth carrying

- **Better Auth's `user.additionalFields` with `input: false`** prevents the field from being writable through Better Auth's sign-up / update payloads while still surfacing it on `getSession()`. Read-only-from-Better-Auth, written-only-through-domain. This is the pattern for any future per-user metadata projection (notification prefs, locale, …).
- **`inferAdditionalFields` is the client mirror.** Must be added to the client's `plugins` array alongside `magicLinkClient()`. Schema shape is `{ user: { fieldName: { type: 'string', required: true } } }` — matches the DBFieldAttribute shape, not the server's full `additionalFields` config.
- **`app.decorate('db', db)` happens after `registerSecurity` and before `registerAuth`**, but really any time before the tRPC plugin registers is fine. The decorate creates an instance-level prop accessible via `req.server.db` inside the tRPC context.
- **`appRouter.createCaller(ctx)` is now the canonical procedure-test entry-point.** `protectedProcedure` throws `UNAUTHORIZED` from the context check, so passing a context with `session: null, user: null` is the cheapest way to assert middleware behaviour without spinning up Fastify. (Reuses the FEAT-14 pattern; `user-procedures.test.ts` extends it to a fully realistic context.)
- **ThemeProvider subscribes to `matchMedia` only when preference is `system`.** Effect dep array is `[preference]`; entering/leaving `system` cleanly attaches/detaches the listener. The `dark`-class effect has a separate `[resolved]` dep so it fires for both explicit changes *and* system-driven changes. Tested via a controllable mock (`installMatchMedia`) that exposes a `fire(matches)` method.
- **`document.documentElement.classList.toggle('dark', active)`** is the simplest way to keep the class in sync; idempotent.
- **TanStack Router's auto-code-split** worked exactly as documented for the new `_authed/settings.tsx` — the route file exports only `Route`, the page body lives in `routes/-components/settings-page.tsx`, and the production build emits a dedicated `settings-*.js` chunk (3.34 kB). The FEAT-15 thin-route convention earns its keep every new route.
- **`form.reset({ ... })` inside a `useEffect` on `meQuery.data`** is the React-Hook-Form idiom for hydrating defaults from an async source. Don't pass `meQuery.data` into `defaultValues` directly — those are evaluated once at mount, and the form would be initialised empty.

### Spec ambiguities resolved here (don't re-litigate)

- "themePreference persisted per-user in DB so it follows across devices" (DEC-54) — interpreted as "session payload carries it after server-side projection," not "client polls a tRPC query on every render." See first decision above.
- "Backend procedure file location" — spec said `backend/src/trpc/routers/user.ts`; codebase had `backend/src/trpc/procedures/health.ts`. Codebase convention wins. New procedure files go in `procedures/`. If we ever do migrate this directory, do it in one rename PR, not piecemeal.
- "shared schema file naming" — spec said `shared/src/schemas/user.ts`; resolved as a new file (not extending `auth.ts`). One file per domain noun.

### Open items for downstream FEATs

- **Sign-out flow still not built.** FEAT-15's session-notes flagged this as "likely FEAT-16 or a dedicated shell FEAT"; FEAT-16 left it untouched because the settings page is reachable only by hand-typing `/settings` and the navigation shell hasn't landed yet. First nav shell — likely FEAT-26 (PWA shell) or the layout-side of a later recipes/planner FEAT — should wire `authClient.signOut()` + `router.navigate({ to: '/sign-in' })` on success.
- **Settings page is URL-only.** No nav entry; user has to type `/settings`. Same deferral as sign-out — wait for the nav shell.
- **Account deletion (FEAT-35)** will extend `_authed/settings.tsx`. The seven-step tombstoning sequence (DEC-29) needs to land alongside; the form add will be a new section under "Theme," likely with a confirmation dialog primitive (which *may* finally justify the first Radix dep).
- **First backend `/shared` import resolved** (see drift item 2). Pattern: import from `'../../../../shared/src/schemas/<file>.ts'` for now. If we accumulate enough of these to want the `@loftys-larder/shared` package-name syntax in backend, add `paths` to both `backend/tsconfig.json` and `shared/tsconfig.json` (the cycle means both compilation units need the mapping) — not just backend's. Don't add to backend alone; the shared-typecheck step will fail.
- **`db` is now on `AppContext`.** Every procedure can read `ctx.db` without further wiring. Procedures should still scope their queries explicitly — `ctx.user.id` for user-owned tables (auth-owned), `CURRENT_HOUSEHOLD_ID` for household-scoped tables (FEAT-17 onward, DEC-17). The convention belongs in the first ingredient/recipe procedure to establish the pattern.
- **`useSession()` is now in use** (ThemeProvider) — closing the FEAT-15 open item. The hook fires for any UI that wants the current user without re-fetching; combine with `trpc.user.getMe` when you need additional fields (like `name` in the settings form).
- **No toast primitive yet.** Save UX is inline. First async-action-elsewhere-on-screen FEAT (probably the planner's optimistic slot assignment, FEAT-31) is the right place to introduce shadcn `sonner` — at that point a dep is justified.

---

## 2026-06-03 — FEAT-15 (Sign-in UI + magic-link verification + protected routing)

**Status:** implementation complete; `pnpm --filter frontend test` green (19 tests across 5 files — `sign-in.test.tsx`, `auth.verify.test.tsx`, `_authed.test.tsx`, `lib/trpc.test.ts`, plus the inherited `-components/index-page.test.tsx`). `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r format` clean across all three workspaces. Definition-of-done boxes in `docs/feature-specs.md §FEAT-15` left unticked — human action. The end-to-end gate check (real magic-link → click → app in a browser) is still owed.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Server-default magic-link redirect target (Better Auth's built-in flow).** The email link points at the server (`/api/auth/magic-link/verify?token=…&callbackURL=…`); the server verifies the token, sets the session cookie, and 302s straight to `callbackURL` (`/`). The frontend `/auth/verify` route is therefore an *error-landing page only* — reached when Better Auth's `errorCallbackURL` fires with `?error=<code>`. The alternative (frontend extracts the token and calls a verify API itself) would double the network hops and re-introduce cross-origin and CSRF concerns we don't need. The FEAT-15 spec wording ("verification route consumes the token from the URL") was interpreted to mean "is the destination of the verification flow," not literally "extracts the token in the browser."
- **Move `routes/index.tsx` → `routes/_authed/index.tsx`.** `/` becomes the first authenticated route. Cleanest implementation of "logged-in user visiting `/sign-in` is redirected to `/`" — and matches the long-term shape, since every later FEAT (settings, recipes, planner, shopping list) will live under `_authed/`. The alternative of leaving `/` public and adding a placeholder `_authed/home.tsx` was rejected as junk that would get renamed in FEAT-16.
- **Native `<label htmlFor>`, no `@radix-ui/react-label`.** Radix's label adds zero behavioural value for a single email input (the native `<label htmlFor>` already gives click-to-focus). Saved one dependency. shadcn/ui is still the styling system per DEC-51; this is purely "don't add a dep you don't need."
- **CSRF transport: Better Auth's double-submit cookie, sent via `credentials: 'include'`.** Better Auth's default CSRF model uses a cookie the browser sends automatically. No header injection in the tRPC client. Confirmed at implementation time against the installed `better-auth@1.6.11`. The tRPC `httpBatchLink` was extended with a `fetch` override (`(input, init) => fetch(input, { ...init, credentials: 'include' })`) — minimum-viable wiring.
- **tRPC URL shape preserved (cross-cutting #16).** `httpBatchLink({ url: '/api/trpc' })` stays — the PWA cache rules (FEAT-41 onward) match on the procedure segment.
- **Custom `unauthorizedRedirectLink` over per-call `onError`.** A `TRPCLink<AppRouter>` (using `observable` from `@trpc/server/observable`) intercepts errors with `err.data?.code === 'UNAUTHORIZED'` and calls an injected `onUnauthorized` callback. `app.tsx` wires that callback to `router.navigate({ to: '/sign-in' })`. The injection pattern keeps `lib/trpc.ts` independent of the router and dodges the otherwise-cyclic import.
- **Route file structure: named exports for `beforeLoad` + components.** Each route file exports its `beforeLoad` and its component as named exports (`signInBeforeLoad`, `SignInPage`, `verifyBeforeLoad`, `VerifyPage`, `copyForError`, `authedBeforeLoad`) which the `Route` definition then references. Tests call the named exports directly without standing up a memory router; the `Route` object's option shape doesn't expose a plain function for testing.

### Drift from kick-off plan

1. **Two stop-and-asks mid-implementation, both producing new DECs:**
   - **DEC-80's deferred call resolved.** `signInSchema` was the first runtime import from `/shared`; Vite couldn't resolve `@loftys-larder/shared` (the `main` field pointed at non-existent `./dist/index.js`). User chose option (2) — alias to source. `frontend/vite.config.ts` and `frontend/vitest.config.ts` now alias `@loftys-larder/shared` → `../shared/src/index.ts`. `shared/package.json` gained `zod`. Captured as DEC-80 update.
   - **`@typescript-eslint/only-throw-error` vs `throw redirect(...)`.** TanStack Router's `beforeLoad` contract is throwing a Response-like object; the strict rule flags this at every guard. User chose global config relaxation for `frontend/src/routes/**` over per-line suppressions. Captured as **DEC-81**.
2. **Three failure states in `/auth/verify` collapse to two codes + default.** Plan listed {expired, used, invalid}. Reading Better Auth's source: only `EXPIRED_TOKEN` and `INVALID_TOKEN` are emitted (no separate "used" — once consumed, re-clicking hits `INVALID_TOKEN` because the verification row is deleted). UI copy is now: expired → "this link has expired"; invalid → "no longer valid (may have been used or modified)"; default branch covers `failed_to_create_user` / `failed_to_create_session` / `new_user_signup_disabled`.
3. **`frontend/tsr.config.json` added** with `routeFileIgnorePattern: "\\.test\\.tsx?$"`, plus a matching `routeFileIgnorePattern` in the Vite plugin's `tanstackRouter({...})` call. Without it, `tsr generate` warns on every run for `*.test.tsx` files colocated with their routes. Not in plan; mechanical fix.
4. **shadcn `Input` primitive added** (`frontend/src/components/ui/input.tsx`). Plan listed it; landed as anticipated, no new deps.
5. **`zod` added as a direct `shared/package.json` dep** — was previously only in backend + frontend. Shared's first runtime import is FEAT-15's `signInSchema`. Mechanical, but worth flagging because it changes shared's dependency surface.

### Implementation details worth carrying

- **TanStack Router's `redirect()` returns a `Response`-like object with the target on `.options.to`, not `.to`.** First-pass tests asserted `{ to: '/sign-in' }` and failed with `Response { options: { to: '/sign-in', statusCode: 307 } }`. Fix the assertion shape to `{ options: { to: '/sign-in' } }`.
- **Better Auth's React `useSession()` is backed by nanostores, not TanStack Query.** Don't try to fold it into the app's `QueryClient`. It manages its own subscription independently. For route guards, call `authClient.getSession()` directly in `beforeLoad` (it short-circuits to `{ data: null }` with zero DB round-trip when there's no session cookie, per the FEAT-14 implementation note).
- **The unauthorized-redirect link sits *before* `httpBatchLink` in the links array.** Order matters: the batch link's error must propagate up through the redirect link's `error()` observer to fire the callback.
- **`routes/_authed.tsx` (layout) and `routes/_authed/index.tsx` (child) are sibling files** under TanStack Router's pathless-route convention. The route tree generator merges them — no manual wiring.
- **The tRPC client factory is now `createTRPCClient({ onUnauthorized })`** in `lib/trpc.ts`. The factory returns a fresh client wired with both the redirect link and the cookie-credentials `httpBatchLink`. The old inline `httpBatchLink({ url: '/api/trpc' })` in `app.tsx` is gone.
- **Vite proxy gotcha sanity-checked.** `frontend/vite.config.ts` proxies `/api/*` to `BACKEND_URL ?? http://localhost:3000`. Better Auth's React client points at `/api/auth` (same-origin from the browser's perspective) and rides this proxy in dev. In prod the Fastify app serves both `/api/*` and the SPA — same origin, no proxy needed.

### Spec ambiguities resolved here (don't re-litigate)

- "Verification route consumes the token from the URL, completes sign-in, redirects to `/`" — interpreted as Better Auth's server-default flow. Server consumes the token; the frontend `/auth/verify` route is the error-landing.
- "tRPC client treats `UNAUTHORIZED` responses by redirecting to `/sign-in`" — implemented as a global custom link, not as per-call `onError` handlers in individual queries.
- "Verification route should handle the failure cases (expired, used, invalid) with distinct messages" — interpreted as: distinct copy for `EXPIRED_TOKEN`, distinct copy for `INVALID_TOKEN` (which is what "used" collapses to once Better Auth deletes the verification row), and a generic-failure default for the rarer codes.

### Open items for downstream FEATs

- **FEAT-16 (profile + theme settings).** First feature to land under `_authed`. Route file: `frontend/src/routes/_authed/settings.tsx`. Backend procedures `user.getMe` / `user.updateProfile` should be `protectedProcedure` (FEAT-14 contract). `ThemeProvider` reads from the Better Auth session — *not* localStorage — to honour DEC-TBD's cross-device theme persistence. Until a real navigation shell lands, the settings page is reachable only by hand-typing the URL.
- **FEAT-17 onward** — every domain procedure inherits the `protectedProcedure` + `CURRENT_HOUSEHOLD_ID` discipline from FEAT-14. The frontend tRPC client now sends cookies on every call automatically; no per-procedure wiring needed on the frontend side.
- **First backend runtime import from `/shared`.** Should resolve transparently — `tsx watch` (dev) and `esbuild` bundle (prod) both follow the workspace symlink to `shared/src/index.ts`. No config change anticipated. If anything trips, add a `paths` mapping to `backend/tsconfig.json` mirroring the frontend's.
- **Sign-out flow not built.** `authClient.signOut()` exists in the auth client; when a real navigation shell adds a "sign out" affordance (likely FEAT-16 or a dedicated shell FEAT), wire `signOut()` + `router.navigate({ to: '/sign-in' })` on success.
- **`useSession()` not exercised in code yet.** Route guards use `getSession()` directly. When a logged-in user's name needs to appear in the UI (FEAT-16 settings page), that's the call site for `useSession()`. The hook is already re-exported from `lib/auth-client.ts`.

### Follow-up later the same day — route-file thinning

First `pnpm dev` after the initial implementation surfaced a TanStack Router auto-code-split warning:

> These exports from "/.../routes/sign-in.tsx" will not be code-split and will increase your bundle size: - SignInPage

The plugin can only split `Route.options.component` cleanly; any other exported React component gets hoisted into the route's chunk. Triggered because the initial implementation exported `SignInPage` / `VerifyPage` from the route files so the test suite could import them directly.

**Fix:** moved page components and `beforeLoad` functions out of `routes/*.tsx` into `routes/-components/` (matching the existing `index-page.tsx` pattern; the `-` prefix excludes the dir from route detection). Route files are now thin shells exporting only `Route`. Test files colocated with the components they exercise — `routes/-components/sign-in-page.test.tsx`, `verify-page.test.tsx`, `authed-layout.test.tsx`.

One small refactor along the way: `VerifyView` used to call `Route.useSearch()` directly, which couples the component to the route file. The component now takes `error: string | undefined` as a prop; the thin wrapper inside `auth.verify.tsx` reads `Route.useSearch()` and passes it through. Cleaner test surface, no circular import.

**Codified in AGENTS.md** as a new "Code conventions" bullet (route files are thin shells; everything else in `-components/`) and a new "Common traps" row (don't export from route files). Every future FEAT that adds a route inherits this.

Verification: typecheck + lint + 19 tests pass; dev server boots without the warning. Tests, route tree, and dev surface all green.

### Follow-up 2026-06-08 — gate check passed; tsx-watch + .env gotcha

End-to-end magic-link flow confirmed working against the local stack: form → Resend → inbox → click → authenticated session. FEAT-15 DoD gate check is satisfied (human ticks the boxes in `docs/feature-specs.md §FEAT-15`).

Debugging detour worth recording: `tsx watch` does **not** restart on `backend/.env` changes — it only watches imported source files. The symptom (emails not arriving despite the form returning success) traced to a backend instance that had loaded an early version of `.env` hours earlier and kept running across multiple in-place `.env` edits. Resolution: kill the backend and re-run `pnpm dev`. Documented in `README.md` under "Run the backend". Worth a one-paragraph mental model for anyone debugging "config change didn't take effect": tsx watch reloads `src/`, not env files.

A second factor in that debug session: a leftover background `pnpm --filter backend dev` from an earlier "run the app" loop was still holding port 3000, which meant the user's subsequent `pnpm dev` invocations couldn't bind and silently lost their start. The `scripts/dev.sh` cleanup trap now sweeps :3000/:5173 stragglers on exit, but anyone running `pnpm --filter backend dev` outside the script should still `lsof -ti :3000` before/after to catch zombies.

### Follow-up 2026-06-08 — absolute callback URLs

First real magic-link click hit a backend 404: `{"message":"Route GET:/ not found"}`. Cause: the sign-in form passed `callbackURL: '/'` (relative). Better Auth resolves relative URLs against `BETTER_AUTH_URL`, which is the backend origin (`http://localhost:3000`) in dev. The SPA lives on Vite (`:5173`), not Fastify — so the redirect landed on a Fastify origin that has no `/` route.

**Fix:** `frontend/src/routes/-components/sign-in-page.tsx` now passes `` `${window.location.origin}/` `` and `` `${window.location.origin}/auth/verify` ``. Better Auth's server stores those verbatim and redirects to whichever origin the user is on — Vite in dev, the unified origin in prod. The dev origin (`http://localhost:5173`) is already on `MAGIC_LINK_TRUSTED_ORIGIN`, so Better Auth's allow-list lets the redirect through. Test assertion updated.

Codified in AGENTS.md as a new "Common traps" row so future call sites (`signOut`, any future OAuth, anything taking a `callbackURL`) inherit the pattern.

End-to-end flow now confirmed: form → email → click → redirect to `http://localhost:5173/` → authenticated session visible to the SPA.

---

## 2026-05-26 — FEAT-14 (Better Auth integration — server)

**Status:** implementation complete; `pnpm --filter backend test` green (119 tests; 30 new FEAT-14 cases — 12 in `auth.test.ts` plus 7 new in `config.test.ts` and 4 in `server.test.ts` — over 89 inherited). Typecheck + lint + `format:check` clean across all three workspaces. Definition-of-done boxes in `docs/feature-specs.md §FEAT-14` left unticked — human action. The end-to-end gate check (real magic-link → click → session) is still owed.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **No `resend` npm dep; plain `fetch` against `api.resend.com/emails`.** The SDK's only value-add is request shaping that's three lines of code; eliminating the dep removes one SDK-migration risk. The send fn is small enough that adding the SDK later is a one-paragraph diff if Resend ever ships a feature we want (batches, attachments). Production wraps fetch via `createResendSender` (`backend/src/auth/resend.ts`); tests inject a spy.
- **Allow-list lives in a separate `withAllowList` wrapper, not in the Resend transport.** A first pass put the gate inside `createResendSender` — caught by a failing test on first run because injected test spies bypassed the transport entirely. Fix: compose the gate around any sender (real or test) in `buildApp`. The gate semantic is also better-named this way — `withAllowList(sender, emails, log)` reads as the policy it is, separate from the transport it wraps.
- **Better Auth schema bridging: `{ usePlural: true, camelCase: true }`.** FEAT-10's tables are pluralised (`users`, `sessions`, …); Better Auth defaults to singular. `usePlural: true` (vs. per-model overrides) is the cheaper config. `camelCase: true` matches our Drizzle TS-keys (`userId`, `expiresAt`, …) — the snake_case mapping at the DB column level happens at the Drizzle runtime via the global `casing: 'snake_case'` (DEC-15), so the adapter only needs to know how to address fields via TS keys.
- **Better Auth handler bridged via the Web `Request`/`Response` path, not `toNodeHandler`.** The Node-handler path requires disabling Fastify's body parsing on the auth route, which leaks across the rest of the app unless carefully scoped. Bridging via `auth.handler(new Request(url, init))` lets Fastify's built-in JSON parser run on the request body and we just `JSON.stringify` it back into the `RequestInit.body` — no body-parser fight, no encapsulation gymnastics. Matches the pattern in Better Auth's Fastify integration docs.
- **`account.fields.password = false` not configured.** Kick-off plan flagged it; on closer reading, unnecessary. The password column only sees writes when the email-and-password provider is enabled, which it isn't (DEC-41). FEAT-10's session note already covers this — NULL costs zero bytes. Saved one config line plus a downstream migration risk.
- **Cookie prefix: `lofty-larder`, not `__Host-`.** `__Host-` forbids subdomains and invalidates every existing session on the deploy that flips it, for no v1 benefit (single-origin in prod per DEC-44). Better Auth defaults already satisfy DEC-43 (`HttpOnly`, `Secure` in prod, `SameSite=Lax`, CSRF).
- **`health.ping` exemption is dev-only.** Spec verbatim. The pre-handler's `isExempt(url, config)` returns true for `/api/trpc/health.ping` only when `NODE_ENV !== 'production'`. Prod healthcheck endpoint lands separately in FEAT-46 as a plain Fastify route under `/api/health`.
- **No user→household join row.** Per DEC-17, `CURRENT_HOUSEHOLD_ID` IS the link in v1. Better Auth's user-create path runs unmodified; multi-user-household work is a non-goal.
- **`buildApp(config, { db?, sendMagicLink? })` — both injectable.** The signature change is the test ergonomics that pays for itself across every later FEAT's tests. Production calls `buildApp(config)` and gets the singletons; tests pass their own Drizzle handle (Testcontainers in `auth.test.ts`, a no-op pool in `server.test.ts`) plus a spy sender.
- **Module augmentation for `FastifyRequest.session`/`user` lives in `trpc/context.ts`, not the auth plugin.** First pass put it in `plugins/auth.ts` — typechecked fine in the backend but broke `/shared` because `router-type.ts` only pulls the tRPC chain (router → init → context), not the plugins. Moving the augmentation onto the `trpc/context.ts` compilation path makes it visible to every consumer of the AppRouter type.

### Drift from kick-off plan

1. **No `resend` SDK dependency** (see decisions above). Plan said "add `resend` to `backend/package.json`"; instead `backend/src/auth/resend.ts` does the REST call directly.
2. **Allow-list refactored into `withAllowList`** after a failing test showed the gate was bypassed when tests injected a sender (see decisions above). Plan had it inside the Resend transport.
3. **`backend/src/db/index.ts` refactored to lazy init.** Plan didn't flag it. The singleton pool's `loadConfig()` ran at module import — which was fine until `server.ts` started importing from `db/index.ts`. Unit tests that don't set the new auth env vars would have crashed on import. `getDb()` returns the singleton on first call; the pool only opens when something actually wants it. `scripts/seed.ts` updated to call `getDb()` to get `pool` and `withTransaction`.
4. **`server.test.ts` `/api/static/does-not-exist.txt` test expectation changed from 404 to 401.** The pre-handler short-circuits before the not-found handler. The test's intent (static plugin doesn't claim `/api/*`) is now proven indirectly via the auth path catching it; the inline comment in the test calls this out.
5. **No new `/shared` schemas.** Plan said no, and that held — Better Auth owns its own input validation for the magic-link flow. The first `/shared/src/schemas/*` entry will land alongside FEAT-15's frontend wiring or FEAT-17's ingredient procedures.

### Implementation details worth carrying

- **`BetterAuthOptions['account']` typing is open enough to accept a `fields` map** but we don't need it (see "decisions: `account.fields.password` not configured"). The password column will stay NULL forever under magic-link-only auth.
- **Better Auth's verify endpoint returns 302 on token reuse**, not 4xx — the redirect URL carries an `error` query param. Tests must accept either shape: assert "no second session was minted" as the semantic check, and treat 302+`error=` *or* 4xx as both valid token-reuse signals. `auth.test.ts` codifies this.
- **`auth.handler(new Request(url, init))` is the right Fastify bridge.** Fastify parses the body into `req.body` via its JSON parser; we re-stringify it into the Web `Request`'s `RequestInit.body`. The catch-all route declares all relevant methods (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`) so Better Auth sees the full surface. Set-cookie headers pass through Fastify's reply unchanged.
- **`createCallerFactory` is the right way to test a `protectedProcedure` without an HTTP round-trip.** Reaching into `procedure._def.resolver` from outside doesn't exist on tRPC v11 — caller factories do. Reusable pattern for later FEATs that want to assert middleware behaviour without mocking the entire Fastify stack.
- **Better Auth's `getSession` short-circuits to `null` when there's no session cookie present** — no DB query. Means unauth requests through the pre-handler don't pay a round-trip cost, and the no-DB tests in `server.test.ts` can run against a stubbed Drizzle handle without ever connecting.
- **`pg.Pool` is fully lazy** — `new pg.Pool({ connectionString })` doesn't open a connection until a client is checked out. `server.test.ts` exploits this with a pool pointed at a bogus URL that never connects.
- **Better Auth's `magicLink({ disableSignUp: false })` is the default**, but spelt out for clarity in `backend/src/auth/index.ts`. The allow-list is the actual sign-up gate (FEAT-14 kick-off Q2). Toggling `disableSignUp` would block the first-time sign-in path even for allow-listed emails who don't yet have a row.

### Spec ambiguities resolved here (don't re-litigate)

- "Verify cookies are set with the expected flags... `__Host-` prefix if used" — **not enabled** (single-origin prod, no subdomain access desired, flip would invalidate sessions).
- `account.fields.password` — **not configured**. Column stays NULL; no consumer.
- Sign-up posture — **allow-list via `MAGIC_LINK_ALLOWED_EMAILS`** (single-household MVP, two-person privacy default).
- User→household linkage on first sign-in — **none in v1** (DEC-17; `CURRENT_HOUSEHOLD_ID` is the link).
- `health.ping` exemption — **dev-only** per the spec AC literally.
- Verify endpoint failure shape — **either 302+`error=` or 4xx**; test the no-session semantic, not the status code.
- Pre-handler integration with `reqId` (DEC-77) — **honoured naturally**; both the auth handler and `getSession` run on the same `req`, so `req.id` flows untouched into Pino and downstream.

### Open items for downstream FEATs

- **FEAT-15 (sign-in UI + verification + protected routing)** — frontend Better Auth client must point at `/api/auth` and post `{ email, callbackURL }` to `/api/auth/sign-in/magic-link`. The verify endpoint is `/api/auth/magic-link/verify?token=…`. tRPC's client error link maps 401 → redirect to `/sign-in` (cross-cutting #16: don't change the tRPC URL shape; the PWA cache rules match on it).
- **FEAT-15 — the verification route reads the token from `?token=` in the URL**, not the path. Better Auth's plugin generates URLs as `${MAGIC_LINK_TRUSTED_ORIGIN}/api/auth/magic-link/verify?token=…` by default. The frontend "magic-link landing" route should consume that token (or be hit directly server-side — confirm during FEAT-15 kick-off).
- **FEAT-16 (profile + theme)** — `user.getMe` / `user.updateProfile` procedures should be `protectedProcedure` (not `publicProcedure`); the `ctx.user` narrowing means resolvers can read `ctx.user.id` and `ctx.user.themePreference` directly without a null check.
- **FEAT-17 onward — every domain procedure file** uses `protectedProcedure` (from `backend/src/trpc/init.ts`) as the default. `publicProcedure` is reserved for `health.ping` and any future genuinely-anonymous endpoints. Domain procedures scope every query by `CURRENT_HOUSEHOLD_ID` (DEC-17, cross-cutting #3) — `ctx.user.id` is informational only, never authorisation.
- **FEAT-35 (account deletion)** — the seven-step tombstoning sequence (DEC-29) will delete from `sessions` and `accounts` before the `users` row. Better Auth's cascade rule on `sessions.userId` / `accounts.userId` is `ON DELETE CASCADE` (FEAT-10 schema), so deleting the user row would clean those up automatically — but the explicit step is still in the sequence for audit-trace clarity. `verifications` are identified by email string, not `userId`, so they don't cascade; the tombstoning procedure should `DELETE FROM verifications WHERE identifier = :email` as part of the same transaction.
- **FEAT-45 (rate limiting, DEC-45)** — the magic-link request endpoint needs the per-email 5/hour limit (DEC-45). Better Auth's built-in `rateLimit: { window: 60, max: 5 }` on the `magicLink` plugin would cover *per-IP* but not *per-email*; FEAT-45 will need a custom limiter or to extend Better Auth's. Not enabled now — wait for FEAT-45 to land the unified `@fastify/rate-limit` config.
- **FEAT-46 (`/api/health` route)** — when this lands, the auth pre-handler exemption `/api/health` already accepts it (the `isExempt` helper matches the `/api/health` prefix). Just register the plain Fastify route.
- **FEAT-50 (`OPERATIONS.md` + restore drills)** — the prod env-var checklist below should lift into the ops doc.

### Operator action before next prod deploy

Four new env vars are required outside test; the next deploy after this PR merges will crashloop without them. Set in Fly:

```sh
flyctl secrets set \
  BETTER_AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')" \
  BETTER_AUTH_URL="https://loftys-larder.co.uk" \
  RESEND_API_KEY="re_XXXXXXXX" \
  MAGIC_LINK_TRUSTED_ORIGIN="https://loftys-larder.co.uk" \
  MAGIC_LINK_ALLOWED_EMAILS="conorwarne92@gmail.com" \
  --app loftys-larder-prod
```

`MAGIC_LINK_FROM` defaults to `magic@loftys-larder.co.uk` (the FEAT-13 sender) so doesn't need setting unless overriding. Add more comma-separated entries to `MAGIC_LINK_ALLOWED_EMAILS` as second-household-member emails come in.

### Environment notes — same Colima env vars as FEAT-09 / 10 / 11 / 12

```sh
export DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

`auth.test.ts` follows the same Testcontainers pattern as `schema.test.ts` — `beforeAll` boots Postgres + runs migrations; `beforeEach` truncates the four Better Auth tables with `restart identity cascade`. Auth suite finishes in ~5s once the container is warm.

### Deferred (do NOT do as part of FEAT-14)

- Frontend sign-in UI, verification route, protected layout — **FEAT-15**.
- `user.getMe` / `user.updateProfile` procedures — **FEAT-16**.
- Tombstoning sequence (delete sessions/accounts/verifications/recipes/etc. before user row) — **FEAT-35**.
- Per-email rate-limit on magic-link request — **FEAT-45**.
- Unauth `/api/health` Fastify route (already exempt in the pre-handler) — **FEAT-46**.
- `OPERATIONS.md` lift of the env-var checklist above — **FEAT-50**.
- Cloudflare cache-bypass tightening for `/api/auth/*` — already covered by the broad `/api/*` bypass rule landed at FEAT-06; revisit only if Cloudflare's edge starts misclassifying.
- Sentry `beforeSend` PII scrub for auth headers — **FEAT-43** (when Sentry first lands).

---

## 2026-05-23 — FEAT-13 (Resend domain verification)

**Status:** verification complete on 2026-05-23. `loftys-larder.co.uk` verified with Resend; SPF / DKIM / DMARC published in Cloudflare; test send to a personal Gmail showed `spf=pass`, `dkim=pass`, `dmarc=pass` and landed in Inbox. Sender confirmed as `magic@loftys-larder.co.uk`. Definition-of-done boxes in `docs/feature-specs.md §FEAT-13` left unticked — human action.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Sender address: `magic@loftys-larder.co.uk`.** Matches the spec's example; scannable in an inbox; signals intent. This will be referenced in FEAT-14's Better Auth config as a constant — don't pre-bake it anywhere now (no premature import; see "Deferred" below).
- **DKIM published at the apex, not a subdomain.** Single-purpose project, single sender; the trade-off (apex becomes "claimed" by Resend if a second sending service is added later) does not bite us. DKIM CNAME name will be whatever selector Resend prescribes under `*._domainkey.loftys-larder.co.uk` — copy verbatim from the wizard, do not invent.
- **DMARC starts at `v=DMARC1; p=none` with no `rua`.** Per the spec ("start with `p=none` so failures are visible without blocking"). Skipping `rua` because at this send volume the daily XML reports cost more than they're worth; trivial to add `rua=mailto:...` later by editing the one TXT record. Tighten to `quarantine`/`reject` only after real send-volume data confirms alignment is stable.
- **Fresh Resend account for this project**, not adding `loftys-larder.co.uk` to an existing personal workspace. Cleaner billing isolation; one account = one app.
- **Resend region: EU (Dublin) if offered at signup.** Lowest latency from the Fly `lhr` app, and keeps personal-data processing in-region. If Resend's signup doesn't expose a region toggle, accept the default — it isn't a v1 blocker.
- **No MX records.** Resend is outbound-only for our use; no inbound mail, no catch-all. Resend may *suggest* an MX for bounce handling — skip it; bounces are surfaced in the Resend dashboard already.
- **DKIM CNAME must be unproxied (DNS only) in Cloudflare.** Proxied (orange-cloud) CNAMEs return Cloudflare's edge IPs on lookup, breaking the value chain for receivers fetching the public key. This is the named gotcha in the FEAT-13 spec; the runbook below double-flags it.

### Pre-flight check (done at plan time)

- `dig +short TXT loftys-larder.co.uk` → **empty.** No pre-existing apex TXT records, so SPF and DMARC TXT entries can be added as fresh records without the RFC-7208 single-merged-TXT dance.

### Runbook — first-time Resend domain verification

Substitute `<SPF_TXT>`, `<DKIM_SELECTOR>`, `<DKIM_TARGET>` with the verbatim values Resend's "Add domain" wizard shows for this workspace — those values are workspace-scoped and not predictable. The live values are in the Cloudflare DNS zone and the Resend dashboard; do not duplicate them here.

#### Step 0 — Prerequisites

- Domain live and on Cloudflare DNS: `loftys-larder.co.uk` (confirmed by FEAT-06).
- A personal Gmail (or equivalent showing `Authentication-Results`) reachable for the test send.
- Cloudflare dashboard access to `loftys-larder.co.uk`'s DNS zone.

#### Step 1 — Resend account + add domain

1. Sign up at <https://resend.com> with the project email. Record the account email.
2. After signup, complete the workspace setup. Record the workspace name.
3. Domains → Add Domain.
   - **Domain:** `loftys-larder.co.uk` (apex — no subdomain).
   - **Region:** EU (Dublin) if offered; otherwise the default.
4. Resend reveals the required DNS records on the next screen. Leave that tab open — every value below comes from it verbatim.

#### Step 2 — Capture Resend's prescribed records

Read off Resend's wizard. Typically three records:

| Resend field | Type | Name (host) | Content (target/value) |
|---|---|---|---|
| SPF | TXT | apex (`@`) | something like `v=spf1 include:<resend-domain> ~all` — copy **exact** string |
| DKIM | CNAME | `<selector>._domainkey` | a Resend-hosted target (e.g. `<selector>._domainkey.<workspace>.<resend-host>`) |
| DMARC | TXT | `_dmarc` | Resend may *suggest* a value; **use ours instead**: `v=DMARC1; p=none` |

Notes:
- Resend has sometimes shown a single DKIM CNAME, sometimes three (multi-selector). Copy whatever it shows, in whatever number; each goes in as its own DNS-only CNAME in step 3.
- If Resend suggests an MX record for bounce handling, **skip it.** Outbound-only.
- If Resend offers an existing-DMARC option for your DMARC TXT, **override** to our `v=DMARC1; p=none` — keeping our `rua`-less form explicit.

#### Step 3 — Cloudflare DNS records

Cloudflare dashboard → DNS → Records. Add each row exactly:

| # | Type | Name | Content | Proxy | Source of value |
|---|---|---|---|---|---|
| 1 | TXT | `@` | `<SPF_TXT>` | DNS only — TXT never proxies | Resend wizard |
| 2 | CNAME | `<DKIM_SELECTOR>._domainkey` | `<DKIM_TARGET>` | **DNS only — explicitly toggle off orange-cloud** | Resend wizard |
| 3 | TXT | `_dmarc` | `v=DMARC1; p=none` | DNS only | Our decision |

Repeat row 2 for each DKIM CNAME if Resend prescribes multiple.

Cloudflare quirk: entering `@` in the Name field resolves to the zone apex; entering `_dmarc` resolves to `_dmarc.loftys-larder.co.uk`; entering `<selector>._domainkey` resolves to `<selector>._domainkey.loftys-larder.co.uk`. The dashboard preview confirms FQDN — verify before saving each row.

**Defence-in-depth on the DKIM CNAME proxy flag.** After saving each CNAME, re-open it and confirm the toggle reads "DNS only" (grey cloud), not "Proxied" (orange cloud). Cloudflare's defaults try to proxy CNAMEs. The spec gotcha names this as the primary FEAT-13 failure mode.

#### Step 4 — Wait + sanity-check DNS propagation

Cloudflare propagates internally in < 60s; public DNS caches may lag a few minutes. From a shell:

```sh
dig +short TXT loftys-larder.co.uk                          # expect: SPF string
dig +short CNAME <DKIM_SELECTOR>._domainkey.loftys-larder.co.uk   # expect: Resend target
dig +short TXT _dmarc.loftys-larder.co.uk                   # expect: "v=DMARC1; p=none"
```

If empty after a few minutes: confirm the records exist in the Cloudflare dashboard and that no row was saved with the orange-cloud toggle on for the DKIM CNAME (a proxied CNAME would not resolve to the Resend target on lookup).

#### Step 5 — Trigger Resend verification

Resend dashboard → Domains → `loftys-larder.co.uk` → "Verify DNS" (or equivalent). Resend pulls fresh DNS and reports per-record status.

Wait until the domain card reads **Verified** (green). Initial polls can take a few minutes; subsequent re-tries are instant.

#### Step 6 — Test send + Gmail authentication-results check

1. Resend dashboard → Emails → "Send test" (or via the API console).
   - From: `magic@loftys-larder.co.uk`.
   - To: a personal Gmail.
   - Subject + body: anything plain text.
2. In Gmail, open the message → ⋮ menu → "Show original".
3. In the headers, locate the `Authentication-Results` line. Confirm three substrings:
   - `spf=pass`
   - `dkim=pass`
   - `dmarc=pass`
4. Confirm the message landed in **Inbox**, not Spam/Promotions.

If any of the three reads `fail` or `neutral`, do **not** declare done — the corresponding DNS record is wrong (typo in the value, or DKIM was proxied) and needs re-checking.

### Open items for downstream FEATs

- **FEAT-14 (Better Auth server)** — consumes the verified domain. Sender constant should be `magic@loftys-larder.co.uk`; `RESEND_API_KEY` lands then via `flyctl secrets set` (do **not** set it now — no consumer yet, and an unused secret in Fly drift-checks adds noise).
- **FEAT-50 (`OPERATIONS.md` + restore drills)** — lifts this runbook into the operations doc. The live record values stay in Cloudflare DNS / Resend dashboard; don't duplicate them into the doc.
- **DMARC tightening watch.** Once FEAT-14 is live and we have a few weeks of real magic-link sends with no SPF/DKIM failures, revisit DMARC `p=none` → `quarantine`. Not now.
- **`rua` watch.** If we ever suspect domain spoofing or want visibility into receiver behaviour, add `rua=mailto:conorwarne92@gmail.com` to the `_dmarc` TXT. Single-record edit, no other change.

### Deferred (do NOT do as part of FEAT-13)

- Any `backend/src/auth/*` file — **FEAT-14**.
- `RESEND_API_KEY` in Fly secrets — **FEAT-14**.
- A `from`-address constant anywhere in code — **FEAT-14**.
- Postmark as a configured fallback — out of scope per DEC-69; only *named* as a fallback in case Resend deliverability degrades.
- MX records on `loftys-larder.co.uk` — out of scope; outbound-only sender.
- Tightening DMARC beyond `p=none` — explicitly deferred per spec.
- Adding `rua` / `ruf` to DMARC — explicitly skipped at kick-off.

### Commit

`chore(infra): document Resend domain verification` — diff is this session-notes entry only.

---

## 2026-05-21 — FEAT-12 (Schema: meal plans and shopping list items)

**Status:** implementation complete; `pnpm --filter backend test` green (99 tests; 30 new FEAT-12 cases + 69 inherited). Typecheck + lint + `format:check` clean across all workspaces. Migration applies cleanly via Testcontainers from a fresh image. Definition-of-done boxes in `docs/feature-specs.md §FEAT-12` left unticked — human action.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **`meal_plans.id` and `meal_plan_slots.id` are `integer().generatedAlwaysAsIdentity()`.** Same reasoning as FEAT-11's recipe tables — plan/slot row counts climb at the same order as recipes, and the slot FKs `(recipeId, cooksBaseRecipeId)` must be `integer` to match `recipes.id`'s type. Consistent identity-PK style across the whole domain.
- **`meal_plan_slots.planId` is `ON DELETE CASCADE`,** not RESTRICT. *Why:* slots have no meaning outside their plan. The alternative — forcing FEAT-37's plan-delete procedure to clear slots first — adds boilerplate to every plan-delete path for no semantic gain. Recipes and ingredients are explicitly *not* cascaded (RESTRICT on `recipeId` / `cooksBaseRecipeId`) because those references survive plan deletion (the recipe is shared, not owned).
- **`number_of_servings > 0` extends the spec's NOT-NULL-when-recipe rule.** Spec called only for "NOT NULL when slot_type='recipe'"; added `> 0` as part of the same CHECK because a zero-serving slot would silently zero out FEAT-36's aggregation. The CHECK clause is one composite: `slot_type <> 'recipe' OR (number_of_servings IS NOT NULL AND number_of_servings > 0)` — a single named constraint, one violation message, cheap.
- **`cooks_base_*` joint-set encoded as one combined CHECK.** Form: `(cooks_base_recipe_id IS NULL) = (cooks_base_servings IS NULL) AND (cooks_base_servings IS NULL OR cooks_base_servings > 0)`. *Why one clause:* the violation surface is "the pair is wrong somehow"; splitting into two named constraints would make the test assertions report on whichever fires first, not the conceptual violation. One name (`meal_plan_slots_cooks_base_joint`) is what FEAT-30's application layer will surface to the user.
- **`recipeId` (eaten-recipe FK) is `ON DELETE RESTRICT`,** mirroring `cooksBaseRecipeId`. *Why:* recipes are soft-deleted (DEC-21) so the FK rarely fires in practice, but if a future migration ever hard-deletes a recipe, an existing slot reference should block it rather than corrupt the past plan. Spec only explicitly specified RESTRICT for `cooksBaseRecipeId`; same reasoning applies to both.
- **`recipe_id IS NOT NULL` and `slot_type = 'recipe'` are coupled via biconditional CHECK.** Form: `(slot_type = 'recipe') = (recipe_id IS NOT NULL)`. *Why a biconditional, not just one direction:* a slot of type `eat_out` with a stray `recipeId` is also a bug; both directions of the bug have the same fix (clear or set the field), so one bidirectional CHECK is the precise primitive.
- **No `shop_date` column on `meal_plans` in v1.** Spec AC didn't list it; `docs/non-goals.md` defers multi-shop planning and names `shop_date` as the entry point when that work happens. Adding it now would invite UI to surface a field nothing reads.
- **No `householdId` denormalisation on slots / shopping-list items.** Both inherit scope via `planId → meal_plans.householdId`. *Why:* DEC-17's single-tenant-with-multi-tenant-readiness posture is satisfied at the plan level; queries already need to join the plan for date filtering, so the join is free. Redundant denormalisation would have to be kept in sync without a corresponding query win.
- **`is_base = true` rule for `cooks_base_recipe_id` is application-layer.** Spec implementation notes say so explicitly; honoured. The DB enforces only the FK and the joint-set. FEAT-30's slot-save procedure will validate `is_base = true` against the `recipes` table and surface a domain error code via `TRPCError.cause` (per cross-cutting #11). Do not push this into a Postgres trigger.

### Drift from kick-off plan

1. **Tests live at `backend/test/meal-plans-schema.test.ts`,** not `backend/src/db/schema/__tests__/` as the kick-off plan said. Matches the FEAT-11 precedent — Vitest's `include: ['test/**/*.test.ts']` (in `backend/vitest.config.ts`) is the source of truth. Plan file said `__tests__/`; reality is `test/`.
2. **Dropped a planned `meal_plan_slots_plan_id_idx` btree.** The `(plan_id, date, occasion_id)` unique index already serves single-column `plan_id` lookups (leading-column rule), so the standalone btree was redundant. drizzle-kit's first-pass output included it; removed before regenerating the migration. Migration is `0002_meal_plans_and_shopping.sql`.
3. **First-pass migration auto-named `0002_redundant_black_bird.sql`; regenerated as `0002_meal_plans_and_shopping.sql`** using `pnpm --filter backend db:generate --name meal_plans_and_shopping`. The `--name` flag is the right way to get a descriptive tag — same naming discipline as FEAT-11's `0001_recipes_domain.sql`. If you regenerate, also clean up `drizzle/meta/_journal.json` so old entries don't accumulate.

### Implementation details worth carrying

- **`pgEnum` declaration and column use share the same identifier.** Following the `themePreference` precedent from FEAT-10/`auth.ts`: `export const slotType = pgEnum('slot_type', [...])` then `slotType: slotType().notNull()` in the table. Confusing at first glance, but the JS-name overload (constructor function for column declaration, value reference everywhere else) works and matches house style. Don't rename to `slotTypeEnum` — diverges from precedent.
- **Postgres enum label order is observable.** The migration emits `CREATE TYPE "public"."slot_type" AS ENUM('empty','recipe','eat_out','takeaway','leftovers')` and the order is encoded in `pg_enum.enumsortorder`. A smoke test in `meal-plans-schema.test.ts` asserts the exact 5-label sequence; if a later migration accidentally reorders or renames, the test fires. Extending the enum requires `ALTER TYPE ... ADD VALUE ...` in a migration — drizzle-kit handles this when the array order is preserved and a new value is appended.
- **Drizzle's `check()` SQL-tag generates correctly-quoted identifiers.** All four FEAT-12 CHECKs compiled to the expected form with backtick-style sql tags. No hand-edit of the migration was needed for the CHECK syntax (unlike FEAT-11's `CREATE EXTENSION pg_trgm` which had to be prepended manually — drizzle-kit doesn't track extensions, but it does track CHECKs).
- **Test-FK behaviour via `expectConstraintViolation(promise, name)`.** Reused from FEAT-11. Drizzle's `DrizzleQueryError` wraps the underlying pg `DatabaseError`; `.cause.constraint` is the canonical place to read the constraint name. `vitest`'s `.rejects.toThrow(/regex/)` would match against the wrapper's `.message` which is just the failed SQL — the helper reads the constraint name directly so the tests prove which invariant fired.
- **`date` columns declared with `mode: 'date'`,** same as FEAT-11. `meal_plans.startDate` / `endDate` and `meal_plan_slots.date` all use Drizzle's date-mode-Date variant so values round-trip as JS `Date` rather than strings. SQL is unchanged.
- **`updatedAt` via `$onUpdate(() => new Date())` on all three new tables.** DEC-16 discipline. `mealPlans.updatedAt`, `mealPlanSlots.updatedAt`, `shoppingListItems.updatedAt` — all `timestamp({ withTimezone: true }).notNull().default(sql\`now()\`).$onUpdate(...)`. Tests cover the bump for all three.

### Spec ambiguities resolved here (don't re-litigate)

- "joint-set CHECK on `cooks_base_*` with `> 0` guard" — one combined CHECK, one constraint name, biconditional + positive guard.
- `ON DELETE` for `meal_plan_slots.planId` — **CASCADE**. Slots are owned by their plan.
- `number_of_servings` constraint when `slot_type = 'recipe'` — **NOT NULL AND > 0**, both in the same named CHECK.
- `recipeId` ON DELETE — **RESTRICT**, mirroring `cooksBaseRecipeId`'s explicit RESTRICT.
- `shop_date` on `meal_plans` — **not added in v1**; defer to whenever multi-shop work lands (per `docs/non-goals.md`).
- `householdId` on slots / shopping_list_items — **not added**; inherited via `planId → meal_plans.householdId`.

### Open items for downstream FEATs

- **FEAT-27 (create plan) — overlap check uses the `meal_plans_household_start_date_idx` btree** on `(household_id, start_date)`. DEC-38's rule ("new plans cannot overlap with non-deleted plans whose `endDate >= today`") translates to a `WHERE household_id = CURRENT_HOUSEHOLD_ID AND end_date >= :today AND tstzrange(start_date, end_date, '[]') && tstzrange(:new_start, :new_end, '[]')` predicate; the index covers the leading clause.
- **FEAT-30 (slot editor) — `cooks_base_recipe_id` must reference a recipe with `is_base = true`.** Application-layer validation, raise `TRPCError({ code: 'BAD_REQUEST', cause: { code: 'NOT_A_BASE_RECIPE', recipeId } })`. Multi-statement slot saves wrap in `withTransaction` (cross-cutting #4).
- **FEAT-35 (account deletion) — the tombstoning sequence now also NULLs** `meal_plans.created_by_user_id` and `meal_plan_slots.chef_user_id`. Both columns are `ON DELETE SET NULL`, so the user-row delete would handle it automatically — but the explicit-update step in DEC-29's sequence still applies for audit-trace clarity.
- **FEAT-36 / FEAT-38 (shopping list) — `shopping_list_items` rows are lazy-created on first call to `shopping.getForPlan(planId)`** (DEC-30). The `getForPlan` procedure must run inside `withTransaction` (cross-cutting #13) so concurrent first-reads can't race on insert. Quantities are *not* stored on the table — they're computed from the plan's recipes on read; only `is_checked` is persistent state.
- **FEAT-37 (delete plan) — plan delete cascades to slots and shopping_list_items.** No explicit cleanup needed in the application layer; the FK actions handle it.

### Environment notes — same Colima env vars as FEAT-09 / 10 / 11

```sh
export DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

This pass confirmed the failure mode again: without `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` set, Ryuk tries to bind-mount `~/.colima/default/docker.sock` *inside* the Ryuk container, which the Lima VM rejects with `operation not supported`. The override points the bind-mount at `/var/run/docker.sock` (the path the daemon listens on *inside* the VM) and Ryuk is happy. `TESTCONTAINERS_RYUK_DISABLED=true` is the alternative documented at FEAT-10/11; either works.

CI (`ubuntu-latest`) doesn't need either.

### Deferred (do NOT do as part of FEAT-12)

- `recipes.create` / `recipes.updateHeader` etc. — **FEAT-20**.
- `plans.create` (with overlap check) — **FEAT-27**.
- Slot-save procedure with `is_base` validation — **FEAT-30**.
- Plan shrink/extend transaction — **FEAT-35**.
- Shopping-list aggregation + lazy create — **FEAT-38**.
- `pickable-recipes` helper (cross-cutting #5) — **FEAT-19**.
- `dateUtils` module (cross-cutting #8) — **FEAT-27** (first consumer is the plan-overlap check).
- Plant-points helper — **FEAT-40**.
- Zod schemas in `/shared/src/schemas/*` — land alongside the procedures that consume them.

---

## 2026-05-21 — FEAT-11 (Schema: recipes domain)

**Status:** implementation complete; `pnpm --filter backend test` green (69 tests; 32 new recipes-domain cases + 37 inherited). Typecheck + lint clean across all workspaces. Migration applies cleanly via Testcontainers from a fresh image. Definition-of-done boxes in `docs/feature-specs.md §FEAT-11` left unticked — human action.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **Eight per-serving macro columns, not the spec's six.** Final set: `calories`, `protein`, `carbs`, `fat`, `saturated_fat`, `fibre`, `sugar`, `salt` (all `smallint NULL`). *Why:* matches UK front-of-pack labelling — covers everything most online recipes already publish, and avoids a follow-up migration to add `salt` the first time someone logs a soy-sauce-heavy meal. `docs/plan.md` line 217 updated in the same pass.
- **`recipe_sources` is household-scoped** with `UNIQUE (household_id, name)`. *Why:* the plan called it "user-extensible" but listed no `household_id`; under DEC-17's single-tenant-with-multi-tenant-readiness posture, the global option would leak one household's sources into another's picker the day a second household is added. Cheaper to scope now.
- **`recipe_ratings.user_id` is `ON DELETE RESTRICT`,** not CASCADE. *Why:* DEC-29's tombstoning sequence (plan.md lines 86–91, step 1) explicitly deletes the user's ratings before the user row. RESTRICT forces FEAT-35 to honour that step instead of letting a stray `DELETE FROM users` quietly destroy ratings without going through the documented path.
- **No `$onUpdate` on `recipe_comments.last_updated_at`.** *Why:* Drizzle's `$onUpdate` fires on INSERT too (when the column has no provided value) — keeping it would mean the column is never NULL on a fresh comment, defeating the spec's NULL-means-never-edited inference (plan.md line 229). The application layer (FEAT-29) sets `last_updated_at` explicitly when a comment is edited. All other timestamp / date columns in the new schema do use `$onUpdate` per DEC-16.
- **Trigram GIN index expression went straight through `drizzle-kit`.** Declared as `index(...).using('gin', sql\`lower(${table.name}) gin_trgm_ops\`)`; the generated SQL is correct verbatim — no hand-edit needed for the index DSL. The only manual edit to the generated migration was prepending `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (drizzle-kit doesn't track extensions). This means future schema diffs against this index round-trip cleanly.
- **`date_added` / `date_last_updated` use `date({ mode: 'date' })`.** *Why:* the default `date()` builder returns string mode, which mismatches `$onUpdate(() => new Date())`'s `Date` return type. `mode: 'date'` keeps the column as Postgres `date` while letting Drizzle round-trip JS `Date` values. No SQL difference.
- **PK style for recipe-domain tables is `integer().generatedAlwaysAsIdentity()`.** *Why:* spec says `int PK`; reference tables (FEAT-10) use `smallserial` because they're 5–10 rows each. Recipe-domain tables expect orders of magnitude more, so 32-bit identity is the right fit. The choice cascades into FKs — `recipe_ingredients.recipe_id` is `integer`, `recipe_ingredients.prep_type_id` is `smallint` to match `preparation_types.id`'s `smallserial`.

### Drift from kick-off plan

1. **Recipe `dateAdded` / `dateLastUpdated` declared with `mode: 'date'`** — not pre-flagged in the plan but unavoidable once Drizzle's typed builder rejected `Date` as the `$onUpdate` return type for a string-mode column. SQL output unchanged.
2. **Test file is `backend/test/recipes-schema.test.ts`** (per the approved plan). Reuses the Testcontainers + per-test `truncate ... restart identity cascade` pattern from `backend/test/schema.test.ts:44–77`. 32 tests across migration-shape, CHECK constraints, FK ON DELETE behaviour, surrogate-key duplicates, NULL-distinct uniqueness on `recipe_drafts`, and `$onUpdate` round-trips.
3. **A small `expectConstraintViolation(promise, name)` helper** lives in the test file. *Why:* `vitest`'s `rejects.toThrow(/regex/)` matches against the thrown error's `.message`, but Drizzle wraps the underlying `pg` `DatabaseError` in a `DrizzleQueryError` whose `.message` is just `"Failed query: <sql> params: ..."`. The constraint name is on `.cause.constraint`. The helper reads that and asserts on it — without it, the tests would either pass when the wrong constraint fired, or be reduced to "something threw."

### Implementation details worth carrying

- **Drizzle's `$onUpdate` fires on INSERT-without-value, not just UPDATE.** Counter-intuitive name. If a column should be NULL until explicitly set (like `recipe_comments.last_updated_at`), do not use `$onUpdate`. If the column should always be populated (the standard `updated_at` discipline DEC-16 describes), `$onUpdate` is correct precisely because of this behaviour.
- **drizzle-kit doesn't track Postgres extensions.** `CREATE EXTENSION IF NOT EXISTS pg_trgm` had to be prepended to the generated SQL. The migration carries a `--` comment explaining why; any future migration that uses `gin_trgm_ops` (or any other extension operator class) needs the same treatment. There's no Drizzle DSL hook for this — it's a one-line manual edit and that's fine.
- **`index(...).using('gin', sql\`lower(${col}) gin_trgm_ops\`)`** is the right Drizzle DSL for a trigram GIN index on an expression. The generated SQL is `CREATE INDEX "name" ON "table" USING gin (lower("col") gin_trgm_ops);` — verbatim what FEAT-19's ILIKE search needs.
- **Self-referential FKs use `references((): AnyPgColumn => table.id, {...})`.** The lazy arrow + `AnyPgColumn` cast is the documented Drizzle pattern; the back-reference resolves at table finalisation. Three columns use it here: `recipes.base_recipe_id` (RESTRICT), `recipes.paired_recipe_id` (SET NULL), and (transitively, via composite FKs) `related_recipes`.
- **Migration file was auto-named `0001_futuristic_cerise.sql`; renamed to `0001_recipes_domain.sql` and the journal `tag` updated to match.** drizzle-kit's auto-naming is fine in CI but worse than a descriptive name for future grep. The pattern: rename the `.sql` file, edit `drizzle/meta/_journal.json` to update the `tag` field for the matching `idx`. Snapshot file is keyed by `idx` and doesn't need renaming.
- **Composite PK on `related_recipes` declared via `primaryKey({ columns: [a, b] })`** in the table's second-argument array. The CHECK `recipe_one_id < recipe_two_id` enforces symmetry at the DB level — one row per pair, period. App-layer code in FEAT-21 only ever has to compute `[lo, hi] = a < b ? [a, b] : [b, a]` before inserting.

### Open items for downstream FEATs

- **FEAT-12 (meal plans) — `meal_plan_slots.recipe_id` and `meal_plan_slots.cooks_base_recipe_id`** both FK to `recipes.id`. Recipes are 32-bit `integer`, so the slot FKs are `integer`. `cooks_base_recipe_id` ON DELETE RESTRICT (per spec). The slot-type enum lives there, not here.
- **FEAT-19 (recipe procedures) — `pickable-recipes` helper** (cross-cutting #5) encodes the soft-delete visibility rule. Don't filter `is_deleted = false` by hand at any call site. The trigram GIN index is now ready for `lower(name) % :query` ILIKE search; no further DB work needed.
- **FEAT-21 (recipe editor) — `paired_recipe_id` symmetry** is maintained in the application layer inside a `withTransaction` (DEC-22, cross-cutting #4). Setting A.paired = B must also set B.paired = A in the same tx; clearing one must clear both.
- **FEAT-29 (comments) — `recipe_comments.last_updated_at`** is application-managed (no `$onUpdate`). The comment-edit procedure must set it explicitly. UI shows "(edited)" iff non-NULL.
- **FEAT-35 (account deletion) — RESTRICT on `recipe_ratings.user_id` and `recipe_drafts.user_id`** forces the tombstoning sequence to delete those rows *before* the user row. Verified by the FK tests in this pass.

### Spec ambiguities resolved here (don't re-litigate)

- "six `*_per_serving` macro columns" — explicitly **changed to eight** with named columns (`calories`, `protein`, `carbs`, `fat`, `saturated_fat`, `fibre`, `sugar`, `salt`). Spec text in `docs/plan.md` line 217 updated.
- "user-extensible" `recipe_sources` with no `household_id` mentioned — **scoped to household** + `UNIQUE (household_id, name)`.
- `recipe_ratings.user_id` ON DELETE not specified explicitly — **RESTRICT**, in line with the spec's "tombstone-able SET NULL, the rest RESTRICT" rule and DEC-29's explicit-deletion sequence.

### Environment notes — same Colima env vars as FEAT-09/10

```sh
export DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock
export TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1
export TESTCONTAINERS_RYUK_DISABLED=true   # or TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE per FEAT-09 entry
```

CI (`ubuntu-latest`) doesn't need either.

### Deferred (do NOT do as part of FEAT-11)

- tRPC procedures for recipes / ingredients — **FEAT-17 / FEAT-19 / FEAT-20**.
- Zod schemas in `/shared/src/schemas/` — land alongside the procedures that consume them.
- Cloudinary signed-upload procedure — **FEAT-17**.
- The `pickable-recipes` helper — **FEAT-19**.
- Recipe-pairing symmetry transaction — **FEAT-21 / FEAT-23**.
- Account-deletion tombstoning — **FEAT-35**.
- Partial index on `recipes WHERE is_deleted = false` — not in the spec; revisit if recipe scan plans get slow with soft-deleted rows.

---

## 2026-05-21 — FEAT-10 (Schema: auth, household, reference tables + seeds)

**Status:** implementation complete; `pnpm --filter backend test` green (37 tests; 11 new FEAT-10 cases + the 26 inherited). Typecheck + lint clean across all workspaces. Manual flow verified locally: migrate → seed → re-seed → psql confirms one household row, 2 occasions, 8 categories, 8 units, 6 prep types; counts unchanged after the second run. Definition-of-done boxes in `docs/feature-specs.md §FEAT-10` left unticked — human action.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **`households.id` is `uuid`, not the spec's `smallint`.** Kept the existing `CURRENT_HOUSEHOLD_ID = '00000000-0000-4000-8000-000000000001'` from FEAT-09. *Why:* DEC-17's "multi-tenancy-ready" promise is exactly the place the FK type pays off — a future `smallint → uuid` migration touches every domain table's FK and every index built on it, and uuid is the only sensible choice at SaaS scale (non-enumerable, no count leak, distributed-generation-safe). At household scale the 14 extra bytes per FK are rounding error. Spec text updated in this pass; the `[ ]` checkbox on that AC still reads literally — see "spec wording" below.
- **Install `better-auth` now, code the schema against its runtime.** Reading the installed package's `@better-auth/core/db/get-tables.mjs` is unambiguous; reading the docs site is not. Schema shapes are now derived from the same code the library will execute at runtime, which is the only mismatch-proof reading.
- **Reference seeds: opinionated MVP lists** (`INGREDIENT_CATEGORIES`, `UNITS_OF_MEASUREMENT`, `PREPARATION_TYPES` in `backend/src/db/seeds/reference.ts`). *Why:* "with their seed data" in the spec implies populated, not empty. Seeded lists are exported so tests can assert the full set; edit at source, not via DB-only inserts.
- **`themePreference` via Drizzle `pgEnum`.** *Why:* matches DEC-78 verbatim and Drizzle infers the literal union type automatically. Adding values is cheap; removing values (the only painful case) isn't a realistic future for `system|light|dark`.
- **Reference table columns minimal:** `id smallserial`, `name text UNIQUE NOT NULL`. No `display_order`, no timestamps. *Why:* these rows are static enums-with-attributes. Add `display_order` later only when the UI actually needs explicit ordering.
- **Pluralised table names** (`users`, `sessions`, `accounts`, `verifications`). Better Auth defaults to singular (`user`), but `user` is a Postgres reserved word — quoting on every raw-SQL path is a footgun and the spec's `\d users` line uses plural anyway. FEAT-14 will need `usePlural: true` (or per-model `modelName` overrides) when configuring the Better Auth Drizzle adapter.

### Drift from kick-off plan

1. **`backend/src/db/seeds/index.ts` added** — not on the kick-off file list. Hosts the `runSeeds(withTransaction)` runner that both `scripts/seed.ts` and the test suite consume. Keeping it as a module lets the test import `runSeeds` without spinning up the CLI's pino logger or owning pool lifecycle.

2. **`backend/tsconfig.json` extended** to include `scripts/**/*`. ESLint's project service couldn't resolve `scripts/seed.ts` otherwise (same shape as the FEAT-09 fix that added `drizzle.config.ts`). Follow the same pattern when adding any future top-level script directory.

3. **`backend/package.json` script added:** `"seed": "tsx --env-file-if-exists=.env scripts/seed.ts"`. Mirrors the `dev` script's env-file handling so `pnpm --filter backend seed` works against any environment that has a `.env`, not just the shell session that exports vars.

4. **Spec wording updated, AC checkbox text changed.** The original FEAT-10 spec said `household_id smallint PK`. With the uuid call locked in, the AC line now reads "`id uuid PK` matching `CURRENT_HOUSEHOLD_ID`". *Per AGENTS.md the box itself stays unticked* — the user verifies and ticks. Spec-text edits are not the same as DoD ticks.

5. **No standalone Pino plugin used in the seed CLI.** `backend/src/plugins/logger.ts` returns a Fastify `FastifyServerOptions['logger']`, not a Pino instance — fine for the server, no use to a CLI script. Created a small `pino({ level: process.env.LOG_LEVEL ?? 'info' })` instance directly in `scripts/seed.ts`. The AGENTS.md "Pino only" rule is honoured; no `console.log` introduced.

### Implementation details worth carrying

- **Better Auth's canonical schema lives in `@better-auth/core/dist/db/get-tables.mjs`.** Single function `getAuthTables(options)` that returns the user/session/account/verification table shapes plus their plugin extensions. Read it first if a future schema change feels ambiguous from the docs — the source is unambiguous.
- **Better Auth uses string IDs everywhere.** `users.id`, `sessions.userId`, `accounts.userId`, `verifications.id` are all `text`. Downstream FKs to `users.id` (FEAT-29's tombstoning columns: `recipes.addedByUserId`, `meal_plans.createdByUserId`, etc.) must be `text`, not `uuid`. Don't try to "normalise" by switching the auth schema to uuid PKs — Better Auth's own generator won't match.
- **`pgEnum` migration shape.** Drizzle emits `CREATE TYPE "public"."theme_preference" AS ENUM('system','light','dark');` as a separate statement before the table referencing it. If a future migration removes the enum, the type-drop step has to follow the last column reference — Drizzle handles this automatically via `db:generate` but raw SQL migrations need to know it.
- **`drizzle-orm/node-postgres/migrator`** is the right import for programmatic migrations in tests; pass `{ migrationsFolder: '<path-to>/backend/drizzle' }`. `import.meta.url` + `fileURLToPath` resolves to the test file's directory, so `path.resolve(here, '..', 'drizzle')` keeps the test file portable.
- **`onConflictDoNothing({ target: column })`** needs the column to participate in a unique constraint *of its own* — not just a multi-column index that includes it. Our reference tables use a single-column `UNIQUE` per spec, so this works directly. Worth knowing if FEAT-11 lands a composite-unique table and the seed pattern repeats.
- **`accounts.password` is dead-but-kept under magic-link-only.** DEC-41 forbids password *flows*; Better Auth's canonical account model has the column unconditionally and the Drizzle adapter inserts every field listed in `getAuthTables(options)`. Removing the column would crash the adapter on its first account-write unless we *also* configure `account.fields.password = false` (or similar) in `betterAuth({...})` at FEAT-14. NULL costs zero bytes in PG's row payload (only a bit in the null bitmap), so the schema-hygiene win isn't worth the new failure mode. Revisit at FEAT-14 if pruning the column for clarity becomes worth a one-config-line + one-migration follow-up.
- **Session/verification token columns are plaintext-at-rest, not hashed.** This is Better Auth's design (`@better-auth/core/dist/crypto/*` generates `crypto.randomBytes`-backed strings); we just store them. Defence model is HttpOnly+Secure cookies (DEC-43) + 10-minute TTL on magic-link nonces (DEC-41). If a future security review wants hashed-at-rest sessions, that's a Better Auth fork/config conversation, not a schema change.

### Open items for downstream FEATs

- **FEAT-14 — Better Auth `usePlural: true` config.** Schema is plural; Better Auth defaults to singular model names. Either pass `usePlural: true` in the adapter options or override per-model with `user: { modelName: 'users' }`, etc. If we forget, the adapter will throw at runtime on its first DB call.
- ~~**FEAT-14 — Zod 4 transitive pin.**~~ **Resolved 2026-05-21:** project upgraded to `zod@^4` while the consuming surface was a single file (`backend/src/config.ts`); path (a) chosen. DEC-07 amended with the version pin. `@hookform/resolvers` bumped to `^5` alongside. No translation seam needed at the Better Auth boundary — `/shared/src/schemas/*` will land on v4 from the start.
- **FEAT-11 (recipes) — `addedByUserId` is `text` (Better Auth string ID)**, not `uuid`. Cascade behaviour at user deletion is *not* `ON DELETE CASCADE` (DEC-29 tombstoning); the recipe deletion step must NULL these columns explicitly in the FEAT-35 transaction.
- **FEAT-11 (recipes) — `householdId` is `uuid`.** All FKs to `households.id` are 16-byte uuid columns. Index sizing in `docs/measurements.md` will need updating once recipe volume becomes measurable.

### Spec ambiguities resolved here (don't re-litigate)

- "household_id smallint PK" — overridden to uuid per DEC-17's revisit clause. Spec text updated.
- "with their seed data" for the three under-specified reference tables — resolved to the opinionated MVP lists exported from the seed module.
- "users (with `theme_preference`...)" — implemented as Drizzle `pgEnum('theme_preference', [...])` rather than text + CHECK.

### Environment notes — Colima continued

Same two env vars as FEAT-09 are still required to run the backend test suite locally:

```sh
export DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock
export TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1
export TESTCONTAINERS_RYUK_DISABLED=true   # or TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE per FEAT-09 entry
```

CI (`ubuntu-latest`) uses the default socket path and needs neither.

### Prettier ignore — root file isn't enough for per-workspace runs

`pnpm format:check` (root) was always clean; `pnpm -r format:check` (per-workspace) was flagging `frontend/dist/`, `frontend/src/routeTree.gen.ts`, `backend/dist/server.js`, `backend/drizzle/meta/*.json`. **Root cause:** prettier 3 finds `.prettierrc` by walking *up* the directory tree, but `.prettierignore` is only read from the CWD. So `pnpm -r format:check` ran `prettier --check .` inside each workspace and never saw the root ignore file. CI uses the root invocation, so it stayed green throughout — only local `-r` runs hit the gap.

**Fix landed alongside FEAT-10:** added per-workspace `.prettierignore` files in `frontend/`, `backend/`, `shared/`, each with workspace-relative paths (`src/routeTree.gen.ts` in frontend, `drizzle/meta` in backend, etc.). Slight duplication with the root file, accepted because the alternative — `--ignore-path ../.prettierignore` in each workspace's `format`/`format:check` scripts — hits anchored-path issues (a rule like `frontend/src/routeTree.gen.ts` won't match `src/routeTree.gen.ts` when prettier runs from inside `frontend/`).

Also tightened the root file: narrowed `backend/drizzle` (which was hiding the .sql migration files from prettier) to `backend/drizzle/meta`, and dropped the redundant `shared/dist` (matched by plain `dist`).

If a future change adds a fourth workspace, copy the relevant subset into a new workspace-local `.prettierignore` rather than relying on the root file.

### Deferred (do NOT do as part of FEAT-10)

- Configure `betterAuth(...)`, mount the auth router, set `usePlural` — **FEAT-14**.
- Recipes domain (recipes, recipe_ingredients, recipe_method, etc.) — **FEAT-11**.
- Meal-plans domain — **FEAT-12**.
- Trigram GIN indexes on recipe / ingredient name — **FEAT-11**.
- Account-deletion tombstoning sequence (NULL `addedByUserId` etc., delete user row) — **FEAT-35**.
- Update `docs/measurements.md` with index sizing implications of `uuid` household FKs — open whenever FEAT-11/12 lands measurable row counts.

---

## 2026-05-20 — FEAT-09 done; FEAT-10 next

- **Just finished:** FEAT-09 (Drizzle infrastructure). Detailed entry below. Tests green locally (26/26); human verification of acceptance criteria still pending. **Commit not yet made.**
- **Operational follow-up (do before next prod deploy):** `flyctl postgres create` → `flyctl postgres attach` against `loftys-larder-prod`. Today the prod app has no `DATABASE_URL`; with FEAT-09 in, the server refuses to boot without it. Order matters: attach before merging FEAT-09 to `main`, or the next deploy crashloops.
- **Next:** kick-off FEAT-10 (Schema: auth, household, reference tables + seeds). Read `docs/feature-specs.md §FEAT-10` + DEC-15 / DEC-16 / DEC-17 / DEC-41 / DEC-42.
- **DEC-80 decision now blocking FEAT-10/11.** FEAT-09 didn't trigger it (no `/shared` runtime imports added); FEAT-10 will if it lands Better Auth Drizzle table shapes / Zod schemas in `/shared`. Decide build approach (tsc emit vs `paths` mapping vs `exports` → `src/`) at FEAT-10 kick-off, *before* the schema PR lands. Three options sketched in FEAT-05 session note.
- **FEAT-10 must import `CURRENT_HOUSEHOLD_ID`** from `backend/src/config.ts` (or its re-export from `backend/src/db/index.ts`) for the households seed row. Do NOT regenerate the UUID — value is `00000000-0000-4000-8000-000000000001`.
- **FEAT-10 first real migration** will be the first thing `backend/drizzle/` actually contains. `db:generate` is wired and verified empty against today's schema; `db:migrate` is wired and verified no-op against the Compose Postgres.

---

## 2026-05-20 — FEAT-09 (Drizzle infrastructure)

**Status:** implementation complete; `pnpm --filter backend test` green (26 tests, including 5 Testcontainers smoke cases) with Colima env. Typecheck and lint clean across all workspaces. Definition-of-done boxes in `docs/feature-specs.md §FEAT-09` left unticked — human action.

### Decisions taken at kick-off (the *why*, not just the *what*)

- **`CURRENT_HOUSEHOLD_ID` is a hardcoded UUID constant** in `backend/src/config.ts` (`00000000-0000-4000-8000-000000000001`), re-exported from `backend/src/db/index.ts`. *Why hardcoded, not env-var:* single-household MVP (DEC-17) only needs *one* value across all environments; an env var would invite drift between dev/test/prod. FEAT-10's seed must import this constant — do not regenerate.
- **`DATABASE_URL` is required in every environment** (Zod-validated as `postgres://` or `postgresql://`). *Why required, not optional-with-lazy-pool:* plumbing only earns its keep if it's hot at startup, and `health.ping` will start touching the DB at FEAT-46. Boot-time failure is the right time to surface a missing secret, not first-DB-query time.
- **Pool max hardcoded at 10**, `min` at pg-pool default 0. *Why not env-var-overridable:* DEC-71 picked a static number once for the household workload ceiling. The Testcontainers smoke builds its own `pg.Pool({ max: 1 })`, so test concurrency is decoupled.
- **DEC-80 not triggered by FEAT-09.** No `/shared` runtime imports added; the call is deferred to FEAT-10/11 when Better Auth Drizzle table shapes and/or Zod schemas first cross the workspace boundary at runtime.

### Drift from kick-off plan

1. **No `currentDatabase` factory.** Plan implied a singleton with optional factory; ended up with a clean singleton (`pool`, `db`, `withTransaction` exported from `backend/src/db/index.ts`) and a `makeWithTransaction(db)` constructor in its own file so the smoke test can build its own Drizzle handle against the Testcontainers Postgres without depending on env-var config. Audit-grep for `db.transaction(` still hits only `withTransaction.ts`.

2. **`drizzle-kit` casing option set globally** via `casing: 'snake_case'` on both the Drizzle runtime (`drizzle(pool, { schema, casing: 'snake_case' })`) and `drizzle.config.ts`. Means FEAT-10 columns can stay camelCase in the Drizzle DSL without per-column `name()` mapping — DEC-15 honoured by config, not by per-column boilerplate.

3. **`tsconfig.json` extended** to include `drizzle.config.ts` so ESLint's project service can lint it; not on the kick-off file list but unavoidable once `strictTypeChecked` ran on the config file.

4. **`backend/test/server.test.ts` and `backend/test/config.test.ts` updates** beyond the kick-off plan: existing tests assumed `DATABASE_URL` didn't exist; both now pass it via `baseEnv` (config) / inline (server). The `_ignored` destructure pattern wasn't allowed by `@typescript-eslint/no-unused-vars` — switched to an `envWithout(key)` helper using `Object.fromEntries(...).filter(...)`.

5. **`pg-pool` exhaustion test loop** initially asserted `select ${i}` round-trip; pg returns parameterized numeric values as strings (pg-types default for inferred `int4/numeric`). Tightened to `select 1 as ok` — still exercises the release-back-to-pool path, just without the type-coercion noise. Worth knowing in FEAT-10 onward: when a test (or runtime code) reads a count or numeric value back from pg, **the value may arrive as a string** unless you cast in SQL (`::int`) or configure `pg-types.setTypeParser`. Drizzle's typed `db.select()` API masks this for column reads — it's only loose `db.execute()` rows that hit the raw pg-types behaviour.

### Implementation details worth carrying

- **`pg` ESM import shape:** `import pg from 'pg'; const { Pool } = pg;` (or `new pg.Pool(...)`). `pg` is CJS-published with named exports; under NodeNext, the default-import-then-destructure pattern is what works. Reach for `import { Pool } from 'pg'` and the build will fail.
- **`vitest.config.ts` left untouched.** No global test setup, no env-var injection at the vitest layer. Each test file that needs Postgres builds its own Drizzle handle (smoke test pattern). FEAT-10 integration tests can copy the smoke-test pattern; don't add a global setup file unless the duplication actually hurts.
- **Drizzle's global `casing: 'snake_case'`** is set in both `backend/src/db/index.ts` (runtime) *and* `backend/drizzle.config.ts` (kit). The two need to agree, or generated migrations will diff against the runtime DSL. If you change one, change the other.

### Environment notes — Testcontainers under Colima

Two env vars required to run the smoke suite locally:

```sh
export DOCKER_HOST=unix:///Users/$USER/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

- `DOCKER_HOST` — Colima's socket isn't at the default `/var/run/docker.sock`; Testcontainers' runtime detection has to be pointed at it.
- `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` — Ryuk (Testcontainers' reaper) bind-mounts the docker socket back into its own container. Colima's Lima VM can't bind-mount a `~/.colima/...` path through 9p in a way Ryuk expects; pointing the override at `/var/run/docker.sock` is the documented Colima workaround.

GitHub Actions runners use the default socket path and don't need either override. Worth a `docs/OPERATIONS.md` line at FEAT-50 lift; not blocking.

### Deferred (do NOT do as part of FEAT-09)

- Wire `db` into the tRPC context — downstream FEAT (FEAT-10 first procedure).
- `flyctl postgres create` / `flyctl postgres attach` and `DATABASE_URL` in Fly secrets — operational follow-up; required before the next prod deploy.
- Any table/schema — FEAT-10/11/12.
- `release_command "pnpm drizzle-kit migrate"` in CI — FEAT-48.
- `/shared` runtime build wiring (DEC-80 revisit) — deferred until the FEAT that first lands a runtime shared import.

---

## 2026-05-17 — FEAT-06 (Fly.io initial deploy + Cloudflare DNS)

**Status:** implementation complete on 2026-05-20. Live URL is `https://loftys-larder.co.uk`, `www` 301s to apex, `/api/trpc/health.ping` round-trips through Cloudflare → Fly (`lhr`). Browser load + DevTools clean. Definition-of-done boxes in `docs/feature-specs.md §FEAT-06` left unticked — human action.

### Drift from runbook

1. **Cert ownership via `_fly-ownership` TXT, not the A/AAAA path Fly "recommended".** Behind Cloudflare orange-cloud, public DNS returns Cloudflare IPs, not Fly's — so Fly's IP-based ownership check can never validate while proxying is on. TXT is the right path here. Runbook Step 4/5 updated mid-execution to reflect this; same fix will apply for any future hostname added to the Fly app.

2. **Cache rule needed a UI-builder fix.** Initial config used `URI Full` + `wildcard` with the raw expression syntax pasted as the wildcard value — that never matches. Final: `URI Path` + `starts with` + `/api/`, action `Bypass cache`. Rule shows Active in dashboard.

3. **`cf-cache-status` reports `DYNAMIC`, not `BYPASS`, on `/api/*` probes.** Accepted: tRPC responses carry no `Cache-Control`, so Cloudflare's default classifier independently marks them uncacheable before the bypass rule's signal is attributed in the header. Defense-in-depth holds (classifier + rule both say don't cache). Worth knowing if a future endpoint inadvertently sets cacheable headers — that's when we'd start seeing `BYPASS` instead.

4. **`www → apex` redirect went Dynamic, not Static.** Static + "Preserve path suffix" toggle dropped the path on test probes — only query string came through. Switched to Dynamic with expression `concat("https://loftys-larder.co.uk", http.request.uri)`. `http.request.uri` is already path+query, so the expression is short. The `if`/`len` builtins from typical filter expressions aren't available in `target_url` expressions — caused one false start.

### Implementation decisions worth carrying

- **`flyctl deploy --remote-only` for the first deploy** because local Docker has no `buildx` (see FEAT-05 entry below). Once `docker-buildx` is installed, the flag can be dropped.
- **Fly issues only the LE cert** in `flyctl certs show`. The FEAT-06 gotcha's mention of "two certs (LE + Cloudflare-origin)" refers to Fly's LE cert plus Cloudflare's edge SSL cert — the latter is implicit and verified by Full (strict) SSL mode being on without TLS errors on the live URL.
- **Cloudflare SSL/TLS mode: Full (strict).** "Always Use HTTPS" left **off** — Fly's `force_https = true` (in `fly.toml`) is the single redirect authority. No loops.
- **`fly-request-id` flows through Cloudflare untouched.** Confirmed in probes. This is the foundation for FEAT-43's `reqId` propagation (DEC-77 / cross-cutting #1).
- **All helmet security headers survive the Cloudflare hop.** CSP, HSTS, X-Frame-Options, etc. all present on responses fetched through the proxied URL.

### Decisions taken at kick-off

- **App name:** `loftys-larder-prod`. Now pinned in `fly.toml`. Renaming is painful — treat as permanent.
- **Canonical host:** apex. `www` 301-redirects to apex. Done at Cloudflare with a Single Redirect rule (cheapest place — keeps the redirect off the Fly machine's wake path).
- **HTTPS redirect authority:** Fly. `force_https = true` stays in `fly.toml`; Cloudflare "Always Use HTTPS" stays **off**. Single source of truth, no loop (FEAT-06 gotcha line 266).
- **Cloudflare SSL mode:** Full (strict). Fly issues a real LE cert; Flexible would downgrade the Cloudflare→Fly hop to HTTP and break `force_https`.
- **Cache bypass pattern:** the rule matches `/api/*` — broad enough to cover the tRPC URL shape `/api/trpc/<procedure>?batch=1&input=...` (cross-cutting #16). Do not narrow it.

### Runbook — first-time prod deploy

Substitute `<DOMAIN>` throughout once chosen. Capture every command's exit status / output worth keeping; FEAT-50 lifts this into `OPERATIONS.md`.

#### Step 0 — Domain (manual, Cloudflare Registrar)

1. Pick a domain. Cloudflare Registrar charges at-cost (no markup, no upsell). Avoid `.app` (HSTS preloaded — debugging cert issues is harder); `.io` has had reliability wobbles. A plain `.com` or `.co.uk` is the boring correct choice.
2. Register / transfer at <https://dash.cloudflare.com/?to=/:account/registrar>. Cloudflare Registrar requires the domain's DNS already be on Cloudflare — if it's elsewhere, add the zone first, change nameservers at the current registrar, then transfer.
3. Once registered, the zone appears in the Cloudflare dashboard. Note the zone's API account-id and zone-id — useful for later Cloudflare automation but not required here.

Record: chosen domain, registration date, registrar account email.

#### Step 1 — Install + auth flyctl

```sh
brew install flyctl          # if missing
flyctl version               # record
flyctl auth login            # opens browser
flyctl auth whoami           # record the org / email
```

`flyctl` was not installed locally at FEAT-05 (see 2026-05-17 entry below). Do not commit any flyctl config files that land in `~/`.

#### Step 2 — Create the Fly app (no deploy yet)

```sh
flyctl apps create loftys-larder-prod --org <org>
```

The repo's `fly.toml` already names the app; do **not** run `flyctl launch` — it would prompt to overwrite `fly.toml`, the `Dockerfile`, and `.dockerignore`, all of which are correct as-is from FEAT-05. `apps create` is the surgical equivalent.

Verify:

```sh
flyctl config validate        # reads ./fly.toml
flyctl apps list | grep loftys-larder-prod
```

#### Step 3 — First deploy

No Postgres yet (FEAT-09 attaches it). The app boots without `DATABASE_URL`; `health.ping` doesn't touch the DB, so this is sufficient for FEAT-06's acceptance criteria.

```sh
flyctl deploy --remote-only
```

`--remote-only` uses Fly's remote builder (BuildKit), sidestepping the local-Docker-29-no-buildx situation noted in FEAT-05.

Once it returns healthy:

```sh
flyctl status
flyctl logs                   # sanity-check Pino output
curl -I https://loftys-larder-prod.fly.dev/
curl 'https://loftys-larder-prod.fly.dev/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D'
```

The `*.fly.dev` URL bypasses Cloudflare entirely — use it later to A/B against the Cloudflare-fronted custom domain when diagnosing edge issues.

#### Step 4 — Attach the custom domain at Fly

Apex and www both need Fly certs.

```sh
flyctl certs add <DOMAIN>
flyctl certs add www.<DOMAIN>
flyctl certs list             # both should appear "Not verified"
flyctl ips list -a loftys-larder-prod                 # IPv4 + IPv6 for the app
flyctl certs setup <DOMAIN>                            # prints exact DNS instructions, incl. _fly-ownership TXT
flyctl certs setup www.<DOMAIN>
```

Record the IPv4, IPv6, and the two `_fly-ownership` TXT values verbatim — they go into Cloudflare next.

#### Step 5 — Cloudflare DNS records (TXT for ownership + proxied A/AAAA/CNAME for traffic)

**Why two record types per hostname.** Per DEC-72 we proxy DNS through Cloudflare (orange cloud). When proxied, public DNS lookups return Cloudflare's edge IPs, not Fly's — so Fly's IP-based cert-ownership check via A/AAAA records cannot succeed through the proxy. The fix is a `_fly-ownership` TXT record (TXT records are never proxied), which is what proves ownership to Fly. The A/AAAA/CNAME records still go in, proxied, because that's how live traffic reaches Fly through Cloudflare — they just aren't the ownership proof.

In the Cloudflare dashboard → DNS → Records:

| # | Type | Name | Content | Proxy |
|---|---|---|---|---|
| 1 | TXT | `_fly-ownership` | (value from `flyctl certs setup <DOMAIN>`) | DNS only — TXT never proxies |
| 2 | TXT | `_fly-ownership.www` | (value from `flyctl certs setup www.<DOMAIN>`) | DNS only |
| 3 | A | `@` | (IPv4 from `flyctl ips list`) | Proxied (orange cloud) |
| 4 | AAAA | `@` | (IPv6 from `flyctl ips list`) | Proxied (orange cloud) |
| 5 | CNAME | `www` | `loftys-larder-prod.fly.dev` | Proxied (orange cloud) |

Notes:
- Cloudflare strips the zone suffix in the Name field — entering `_fly-ownership` produces FQDN `_fly-ownership.<DOMAIN>`. Same for the `www` variant.
- Don't add MX / SPF / DKIM / DMARC records here — email lands in FEAT-13.

After DNS propagates (usually < 60s on Cloudflare; TXT records occasionally take a couple of minutes to be visible externally):

```sh
dig +short TXT _fly-ownership.<DOMAIN>      # sanity: TXT visible publicly?
dig +short TXT _fly-ownership.www.<DOMAIN>
flyctl certs check <DOMAIN>                  # re-triggers Fly's validation
flyctl certs check www.<DOMAIN>
flyctl certs show <DOMAIN>
flyctl certs show www.<DOMAIN>
```

Wait until both certs show `Issued` for both Let's Encrypt and Cloudflare-origin (FEAT-06 gotcha line 265 — wait for **both** before declaring done).

#### Step 6 — Cloudflare SSL/TLS settings

Cloudflare dashboard → SSL/TLS → Overview:

- **Encryption mode: Full (strict).** Not Flexible, not Full — Full (strict) requires the origin to present a trusted cert, which Fly does.

SSL/TLS → Edge Certificates:

- **Always Use HTTPS: OFF.** Fly does the redirect (`force_https = true` in `fly.toml`). Two redirect authorities loop.
- **Automatic HTTPS Rewrites: ON** (safe default; rewrites in-page links).
- **Minimum TLS Version: 1.2** (1.3 if no client compatibility worries — fine here).

#### Step 7 — Cloudflare cache rule: bypass `/api/*`

Dashboard → Caching → Cache Rules → Create rule.

- **Rule name:** `bypass-api`
- **When incoming requests match:** custom filter expression
  ```
  (starts_with(http.request.uri.path, "/api/"))
  ```
- **Then:**
  - Cache eligibility: **Bypass cache**
  - (No other settings needed.)
- **Save and deploy.**

Verify with a hit to the protected path:

```sh
curl -sI "https://<DOMAIN>/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D" | grep -i 'cf-cache-status\|cf-ray'
```

Expect `cf-cache-status: BYPASS` (or `DYNAMIC` if the rule hasn't matched but Cloudflare classified it as uncacheable anyway — BYPASS is the desired explicit signal).

#### Step 8 — Cloudflare Single Redirect: `www` → apex

Dashboard → Rules → Redirect Rules → Create rule.

- **Rule name:** `www-to-apex`
- **When incoming requests match:** custom filter expression
  ```
  (http.host eq "www.<DOMAIN>")
  ```
- **Then:**
  - Type: **Static**
  - URL: `https://<DOMAIN>${http.request.uri.path}` (use Dynamic with expression `concat("https://<DOMAIN>", http.request.uri.path)` and preserve query string if you want querystrings forwarded — simpler to enable "Preserve query string" toggle on Static).
  - Status code: **301**
  - Preserve query string: **on**

Verify:

```sh
curl -sI https://www.<DOMAIN>/ | grep -i 'location\|HTTP/'
```

Expect `HTTP/2 301` + `location: https://<DOMAIN>/`.

#### Step 9 — Final probes (acceptance criteria mapping)

| Probe | Expected | Maps to AC |
|---|---|---|
| `curl -I https://<DOMAIN>/` | `200`, `server: cloudflare`, `cf-ray:` present | line 260 |
| `curl 'https://<DOMAIN>/api/trpc/health.ping?batch=1&input=%7B%220%22%3A%7B%7D%7D'` | tRPC success shape | line 261 |
| Response headers on `/api/*` probe | `cf-cache-status: BYPASS` (or `DYNAMIC`) | line 262 / line 250 |
| Browser load on `https://<DOMAIN>/` | frontend renders, no mixed-content warnings | line 251 / 252 |
| Browser load on `https://www.<DOMAIN>/` | 301s to apex | line 251 |
| `flyctl certs show <DOMAIN>` / `www.<DOMAIN>` | both `Issued` for LE + Cloudflare-origin | line 248 |

When all six pass: report back. **Do not** tick the FEAT-06 boxes in `feature-specs.md`; that's a human action after the browser check.

### Deferred to later FEATs (do NOT do as part of FEAT-06)

- `flyctl postgres create` / `flyctl postgres attach` — **FEAT-09**.
- `flyctl secrets set DATABASE_URL=…` — **FEAT-09** (or implicit via `postgres attach`).
- SPF / DKIM / DMARC DNS records for Resend — **FEAT-13**.
- Swap TCP `[checks.tcp_alive]` for HTTP `/api/health` check — **FEAT-46**.
- Wire `release_command "pnpm drizzle-kit migrate"` into CI on push to `main` — **FEAT-48**.
- Cold-start measurement against 3-second budget (DEC-64) — **FEAT-51**.
- Nightly `pg_dump → R2` (DEC-73) — **FEAT-49 / 50**.

### Captured values (live record — for FEAT-50's `OPERATIONS.md` lift)

Fly app: `loftys-larder-prod`, region `lhr`, org TBD.

From `flyctl certs setup` (2026-05-20):

| Hostname | Type | Value |
|---|---|---|
| `loftys-larder.co.uk` | A | `66.241.124.105` |
| `loftys-larder.co.uk` | AAAA | `2a09:8280:1::118:845e:0` |
| `www.loftys-larder.co.uk` | A | `66.241.124.105` |
| `www.loftys-larder.co.uk` | AAAA | `2a09:8280:1::118:845e:0` |
| `loftys-larder.co.uk` | TXT `_fly-ownership` | `app-xkjgdnn` |
| `www.loftys-larder.co.uk` | TXT `_fly-ownership.www` | `app-xkjgdnn` (same value — Fly's token is app-scoped) |

Both hostnames share the same Fly machine IPs (single app, shared edge).

Certificate issuance (2026-05-20): both `loftys-larder.co.uk` and `www.loftys-larder.co.uk` validated via `_fly-ownership` TXT within ~1 min of DNS propagation. LE certs issued (rsa + ecdsa), 2-month expiry. Fly handles renewal automatically.

Cache rule `bypass-api` configured at Cloudflare → Caching → Cache Rules. Initial misconfig used UI builder fields `URI Full` + `wildcard` with the raw expression syntax pasted as the wildcard value — that pattern never matched anything. Corrected to `URI Path` + `starts with` + `/api/`. Probe still shows `cf-cache-status: DYNAMIC` rather than `BYPASS`; the AC is configuration (rule listed + enabled + bypass action), not the header value. Defense-in-depth holds: tRPC responses carry no `Cache-Control` so Cloudflare's default classifier independently marks them uncacheable. The rule remains as the explicit second layer in case a future endpoint inadvertently sets cacheable headers.

### Open ops questions worth resolving before run

- **Domain not yet chosen.** Step 0 above; user will pick at Cloudflare Registrar.
- **Fly org.** `flyctl orgs list` after auth — confirm which org owns this app. Personal org is fine for household-scale.

---

## 2026-05-17 — FEAT-05 (Production Dockerfile + fly.toml)

**Status:** implementation complete; manual smoke (docker build + docker run probes) verified. Definition-of-done left unticked.

### Drift from kick-off plan

1. **Base image is `node:24-alpine`, not `node:24-slim`.** Plan recommended slim; first build came in at 346 MB (slim itself is ~345 MB on Apple-silicon Docker), failing the < ~300 MB acceptance criterion. No native-binding deps in the runtime image — esbuild's native bits live only in the build stage — so musl-libc risk is nil at this stage. Final image is **229 MB**. Revisit if `pg` (FEAT-09) or another native dep needs glibc; the swap is one-token (`alpine` → `slim`).

2. **Health check in `fly.toml` is a machine-level TCP check, not the HTTP `/api/health` path specified in FEAT-05.** `/api/health` ships in FEAT-46; declaring an HTTP check that resolves to a non-existent route would have marked every machine unhealthy from FEAT-06's first deploy. Inline comment in `fly.toml` flags the swap point. **FEAT-46 must replace `[checks.tcp_alive]` with an HTTP check (or add one and keep TCP).**

3. **`frontend/tsconfig.json` was modified** — not on the kick-off file list. Docker exposed that `shared/dist/` is a one-off local artefact, not reproducibly built (`shared`'s `build` script is `tsc --noEmit`). Restored a reproducible frontend build with:
   - `paths: { "@loftys-larder/shared": ["../shared/src/index.ts"] }` — resolves the type-only import to source.
   - `rootDir: ".."` (was `"src"`) — widens TS's project boundary so cross-workspace type traversal no longer trips TS6059. Safe because `noEmit: true`.

   Consistent with DEC-80's single narrow type-only exception.

4. **Dropped BuildKit-only directives from the Dockerfile.** Originally used `# syntax=docker/dockerfile:1.7` + `RUN --mount=type=cache,id=pnpm,...` for a pnpm-store cache mount. Local Docker 29 has no `buildx` plugin installed, and classic builder rejects both. Removed them; Fly's remote builder is BuildKit and will work either way — we just lose the local pnpm-store cache.

5. **Deferred verification: `flyctl config validate`.** flyctl isn't installed locally; runs as part of FEAT-06 setup.

### Implementation decisions worth carrying

- **`STATIC_DIR` is the explicit signal for SPA serving.** `security.ts` only mounts `@fastify/static` at `/` (with SPA fallback) when `STATIC_DIR` is set. The Dockerfile sets it to `/app/public`; dev never sets it (Vite's `server.proxy` covers that path). Avoids any magic `import.meta.url`-relative resolution that would break inside the bundle.

- **SPA fallback uses `setNotFoundHandler`, gated on `!req.url.startsWith('/api/')`.** Unknown `/api/*` paths return JSON 404; unknown non-`/api/*` GETs return `index.html` so TanStack Router can hydrate. Don't widen this without thinking through the tRPC URL contract (cross-cutting #16).

- **The FEAT-03 placeholder `/api/static/` mount was removed.** The original FEAT-03 comment ("real `dist/` wiring lands with FEAT-05") was the trigger. `backend/public/.gitkeep` deleted with it.

- **esbuild bundle has a CJS-interop banner.** `format: 'esm'` strips CJS shims; if a transitive dep reaches for `require` / `__dirname` / `__filename` at module-eval time it crashes. The banner restores them against `import.meta.url`. Cheap insurance; can be revisited if it ever causes confusion.

- **`shared`'s `package.json` `main` / `types` fields point at `./dist/index.js` / `./dist/index.d.ts` — neither is produced by `shared`'s `build` script.** This is now a latent inconsistency: nothing in the build graph emits them, the frontend now bypasses them via paths mapping, the backend doesn't import shared at runtime. Two clean follow-ups: (a) strip `main` / `types` (and `files`) from shared's package.json since the workspace is consumed via TS paths only, or (b) wire a real emit step (probably a stripped `tsconfig.build.json` without `noEmit` and `allowImportingTsExtensions`). Cheap to defer; worth doing before a fourth workspace needs to import shared.

### Environment notes

- Local Docker is 29.2.1, classic builder only. `docker buildx` not installed. `brew install docker-buildx` would fix it; not required for FEAT-05/06.
- `flyctl` not installed locally — install during FEAT-06.

---

## 2026-05-16 — FEAT-03 (Backend Fastify scaffold)

**Status:** implementation complete; acceptance criteria verified via tests + smoke probe (not ticked — that's a human action).

### Drift from kick-off plan

1. **Dropped TS `composite: true` from `/shared` and project references from `/backend` + `/frontend`.** The type-only cross-workspace import in `shared/src/router-type.ts` was incompatible with `composite + rootDir` (TS refuses to read files outside the project boundary, even for type-only imports). `/shared/tsconfig.json` now runs `noEmit: true` with `rootDir: ".."`. Captured as **DEC-80** with the revisit trigger ("first runtime import from `/shared`", likely FEAT-08). AGENTS.md leaf-rule bullet updated to note the type-only exception.

2. **Added `LOG_LEVEL` env var** to `backend/src/config.ts` and `.env.example`. Not in FEAT-03's plan; added so the Vitest suite can run Pino at `silent` without polluting test output. Defaults to `info` in dev/prod. Worth knowing this exists when wiring Axiom in FEAT-43 (don't accidentally set it to `silent` in production env).

3. **Added two extra tests** beyond the planned set:
   - `security headers > sets helmet default headers` — guards against accidental helmet misconfiguration.
   - `buildApp > generates a fresh reqId per request` — replaces a planned "honours an injected request-id header" test that turned out to be testing a Fastify v5 opt-in feature (`requestIdHeader` defaults to `false`) we don't currently need.

### Implementation decisions worth carrying

- **CORS origin is a function predicate**, not the bare `ALLOWED_ORIGIN` string. Passing a string to `@fastify/cors` echoes that origin to *every* request regardless of the incoming `Origin` header; using a function predicate means foreign origins get no `Access-Control-Allow-Origin` at all. Matches the AGENTS.md "restricted to the Vite dev server URL" intent.

- **`@fastify/static` is mounted at `/api/static/`**, not root, to avoid the documented gotcha of static swallowing `/api/*` routes. When FEAT-05 wires the real `dist/` for the production bundle, it'll need a different mount strategy (root with explicit `prefix` ordering relative to tRPC).

- **`fastify-tRPC onError` typing.** `@trpc/server`'s Fastify adapter currently surfaces `error`/`path` as implicit-`any` in the destructure under our strict TS settings. Worked around with an inline `{ error: unknown; path: string | undefined }` annotation. If `@trpc/server` ships better types later, the annotation can go.

- **`AppRouter` re-export uses a `.ts` extension** in the relative import (`'../../backend/src/trpc/router.ts'`) and requires `allowImportingTsExtensions: true` in `shared/tsconfig.json`. ESM-strict NodeNext doesn't auto-resolve extensions; the `.ts` here is type-only (erased) so it never hits Node's resolver.

### Environment housekeeping (not project state, just useful to future-me)

- Project pins Node LTS via `.nvmrc` (`24`). Today (2026-05) that's v24.15.0. Local environment was previously serving Homebrew's v26 (latest "Current"); Homebrew's `node` and `node@22` formulae were uninstalled; nvm sourcing was added to `~/.zshrc` and `nvm alias default 24.15.0` set. Per DEC-02, revisit the pin around October 2026 when Node 26 is promoted to LTS.
