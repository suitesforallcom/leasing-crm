# DECISIONS — terminology, business rules, formulas, UX conventions

> Quick-read reference for any future Claude session working on this repo.
> Read this BEFORE diving into code. Updated as decisions are made.
> If a rule conflicts with `CLAUDE.md`, CLAUDE.md wins.

---

## 1. Terminology (canonical names + what they mean)

| Term | Meaning | Where it lives |
|---|---|---|
| **Building** | Physical address (e.g. «16001 Bay Vista Dr»). Top-bar selector controls «active building». | `state.buildings[]` |
| **Floor** | One level inside a building. Has its own SVG canvas, scale, outline polygon, units. | `state.buildings[].floors[]` |
| **Unit / Suite** | One leasable room (rect or polygon shape on the floor SVG). «Suite» is the customer-facing label (e.g. «Suite 101»); «Unit» is the code term. | `state.buildings[].floors[].units[]` |
| **Tenant** | Individual / company occupying a suite. Lives ON the unit (`u.tenant`, `u.company`). NOT a separate entity. | `u.tenant`, `u.company` |
| **Lease** | Contract on a unit. `u.leaseStart` / `u.leaseEnd` / `u.contractRent`. For multi-suite leases, units share a `groupId` and one is `groupRole='primary'` holding the combined rent. | `u.lease*` fields + `u.groupId` |
| **Prospect** | Pre-lease pipeline entry (Inquiry → Toured → LOI → Lease sent → Signed). | `u.prospects[]` |
| **Group / Multi-suite lease** | One tenant occupying ≥2 suites under one contract. `u.groupId` joins them; primary suite holds combined `contractRent`, members hold `0`. **Never split per-suite for invoices/overdue/payments — collapse to one set everywhere.** | `u.groupId`, `u.groupRole` |
| **Sub-room / Child unit** | Unit nested inside a parent (`u.parentId`). When parent is whole-rented or part of a group, child is «inactive» — skip it in MRR / aging / vacancy aggregations via `_isInactiveSubRoom`. | `u.parentId` |
| **Shadow unit** | Non-head member of a group; non-primary in a multi-suite lease. Skip via `_isFinanceShadow` so finance tables count one row per tenant. | derived |
| **Floor outline** | Polygon (operator-traced) marking the building perimeter on a floor. Drives Total / GFA. **NOT the same as building rectangle.** | `floor.outline.points` |
| **Background blueprint** | The PDF/PNG/JPG/DXF the operator uploaded as the underlay. | `floor.bg.{src, scale, opacity, x, y}` |

---

## 2. Roles + access matrix

Source of truth: `currentRole()` returns one of `admin / manager / mapeditor / teamviewer / viewer`.
Mirror in `firestore.rules`. UI gates via CSS body classes (`role-admin`, `role-manager`, etc) PLUS function-level checks.

| Role | Edit | See finance | Manage members | Manage backups | Restore backup | Restructure | **See Financial Analytics tab** |
|---|---|---|---|---|---|---|---|
| `admin` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓ (only role)** |
| `manager` | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| `mapeditor` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `teamviewer` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `viewer` | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |

Helpers: `canEdit()`, `canSeeFinance()`, `canEditFinance()`, `canSeeFinanceAnalytics()` (admin only — added 2026-05-11), `canManageMembers()`, `canManageBackups()`, `canRestoreBackup()`, `canRestructureWorkspace()`.

CSS hides per role: `body:not(.role-admin) #railFin { display: none !important; }` — applied via `applyRoleVisibility()`.

---

## 3. Key formulas

> **2026-05-12 update:** canonical financial model from Kiwi Rentals loaded into `financial-model/`. The formulas below are the SuitesForAll-active forms; cross-reference `FINANCIAL_MODEL_REFERENCE.md` § 2 + § 9 for the Kiwi-vs-SuitesForAll mapping. Any change to these formulas now requires passing the Financial-Model Gate (CLAUDE.md «Approval STILL required» → «Financial-model gate»).



### Effective rent (per unit, per month)
```
effectiveMonthly = (u.status === 'occupied')
                   ? (+u.contractRent || +u.rent || 0)   // tenant pays the contract; legacy fallback to u.rent
                   : (+u.rent || 0)                       // vacant/reserved → asking proforma
```
Used by: Window/Interior/Average rate cards (Dashboard), Rent Roll MRR, Stacking, A/R Aging.

### Building valuation (Income approach)
```
GPR_annual           = Σ (u.rent × 12) для rentable office units
EGI                  = GPR × (1 - vacancyPct/100)        // default vacancy 5%
NOI                  = EGI × (1 - opexPct/100)            // default opex 35%
Building Value       = NOI / (capRatePct/100)             // default cap 7% (full underwriting), 9% (Forecast hero «Potential Value»)
```

