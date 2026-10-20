---
name: phase-report
description: Produce the end-of-milestone or end-of-phase report required by the working agreement. Use when a milestone (1a–1d) or a whole phase is finished.
---

# Phase / milestone report

Before writing, **verify** rather than assume:
1. Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run check:brand`. Record the actual outcomes. If e2e is in scope, run `npm run test:e2e`.
2. `git log --oneline main..HEAD` for the list of commits.
3. Compare against the Definition of Done in `docs/plan/phase-0.md` and the original brief.

Then report, in this order and kept tight:

## What was built
Grouped by spec item number, one line each, with the key files linked.

## How to run it
Exact commands from a clean checkout (install, env, migrate, install:instance, dev). Note any local-environment differences (e.g. Herd MySQL vs Docker).

## Verification
The real results of lint, typecheck, tests (counts), build, brand check, and e2e. Paste the failing output for anything red.

## Untested or deferred
What was skipped or stubbed, and why. Anything moved to `docs/roadmap.md` → Future.

## Decisions made
New decisions taken during the milestone, also recorded in `CLAUDE.md` or the plan.

## Open questions
Only things that genuinely need the user.

Finally, update the status table in `docs/roadmap.md` and the "Current status" section of `CLAUDE.md`.
