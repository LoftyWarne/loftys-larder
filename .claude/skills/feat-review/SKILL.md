---
name: feat-review
description: "Review the current diff against a FEAT and its DECs — best run in a fresh session"
disable-model-invocation: true
argument-hint: "<FEAT number, e.g. 12>"
---

Review the current diff against `docs/feature-specs.md §FEAT-$ARGUMENTS` and the DECs it cites. The diff is the uncommitted changes, untracked files included; if the tree is clean, ask which commits to review.

If this session wrote the change, say so before starting: a reviewer that didn't write the code catches more, so suggest running `/feat-review $ARGUMENTS` in a fresh session.

Load `AGENTS.md`, the FEAT, the DECs it cites, `docs/non-goals.md` (to catch scope creep into excluded territory) and the diff. Read `docs/plan.md` only for the sections the FEAT cites.

For each area, report findings with a severity (blocker / suggest / note):

1. **DECs:** for each cited DEC, does the diff follow it?
2. **Shared helpers:** were the canonical ones used? Look for duplication of `pickable-recipes`, `withTransaction`, the date module, `settleReservations`, `markHealthScoreStale`, `SearchableCombobox`, the optimistic-update hook or the slot card.
3. **Rules:** walk `AGENTS.md`'s Rules, Ask first and Never lists. Any hits?
4. **Acceptance criteria:** for each one, point at the code or test that meets it. Don't tick anything.
5. **Non-goals:** does anything drift into `docs/non-goals.md` territory?
6. **Suppressions:** every `eslint-disable`, `@ts-expect-error`, `@ts-ignore` or `prettier-ignore` is a finding.

Output the findings list. Don't commit fixes.
