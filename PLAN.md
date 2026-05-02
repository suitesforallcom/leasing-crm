# SuitesForAll — Master Plan

> Living document. Update as work progresses. Date created: 2026-04-29.
> File: `floor-map-editor.html` (~2.67 MB single-page app).
> Stack: vanilla HTML/JS + Firebase (Firestore + Auth + Storage + Functions) + Stripe + DocuSign.

---

## Status

**Stage 1 — Auth + workspace model** ✅ DONE
- Firestore sync (`/workspaces/default/state`)
- Login screen (Google + email/password)
- Role system: `admin` / `manager` / `teamviewer` / `viewer`
- Member invites via emailAllowlist

**Stage 2 — Stripe / DocuSign integration** 🟡 IN PROGRESS
- Stripe customer + invoice creation, hosted payment, webhook
- Auto-charge after first payment saved
- Move-in invoices (rent + deposit) with smart prorating
- Auto-invoicing cron (workspace-level + per-unit overrides)
- DocuSign envelope send + status polling
- Lease document timeline (multi-doc per unit)

**Stage 3 — Reliability + reports** 🟡 IN PROGRESS
- Local backup engine (this session) ✅
- Server-side Firestore backups (15-min + daily) ✅
- Audit log ✅
- Revenue forecast (per-lease ledger model) ✅
- Backup automation, restore UI ✅

---

## Critical principles (from project CLAUDE.md)

1. **Lease document is single source of truth for rent.** `u.contractRent` always mirrors active rent doc.
2. **state shape** must stay backwards-compatible. Don't break saved data on migration.
3. **No Object.assign over user fields.** Migration / seed-merge is fill-only by construction.
4. **Sanitize every user-typed field on render** (`esc()`).
5. **localStorage quota awareness** — don't write photo blobs into state without size guard.
6. **Atomic Edit ops + per-mutation backups** — prevents 1.5h-of-work-lost from silent code bugs.

---

## High-priority backlog (do first)

### A. Stripe / billing — finalize

- [ ] **Send reminder via Stripe** — replace post-send "Send" buttons with "Send reminder" that calls `stripe.invoices.sendInvoice()` retry. Verify the email actually arrives.
- [ ] **Invoice duplication guard** — block creating two rent invoices for same `(unitId, ym)` within 24h. Pre-flight check + clear error.
- [ ] **Invoice naming with month** — change number format so rent invoices show `R-{suite}-{billingMonth}-{issuedDate}` (already done — verify display in all surfaces).
- [~] **Failed payment handling** — UI surfacing DONE in 4 layers: floor-map red `$` badge on units (`96cb219`), Rent Roll Suite cell + critical Stripe Status chip override (`cc37786`), Billing KPI clickable filter for "see N failures → show only those rows" (`1205e40`), real-time toast with Suite + Tenant + ym + amount + reason + "View →" jump button (`09771d5`). REMAINING: backend "Retry charge" endpoint via `stripe.invoices.pay()` + UI button (PAYMENT LOGIC — needs explicit approval per CLAUDE.md §7).
- [ ] **Refund flow** — currently no UI. Add Refund button to PAID invoice rows in Invoice Report. Calls Stripe API, updates state, audits.
- [ ] **Subscription detection** — for tenants on Stripe subscriptions, render subscription status in Move-in card instead of single-invoice flow.
- [ ] **Smart Retries config** — surface Stripe's smart-retry settings in Settings → Billing so operator knows what's configured.
- [ ] **Stripe Dashboard parity** — when invoice status changes via Dashboard, our webhook should re-pull and update local cache (not just rely on listing).

### B. Teamviewer role restrictions (Stage 2 finishup)

