# MAINTENANCE_TASKS.md

> Recurring maintenance Tony should consider doing manually (or asking Claude to assist with).
> All tasks below are **local-only** in current mode unless explicitly marked otherwise.

## Daily (when actively using the app)

| Task | How | Who | Time |
|---|---|---|---|
| Check for cloud-sync banner errors | Refresh the app; look for red banner at top | Operator | 30 sec |
| Check overdue pill (top-bar) | Visible in topbar when overdue invoices exist | Operator | 30 sec |
| Review today's autobilling fires | Settings → Auto-billing → review «firing today» KPI | Operator | 2 min |
| Glance at "Cloud sync" badge | Topbar should say "● Live sync" | Operator | 5 sec |

## Weekly

| Task | How | Who | Time |
|---|---|---|---|
| Review Recovery cases progress | left rail → Billing → Recovery tab | Operator | 5 min |
| Review Pipeline (prospects) staleness | left rail → Pipeline button → "Stale only" filter | Operator | 5 min |
| Verify backup snapshot ran | Settings → Backups → check `lastSnapshotAt` | Operator | 1 min |
| Review unaccounted floor area % | Home → Floor area panel — % unaccounted | Operator + Claude | 5 min |
| Inspect any units with red autoInvoice error border | Floor plan → red-bordered cells; check `u.stripe.lastAutoInvoiceError` reason | Operator | 5-10 min |

## Monthly

| Task | How | Who | Time |
|---|---|---|---|
| Reconcile Stripe vs `u.payments` | Stripe Dashboard → invoices → cross-check with Payments matrix in app | Operator | 15-30 min |
| Archive moved-out tenants past retention period | Right panel → Tenant tab → Archive | Operator | 10 min |
| Review building valuation drift (Investment Analysis) | Home → Fin. analytics → check Income Val for each building | Tony (admin) | 10 min |
| Update lease-end forecasts | Calendar / Lease expiry tab → 90d window | Operator | 10 min |
| Clean up stale Files in Files tab | Building modal → Files tab → review by folder | Operator | 10 min |

## Quarterly

| Task | How | Who | Time |
|---|---|---|---|
| Review KNOWN_ISSUES.md and prune resolved entries | This file → manual review | Tony + Claude | 20 min |
| Audit role assignments | Settings → Members → check each member's role still matches their job | Tony | 10 min |
| Review Firestore document size | Browser console: `JSON.stringify(state).length` — should be < 950 KB | Operator | 1 min |
| Run Playwright smoke tests | `cd tests && npx playwright test` | Tony or Claude (with approval) | 5 min |
| Audit auto-billing rules per building | Settings → Auto-billing → coverage matrix | Tony | 15 min |

## Annually

| Task | How | Who | Time |
|---|---|---|---|
| Renew SSL / domain | Hosting provider (Firebase Hosting auto-renews; verify) | Tony | 5 min |
| Renew Stripe / DocuSign / UniFi API keys (if rotation policy) | Each provider's console; update `functions/.env` | Tony only — DO NOT have Claude do this | 30 min |
| Review Firestore Security Rules | `firestore.rules` — re-read against role matrix in DECISIONS.md § 2 | Tony + Claude | 30 min |
| Update Firebase Functions deps | `cd functions && npm outdated` → review → upgrade carefully | Tony + Claude (with approval) | 1 hr |
| Update Playwright / test deps | `cd tests && npm outdated` → upgrade | Tony + Claude (with approval) | 30 min |

## On-demand maintenance

### When Tony reports "something's slow"

1. Browser DevTools → Performance tab → record a session of the slow action
2. Look for long tasks in the timeline (>50ms)
3. Common culprits:
   - `renderUnits()` re-rendering full floor on every state change → check if state-change is debounced
   - Firestore writes too frequent → check `fbPushNow` debounce window (250-1000ms)
   - Large blueprint image → check `f.bg.src` size (should be Storage URL, not dataURL > 1 MB)

### When Tony reports "something visual is wrong"

1. Cmd+Shift+R hard refresh (clears cache)
2. Open DevTools Console → look for red errors
3. **Critical**: also look for SVG `DOMException` warnings (NOT errors per se but visible in Console). Past incident with `tspan dy: Expected length, Infinity` was Console-only.
4. If Tony is on label-drag mode (`mode='label'`), confirm they're in the right tool
5. Compare visually with a known-good screenshot if available

### When Tony asks "is this safe to deploy?" (if mode is re-enabled)

This is currently a Tony-only decision (local-only mode disallows deploy). When re-enabled:

1. Run all checks per QA_CHECKLIST.md
2. Confirm `git diff` only contains intended changes
3. Confirm `<meta name="sfa-release">` would be stamped with current commit
4. Run Playwright smoke against local server first (`PW_BASE_URL=http://localhost:5577`)
5. **Tony then runs `firebase deploy --only hosting`** — Claude doesn't deploy in any mode without explicit per-deploy approval going forward.

## Scheduled cleanup

### Browser localStorage hygiene

`localStorage` cap is 5 MB per origin. If app starts behaving weirdly:

1. Open DevTools → Application → Storage → Local Storage → `https://suitesforall.web.app`
2. Check `sfa_state_v1` size
3. If > 4 MB, suspect: blueprint stored as dataURL instead of Storage URL
4. **Don't clear**: would lose unsynced changes. Force-push first, then clear.

### Firestore document hygiene

Single-doc design caps at 1 MB. The hard guard in `fbPushNow` refuses pushes > 950 KB:

1. Check `state._size` after a push (logged to console)
2. If approaching limit:
   - Archive old buildings (Settings → Archive)
   - Trim large photos (Settings → Storage)
   - Consider migrating sub-collections (e.g. `recoveryCases` → its own collection) — **schema change, requires Tony's approval**

### Storage cleanup

Receipts, blueprints, lease PDFs accumulate in Firebase Storage. To clean:

1. Firebase Console → Storage → audit folders
2. Cross-check with `state` references — files with no reference in any `u.payments[*].receiptPath` etc. are orphans
3. **Don't bulk-delete** without Tony's approval — false-positives can lose audit trail

## Documentation maintenance

| File | When to update |
|---|---|
| `DECISIONS.md` | New business rule, formula change, terminology, latent bug discovery |
| `SESSION_LOG.md` | After every shipped commit |
| `KNOWN_ISSUES.md` | Bug discovery; mark fixed when resolved |
| `CHANGELOG.md` | Major milestones (≈ monthly bump) |
| `RISK_MATRIX.md` | New risk identified; risk score changes |
| `USER_FLOWS.md` | New workflow added or major flow change |
| `DATA_MODEL.md` | Schema field added / removed / repurposed |
| `ENVIRONMENT_VARIABLES.md` | New env var added |
| `MAINTENANCE_TASKS.md` | This file — when cadence rules change |

## What NOT to do as "maintenance"

- ❌ Don't run `npm audit fix` automatically — could introduce breaking changes
- ❌ Don't run `firebase functions:delete <fn>` ever
- ❌ Don't delete Firestore documents directly
- ❌ Don't clear browser localStorage on operator's machine remotely (no API for this anyway)
- ❌ Don't disable any auto-billing tenant without explicit Tony OK
- ❌ Don't void Stripe invoices (only Tony does)
- ❌ Don't auto-resolve Sentry issues without verifying the fix shipped (legacy auto-resolve mode is suspended)

## When something slips

If maintenance task is overdue:
1. Add to KNOWN_ISSUES.md with severity tag
2. Tell Tony in next session start
3. Don't auto-execute "I'll just fix it" — let Tony schedule it
