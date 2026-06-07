# CLAUDE.md — Operating Manual

> Lean operating manual (slimmed 2026-06-06 from 520→~150 lines). This is the ONLY doc
> loaded into context every session — it holds the always-in-memory behavioral gates.
> Everything else lives in topic docs (see § Doc map) and is read on demand.
> Mode-switch history is in DECISION_LOG.md.

## Project Mode (active) — AUTO-DEPLOY + AUTO-PUSH

**SuitesForAll** = multi-building office floor-plan manager (leasing/billing/Stripe/Firebase/DocuSign).
Business-critical program. Re-enabled by Tony 2026-05-11 evening («все правки выгружались сразу онлайн… автоматически»).

- Every commit on the active branch → parse-check → commit → release-stamp → `firebase deploy --only hosting` → `git push origin <branch>`. Automatic, no per-deploy approval phrase.
- `<meta name="sfa-release">` is bumped to the committed hash before every deploy (Sentry release tag).
- GitHub mirror: `https://github.com/suitesforallcom/leasing-crm` (remote `origin`). Hosting: `https://suitesforall.web.app`.
- Full auto-deploy loop + allowed/forbidden automation: **AUTOMATION_BOUNDARIES.md** + **DEVELOPMENT_WORKFLOW.md**.
- Local-only fallback mode (currently inactive) is documented in **DEVELOPMENT_WORKFLOW.md § Alternative Mode**.

## § 0. Regression Memory (mandatory)

Before editing any payment, finance, lease, invoice, balance, late-fee, deposit, Stripe, report, or floor-map logic, read **FIXES_LOG.md** AND **FINANCIAL_INVARIANTS.md** and preserve all listed invariants. If touching a listed file/function, cite the relevant `FIXES_LOG` entry number in the PR handoff.

- `FIXES_LOG.md` — single source of truth for prior fixes + regression risks. Append-only; mark superseded entries with a pointer, never delete.
- `FINANCIAL_INVARIANTS.md` — architectural rulebook for everything touching money (append-only ledger, idempotent ingestion, source-of-truth pointers, audit trail, reconciliation, defensive UI).

## § 0.1 Data-safety operating rules (after 2026-06-04 DATA-LOSS incident)

A latent bug (`fixFloorAssignments` deleting units, FIXES_LOG Entry 44) + a backup gap caused permanent loss of two floors. Non-negotiable:

- **Backup BEFORE any structural operation** (strip/cutover, floor/unit delete, restore, schema change). Take a full snapshot AND verify it contains real data (not a stripped shell), then proceed.
- **NEVER run `sfaWipeBackups()` / prune backups while the workspace is unstable or mid-incident.**
- **Backups must cover collections, not just the monolith.** Firestore **PITR is ENABLED (7-day)** — keep it on. If ever disabled, extend the backup CF to snapshot collections first.
- **Destructive auto-repairs must never run on page load** (`dedupeAllFloors` / `dedupeUnitsEverywhere` / `fixFloorAssignments` auto-run is frozen on init — keep frozen until the workspace is demonstrably stable).
- **Suspected data loss → FREEZE mutations + secure a verified copy FIRST, then diagnose.** No iterating destructive console scripts. Plan: preserve → ground-truth → instrument → isolate → confirm-with-evidence → fix.

## § 1. Safety + Main Rule

- Always check `git status` before editing. If the working tree has uncommitted changes you didn't make, **stop and ask**.
- Always work on the active feature branch. **Never edit production directly** (prod = `https://suitesforall.web.app`; source becomes prod only on deploy).
- **Parse-check is MANDATORY before every commit** (`new Function(scriptText)` on every inline `<script>` block in `floor-map-editor.html` — see QA_CHECKLIST.md / DEVELOPMENT_WORKFLOW.md).
- Commits are **small + focused** (≤ 3-5 files per pass unless Tony approves a larger list up front).
- Each commit ships immediately to production. Final report after every shipped change must include a **Rollback** block (prior commit hash, branch, files changed, revert command).
- Never run destructive commands, never delete/rename/move/overwrite files, never do broad refactoring without explicit approval.
- Never use `--no-verify`.

## § 2. Approval STILL required (even in auto-deploy mode)

STOP and ask Tony before ANY of these — also covers all of: real money, invoices, payments, bank accounts, reconciliation, accounting, customer financial data, schema, migrations, auth, permissions, roles, external APIs, secrets, legal workflows, destructive changes, new dependencies, large refactors.