- [x] **Hide rent roll for teamviewer** — `applyRoleVisibility()` bounces from `rentroll`. CSS hides `#railRent`. Done before this session.
- [x] **Hide Stripe data for teamviewer** — `body.no-finance` CSS hides `.revenue-block`, `.money-row`, `.rent-strip`, `.stat-val.money`, `.sfa-finance-only`. `showBilling()` gated by `canUseStripe()`. Floor-map financial signals hidden via CSS + JS gates in commit `a6ea72d`.
- [x] **Hide payment data for teamviewer** — `applyRoleVisibility()` bounces from `payments`. CSS hides `#railPay`. Floor-map $ pills + overdue dot + auto-error overlay gated in `a6ea72d`.
- [x] **Map view for teamviewer** — Floor plan only shows tenant names + lease/onboarding signals; financial signals (overdue mark, charge-failed badge, autopay error overlay, rent/deposit pills) hidden via CSS `body.no-finance` + JS `canSeeFinance()` gates (`a6ea72d`).
- [x] **All Reports views gated for teamviewer** — `applyRoleVisibility()` bounce list extended to `home / billing / invoices / leases / stacking / commissions` in addition to `rentroll / payments`. Entry guards added to `showHome / showStackingPlan / showCommissions`. CSS hides rail icons `#railHome / #railBill / #railLeases / #railComm` (`b1c30f7`, 2026-05-02).
- [ ] **Settings tabs for teamviewer** — only Templates + Help. Hide Billing, Integrations, Team, Data. NOT YET DONE.
- [ ] **Audit teamviewer access** — log every page load + tab open by teamviewer (consultant accountability). NOT YET DONE.

### C. DocuSign — go deeper

- [ ] **Multi-signer support** — currently single recipient. Add multiple signers (landlord + tenant + guarantor).
- [ ] **Counter-signature flow** — landlord signs after tenant. Currently auto-completes on tenant sign.
- [ ] **Resend with new email** — operator wants to send to a different address without voiding first.
- [ ] **Decline reason capture** — when tenant declines, capture their reason in audit log.
- [ ] **Template merge field validation** — flag missing `{{tenant_name}}` etc before send.
- [ ] **Per-template default subject + body message** — currently each send modal asks anew.

### D. Reports — fill in gaps

- [x] **Vacancy report** — Billing → Vacancy sub-tab. Suites with no active lease, sub-rooms of whole-rented parents excluded. KPIs (vacant suites/sqft/lost market rent/avg days), filters (search/min-days/building), days-vacant colour-coded ≥90/180/365, CSV. Days-vacant TREND deferred — needs snapshot store like revenue forecast (commit `33746b0`, 2026-05-02).
- [x] **Move-out / move-in calendar** — Billing → Calendar sub-tab. Combined timeline of `u.until` (move-outs) + `u.leaseStart > now` (move-ins) within 30/60/90/180d window. KPIs split by direction with $ at-risk / incoming. Type pill, days countdown coloured, CSV (commit `2bcec76`, 2026-05-02).
- [x] **Aging A/R CSV** — `exportAgingCsv` already shipped earlier; PLAN item was stale (no new commit needed, 2026-05-02).
- [x] **P&L by month** — Billing → P&L sub-tab. Walks `u.payments[ym]` bucketed by `p.date` month. Revenue = status='paid', Bounced = status='bounced' (refunds proper not first-class — Stripe Dashboard handles them). Range 12/24mo/YTD/all-time, building filter, MoM trend column, footer Total, CSV (commit `0efd6bd`, 2026-05-02).
- [ ] **Tenant churn analytics** — % renewing vs not, by month / by suite size / by tenant tenure. BLOCKED on snapshot store (need to capture lease-end events + outcome over time).
- [ ] **Lease expiration heat map** — partial overlap with the Move-out half of the new Calendar. Reconsider scope: month-grid heatmap may still be a useful at-a-glance complement.
- [x] **Year-end financial export — Schedule E CSV** — Button on P&L toolbar with year selector. Per-building rows mapped to IRS Form 1040 Schedule E Part I columns (Property/Address/Type=4 Commercial/Fair Rental Days/Rents Received line 3/expense placeholders lines 5-19/Income or Loss). TOTAL row + memo Bounced/Payments columns. Operator fills expense columns from their books (commit `a828012`, 2026-05-02).

