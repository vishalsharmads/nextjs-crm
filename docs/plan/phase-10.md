# Phase 10: AI setup mode (onboarding)

Status: planned; approved by the user on 2026-11-14.

A guided, AI-led setup that turns a business's own story into a working CRM. The admin shares the website and business details; the assistant interviews them (one question at a time, with suggestions to click), refines what it heard into a business brief they approve, proposes a full setup they can adjust, builds it through the existing safe paths, and prepares their spreadsheets for import with every validation problem explained in plain words.

## Flow

1. **Start**: offered to admins on a new workspace and always at Settings → Set up with AI. If no AI provider is set up, the first step picks one (simulated replies work for a trial run).
2. **Tell us about the business**: business name (required), website, industry, offerings and customers, how customers arrive, the process step by step, team and roles, current tools and spreadsheets, problems to solve, anything else.
3. **Website reading**: one page, fetched once by the server within size and time limits and the outbound safety checks; it suggests the name, description, logo, brand colours and offerings.
4. **Interview**: the assistant asks one follow-up question at a time, says why it asks, and offers suggestions to click (or a free answer). It brainstorms with the client (what to track, which stages, which reports) and stops when it has enough.
5. **Business brief** ("prompt refining"): the answers, website and interview become a structured brief the client edits and approves before anything is proposed.
6. **Proposed setup**: from the approved brief, the closest industry preset and the assistant's industry knowledge: branding (name, colours adjusted for AA contrast, logo, login text), record names, pipelines and stages, custom fields, roles, modules, automations (never sending email), dashboard and reports. Shown as the interactive review cards (tick items in or out, rename, switches).
7. **Build**: applied through the preset engine in add mode and the configuration tools, as the admin, audited; nothing deleted or overwritten except names and settings. A summary links to what was built.
8. **Bring your data**: the client uploads spreadsheets (CSV or Excel). The assistant maps each column to the CRM's fields (custom fields included), runs the import's own checks without saving, explains every problem in plain words with how to fix it, and starts the import when the client confirms.

## Milestones

| Milestone | Scope                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10a       | Setup sessions (saved, resumable), the business form, website reading, the interview loop with suggestions, the editable business brief           |
| 10b       | Setup proposal from the brief, interactive review, build, branding from the website (logo stored, contrast-safe colours), summary                 |
| 10c       | Spreadsheet import in setup: Excel and CSV, AI column mapping, check-before-import (dry run) with plain explanations, start and follow the import |
| 10d       | Onboarding entry for new workspaces, Settings entry, help article and tour, end-to-end test                                                       |

**Status (2026-11-14):** 10a–10d are built. 10d puts the entry on the assistant page and in its settings; a home-page prompt for new workspaces and a guided tour moved to Future.

## Decisions

| Decision                                                                                                                                                                                 | Why                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Lives in the assistant module; sessions in `m_assistant_setup_sessions`                                                                                                                  | It needs the AI provider; workspaces without the module keep the manual setup           |
| Admins only                                                                                                                                                                              | Setup changes the whole workspace                                                       |
| One website page, fetched once, never a crawl; logo downloaded and stored like an upload                                                                                                 | Predictable, cheap and safe (outbound URL checks, size and time limits, no hot-linking) |
| The assistant returns structured JSON for each interview turn and for the brief and the plan, validated with Zod; a malformed turn is retried once, then the client can continue by hand | Models are fallible; the flow must never dead-end                                       |
| The client approves the brief before a plan is made, and every plan item before it is built                                                                                              | "Prompt refining": they correct its understanding first, then choose what is built      |
| Build reuses `applySetupDraft` (add mode), the configuration tools and their guards                                                                                                      | No second path that could skip permissions, audit or the guards                         |
| Brand colours are adjusted to keep AA contrast                                                                                                                                           | Readability is not optional, whatever the website uses                                  |
| Automations proposed by setup never send email                                                                                                                                           | Same rule as the assistant's configuration tools                                        |
| Excel via `exceljs` (first sheet, values only) next to CSV                                                                                                                               | Most clients keep data in Excel; it is well known and MIT                               |
| Import check is a dry run of the real import rules, not a separate validator                                                                                                             | One set of rules; what passes the check imports                                         |
| Simulated replies support the whole flow                                                                                                                                                 | It can be tried and tested without tokens                                               |

## Future (parked)

- Several website pages, and reading social profiles.
- Importing from other CRMs' exports with their own column names learned.
- Re-running setup to suggest improvements from how the workspace is used.
