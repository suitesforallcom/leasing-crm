# CLAUDE.md

> **MODE SWITCH 2026-05-11.** This file replaces the previous auto-deploy / Firebase-push CLAUDE.md. The project is now in **local-only maintenance mode**. The previous engineering principles + non-negotiables are preserved as a reference at the bottom of this file (§ Legacy Project Rules) — they describe business logic Claude must NOT break, but the operational rules (auto-deploy after every commit, auto-push to GitHub, etc.) are SUSPENDED until Tony explicitly re-enables them.

---

## Project Mode

This is a completed existing program in **local-only maintenance mode**.

This project does not currently use:
- GitHub workflow
- Pull requests
- auto-merge
- multi-agent parallel development
- external service connections
- production deployment automation

Future Claude sessions must treat this project as a **conservative maintenance project**.

## Main Rule

Do not redesign, refactor, reconnect, redeploy, or restructure the project unless Tony explicitly asks.

## Primary Goal

Help Tony maintain and improve the completed program safely, with maximum local automation and minimum manual analysis, **without connecting external services or touching production**.

## Allowed Work

Claude may:
- inspect the project,
- document the architecture,
- explain how the program works,
- identify bugs,
- recommend safe improvements,
- create local documentation,
- create QA checklists,
- create maintenance task lists,
- make small code changes only when Tony explicitly asks,
- run existing local checks if available.

## Forbidden Work Without Tony's Explicit Approval

Claude must not:
- connect external services,
- deploy (`firebase deploy`, `vercel deploy`, etc.),
- push code (`git push`),
- configure GitHub,
- create PRs,
- auto-merge,
- configure CI/CD,
- configure Stripe or payments,
- configure bank connections,
- configure email/SMS sending,
- configure DocuSign,
- configure Dropbox,
- configure Cloudflare,
- configure Vercel,
- configure Supabase / Firebase / database hosting,
- configure MCP,
- configure browser automation against production,
- install new dependencies (`npm install <pkg>`, `pip install`, etc.),
- create real `.env` files,
- store secrets,
- change financial logic,
- change database schema (Firestore rules, indexes),
- change auth or permissions,
- delete important files,
- rename important files,
- perform large refactors.

## Tony Approval Required

Stop and ask Tony **before** any work that touches:
- real money,
- invoices,
- payments,
- bank accounts,
- reconciliation,
- accounting,
- customer financial data,
- database schema,
- migrations,
- authentication,
- permissions,
- roles,
- production deployment,
- external APIs,
- secrets,
- legal/business-critical workflows,
- destructive changes,
- new dependencies,
- large refactors.

## Communication Rules

- Explain to Tony in **Russian** unless he asks for English.
- UI text inside the app stays in **English** (existing convention).
- In-file code comments stay in **Russian** (existing convention from MEMORY.md).
- Keep reports practical and business-oriented.
- Do not over-explain basic technical theory unless Tony asks.
- Always give exact next steps.
- When giving commands, give copy-paste ready commands in fenced ```bash blocks (per Section 13 of legacy rules).

## Work Style

Before making changes:
1. Inspect relevant files.
2. Explain what you found.
3. Explain what you plan to change.
4. Identify risks.
5. Ask Tony only if approval is needed.

After making changes:
1. List files changed.
2. Explain what changed.
3. Explain how to test.
4. List checks run.
5. List checks not available.
6. List remaining risks.

## Local Checks

Use only commands that **actually exist** in the project. Do not invent scripts.

Available checks (verified 2026-05-11):

| Check | Command | Notes |
|---|---|---|
| Parse-check inline scripts | `node -e "..."` (see `QA_CHECKLIST.md`) | Validates every `<script>` block in `floor-map-editor.html` parses. **Required after every edit.** |
| Playwright smoke | `cd tests && npx playwright test` | 3 specs: app-loads, auth-gate, static-pages. Default target = production; override with `PW_BASE_URL=http://localhost:5577`. |
| Functions package | `cd functions && npm run lint` | Currently a no-op (`echo` placeholder) — pure vanilla JS, no toolchain. |