### E. UX polish

- [ ] **Mobile / responsive** — current layout breaks below 1024px. Make at least Map + Rent Roll viewable on phones.
- [ ] **Keyboard shortcuts** — `?` modal listing all (Cmd+K search, M for Map, R for Rent Roll, F for Finance pane, etc).
- [ ] **Dark mode polish** — some surfaces still have light-mode-only color tokens.
- [ ] **Toast deduplication** — "Sync error" can fire 5x in 30s, queue/dedupe.
- [ ] **Better empty states** — every list has "no data" — make them informative + actionable.

---

## Medium-priority backlog

### F. Data integrity

- [ ] **State validator on load** — schema-check buildings/floors/units shape, surface anomalies in console + Settings → Data.
- [ ] **Migration test harness** — for any change to loadState() migrations, run a synthetic state through it, assert specific invariants.
- [ ] **Photo storage migration** — current u.photos store base64 in state, blowing localStorage quota. Move to Firebase Storage URLs.
- [ ] **State size monitor** — banner when state JSON > 4MB (approaching browser quota).
- [ ] **Stripe customer dedup** — sometimes two `cus_*` IDs map to same email; dedup wizard.
- [ ] **Lease end vs leaseTerm mismatch self-heal** — already detect via `_addLeaseDocMonthsBetween`; add UI nudge if there's a discrepancy.

### G. Tenant onboarding flow

- [ ] **Onboarding modal — combined view** — currently 3-step modal; make it 1 page with progressive disclosure.
- [ ] **Tenant self-portal** — Phase 4: tenant logs in, sees their leases, pays, downloads PDFs.
- [ ] **Guarantor capture** — name + email + phone + ID number for tenants who need one.
- [ ] **Pre-move-in checklist** — keys delivered, walkthrough done, deposit paid, lease signed. Visible on Move-in card.

### H. Financial niceties

- [ ] **Late fee accrual** — calculate days-late × daily-rate. Currently flat fee. Add option.
- [ ] **Auto-prorate on move-out** — refund unused portion of last month rent.
- [ ] **Multi-currency support** — currently $ only. Defer.
- [ ] **CAM / NNN charges** — common-area maintenance, taxes, insurance line items.
- [ ] **Annual rent escalation clause** — auto-bump rent on lease anniversary.
- [ ] **Security deposit interest** — some states require it. Add settings flag.

### I. Lease docs / templates

- [ ] **PDF text extraction** — parse uploaded lease PDFs to confirm tenant name + rent + dates match form values. Lightweight check.
- [ ] **Template versioning** — every save creates a version. Audit which lease used which template version.
- [ ] **Per-state templates** — Florida, NY, CA each have different mandatory clauses.
- [ ] **Insurance certificate tracking** — upload tenant's COI, track expiration.

### J. Operations / admin

- [ ] **Bulk operations** — select N units → bulk-send rent invoice / bulk-archive / bulk-set rent. Already partial in Rent Roll.
- [ ] **Search across everything** — current Cmd+K is unit-only. Add tenant names, invoice numbers, audit entries.
- [ ] **Building floor plan upload** — operator currently draws by hand or uploads image bg; add SVG / DXF support.
- [ ] **Maintenance ticket tracking** — basic CRUD: report → assign → resolve → log. Not part of MVP but operators ask.

---

## Low-priority / nice-to-have

### K. Integrations

- [ ] **Plaid for tenant ACH verification** — alternative to Stripe ACH.
- [ ] **QuickBooks export** — sync paid invoices to QBO.
- [ ] **Slack / email notifications** — tenant signed, payment failed, etc.
- [ ] **Zapier webhook** — send key events to operator's automation.

### L. Map & visualization

- [ ] **Floor plan auto-detect (AI)** — already partial; needs OpenAI key flow polish + fallback to manual.
- [ ] **Multi-building portfolio view** — bird's-eye campus view with all buildings.
- [ ] **Print floor plan** — clean PDF export of current floor.
- [ ] **Embed floor plan in tenant emails** — image of their suite highlighted.