- Editing `firestore.rules` / `firestore.indexes.json` / `cors.json` / `firebase.json`
- Editing `functions/index.js` (Cloud Functions) or deploying functions
- Touching `functions/.env` / any secret-bearing file; `firebase functions:secrets:set/get/remove`
- Adding a dependency (`npm install <pkg>`)
- Force-push (`--force` / `--force-with-lease`); file/branch deletion (`git branch -D`, `rm tracked-file`); `git reset --hard`
- Schema changes to `state.*` (rename / remove / type-change a field)
- Auth-gate / role-helper changes
- Stripe / DocuSign / UniFi / Plaid / Sentry external calls beyond passive reads
- Bulk-modifying `u.payments[*]`, voiding invoices, issuing refunds
- Member invite / role-change / workspace ownership transfer
- Changing `STRIPE_MODE` (live ↔ test)
- **`git push origin main`** — main is the working branch; each push to main is gated per-action (Tony adds the allow rule himself; I cannot self-grant).

If a change touches anything above, **stop and ask** — even though hosting deploy itself is automatic. If unsure, ASK.

## § 3. Financial-model gate

Every proposed change to a financial computation path (effective-rent `u.contractRent || u.rent`, late-fee math, waiver pro-rate `_unitProrationCredit`, building valuation defaults, BRRRR/NOI/EGI/IRR/DSCR, Forecast «Potential Value» defaults, auto-billing cron) MUST first be validated against **FINANCIAL_MODEL_REFERENCE.md**. Report discrepancies to Tony BEFORE committing; ship only after explicit alignment. UI-only / non-financial / doc changes auto-deploy normally.

Lease-start gate: month-loop billing functions MUST early-return when `leaseStart` is null (else phantom owed-amount). See FIXES_LOG.

## § 4. Business-Critical Elements (do not break)

contact forms · phone numbers · "Schedule a Tour" buttons · pricing · CRM/HubSpot · GA / GTM / Meta Pixel · UTM tracking · SEO metadata · schema markup · page URLs · lease source tracking · email notifications · call-tracking scripts.

(Scope note: SuitesForAll is currently a logged-in admin tool — no public marketing surface yet. The full list becomes in-force the moment a marketing page is added. Active today: contact forms, phone numbers, email notifications, CRM when configured.)

## § 5. Communication Rules

- Explain to Tony in **Russian** unless he asks for English.
- UI text inside the app stays in **English** (existing convention).
- In-file code comments stay in **Russian**; identifiers stay English.
- Keep reports practical + business-oriented; don't over-explain basic theory; always give exact next steps; give copy-paste-ready commands in fenced ```bash blocks.

## § 6. Git Rules

