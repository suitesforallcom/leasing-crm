# PROJECT_CONTEXT.md

## Project Name

**SuitesForAll** — multi-building office floor-plan + leasing manager.

## Current Status

This is a completed existing program in **local-only maintenance mode** (set 2026-05-11).

No external services should be re-connected at this stage without Tony's explicit approval. The app is currently live at `https://suitesforall.web.app` from past deploys, but new auto-deploys are SUSPENDED until Tony re-enables.

## Business Purpose

SuitesForAll is an admin-facing operational tool for property managers running multi-building office space portfolios. It combines:

1. **Floor-plan editor** — operator uploads a blueprint (PDF / PNG / JPG / DXF), traces the building outline, draws units / suites with rect or polygon shapes, sets metadata (rent, sqft, capacity, type).
2. **Tenant + lease management** — assigns tenants to suites, captures lease terms (start, end, rent, deposit), tracks lease lifecycle (prospect → toured → LOI → lease sent → signed).
3. **Billing + payments** — generates monthly rent invoices, syncs to Stripe (when configured), records manual payments (check / ACH / wire / cash / waiver), tracks A/R aging, late fees, recovery for moved-out tenants who left owing money.
4. **Reporting** — Rent Roll (across all buildings or per-building), Vacancy report, Calendar (move-ins / move-outs over a window), Recovery (collections cases), Auto-billing matrix, Pipeline (prospects kanban).
5. **Investment Analysis (admin only)** — BRRRR cash-out underwriting model: building valuation (NOI / cap rate), IRR, DSCR, hold-period sensitivity, scenario compare. Quick-estimate inline; full sub-tabs (Overview / Cash Flow / Hold / Sensitivity / Compare / AI heuristics) available after seeding an investment record.

## Primary Users

| User type | Role key | Access |
|---|---|---|
| **Owner / Admin** | `admin` | Full access including Financial Analytics, member management, backup restore, workspace restructure |
| **Property Manager** | `manager` | Edit + see finance, manage backups (read), but no member mgmt, no analytics, no restore |
| **Map Editor** | `mapeditor` | Edit floor plans only — no finance, no analytics, no member mgmt |
| **Team Viewer** | `teamviewer` | Read-only floor plan + tenant names, NO finance |
| **Viewer** | `viewer` | Read floor plan + rent roll, no edit |

Source of truth: `currentRole()` in `floor-map-editor.html` + `firestore.rules`.

## Main Features

| Feature | What it does | Main files / surfaces | Risk level |
|---|---|---|---|
| **Floor plan editor** | Visual SVG editor for buildings + floors + units. Tools: rect / polygon / wall / door / cut-wall / measure / calibrate / label-drag («123») / floor-outline. | `floor-map-editor.html` § renderUnits, setMode | Medium — visual bugs surface immediately |
| **Multi-building org** | Top-bar building switcher; data scope is per-building across all tables. | `switchBuilding`, `_matchesActiveBuilding` | Medium |
| **Rent Roll** | Cross-building tenant table with filters, status, sort, CSV export. | `renderRentRoll`, `filterRentRollRows` | High — financial display |
| **Payments matrix** | Monthly collection grid; click cell to record manual payment / waiver. | `renderPayments`, `submitManualPayment` | **Critical — touches money** |
| **A/R Aging** | Past-due bucketing (Current / 30d / 60d / 90d / 90+) with trend, late-fee triggers. | `buildAgingRows`, `renderAgingPanel` | **Critical — touches money** |
| **Auto-billing** | Per-tenant matrix of "auto-invoice on" / "late-fee on" toggles + cron-driven daily run via Cloud Functions. | `applyAutoBillingFilters`, `functions/index.js` | **Critical — sends real invoices** |
| **DocuSign Leases** | Lease envelope lifecycle, expiring-soon view, status tracking. | `renderLeasesPanel`, `_leaseCollectAll` | High — legal documents |
| **Recovery (collections)** | Cases for moved-out tenants who left owing; agency assignment, payment plans. | `renderRecoveryPanel`, `state.recoveryCases[]` | High — legal / financial |
| **Pipeline (prospects)** | Kanban: Inquiry → Toured → LOI → Lease sent → Signed. | `_pipelineCollectProspects`, `_renderPipelineBoard` | Low |
| **Vacancy report** | Vacant suites + last-tenant info + days-vacant. | `_vacancyCollect`, `_vacancyApplyFilters` | Medium |
| **Calendar / Lease expiry** | Move-ins + move-outs over configurable window. | `_calendarCollect`, `_calendarApplyFilters` | Medium |
| **Stacking view** | Building cross-section showing rent stack per floor. | `renderStackingChart` (single building) | Medium |
| **Commissions** | Per-manager rollup (this month / last 30d / YTD) — workspace-wide, not building-scoped. | `renderCommissions` | Medium |
| **Financial Analytics** (admin only) | Revenue Forecast (12-mo projection with non-renewal + pace sliders) + Investment Analysis (BRRRR cash-out underwriting). | `renderHomeForecast`, `renderHomeInvest` | Medium — admin-only display |