### M. Internationalization

- [ ] **i18n string extraction** — currently English hard-coded. Extract to dict.
- [ ] **Russian translation** — operator is Russian-native, helpful for in-app strings.

---

## DONE — past sessions (Stage 1 + Stage 2 catalog)

Compiled from transcripts of:
- `local_8b2be126` — "Create office occupancy map program"
- `local_55481496` — "SuitesForAll app Stage 2 development"
- `local_3753233f` — "Transfer previous chat history"
- `local_d9cc18e5` — "Review previous chat history"
- `local_a1260994` — "Review chat history and continue work"
- `local_415560b6` — "Unit 408 automatic substitution issue"
- `local_65ffece4` — "Upload previous project chat history"

Numbered for traceability. ✅ = shipped & live in `floor-map-editor.html`.

### Auth + workspace model (Stage 1)

1. ✅ Login overlay screen with Google + email/password sign-in
2. ✅ Workspace data model in Firestore (`/workspaces/{wsId}/data/state`)
3. ✅ Workspace members collection (`/workspaces/{wsId}/members/{uid}`)
4. ✅ Email allowlist (`/workspaces/{wsId}/emailAllowlist/{email}`) for pre-authorized invites
5. ✅ Role system: `admin` / `manager` / `teamviewer` / `viewer` with role-based Firestore rules
6. ✅ Single-pass member bootstrap on sign-in (replaces old create-then-consume race)
7. ✅ Sync indicator in topbar (Offline / Loading / Live sync / Sync error)
8. ✅ User badge with role pill in header
9. ✅ Skeleton state on first sign-in (renders before Firestore pulls)
10. ✅ Inbound listener with revision-based last-write-wins
11. ✅ ignoreNext flag suppresses self-echoes from listener
12. ✅ Optimistic locking on push via Firestore transaction

### Lease management

13. ✅ End-of-month convention (`start + N months → last day of that month`) for lease end
14. ✅ Three-convention detection: end-of-month / anniversary-day / anniversary-1-day (legacy)
15. ✅ `_addLeaseDocMonthsBetween` reverse function for term auto-detect
16. ✅ Self-healing `leaseTerm` derive on every page load (no migration flag — idempotent)
17. ✅ Add Lease modal: Term dropdown ↔ Lease end date two-way sync
18. ✅ Standard term auto-detect (6/12/18/24/36/60) on manual end-date change
19. ✅ Dynamic option injection for non-standard terms (e.g. "19 months")
20. ✅ Pre-fill on modal open: vacant suite → today + 12mo, occupied → from unit fields
21. ✅ `saveQuickAddTenant` reads manual end date with end-of-month fallback
22. ✅ Suite 408 detection — now correctly reports "18 months" instead of Custom
23. ✅ M2M lease handling — disables end date field, no maturity calc
24. ✅ All four entry points use the same convention: Add Lease modal, right-panel onTermChange, Add Unit modal, saveAddUnitModal

### Lease documents (timeline view)

25. ✅ Multi-document timeline per unit (lease / amendment / renewal / notice)
26. ✅ Status pills with consistent ZIP theme (signed / awaiting signature / voided / declined / expired / uploaded)
27. ✅ Document Preview modal (PDF iframe + HTML body fallback)
28. ✅ Per-unit lease template editor (`u.leaseTemplateOverrides[kind]`)
29. ✅ Workspace lease template defaults (`state.settings.leaseTemplates[kind]`)
30. ✅ Template resolution: unit override wins, falls back to workspace
31. ✅ Edit Details modal — title / dates / rent change / notes / term months
32. ✅ Document deletion with role gate
33. ✅ DocuSign envelope linking (`doc.envelopeId`) with status mirroring
34. ✅ PDF upload to Firebase Storage with per-unit path scoping
35. ✅ 15 MB cap on uploads with friendly error
36. ✅ Storage rules `isEditor()` check via `workspaces/{wid}/members/{uid}` (fixes upload permissions)
37. ✅ Add Document modal with source picker (DocuSign vs Upload)

