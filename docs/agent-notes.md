# Agent notes

Shared memory for every AI coding agent working in this repo. Project rules live in [AGENTS.md](../AGENTS.md); this file holds the user's preferences and lessons learned while working. Add a dated line when you learn something durable; delete lines that stop being true. Don't repeat what code, git history or AGENTS.md already record.

## User preferences

- **Security upgrades without asking** (2026-10-26, "choose safety first"): when `npm audit` reports vulnerabilities, upgrade the packages, even across majors, as long as typecheck, lint and all test suites pass. Do it in its own commits, not mixed with features. Ask only if users would notice a behaviour change.
- **Every new env key goes into `.env.example`** with a short comment, in the same commit that adds it to `apps/api/src/config/env.ts` (2026-10-28).
- **Delegated decisions:** the user expects decisions made with multi-industry CRM experience and asks only when blocked. "Finalise completely" has meant: merge each milestone with `--no-ff` once its checks and reviews pass.
- **Always update the knowledge base and tours** (2026-11-14, "always must update the knowledge base and tours"): every change that alters what people see or how something behaves updates the help articles (`apps/web/src/help/articles`, `modules/<key>/help`) and, when a flow or target changes, the guided tours (`src/help/tours.ts`, `data-tour` targets), in the same milestone and usually the same commit. Fixes included, not only features.
- **Never push** unless asked. The user pushes `main` themselves.

## The user's local files (never commit)

The main checkout usually holds uncommitted work that isn't yours:

- `.claude/settings.json`, `.env.example` (LAN IP, `DEMO_MODE`), the Future lines in `docs/roadmap.md`, `package-lock.json`, `.superpowers/`.
- `packages/blueprints/charity-fundraising/`: untracked WIP blueprint. `demo-reset.test.ts` fails on it (it has no module sample records); that failure is expected.

How to work around them:

- **Stage explicit paths.** Never `git add packages`, `git add apps` or `git add -A`; that swept the WIP blueprint into commits twice.
- To commit your own change to a file they also edited: save `git diff <file>` as a patch, `git checkout <file>`, make and commit your edit, then `git apply` the patch. For `.env.example`, alternatively build the blob from `git show HEAD:.env.example` and stage it with `git update-index --cacheinfo`.
- Stash their edits around branch switches and pop them back.

## Workflow lessons

- lint-staged rolls back the working tree when a commit fails; check your doc edits survived.
- A transient `.git/index.lock` from the editor can break a git command; retry it.
- Stacked milestones: rebase each onto the latest `main`, test, then merge one by one with `--no-ff`.
- Before merging a milestone, run the review checklists in `.claude/agents/` (access control, white-label) and fix findings.

- A new help article (or any file picked up by `import.meta.glob`) can stay invisible to Vitest because of its transform cache: delete `node_modules/.vitest-cache` and rerun.

## Machine notes

- When two agent sessions share this machine, give each its own git worktree and its own test databases (`DATABASE_URL_TEST=…/crm_test_<name>`, `DATABASE_URL_E2E=…/crm_e2e_<name>`); test runs drop and recreate their databases.
- Reading `.env` is denied to agents; the defaults work for tests.
- After pulling new migrations, run `npm run db:migrate` on `crm_dev` before signing in.

## History

- 2026-10-26: Phase 5 (compliance) merged.
- 2026-10-28: Phase 6 (6a–6l) merged; the user pushed `main` up to 6g.
- 2026-10-29: Phase 7 (in-app help, knowledge base, guided tours) merged locally.
