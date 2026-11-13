# Phase 9: tasks upgrade and CRM quick wins

Status: 9a and 9b are built.

Tasks (activities of type task, call and meeting) grow from a flat "My work" list into a full work-management surface: a detail page, comments with mentions, an optional status pipeline, checklists, recurrence, reminders and a rebuilt My work page. 9b follows with small, high-value improvements found in a review of the whole CRM.

## Milestones

| Milestone | Scope |
| --------- | ----- |
| 9a | Task detail page, comments and mentions, task pipeline (behind a flag), checklists, recurring tasks, reminder UI and daily digest, My work rebuild, calendar drag and create, tools |
| 9b | "Move to stage" on board cards, quote and invoice panels on deal and organization pages (notification preferences shipped with the digest in 9a) |

## Decisions

| Decision | Why |
| -------- | --- |
| Tasks stay `activities` rows; no new entity | Timeline, scope, reports, automations and tools already understand activities |
| `completed_at` stays the source of truth for done | Every list, report, reminder and tool reads it; the pipeline syncs to it, not the other way round |
| Task pipeline sits behind `features.taskPipeline`, off by default | Same pattern as `leadPipeline`; most workspaces only need open and done |
| Comments get their own `activity_comments` table, cascading with the activity | Comments are not activities; the cascade means erasing a person's activities removes the discussion with no extra code. Comments elsewhere get their own table later |
| Mentions notify only people who can view the task | A mention must never reveal a record to someone outside its scope |
| Checklist items live in `activity_checklist_items`, not JSON | Per-item audit, reorder and "done by" without rewriting the whole task |
| Recurrence is stored on the task; completing it creates the next one in the same transaction | No scheduler needed, and no orphan series if a task is deleted |
| Next due dates are computed in the workspace time zone | "Every Monday 9:00" must not drift across daylight saving changes |
| The daily digest is opt-in per person and skipped in the minimal-email compliance mode | Avoids unwanted email and respects compliance floors |

## Built

- 9a: task page (`/tasks/:uuid`), comments with mentions (`activity_comments`), checklists (`activity_checklist_items`), recurrence (`activities.recurrence`, shared `recurrence.ts`), reminder presets, daily digest (`tasks.digest`, opt-in in the profile), My work rebuild, calendar drag and create, task statuses (`features.taskPipeline`, `activity_stage_history`), task tools (`update_task`, `get_task`, `add_task_comment`, `add_checklist_item`).
- 9b: Move to on board cards; Quotes and Invoices tabs on deal and organization pages.

## Next candidates (from the CRM review)

Email thread view and reply in thread; connecting a mailbox by signing in; record-level sharing; field visibility for core columns; rule-based lead scoring; branching in automations; sequences. Each needs its own plan.

## Future (parked)

- Comments on deals, contacts and other records.
- Task dependencies (blocked by).
- Time tracking on tasks.
