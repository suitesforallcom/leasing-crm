# CLAUDE.md

> **MODE SWITCH 2026-05-11 (PM session, evening).** Tony explicitly re-enabled **auto-deploy + auto-push** mode («мне нужно чтобы все правки выгружались сразу онлайн чтобы выгрузка происходило автоматически»). The local-only maintenance mode introduced earlier today is now **suspended** — preserved as «§ Alternative Mode (currently inactive)» at the bottom of this file in case Tony wants to switch back.
>
> All other docs in this repo (DEVELOPMENT_WORKFLOW.md, AUTOMATION_BOUNDARIES.md, LOCAL_SETUP.md, etc.) reference «local-only mode» conditionally — those rules apply when local-only is active. **Current active mode = AUTO-DEPLOY.**

---

## Project Mode (active)

This is a business-critical program in **auto-deploy + auto-push mode**.

Active rules:
- Every commit on the active feature branch → parse-check → commit → release-stamp → `firebase deploy --only hosting` → `git push origin <branch>` — automatic, no per-deploy approval phrase needed.
- The `<meta name="sfa-release">` tag is bumped to the committed hash before every deploy so Sentry can tag events with the live release.
- GitHub mirror at `https://github.com/suitesforallcom/leasing-crm` (remote `origin`).
- Hosting URL: `https://suitesforall.web.app`.

Approval STILL required (these never auto-fire) for:
- destructive ops (file delete, rename, force-push)
- schema migrations (Firestore rules / indexes)
- new dependencies
- auth / payment / CRM / form / SEO logic changes
- CI/CD config edits (`firebase.json`, GitHub workflows)
- bulk record deletions

If a change touches anything in the «Approval STILL required» list, **stop and ask** — even though deploy itself is automatic.

## Main Rule

Ship safely. Each commit ships immediately to production. Therefore:
- Parse-check is **mandatory** before commit.
- Commits are **small + focused** (legacy rule § 9 — ≤ 3-5 files per pass).
- Final report after every shipped change must include rollback instruction.

## Primary Goal

Maintain and improve the program quickly + safely with auto-deploy, while preserving every business-critical contract documented in the rest of the repo.

## Allowed Work (auto-fires after commit)

Claude may, automatically after each commit:

- Run parse-check on `floor-map-editor.html`
- Stamp release via `scripts/stamp-release.sh` (or inline `sed` of `<meta name="sfa-release">`)
- `firebase deploy --only hosting`
- `git push origin <branch-name>`
- Resolve corresponding Sentry issue if the commit explicitly fixes a known bug ID

Claude may also (without per-action ask):

- Inspect any file in the repo
- Run `git status / log / diff` and other read-only git ops
- Edit `floor-map-editor.html` for small focused fixes (announce intent first if non-trivial)
- Create / update doc files
- Run Playwright smoke tests after a deploy
- Query Sentry for new errors after a deploy

## Approval STILL required

Even in auto-deploy mode, STOP and ask Tony before:

- Editing `firestore.rules` / `firestore.indexes.json` / `cors.json` / `firebase.json`
- Editing `functions/index.js` (Cloud Functions code)
- Touching `functions/.env` or any secret-bearing file
- Running `firebase functions:secrets:set` / `:get` / `:remove`
- Adding a new dependency (`npm install <pkg>`)
- Force-push (`git push --force` / `--force-with-lease`)
- File / branch deletion (`git branch -D`, `rm tracked-file`)
- Schema changes to `state.*` (rename / remove / type-change a field)
- Auth gate / role helper changes
- Stripe / DocuSign / UniFi / Sentry external API calls beyond passive reads
- Bulk-modifying `u.payments[*]` records, voiding invoices, issuing refunds
- Member invite / role-change / workspace ownership transfer
- Changing `STRIPE_MODE` (live ↔ test toggle)

If unsure, ASK. Better one extra question than one accidental finance bug.

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

Rules in active **auto-deploy mode**:
- Check `git status` before changes.
- Do not use `--no-verify`.
- **Push automatically after every commit** (`git push origin <branch>`) — part of the auto-pipeline.
- Do not create PRs (this project doesn't use PR workflow).
- Do not auto-merge.
- Do not create branches unless Tony asks.
- Do not force-push without Tony's explicit approval.
- Do not push to `main` / `master` without Tony's explicit approval.

If git push fails (auth expired, network), report once + ask Tony to fix; do not silently retry forever.

## Automation Philosophy

Active mode = **maximum automation up to but not crossing the «Approval STILL required» boundaries above**.

**Allowed automation (auto-fires after commit):**
- Parse-check
- Release stamp (`<meta name="sfa-release">`)
- `firebase deploy --only hosting`
- `git push origin <branch>`
- Sentry resolve when commit fixes a tracked bug ID
- Project documentation updates
- Playwright smoke test runs

**Forbidden automation (always require explicit per-action approval):**
- `firebase deploy --only functions` (Cloud Functions changes)
- Editing `firestore.rules` / `firestore.indexes.json` / `cors.json`
- `firebase functions:secrets:set` / any secret writes
- `npm install <pkg>` / new dependencies
- Force-push / branch deletion / `git reset --hard`
- Direct Stripe / DocuSign / UniFi / Plaid API calls
- Sending real emails / SMS / DocuSign envelopes from Claude tools
- Production database row mutations beyond what the app's own code paths do

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

## § Alternative Mode (currently inactive) — local-only maintenance

If Tony ever switches back to local-only maintenance mode (was active briefly 2026-05-11 between docs-creation and re-enable), use these rules instead of the auto-deploy ones above:

- No `firebase deploy` (suspended).
- No `git push` (suspended).
- All commits stay local; report to Tony but don't ship.
- No external service calls beyond passive read-only inspection.
- Tony manually deploys / pushes when he wants something live.

Switch back to local-only via: Tony says «switch to local-only mode» → Claude updates this file's «Project Mode (active)» section accordingly + logs the switch in DECISION_LOG.md + SESSION_LOG.md.

---

## § Legacy Project Rules (preserved for business-logic reference — STILL AUTHORITATIVE)

The rules below describe business logic Claude must NOT break — independent of operational mode. Sections 4 / 5 / 6 / 7 / 9 / 10 / 14, plus Engineering Principles, apply ALWAYS.

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