### Stripe — Move-in card + invoice flow

38. ✅ Smart prorate logic: mid-month → prorated charge, 1st → full month
39. ✅ Move-in card with rent + deposit + total breakdown
40. ✅ "Send both" / "Rent only" / "Deposit only" buttons
41. ✅ Direct send path (`_sendMoveInDirect`) bypassing Create Invoice modal
42. ✅ Status badges Not sent ⊙ / Sent ✉ / Paid ✓ (Stripe-style SVG icons, 22×22)
43. ✅ Single `_moveInInvoicePill(status, invoiceId)` shared across 4 surfaces
44. ✅ Reads real bucket from `_invoicesCache` (paid via webhook)
45. ✅ Double-send protection: 3 layers (pre-flight check + disabled button + `_sendingMoveIn` 5s lock)
46. ✅ `_verifyAndStampAfterSend` recovery on send timeout / cancel
47. ✅ "↻ Sync with Stripe" manual recovery button on Move-in card
48. ✅ Auto-open Stripe hosted URL after send removed (was confusing operator)
49. ✅ × close button on onboarding modal
50. ✅ Force re-render unit panel when onboarding modal closes (badge sync)
51. ✅ `purposeBadge` includes `RA` for auto-rent (vs `R` manual)
52. ✅ Stripe field cleanup migration (drops orphaned `_sendingRentAt` / `_sendingDepositAt`)

### Stripe — auto-charge

53. ✅ `collection_method: 'charge_automatically'` when default PM saved
54. ✅ `save_default_payment_method: 'on_confirmation'` for first invoice
55. ✅ Workspace-wide auto-charge toggle (Settings → Billing)
56. ✅ Per-unit auto-charge override (Inherit / Always / Never)
57. ✅ Effective auto-charge banner in Finance pane (⚡ Auto-charge active)
58. ✅ Auto-pay legal notice in invoice footer (compliance for US states)
59. ✅ Cron `runAutoInvoices` honors auto-charge config
60. ✅ Help tab documentation for auto-charge flow

### Stripe — auto-invoicing

61. ✅ Cron schedule (day-of-month, due-days-after) workspace-wide
62. ✅ Per-unit override toggle ("Auto-invoicing on for this suite")
63. ✅ "AUTO 10d" badge on auto-invoiced services in Finance pane
64. ✅ Cloud Function `runAutoInvoices` (idempotent per ym)
65. ✅ Skip already-paid months (no double-billing)

### Invoice Report (KPI surface)

66. ✅ KPI cards: Lifetime collected / Outstanding / Invoices / On-time rate
67. ✅ Revenue last-12-months chart (paid only)
68. ✅ Revenue by purpose breakdown bars
69. ✅ Per-tenant ledger tables (current first, prior tenants by latest invoice)
70. ✅ Voidable detection (draft / open / past_due / uncollectible)
71. ✅ Bulk-cancel via Stripe — sequential, rate-limit-friendly, progress toast
72. ✅ Confirmation modal lists per-row action
73. ✅ Pre-flight permission check via `voidOrDeleteStripeInvoice` callable
74. ✅ Auto-refresh after cancel (force-fetch + re-render)
75. ✅ Voided rows visually struck through + dimmed

### Invoice History (Finance pane, compact)

76. ✅ 3-source matching: metadata.unitId / stamps / customerId+email+tenancy window
77. ✅ Tenancy window check prevents prior-tenant invoice bleed-in
78. ✅ Diagnostic empty state with explicit reasons (cache size / customerId / email / stamps)
79. ✅ Refresh button kicks customer-scoped fetch
80. ✅ Browse all → invoice browser modal for manual linking
81. ✅ Year-grouped payment timeline grid (37+ months supported)
82. ✅ Cell semantics: paid green / late yellow / overdue red / future grey / pre-tenancy dark grey
83. ✅ Pre-tenancy / future cells styled darker (slate-500 / slate-400, white labels)
84. ✅ Tooltips with month + status + amount + paid date + source method
85. ✅ Late-paid detection using `inv.created` (proxy for paid_at)
86. ✅ Click row → opens hosted URL in new tab