NOT available in this project:
- `npm run lint` at root — no root `package.json`.
- `npm run typecheck` — no TypeScript at root.
- `npm run build` — single-file HTML, no build step.
- `npm test` at root — no root test runner.

If a command is unavailable, write: **"Not available in this project."**

## Git Rules

Git **does** exist. Current branch: `fix/autobilling-respect-archive-filters` (verify with `git branch --show-current`).

Rules:
- Check `git status` before changes.
- Do not use `--no-verify`.
- **Do not push** (`git push origin <branch>`) without Tony's explicit approval.
- Do not create PRs.
- Do not auto-merge.
- Do not create branches unless Tony asks.
- Commits MAY be created locally to checkpoint work; just don't push.

If git becomes unavailable, work in local file mode and report files created/updated.

## Automation Philosophy

Maximum automation is allowed only **inside local-only maintenance mode**.

**Allowed automation:**
- project documentation,
- task planning,
- QA checklist creation,
- local command detection,
- local test instructions,
- safe maintenance recommendations,
- error diagnosis,
- repeatable local workflows.

**Forbidden automation:**
- external connections,
- deployment,
- GitHub workflows,
- PR automation,
- auto-merge,
- real payment flows,
- real email/SMS sending,
- real bank connections,
- production database changes.

## Final Response Format

Every final report should use this structure:

```markdown
# Executive Summary
- Project status:
- What was done:
- Main risk:
- Recommended next step:

# Files Created / Updated
- File:
- Purpose:
- Notes:

# Commands Run
- Command:
- Result:

# Checks
- Passed:
- Failed:
- Not available:

# Safe Next Tasks
1.
2.
3.

# Tony Decisions Needed
Only list real business, legal, financial, production, auth, or data-risk decisions.

# Exact Next Command
Give Tony the exact next command or instruction.
```

---

## Doc map (read in this order at session start)

1. **`CLAUDE.md`** (this file) — operating mode + non-negotiables
2. **`PROJECT_CONTEXT.md`** — what the program does
3. **`ARCHITECTURE.md`** — tech stack + folder structure
4. **`DECISIONS.md`** — terminology, formulas, UX conventions, latent bugs (§ 6)
5. **`SESSION_LOG.md`** — chronological log; tail-50 for recent context
6. **`KNOWN_ISSUES.md`** — current open problems
7. **`RISK_MATRIX.md`** — what can go wrong + impact
8. **`AUTOMATION_BOUNDARIES.md`** — what Claude may auto-execute vs ask first
9. **`PM_OPERATING_MODE.md`** — how Claude PM-coordinates this project
10. Topic files (`PAYMENTS_AND_FINANCE_RULES.md`, `AUTH_AND_PERMISSIONS_RULES.md`, `DATABASE_RULES.md`) — read when working on those areas

---

## § Legacy Project Rules (preserved for business-logic reference)

The rules below were the operational mode prior to 2026-05-11. **Operational items (auto-deploy, auto-push, mandatory deploy after every commit) are SUSPENDED in current mode.** Business-logic rules (Sections 4 / 5 / 6 / 7 / 9 / 10 / 14, plus Engineering Principles) are still authoritative — those describe what Claude MUST NOT break in the application itself.

### Highest Priority Rules (legacy)

This is a business-critical website. The website generates leads and revenue. Do not treat it as an experimental project.

> **Scope note for SuitesForAll (set 2026-05-01):** SuitesForAll is currently a logged-in admin tool — no public marketing landing page yet. The "Business-Critical Website Elements" section below becomes IN-FORCE the moment a marketing surface is added. Until then the active items from that list are: contact forms, phone numbers, page URLs, email notifications, CRM integrations (when configured).

### 4. Business-Critical Website Elements (do not break)

contact forms · phone numbers · "Schedule a Tour" buttons · pricing sections · CRM integrations · HubSpot forms or tracking · Google Analytics · Google Tag Manager · Meta Pixel · UTM tracking · SEO metadata · schema markup · page URLs · lease source tracking · email notifications · call tracking scripts

### 5. Design Rules

