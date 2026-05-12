# RISK_MATRIX.md

> Top risks ranked by impact × likelihood. Read this BEFORE planning any non-trivial change.

## Risk scoring

| Score | Impact | Examples |
|---|---|---|
| 5 | Catastrophic | Real money lost, customer data breach, legal liability, can't recover without backup restore |
| 4 | Major | Operational halt, hours of downtime, manual reconciliation needed |
| 3 | Significant | Visible UX regression, partial feature broken, operator confusion across sessions |
| 2 | Minor | One screen looks off, easily revertible, no data impact |
| 1 | Trivial | Cosmetic, doesn't block any workflow |

| Likelihood | Meaning |
|---|---|
| H | Will happen if you don't plan around it |
| M | Could happen, depending on path taken |
| L | Edge case |

**Risk Score** = Impact × Likelihood (rough guide; use judgment).

---

## Top risks

### R-1. Sending wrong-amount real Stripe invoice 🔴 Score: 5 × M = HIGH
- **Trigger**: Editing rent calc, late-fee logic, or auto-billing cron without testing.
- **Worst case**: Tenants charged wrong amount → refund process + customer trust damage.
- **Mitigation**: 
  - 5× over-record guard in `submitManualPayment`
  - Per-building / per-unit pause flags
  - `STRIPE_MODE=test` for emulator runs
  - Auto-billing dry-run mode (`autoSendLive: false`)
- **Claude action**: NEVER touch Stripe paths without Tony approval. Always test in test-mode first.

### R-2. Database schema change breaks operator's saved data 🔴 Score: 5 × M = HIGH
- **Trigger**: Renaming a `state.*` field, removing a required field, changing optionality.
- **Worst case**: App crashes on `fbApplyRemote()`; operator's data unloadable; emergency restore from backup needed.
- **Mitigation**:
  - Add fields as OPTIONAL with runtime fallback (`typeof u.x === 'number' ? ...`)
  - Never RENAME — add new field + migrate data + leave old field for one revision
  - Backwards-compat is non-negotiable per CLAUDE.md
- **Claude action**: STOP and ask Tony before any schema change. See DATA_MODEL.md «Backwards compatibility».

### R-3. Auth bypass via misconfigured role gate 🔴 Score: 5 × L = MEDIUM-HIGH
- **Trigger**: Adding a new role helper without mirroring in `firestore.rules`, OR weakening an existing gate.
- **Worst case**: Lower-role user (mapeditor / teamviewer) accesses finance data.
- **Mitigation**:
  - Defense-in-depth: UI gate (CSS body class + JS check) PLUS server gate (`firestore.rules`)
  - `_assertCanEditFinance(operation)` throws on the JS side
  - Test each role before shipping auth changes
- **Claude action**: Auth changes ALWAYS require Tony approval. Mirror UI changes in rules same commit.