| Surface | Cap | Vacancy | Opex | Why |
|---|---|---|---|---|
| Forecast hero «Potential Value» | **9%** | **0%** (proforma 100% leased) | **35%** | Conservative ceiling-side sanity |
| Investment Analysis quick-estimate / seed defaults | **7%** | **5%** | **35%** | Industry-typical for US commercial office |
| Investment Analysis (configured record) | operator-set sliders per building | operator-set | operator-set | Tunable underwriting |

### Refi amount default (for auto-seed Investment record)
```
refiAmount = 0.65 × externalValuation     // 65% LTV — typical commercial loan max
```

### Waiver pro-rate credit
For each `u.payments[ym]` with `status='free'` and `waiverStart` + `waiverEnd`:
```
fraction_for_month = days_in_month_covered_by_waiver / monthDays_in_that_month
billable           = rent × (1 - fraction_for_month)
```
Public helper: `_unitProrationCredit(u, ym)` — sums all overlapping waivers, clamps `[0, 1]`.

⚠️ **NOT YET WIRED into invoice generation** as of 2026-05-11. The helper exists; downstream codepaths (runAutoInvoices, manual invoice creation, Stripe sync) still use full rent. See SESSION_LOG.md → Open items.

### Activity pill (top-bar «N new leases +$X/mo»)
- Window: **month-to-date** (since 1st of current calendar month). NOT rolling 30 days.
- Inclusion: `leaseStart` falls inside window AND deposit-paid (sanity gate for committed money).
- Scope: **active building only** (via `_matchesActiveBuilding`).
- Function: `_compute30DayActivity()` (name preserved for compat, intent updated).

---

## 4. UX conventions (non-negotiable)

### Building filter scope
- Top-bar building pick is the **single source of truth** for «which building».
- Every building-scoped surface (Rent Roll / Aging / Vacancy / Calendar / Recovery / DocuSign Leases / Auto-billing / Pipeline / Leases view / Payments) has its data layer hard-clamped via `_matchesActiveBuilding(buildingId)`.
- Vacancy + Calendar dropdowns are single-only + disabled (only the active building shows).
- Other dropdowns default to current building, can be changed per-session.
- `switchBuilding()` → fires `_resetBuildingFiltersToActive()` to snap all open tables to the new building.
- **Stacking + Commissions** are intentional exceptions (Stacking single-building always; Commissions workspace-wide).

### Label drag tool («123» icon, hotkey L)
- Admin + Edit Mode only.
- Click+drag the cyan dashed box on any unit's label to free-form position it.
- Stores `u.labelDX` / `u.labelDY` (top-left of label block in unit-local SVG coords).
- Click without drag: selects the unit (right panel updates).
- Common-area labels (Office / Mech / Restroom etc) also draggable — auto-defaults to centroid for polygons, center for rect.
- Hit-rect tightly bounds suite-number digits (sized via `_labelFontFor(u, 17)`, NOT fixed scene-units).
- **Critical guard**: `_labelFontFor` clamps zoom denominator and rejects non-finite results. Without this guard, `svg.getBoundingClientRect().width = 0` (e.g. during initial render) → font = `Infinity` → `setAttribute('dy', Infinity)` → SVG parser throws DOMException → `renderUnits()` aborts mid-loop → **units after the failing one get NO event listeners** → operator sees «не нажимаются юниты». **Latent. Don't break.**

### Unit border styling (PASS 2 walls)
- All axis-aligned rect units: `stroke: none` in PASS 1; PASS 2 wall-pass paints all edges with a single style: `#475569` width 2 round-cap.
- Polygon + rotated rect: own inline `style="stroke: #475569; stroke-width: 2"` (PASS 2 skips them — bbox edges would form phantom rectangles around L/T/U-shapes).
- All borders (interior dividers AND building perimeter) use the same dark slate — uniform CAD-look. Operator explicitly asked: «приведи всё к единому виду».

### View Mode rules
- Click on unit in any mode (`pan`, `select`, `label+edit`) selects + opens right panel.
- Drag of unit only fires in `pan+edit` or `select+edit`. NOT in `label`.
- View mode (`!editMode`): click-to-select works in any tool, no drag, no destructive actions.

### Cloud sync / optimistic locking
- Every save uses Firestore transaction with `_rev` check. Same-user fast-path conflicts auto-rebase silently.
- Real conflict (other user wrote between baseRev capture + tx) → red `#syncBanner` with two action buttons:
  - **↑ Force push** — adopts cloud rev as new base, pushes local. **Destructive** to cloud-side divergence.
  - **↓ Pull cloud** — discards local, pulls cloud version.