- Check `git status` before changes. Don't use `--no-verify`.
- **Push automatically after every commit** (`git push origin <branch>`) — part of the auto-pipeline.
- No PRs (this project doesn't use PR workflow). Don't auto-merge. Don't create branches unless Tony asks.
- Don't force-push without explicit approval. Don't push to `main`/`master` without explicit approval (see § 2).
- Concurrency: parallel Claude sessions may edit `floor-map-editor.html` at once — **never `git add` the whole file**, re-check HEAD before commit, don't rewrite live history.
- If `git push` fails (auth/network), report once + ask Tony; don't silently retry forever.

## § 7. Local Checks

Use only commands that exist; otherwise write **"Not available in this project."**

| Check | Command | Notes |
|---|---|---|
| Parse-check inline scripts | `node -e "…"` (QA_CHECKLIST.md / DEVELOPMENT_WORKFLOW.md) | Validates every `<script>` in `floor-map-editor.html`. **Required after every edit.** |
| Playwright smoke | `cd tests && npx playwright test` | 3 specs. Default target = prod; override `PW_BASE_URL=http://localhost:5577`. |
| Functions package | `cd functions && npm run lint` | No-op placeholder (vanilla JS). |

NOT available at root: `npm run lint` / `typecheck` / `build` / `test` (single-file HTML, no root toolchain).

## § 8. Review checklist before any change

1. Preserves `state` backwards compatibility?
2. New features discoverable without a tutorial?
3. Every user-typed field sanitized (`esc()` on render)?
4. If localStorage could fill up, does it fail gracefully?
5. Parse-check passes.

## § 9. Final Response Format

Every final report uses this structure (full template in DEVELOPMENT_WORKFLOW.md § Reporting):

```markdown
# Executive Summary  (status · what was done · main risk · recommended next step)
# Files Created / Updated  (file · purpose · notes)
# Commands Run  (command · result)
# Checks  (passed · failed · not available)
# Safe Next Tasks  (1, 2, 3)
# Tony Decisions Needed  (only real business/legal/financial/prod/auth/data-risk decisions)
# Exact Next Command
# Rollback  (prior hash · branch · files changed · revert command)
```

## § Doc map (read in this order at session start)

1. **CLAUDE.md** (this file) — operating mode + non-negotiables
2. **PROJECT_CONTEXT.md** — what the program does (phases, state shape, tradeoffs)
3. **ARCHITECTURE.md** — tech stack + folder structure
4. **PRINCIPLES.md** — engineering + coding standards, design/code rules, pushback
5. **UX_STANDARDS.md** — Tables UX · PageHelp · Topbar-always-visible · Collections Applied
6. **DECISIONS.md** — terminology, formulas, UX conventions, latent bugs (§ 6)
7. **DEVELOPMENT_WORKFLOW.md** — auto-deploy loop, commit hygiene, rollback, Alternative Mode
8. **AUTOMATION_BOUNDARIES.md** — what Claude may auto-execute vs ask first
9. **SESSION_LOG.md** — chronological log (tail-50 for recent context)
10. **KNOWN_ISSUES.md** · **RISK_MATRIX.md** · **PM_OPERATING_MODE.md**
11. Topic files (PAYMENTS_AND_FINANCE_RULES.md · AUTH_AND_PERMISSIONS_RULES.md · DATABASE_RULES.md · FINANCIAL_MODEL_REFERENCE.md) — read when working in those areas

---

<!-- ===== Appended by Claude Code Starter Kit conversion (non-conflicting sections only) ===== -->

## Naming — NEVER Rename Mid-Project

Renaming packages, modules, or key variables mid-project causes cascading failures that are extremely hard to catch. If you must rename:

1. Create a checklist of ALL files and references first
2. Use IDE semantic rename (not search-and-replace)
3. Full project search for old name after renaming
4. Check: .md files, .txt files, .env files, comments, strings, paths
5. Start a FRESH Claude session after renaming

---

## Plan Mode — Plan First, Code Second

**For any non-trivial task, start in plan mode.** Don't let Claude write code until you've agreed on the plan. Bad plan = bad code. Always.

- Use plan mode for: new features, refactors, architectural changes, multi-file edits
- Skip plan mode for: typo fixes, single-line changes, obvious bugs
- One Claude writes the plan. You review it as the engineer. THEN code.

### Step Naming — MANDATORY

Every step in a plan MUST have a consistent, unique name. This is how the user references steps when requesting changes. Claude forgets to update plans — named steps make it unambiguous.

```
CORRECT — named steps the user can reference:
  Step 1 (Project Setup): Initialize repo with TypeScript
  Step 2 (Database Layer): Set up the database layer
  Step 3 (Auth System): Implement authentication
  Step 4 (API Routes): Create user endpoints
  Step 5 (Testing): Write E2E tests for auth flow

WRONG — generic steps nobody can reference:
  Step 1: Set things up
  Step 2: Build the backend
  Step 3: Add tests
```

### Modifying a Plan — REPLACE, Don't Append

When the user asks to change something in the plan:

1. **FIND** the exact named step being changed
2. **REPLACE** that step's content entirely with the new approach
3. **Review ALL other steps** for contradictions with the change
4. **Rewrite the full updated plan** so the user can see the complete picture

```
CORRECT:
  User: "Change Step 3 (Auth System) to use session cookies instead of JWT"
  Claude: Replaces Step 3 content, checks Steps 4-5 for JWT references,
          outputs the FULL updated plan with Step 3 rewritten

WRONG:
  User: "Actually use session cookies instead"
  Claude: Appends "Also, use session cookies" at the bottom
          ← Step 3 still says JWT. Now the plan contradicts itself.
```

**Claude will forget to do this.** If you notice the plan has contradictions, tell Claude: "Rewrite the full plan — Step 3 and Step 7 contradict each other."

- If fundamentally changing direction: `/clear` → state requirements fresh

---

## CLAUDE.md Is Team Memory — The Feedback Loop

Every time Claude makes a mistake, **add a rule to prevent it from happening again.**

This is the single most powerful pattern for improving Claude's behavior over time:

1. Claude makes a mistake (wrong pattern, bad assumption, missed edge case)
2. You fix the mistake
3. You tell Claude: "Update CLAUDE.md so you don't make that mistake again"
4. Claude adds a rule to this file
5. Mistake rates actually drop over time

**This file is checked into git. The whole team benefits from every lesson learned.**

Don't just fix bugs — fix the rules that allowed the bug. Every mistake is a missing rule.

**If RuleCatch is installed:** also add the rule as a custom RuleCatch rule so it's monitored automatically across all future sessions. CLAUDE.md rules are suggestions — RuleCatch enforces them.
