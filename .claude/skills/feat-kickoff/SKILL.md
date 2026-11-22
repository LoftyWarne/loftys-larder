---
name: feat-kickoff
description: "Kick off a FEAT — propose the plan, settle its readings, write no code"
disable-model-invocation: true
argument-hint: "<FEAT number, e.g. 12>"
---

Kick off FEAT-$ARGUMENTS. Write no code in this step.

Load `AGENTS.md`, `docs/feature-specs.md §FEAT-$ARGUMENTS`, the DECs it cites, the cross-cutting concerns it threads through, the `docs/gotchas.md` sections for the areas it touches, and the newest `docs/session-notes.md` entry. Leave out the rest of `feature-specs.md`, `docs/plan.md` beyond the sections the FEAT cites, and `docs/non-goals.md` unless you're ruling out scope creep.

Propose:

1. The files you'll touch, grouped by workspace.
2. The Zod schemas that are new or extended, and confirm they'll live in `/shared/src/schemas/`.
3. The cross-cutting helpers you'll reuse (`withTransaction`, `pickable-recipes`, `useOptimisticSlotUpdate`, the date module, `SearchableCombobox`, `markHealthScoreStale`, `settleReservations`), and any new one you're tempted to introduce.
4. What's ambiguous in the acceptance criteria, and your proposed reading of each, framed as a question.
5. The DECs that constrain the implementation.
6. The test surfaces from the Definition of done.

Output a numbered checklist the user can approve or amend, then stop. Implementing starts only when the user runs `/feat-implement $ARGUMENTS` or approves in words.