## Main Workflows

### W1. Add a new building
1. Operator clicks «+ Add building» from buildings dropdown
2. Modal captures name, address, photo, optional details
3. New building auto-bootstraps: enters Edit Mode, prompts to upload floor plan
4. State updated: `state.buildings.push(...)`, `state.ui.currentBuildingId = newId`
5. Risk: low

### W2. Trace a floor outline
1. Operator uploads blueprint → confirm-prompt asks "Trace outline now?"
2. OK → `setMode('floor-outline')` → operator clicks corners → double-click closes
3. State updated: `floor.outline.points = [...]`
4. Total / Useful / Other ft² KPIs become available
5. Risk: low (outline is a polygon, easily redrawn)

### W3. Draw units on a floor
1. Operator picks Rect or Polygon tool from bottom toolbar
2. Drags rectangle (rect) or clicks corners (polygon)
3. Drawer appears for unit details (suite ID, type, sqft, rent, capacity)
4. State updated: `floor.units.push(...)`
5. Risk: low (units are easily moved / resized / deleted)

### W4. Add a tenant to a unit
1. Operator clicks unit → side panel opens → "Add tenant" CTA
2. Captures tenant name, company, lease terms, contract rent, deposit, lease start/end
3. State updated: `unit.tenant`, `unit.contractRent`, `unit.leaseStart` etc.
4. If multi-suite (Shift+G groups them): `unit.groupId` joins, primary holds combined rent
5. Risk: medium — financial fields drive billing

### W5. Record a payment
1. Operator clicks `$` cell in Payments matrix or "Mark paid" on overdue invoice
2. Modal captures method (Stripe / check / ACH / wire / cash / waiver), amount, date, memo, optional receipt photo
3. **Waiver** (free month): operator picks reason + date range (start/end) — supports pro-rate when waiver crosses month boundary
4. Submit → `u.payments[ym] = {...}` written → optimistic-locked tx to Firestore
5. Risk: **CRITICAL** — touches money. Stripe sync may follow.

### W6. Send a late-fee invoice
1. Auto-billing cron fires daily (Cloud Function) checking units with `lateFee.autoSend: true`
2. For each overdue tenant past grace: creates Stripe invoice with late fee line item
3. Bulk-send UI also available for manual triggering
4. State + Stripe synced; receipt URL stored on payment record
5. Risk: **CRITICAL** — sends real invoices to real tenants

### W7. Move a tenant out
1. Operator clicks "Move out" on unit
2. Captures moved-out date, optional reason
3. Tenant data snapshots into `u.tenantHistory[]`; `u.status = 'vacant'`; clears `u.tenant`, `u.contractRent`, `u.leaseStart`, `u.leaseEnd`
4. If owing balance > 0: optionally creates `state.recoveryCases[]` entry for collections
5. Risk: high — legal + financial endgame