### Unit panel — sections / Edit mode

87. ✅ `.unit-section` card wrappers on Overview, Finance, Lease tabs
88. ✅ Compact Edit mode hides empty sections (Payment History, Lease Card)
89. ✅ Removed duplicate "Payment History" header
90. ✅ Additional services: bold removed, compact rows, single bordered container, ellipsis truncate
91. ✅ Subscription badge on auto-invoiced services

### Payment timeline gating

92. ✅ Pre-tenant months filtered from 12-row payment timeline (Tenant Drawer)
93. ✅ Mark Paid opens current month (not earliest pre-tenancy)
94. ✅ All 12-month widgets check `leaseStart` window (Rent Roll, aging, payment grid)

### Revenue forecast (Home page)

95. ✅ Per-lease ledger model (each lease tracked individually with alive-fraction)
96. ✅ Term distribution captured from current portfolio (12mo / 6mo / 18mo / 24mo mix)
97. ✅ Renewal lottery: fixed-term `alive *= (1-rate)` on end date, M2M monthly distributed attrition
98. ✅ Baseline = max(last3moAvg, last6moAvg) for new lease velocity
99. ✅ Last-6-months velocity strip in assumption panel
100. ✅ Past 3 months + future 12 months display (15 columns)
101. ✅ Past months bleached opacity 55% with dashed `past · forecast →` separator
102. ✅ Color semantics: green = continuing, blue = new this month, orange = non-renewals
103. ✅ Auto-recalc through `saveState()` hook (no manual refresh)
104. ✅ Daily snapshot in `state.forecastSnapshots[]` (idempotent, 365-cap)
105. ✅ "Updated as of" indicator + ▲/▼ diff vs previous snapshot
106. ✅ Term mix breakdown shown in assumption panel
107. ✅ Non-renewal slider drives orange decay correctly across all term types

### Rent Roll

108. ✅ Lease Signed column added (with `formatDisplayDate` normalization)
109. ✅ Date format consistency: ISO / slash / text → "Apr 08, 2026"
110. ✅ Column presets updated (Compact / Financial / Contacts) to include new columns
111. ✅ Bulk-archive selected rows
112. ✅ Search + filter + column visibility persisted in `state.ui.rentRollColumns`

### Bug fixes / data integrity (silent ones that mattered)

113. ✅ `mergeTenantDataIntoFloor` made fill-only (was `Object.assign` over user fields → caused tenant wipe 2026-04-28)
114. ✅ `ensureRealDataSeeded` restoration pass on every load
115. ✅ Bad-date heal on every load (years like 56000/58277 from earlier `inv.created * 1000` bug)
116. ✅ Snap migration v1 (snap + snapEdge default false on legacy data)
117. ✅ Redesign map migration v1 (compact status, hide sqft, hide sink)
118. ✅ Contract rent backfill v1 (legacy `u.rent` → `u.contractRent` for occupied units)
119. ✅ Late-fee year normalization in `state.lateFeeInvoices`
120. ✅ Workspace allowlist consume-on-bootstrap (kills stale-allowlist background job)

### Audit log

121. ✅ Cloud Function `recordAudit` server-side append-only log
122. ✅ Client-side outbox with retry every 30s (survives reload)
123. ✅ Settings → Data → Audit log panel with filters (suite / action / text)
124. ✅ Cursor-based pagination ("Load older entries")
125. ✅ Action color coding (invoice = blue / payment = green / restore = red)
126. ✅ Inline diff render (before → after)
127. ✅ Outbox badge in panel title when pending entries

### Backups (server-side, pre-Stage-3)