- Keep professional, clean, conversion-oriented.
- Reuse existing components.
- Keep mobile responsiveness — desktop, tablet, phone.
- Do not redesign without request.
- Do not introduce new colors, fonts, frameworks, or libraries unless approved.
- Important business actions stay visible: phone, contact form, "Schedule a Tour", pricing, location, availability.

### 6. Code Rules

- Follow existing architecture and file structure.
- Follow existing naming conventions.
- Prefer small, simple changes.
- Avoid unnecessary abstraction.
- Avoid duplicate code.
- Do not add dependencies unless approved.
- Do not change environment variables unless approved.

### 7. Approval Rules (carried forward unchanged)

Ask for approval before:
- deleting files
- renaming files
- changing database schema
- changing authentication
- changing payment logic
- changing forms or CRM integration
- changing SEO structure
- adding new dependencies
- changing hosting/deployment configuration
- making large visual redesigns
- removing old code that may still be used
- broad refactoring

### 9. Step Size & Review Cadence

- Work in small, reviewable steps.
- Do NOT modify more than 3–5 files in one pass unless explicitly approved.
- After each step, summarize and WAIT for confirmation.
- "Confirmation" = explicit "ok", "go ahead", "next", or substantive feedback.
- If a task naturally requires touching more files, propose the file list up front.

### 10. Rollback Instructions

At the end of every task, include a "Rollback" block with:
- Commit hash before changes (run `git rev-parse HEAD` at task start)
- Branch name
- Files changed (exact paths)
- Command to revert (e.g. `git checkout <branch> -- <file>`)

### 14. Tables UX Standard (still in force — do not break)

Every data table must satisfy: column sort + drag-to-reorder + per-column tooltip + visibility gear menu. Use `mountTablePrefs` + `attachTableSort` + `applyTableSort` + `ensureColumnsButton` helpers. Sort + reorder must be PURE UI — must not change row count or totals. CSV export must follow current view.

---

## Engineering principles (legacy — still in force)

1. Optimize for correctness, clarity, maintainability, security, and delivery speed together.
2. Don't jump into coding immediately. Understand business goal, user flow, technical constraints, acceptance criteria.
3. Prefer simple architectures.
4. Avoid overengineering, unnecessary abstractions, premature optimization.
5. Reuse proven frameworks/libraries.
6. Write code a strong senior engineer would approve in production.

### Coding standards

- Readability over cleverness.
- Small, focused modules and functions.
- Clear naming.
- No duplication.
- Explicit data flow.
- Strong typing where available (this project: vanilla JS, no static types).
- Explicit error handling.
- Meaningful logs, not noise.
- Comments where they explain intent or non-obvious decisions (in Russian per project convention).
- No dead code, placeholders, or TODOs unless explicitly requested.

### Pushback

If the requested solution is weak architecturally, say so directly and propose a better alternative.

---

## Project-specific context

**SuitesForAll** is a multi-building office floor-plan manager with leasing/billing/Stripe/Firebase/DocuSign integration.

- **Phase 1**: single self-contained HTML file using pure SVG (no framework) for the interactive floor plan editor — `floor-map-editor.html`.
- **Phase 2**: Firebase for real-time multi-user sync (Firestore + Auth + Storage + Functions).
- **Phase 3**: Stripe (payments) + DocuSign (e-signing).

**Architecture boundaries:**
- UI: DOM + SVG event handlers
- Business logic: pure JS functions operating on `state` object
- Persistence: `localStorage` (Phase 1) → Firestore (Phase 2)
- State shape: `{ buildings: [...], tenants: [...], leases: [...], settings: {...}, ui: {...}, investments: {...}, recoveryCases: [...] }`

**Key tradeoffs:**
- `localStorage` size limit (~5 MB) vs uploaded images/photos — mitigated by warnings, full fix via Storage.
- Role-based access is UX-layer + Firestore rules.
- CDN dependencies minimized (only `pdf.js` + `dxf-parser` lazily loaded with multi-CDN fallback).

**Review checklist before any change:**
1. Does it preserve `state` backwards compatibility?
2. Are new features discoverable without a tutorial?
3. Has every user-typed field been sanitized (`esc()` on render)?
4. If localStorage could fill up, does it fail gracefully?
5. Parse-check passes (see QA_CHECKLIST.md).