- These were added 2026-05-10 to give operator a recovery path without diving into Settings.

### Auto-deploy
Per `CLAUDE.md` Section 1: every commit on the active branch → parse-check (`new Function()` on each `<script>` block) → `firebase deploy --only hosting` → `git push origin <branch>`. No `dep` phrase needed. Render the deploy command as a fenced ```bash code block in the chat reply (Section 13).

### Comments / language
- All in-file code comments: **Russian**. Identifiers: English.
- All UI text (labels, tooltips, button captions, help bubbles): **English**.
- Chat replies to operator: Russian.

---

## 5. Architecture rules (MUST not break)

- **Single-file architecture**: everything in `floor-map-editor.html` (~130k lines). No split into modules. No new dependencies without approval.
- **State shape**: `{ buildings: [...], tenants: [], leases: [], settings: {...}, ui: {...}, investments: {...}, recoveryCases: [...] }` — preserved exactly.
- **`localStorage` size limit 5 MB**: photos go to Firebase Storage (Phase 2), not state.
- **Backwards-compat for state**: never break user's saved data shape. New optional fields OK; renames / required fields are NOT.
- **Polygon vs rect**: detected by `Array.isArray(u.points) && u.points.length >= 3`. Polygon `u.points` are absolute scene coords; subtract `(u.x, u.y)` to make relative for `<polygon>` element.
- **PASS rendering order in `renderUnits()`**:
  - PASS 1: fills + labels (per-unit, in order)
  - PASS 2: wall edges (deduped, classified perimeter/internal — though both now use same style)
  - PASS 2.5: window stripes
  - PASS 2.6: tenant-group highlight overlay
  - PASS 3: handles
  - PASS 4: selection halo

---

## 6. Latent bugs / pitfalls to remember

| Bug | Where | How to avoid |
|---|---|---|
| **`_labelFontFor` Infinity** | `floor-map-editor.html:57360` area | Always guard zoom denom > 0 + `Number.isFinite()` check. Was the cause of «units don't click» on 2026-05-11. |
| **CSS specificity beats setAttribute on `.unit-rect`** | Polygon stroke styling | Use inline `style="stroke: …; stroke-width: …"` — `setAttribute('stroke', …)` loses to the `.unit-rect` CSS rule. |
| **Sentry doesn't catch DOM-attribute exceptions** | Anywhere SVG attrs are set with bad values | Sentry hooks `window.onerror`. Silent SVG `DOMException` (e.g. `Expected length, Infinity`) only shows in browser console. Test with `playwright.console_messages` if you suspect a render issue. |
| **State `_rev` gap > millions** | Cloud sync conflict | Don't auto-resolve; surface the recovery banner. The previous "auto-pull on conflict" approach silently lost operator work. |
| **`setMode('label')` blocks unit click in old gate** | `onUnitPointerDown` mode gate | Gate must accept `select / pan+edit / label+edit / pan` (the latter so View Mode operators can select units in default tool). Don't regress this list. |
| **Activity pill counted via `depositPaidAt`** (legacy) | `_compute30DayActivity` | Switched to `leaseStart` 2026-05-11. Don't revert — recently-recorded deposits on old tenants would re-light the pill incorrectly. |

---

## 7. Where things are

| File | Purpose |
|---|---|
| `floor-map-editor.html` | THE app. Single file, all code. |
| `CLAUDE.md` | Project-level rules + non-negotiables. **Read first every session.** |
| `DECISIONS.md` | THIS file — terminology, formulas, UX conventions. |
| `SESSION_LOG.md` | Chronological «what we shipped» — read tail-50 for recent context. |
| `firebase.json` | Hosting config. `firebase deploy --only hosting` ships from `.` |
| `tests/` | Playwright smoke specs. `cd tests && npx playwright test` |
| `.github/workflows/playwright.yml` | CI runs same suite on every push. |
| `~/.claude/projects/.../memory/MEMORY.md` | Operator preferences, persists across all sessions. |
| `~/.claude/projects/.../memory/feedback_*.md` | Detailed entries referenced from MEMORY.md index. |

---

## 8. When to update this file

After landing any of:
- A new business term that wasn't documented
- A new role / permission helper
- A formula that downstream code depends on (rate calc, valuation, etc.)
- A UX convention the operator stated explicitly («приведи всё к единому виду», «scope to active building», etc.)
- A latent bug discovery worth remembering (one-liner under § 6)

Drop a sentence with date + commit hash. Don't grow this past ~500 lines — if it gets long, split into topic files.
