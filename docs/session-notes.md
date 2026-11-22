# Session notes

Rolling working doc. Pending questions, in-flight context, and drift-from-plan notes worth carrying into future sessions, newest entry first. Delete an entry once its work is committed and nothing in it is open. Before deleting one, move any gotcha or lookup in it to `docs/gotchas.md`. Git history keeps the rest.

---

## 2026-11-22 — Carried forward

Open items from the 152 entries deleted on 2026-11-22. Git history keeps the full entries.

**Docs**
- README doesn't mention Storage (FEAT-78 to FEAT-81).
- CONTEXT.md has no entry for "Original" (DEC-107).

**Waiting on the user**
- The `meal_plan_slot_diners` user FK cascades on delete (a composite PK can't `set null`), so the link drops while the slot and guest count survive. Not yet confirmed against DEC-29. (2026-06-29)
- FEAT-74 reading 1: a 14-day Plan Proposal call has been timed only against the 14-recipe dev library, not the household's. If it doesn't fit one request, cross-cutting #22's background-work trigger fires and DEC-117 is amended.
- FEAT-81: a settled past storage slot always shows the snowflake, even for Pantry food. The picker's snowflake is a text character in a native `<select>`. The editor's live "short by" is an estimate and can differ from what the server reserves when another plan reserves at once.
- FEAT-80: the ingredient form's Staple field shows wherever the form does (recipe-editor inline create, Import Review) and is hidden only in the storage add sheet.
- FEAT-73: a dish whose recipe has no method still gets a cook link. Changing that needs a field on the slot item.
- FEAT-66: the recipe page shows the stored model id as it is (`claude-opus-5-5`).

**Not yet checked by hand** (no Definition-of-done box is ticked, so this is the only record)
- Real `anthropic` adapter not yet called for FEAT-63, FEAT-64, FEAT-65 (including an 8-page PDF against the 75 s limit), FEAT-66 (gate steps 1–3), FEAT-75 to FEAT-77, and FEAT-81 (step 3). FEAT-60 to FEAT-62 had one real image import after the 2026-10-04 schema fix; a production run is still owed.
- Gate check not run: FEAT-78 to FEAT-81.
- Manual verification not run: FEAT-59 (1–2), FEAT-61 (5, phone layout), FEAT-62 (1–5), FEAT-64 (1–4, including choosing a `.md` in iOS Files), FEAT-65 (1–6), FEAT-66 (1–6), FEAT-71 (1), FEAT-72, FEAT-73 (1–3, including Wake Lock in the iOS home-screen PWA), FEAT-75 (1–2), FEAT-76 (1), FEAT-77 (1).
- On a real phone: sign-in by code in the installed iOS PWA with a real Resend email (DEC-114), the code field with iOS and Android autofill, and cook mode swipe.
