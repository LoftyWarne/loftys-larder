---
name: feat-implement
description: "Implement a FEAT from its approved kick-off plan"
disable-model-invocation: true
argument-hint: "<FEAT number, e.g. 12>"
---

The user has approved the kick-off plan for FEAT-$ARGUMENTS. If this conversation holds no kick-off plan for that FEAT, or the user amended one you haven't taken in, stop and say so; `/feat-kickoff $ARGUMENTS` comes first.

Load `AGENTS.md`, the approved plan, `docs/feature-specs.md §FEAT-$ARGUMENTS`, the cross-cutting concerns it threads through, and the `/shared` schemas it touches. Leave out `docs/plan.md` and the FEATs you aren't touching.

Implement the plan, following every DEC the FEAT cites.

- Stop and ask before anything on `AGENTS.md`'s Ask first list that the plan didn't include.
- Record the agreed readings and any drift in `docs/session-notes.md`.
- Leave every Definition-of-done checkbox unticked. Verification is the user's.

Finish with a short status: what landed, what didn't, and any drift from the plan with its reason. Verifying is `/feat-verify $ARGUMENTS`.