### W8. Investment underwriting (admin only)
1. Admin clicks "Fin. analytics" rail button
2. Sees Revenue Forecast + Investment Analysis
3. For building without record: 4 quick-estimate cards (GPR / EGI / NOI / Building Value)
4. Click "+ Create full record →" to seed editable Investment record with smart defaults (externalValuation = NOI/7%, refiAmount = 65% LTV)
5. Sub-tabs: Overview / Cash Flow / Hold / Sensitivity / Compare / AI heuristic insights
6. Risk: low (analysis only; doesn't mutate operational data)

## Important Business Rules

Documented in `DECISIONS.md` § 3 (formulas) and § 4 (UX conventions). Key rules:

- **Effective rent**: occupied → `contractRent || rent` (legacy fallback); vacant/reserved → `rent` (asking proforma).
- **Multi-suite leases**: `groupId` joins units; never split per-suite for invoices / overdue / payments.
- **Sub-rooms**: when parent is whole-rented, sub-room is "inactive" — skip in MRR / aging / vacancy aggregations via `_isInactiveSubRoom`.
- **Building filter scope**: top-bar building pick is single source of truth; all data tables are hard-clamped to active building via `_matchesActiveBuilding`.
- **Activity pill**: window = month-to-date (since 1st of current calendar month); criterion = `leaseStart` (NOT `depositPaidAt`); scope = active building only.
- **Waiver pro-rate**: `_unitProrationCredit(u, ym)` returns fraction of rent to credit. ⚠️ Helper exists but **not yet wired** into invoice generation paths (see KNOWN_ISSUES.md).
- **Building valuation**:
  - Forecast hero «Potential Value»: `(GPR × 65%) / 9%` — operator-fixed defaults
  - Investment Analysis quick-estimate: `(GPR × 95% × 65%) / 7%` — industry defaults
  - Investment Analysis full record: per-building configurable sliders

## What Must Not Be Changed Without Tony Approval

- **Financial logic**: rent calc, late fee triggers, pro-rate math, payment recording, Stripe webhook handlers
- **Auth logic**: `currentRole()`, role gates, Firestore rules
- **Permissions**: any of `canEdit / canSeeFinance / canSeeFinanceAnalytics / canManageMembers / canRestoreBackup / canRestructureWorkspace`
- **Database schema**: `state.*` shape, Firestore document shape, `_rev` optimistic locking
- **Customer data**: tenant info, lease terms, payment history, recovery cases
- **Production settings**: Firebase config, hosting rewrites, Stripe keys
- **External integrations**: Stripe / DocuSign / UniFi / Cloud Functions
- **Core business workflows**: W4–W7 above (tenant + payment + move-out flows)

## Current Limitations (found 2026-05-11)

- **No root `package.json`** — main app is single-file HTML, no toolchain at root
- **No build script** — opens directly in browser; deploy is `firebase deploy --only hosting` of the static HTML
- **No automated unit tests at root** — only Playwright smoke tests in `tests/` (3 specs)
- **`localStorage` 5 MB limit** is a real constraint; uploaded blueprints/photos must go to Storage to avoid filling state
- **`_unitProrationCredit` not wired** into invoice generation — waiver pro-rate works at UI/preview level only
- **Investment Analysis sub-tabs** (Hold / Sensitivity / Compare / AI) not visually verified by operator after the Phase A → v1 rename
- **Auto-deploy was active** prior to 2026-05-11 — every commit triggered Firebase + GitHub push. SUSPENDED in current mode but the patterns may still appear in older PLAN.md / HANDOFF.md docs

## Open Questions for Tony (not blocking)

1. **Re-enable auto-deploy?** Current local-only mode disallows it. If you want a per-commit deploy back, say "re-enable auto-deploy" and I'll restore the legacy CLAUDE.md operating section.
2. **Local dev server preference** — there's no local server set up. For testing changes locally, you'd open `floor-map-editor.html` directly in a browser, OR run a static server (`python3 -m http.server 5577` from project root) and point Playwright at `PW_BASE_URL=http://localhost:5577`. Which do you prefer documented as canonical?
3. **GitHub mirror** — `origin` is `https://github.com/suitesforallcom/leasing-crm.git`. Local-only mode disallows push. Do you want me to keep tracking what should be pushed in a "pending push" file, or just rely on `git log` for that?