### R-4. Cloud sync conflict with destructive recovery 🔴 Score: 4 × M = HIGH
- **Trigger**: Operator clicks "↑ Force push" while teammate is editing same workspace.
- **Worst case**: Teammate's recent changes overwritten silently.
- **Mitigation**:
  - Confirm dialog warns about teammate edits
  - Operator-controlled (Claude doesn't auto-click)
  - Forensic stash in localStorage (`sfa_conflict_stash_v1`) for last 50 conflicts
- **Claude action**: DON'T auto-resolve sync conflicts. Surface the banner. Let Tony decide.

### R-5. `localStorage` cap (5 MB) exhausted 🟡 Score: 3 × M = MEDIUM
- **Trigger**: Operator uploads multiple multi-MB blueprints stored as dataURLs in `state` instead of Storage URLs.
- **Worst case**: New writes silently fail on `localStorage.setItem`; offline mode unreliable.
- **Mitigation**:
  - Blueprints upload to Firebase Storage; `state` only stores Storage URL (not dataURL)
  - Photos same path
  - Hard guard at 950 KB in `fbPushNow` for Firestore document
- **Claude action**: When adding any feature that stores binary in `state`, route to Storage instead.

### R-6. SVG attribute crash silently aborts `renderUnits()` 🔴 Score: 5 × L = MEDIUM-HIGH
- **Trigger**: `setAttribute(name, value)` where value is `Infinity` / `NaN` / `undefined` on SVG element.
- **Worst case**: Render aborts mid-loop; units after the failure get no event listeners; operator can't click. (Real incident 2026-05-11.)
- **Mitigation**:
  - Defensive `Number.isFinite()` checks on any computed numeric attribute
  - Clamp to safe ranges
  - DECISIONS.md § 6 documents the latent bug class
  - Sentry doesn't catch this — must verify via Playwright `console.errors`
- **Claude action**: Any new `setAttribute` with computed value → guard against non-finite. Test via Playwright after.

### R-7. Auto-billing cron sends to wrong tenant 🔴 Score: 5 × L = MEDIUM-HIGH
- **Trigger**: Logic error in auto-billing iteration (e.g. iterating across all buildings without honoring archive flag).
- **Worst case**: Real Stripe invoices to wrong people.
- **Mitigation**:
  - Per-tenant on/off toggle (`u.lateFee.autoSend`)
  - Per-building pause (`b.billingRulesOverride.paused`)
  - Workspace-level dry-run (`state.settings.lateFee.autoSendLive`)
  - Skip `_isFinanceShadow` units
  - Skip archived units
- **Claude action**: Auto-billing edits ALWAYS require Tony approval + test in dry-run first.

### R-8. Multi-suite lease incorrectly billed per-suite 🟡 Score: 4 × M = HIGH
- **Trigger**: New code path doesn't honor `_isFinanceShadow(u)` skip.
- **Worst case**: Tenant of a 5-suite lease gets 5 separate invoices instead of 1; over-bills 5×.
- **Mitigation**:
  - `_isFinanceShadow(u)` is the canonical filter
  - Documented in DECISIONS.md § 1 and MEMORY.md → `feedback_grouped_suites_one_lease.md`
- **Claude action**: When iterating units for finance display/calc, ALWAYS apply `_isFinanceShadow` skip OR document why not.

### R-9. State `_rev` gap caused by stale tab → mass conflict 🟡 Score: 3 × M = MEDIUM
- **Trigger**: Operator leaves a tab open from a prior session; that tab has `_rev = X`; cloud advances to `X + 100k`; tab tries to write → fails.
- **Worst case**: Operator stuck with red banner; force-push wipes legitimate cloud changes.
- **Mitigation**:
  - `↑ Force push` / `↓ Pull cloud` recovery buttons (added 2026-05-10)
  - Auto-rebase for same-user same-doc bursts
- **Claude action**: Don't auto-resolve. Surface the banner.

### R-10. Build / deploy without authorization 🔴 Score: 5 × L = MEDIUM
- **Trigger**: Claude runs `firebase deploy` without explicit per-action approval (currently SUSPENDED in local-only mode).
- **Worst case**: Untested code goes live; affects real users.
- **Mitigation**:
  - Local-only mode disallows deploy entirely
  - Even when re-enabled, Claude requires explicit "deploy this" instruction (see CLAUDE.md "Tony Approval Required")
- **Claude action**: NEVER deploy without Tony's per-action OK.

### R-11. Secret committed to git 🔴 Score: 5 × L = MEDIUM
- **Trigger**: Tony pastes API key in chat; Claude saves to `.env` or commits inline.
- **Worst case**: Key leaked to GitHub mirror; rotation required; potential financial harm if Stripe key.
- **Mitigation**:
  - SECURITY_AND_SECRETS.md absolute rules
  - `functions/.gitignore` ignores `.env`
  - Claude never reads `functions/.env`
- **Claude action**: Refuse to save secrets to ANY file. Tell Tony to use `firebase functions:secrets:set`.

### R-12. CSS specificity beats inline setAttribute → silent visual bug 🟡 Score: 3 × H = HIGH
- **Trigger**: New code does `el.setAttribute('stroke', '...')` on `.unit-rect` — gets overridden by class CSS rule.
- **Worst case**: Operator sees unit borders rendered with the wrong color; logic looks correct but visual is wrong.
- **Mitigation**:
  - DECISIONS.md § 6 documents this
  - Use inline `style="..."` for forced overrides on `.unit-rect`
- **Claude action**: When changing styles on `.unit-rect`, use inline `style`. Test visually after.

### R-13. Refactor / rename breaks Operator's muscle memory 🟡 Score: 3 × M = MEDIUM
- **Trigger**: Renaming a button label, moving a menu item, changing keyboard shortcut.
- **Worst case**: Operator can't find function; wastes time; loses confidence.
- **Mitigation**:
  - Per CLAUDE.md "Forbidden without approval": large UX rearrangement
  - Notify operator in commit message AND mention in next session
- **Claude action**: Don't rename / relocate UI elements without explicit Tony approval.

### R-14. Adding a new dependency increases attack surface + supply-chain risk 🟡 Score: 3 × M = MEDIUM
- **Trigger**: `npm install <pkg>` or adding CDN `<script>`.
- **Worst case**: Malicious dep ships to operator's browser; supply-chain compromise.
- **Mitigation**:
  - CLAUDE.md "Forbidden without approval": new dependencies
  - Existing deps audited (only `pdf.js`, `dxf-parser` lazy-loaded; Stripe, firebase-admin, firebase-functions in functions/)
- **Claude action**: ASK Tony. Default no.

### R-15. Documentation drift (docs say X, code does Y) 🟡 Score: 2 × H = MEDIUM-HIGH
- **Trigger**: Code changes; docs not updated.
- **Worst case**: Future Claude session relies on stale docs; makes wrong assumption; introduces bug.
- **Mitigation**:
  - CLAUDE.md doc map specifies update protocol
  - Each doc has "How to update this file" footer
  - SESSION_LOG.md is the truth for "what shipped recently"
- **Claude action**: After every shipped change, update the relevant doc(s) in the same commit batch.

### R-16. Playwright spec failure ignored / disabled to ship faster 🟡 Score: 4 × L = MEDIUM
- **Trigger**: Spec fails post-change; Claude disables it to "fix later".
- **Worst case**: Real regression masked; operator hits in production.
- **Mitigation**:
  - QA_CHECKLIST.md: don't disable spec without Tony approval
  - Specs are minimal (3); disabling one is a major signal
- **Claude action**: Spec failure = STOP. Diagnose. Don't disable.

### R-17. Building photo / blueprint upload exposes PII 🔵 Score: 2 × L = LOW
- **Trigger**: Operator uploads a photo of a blueprint with handwritten tenant info.
- **Worst case**: PII in Firebase Storage; visible to other workspace members.
- **Mitigation**:
  - Workspace members are vetted by admin
  - Storage gated by Firebase Auth (no public access)
  - CORS config restricts cross-origin reads
- **Claude action**: When adding photo-upload features, check the existing CORS / Auth gates still apply.

### R-18. Test-mode Stripe key accidentally used in production 🟡 Score: 4 × L = MEDIUM
- **Trigger**: Misconfigured `STRIPE_MODE` env var.
- **Worst case**: Webhooks not signed correctly; auto-billing fails silently OR creates test invoices that aren't real charges.
- **Mitigation**:
  - `STRIPE_MODE` env explicit
  - `STRIPE_WEBHOOK_SECRET` paired with mode
  - Cloud Functions logs flag mode mismatch
- **Claude action**: Don't touch Stripe env vars without Tony approval.

### R-19. UI text accidentally translated to Russian (instead of English) 🔵 Score: 2 × L = LOW
- **Trigger**: Code comment in Russian leaks into a `<button>` label or `toast()` message.
- **Worst case**: Cosmetic only; users see Russian where English expected.
- **Mitigation**:
  - MEMORY.md: «UI text in English only» rule
- **Claude action**: When editing string literals shown in UI, keep English.

### R-20. Test infra changes (Playwright config) silently weaken coverage 🔵 Score: 3 × L = LOW
- **Trigger**: Editing `tests/playwright.config.ts` to skip a check / lower timeout / disable retry.
- **Worst case**: CI passes but real bugs slip through.
- **Mitigation**:
  - `tests/` requires Tony approval to modify
- **Claude action**: Hands off `playwright.config.ts` unless Tony asks.

---

## Risk-mitigation summary

For any planned change, ask:

1. **Does this touch money?** → R-1, R-7, R-8, R-18 → Tony approval
2. **Does this change schema?** → R-2 → Tony approval
3. **Does this change auth?** → R-3 → Tony approval + mirror in firestore.rules
4. **Does this add a `setAttribute` with computed numeric?** → R-6 → guard non-finite, test via Playwright
5. **Does this rename a UI element?** → R-13 → Tony approval
6. **Does this add a dep?** → R-14 → Tony approval
7. **Does this rely on stale docs?** → R-15 → re-read DECISIONS.md / SESSION_LOG.md first
8. **Does this disable a spec?** → R-16 → STOP, ask Tony

If any answer is yes, follow the mitigation in that risk's row.

## When risk realizes (incident protocol)

If a risk materializes (something broke):

1. STOP further changes
2. Report to Tony with: what happened + when + which commit + recovery options
3. Tony decides: roll back, hot-fix, or accept and triage
4. Update KNOWN_ISSUES.md immediately
5. After resolution, add post-mortem entry to DECISION_LOG.md
6. If the risk wasn't documented, ADD it to this RISK_MATRIX.md

Past incidents documented in SESSION_LOG.md "Critical incident" entries — read those for real examples of the protocol.