128. ✅ Cloud Function `takeManualBackup` writes to `/workspaces/{wsId}/backups/`
129. ✅ Cron `dailyBackup` at 03:00 UTC with 90-day retention
130. ✅ 15-min frequent snapshots with 48-hour retention
131. ✅ Cloud Function `restoreBackup` with pre-restore safety snapshot
132. ✅ Settings → Data → Backups panel with kind badges (DAILY / 15-MIN / MANUAL / PRE-RESTORE)
133. ✅ "Take backup now" button gated by `canManageBackups()`

### Misc UX polish

134. ✅ Toast deduplication (loading toasts replace previous)
135. ✅ Custom logo SVG (3-leaf + teal circle motif) — left rail + favicon
136. ✅ Help tab — invoice numbering reference table (auto-generated from `PURPOSE_CODE_MIRROR`)
137. ✅ Help tab — auto-charge flow diagram + legal notes
138. ✅ Common charges template list (Settings → Templates)
139. ✅ Additional services catalog (Settings → Billing) — feeds Invoice Setup Purpose dropdown

---

## DONE this session (2026-04-29)

- ✅ Invoice purpose dropdown — removed Replacement keys / Damages / Other from built-ins
- ✅ Invoice Report: checkbox-driven void/hide for ALL rows (not just voidable)
- ✅ "Show hidden N" toggle in Invoice Report
- ✅ Right-click context menu on Invoice History (date / amount / status all open same menu)
- ✅ Lease rent consistency policy — document is single source of truth, auto-sync on save
- ✅ Inline ⚠ badge on lease doc card when suite rent disagrees, one-click sync
- ✅ Local backup engine — sfaBackup/sfaListBackups/sfaRestore/sfaDeleteBackup console API
- ✅ Auto-snapshot on page load (before migrations) + every 30 min
- ✅ Settings → Data → Local backups panel with restore/download/delete
- ✅ Pre-mutation snapshots on 7 critical operations (archive, delete, mass-void, backfill, clean-phantom, import, clear-everything)

---

## Workflow rules (lessons from 2026-04-28)

1. **Never run mutation code without testing actual data flow.** `node --check` is syntax only — not behavior. Smoke-test in browser ANY change touching loadState / migrations / merge.

2. **No Object.assign over user-editable fields.** Migration / seed-merge code is fill-only by construction. Always check if destination is empty before write.

3. **Pre-mutation snapshot before any bulk operation.** Already wired for 7 critical paths; add to ANY new code that touches multiple records.

4. **Batch edits when possible.** One Edit replacing 50 lines is cheaper (in chat output budget) than 10 small Edits.

5. **Subagent for verification work.** Parse-checks, grep audits, multi-file searches — delegate to subagent so the main chat doesn't burn context.

6. **Cap chat session size.** When ~50–70 substantive edits done, propose a new chat with PLAN.md + HANDOFF.md handoff. Don't push past until context is saturated.

7. **Reduce screenshot dimensions.** Mac Retina screenshots at 2600×1629 trip the 2000px API limit. Set `System Settings → Displays → "Default for display"` (not "More Space") — screenshots stay <2000px naturally.

---

## File map (where stuff lives)

```
/Users/diskc/Documents/Claude/Projects/Office map/
├── floor-map-editor.html    ~2.67 MB single-file app
├── functions/
│   └── index.js              Cloud Functions: stripe-* + dsync-* + audit-* + backups
├── firebase.json
├── firestore.rules
├── storage.rules
├── CLAUDE.md                 Project principles (read FIRST in any new chat)
├── PLAN.md                   This file
└── HANDOFF.md                Copy-paste bootstrap message for fresh chats
```

---

## Quick reference

- **Deploy hosting:** `firebase deploy --only hosting`
- **Deploy functions:** `firebase deploy --only functions:<name>` (or `--only functions` for all)
- **Local backup commands** (DevTools console):
  - `sfaBackup("note")` — manual snapshot
  - `sfaListBackups()` — table of all
  - `sfaRestore("sfa_lbk_…")` — restore by key
  - `sfaBackupHelp()` — full reference
- **Reset Stripe state for a unit** (escape hatch): `sfaResetStripe('408')`
- **Hosting URL:** https://suitesforall.web.app
