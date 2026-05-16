# CHANGELOG

> High-level milestone history. For per-commit detail, see **`SESSION_LOG.md`**.
>
> Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — Added / Changed / Fixed / Deprecated / Removed / Security.

---

## [Unreleased] · 2026-05-11 → present (local-only mode)

### Added
- `DECISIONS.md`, `SESSION_LOG.md` for cross-session continuity (commit `5d01adc`)
- 17-file documentation package for local-only PM mode (this commit / batch)

### Changed
- **Project mode switched to local-only maintenance** (CLAUDE.md updated). Auto-deploy / auto-push SUSPENDED. Legacy auto-deploy rules preserved as reference at bottom of CLAUDE.md.

---

## 2026-05-11 milestone — "Building separation + Financial Analytics tab + Critical click fix"

Major release in a single day spanning ~30 commits. Highlights:

### Added
- **Financial Analytics admin-only tab** (commits `e3b0771`, `c3274b9`)
  - New `#financeAnalyticsView` container in left rail
  - Hosts Investment Analysis (BRRRR underwriting) AND Revenue Forecast
  - Gated to admin role via `canSeeFinanceAnalytics()` + CSS `body:not(.role-admin) #railFin`
- **Per-building data separation across 10 surfaces** (commits `0ba0c9c`, `7bc9ac4`)
  - `_matchesActiveBuilding()` predicate hard-clamps every collect/filter
  - Vacancy + Calendar dropdowns single-only + disabled
  - Top-bar building pick = single source of truth
- **Building Valuation feature** — quick estimate + auto-seed (`fa18281`)
  - 4 inline cards: GPR / EGI / NOI / Building Value @ 7% cap
  - "+ Create full record" promotes to editable Investment record
  - Smart defaults: `externalValuation = NOI / 7%`, `refiAmount = 65% × valuation`
- **Potential Value KPI card** on Forecast hero (`590dbde`)
  - 5th card after Max Potential, computed @ 9% cap · 35% expenses
  - Admin-only via CSS gate
- **Waiver date range + pro-rate helper** (`68b7687`)
  - Date pickers when method=waived
  - Live coverage breakdown (per-month days waived)
  - `_unitProrationCredit(u, ym)` helper exported for downstream wiring
- **Activity pill scope clarification** (`b4024ce`, `c7956af`)
  - Window: month-to-date (since 1st of current month) instead of rolling 30d
  - Inclusion criterion: `leaseStart` instead of `depositPaidAt`
  - Scope: active building only
- **Outline-prompt after blueprint upload** (`90a344d`)
  - Confirm dialog: "Trace building outline now?" 350ms after `Loaded` toast
  - Skipped if outline already exists OR source is DXF

### Fixed
- 🔴 **Critical: `_labelFontFor` Infinity → tspan dy SVG parser crash** (`035de45`)
  - Latent bug — when `svg.getBoundingClientRect().width = 0`, font = ∞ → `setAttribute('dy', Infinity)` → silent SVG `DOMException` → `renderUnits()` aborted mid-loop → units after the failure had no event listeners → operator saw "units don't click"
  - Fix: zoom-denom guard + `Number.isFinite` check + clamp to `[0.5, 1000]`
- Allow unit click in `pan View Mode` + `label+edit` mode (`6feed75`)
- Sentry SUITESFORALL-9 (TypeError: 'offsetX' on undefined in `onDragMove`) — empty `drag.items[]` guard
- Calibrate-area error message rewritten to redirect to floor-outline tool when operator confuses the two (`45e27fb`)
- `.snap-popover` scroll inside (max-height + overflow) when content overflows viewport (`0baca69`)
- Revenue Forecast section moved from Home to Financial Analytics + auto-refresh on building switch (`c3274b9`)
- Investment Analysis "Phase A · v1" placeholder badge replaced — all 6 sub-tabs are shipped (`96e8c5a`)

### Changed
- All 10 building-scoped surfaces now scope to active building (UI lockdown + data-layer hard-clamp)
- Activity pill window changed from rolling 30d → month-to-date

---

## 2026-05-10 milestone — "Label drag tool, border unification, building filter rollout"

### Added
- **Label drag tool («123»)** — full feature set across multiple commits:
  - Initial tool + free-form positioning (`229ba6d`)
  - Common-area labels (Office / Mech / etc) draggable (`fdd6893`)
  - Selected unit highlights when moving its label (`6d962d3`)
  - Hit-rect tightly bounds suite-number digits (`89b5474`)
  - Alignment snap + green guide lines vs neighbor labels (`2a24e07`)
  - Allowed unit click in `label+edit` mode (`307a760`)
- **9-position label-position picker + bulk-apply via shift-select** (`b0548c5`)
- **Cyan snap-dots visible during unit drag** for corner-snap discoverability (`9a3fd65`)
- **Pan tool default** instead of select (`978d6f8`)
- **Files tab in Building modal** — aggregator across all building files + folder org (`06c98ab`, `550c1b1`, `6b8edcd`)
- **Auto-bootstrap new buildings** — Edit mode + upload prompt (`e585bce`)
- **Floor area %** alongside Useful / Other / Unaccounted (`b9cc4d5`)
- **Sync banner recovery buttons** — `↑ Force push` and `↓ Pull cloud` (`97b0dbf`)

### Fixed
- **Avg rent cards reflect effective rent** (contract for occupied + proforma for vacant) — was proforma-only (`526196e`)
- **Always render headline $/mo** in unit panel; removed misleading "Unit price" toggle (`1a5463d`)
- **Layers panel scope clarity** — added "(on map)" suffix; section renamed (`3a3ef37`)
- **Building filter defaults to active building** (10 surfaces) (`9d3dbac`)
- **Full per-building separation** (UI + data hard-clamp) (`43c2d20`)
- **Polygon stroke matches rect perimeter** (uniform dark slate `#475569` width 2) (`8adf037`, `ed7b0dc`)
- **Vacant rect borders match occupied** (no double-stroke from setAttribute losing to CSS) (`4062290`)
- **PASS 2 internal walls unified with perimeter style** (`be051f3`)
- **Polygon labels default to top-left like rect** (was centroid) (`33a9bda`)
- **Unit drag works in pan + Edit Mode** (was blocked) (`e84ed0a`)
- **Rect drag handles zoom-aware** (were 10×10 fixed user-units) (`b988083`)
- **Universal `vector-effect: non-scaling-stroke`** so SVG strokes stay thin at zoom (`70f400b`, `5be746a`)
- **Unit labels stay constant screen-px + cap by unit size** (`711f5e3`)
- **Two discrete label sizes** (normal + 65% small) — no continuous interpolation (`4db6239`)
- **Preserve operator's pan/zoom when switching tools** (no auto-fit) (`afaf4a8`)
- **Show building NAME (not address) as primary label everywhere** (`697d26b`)

---

## Earlier 2026-05 — pre-2026-05-10 work

Detailed per-commit history exists in `git log` and HANDOFF.md / PLAN.md. Major themes that pre-date the explicit changelog:

### Added (over the project lifetime)
- Floor plan editor with rect / polygon / wall / door / cut-wall / measure / calibrate / label-drag tools
- Multi-building / multi-floor org with top-bar switcher
- Tenant + lease management with multi-suite grouping
- Stripe billing integration (manual + auto)
- DocuSign lease envelope lifecycle
- A/R Aging with bucket buckets + late-fee triggers
- Recovery (collections) for moved-out tenants
- Investment Analysis (BRRRR cash-out underwriting) with 6 sub-tabs
- Pipeline (prospects kanban)
- Auto-billing matrix with cron-driven daily run
- Cloud Functions (Stripe webhooks, scheduled tasks, DocuSign sync)
- Firebase real-time sync via `onSnapshot` + optimistic locking
- Local backup snapshots
- Sentry error tracking + auto-resolve workflow
- Playwright smoke tests (3 specs)
- Role-based access control (admin / manager / mapeditor / teamviewer / viewer)
- Building photos, blueprints, lease PDFs in Firebase Storage
- UniFi Protect / Access stubs (Phase 4)

---

## How to update CHANGELOG

After a major milestone (≈ monthly), promote SESSION_LOG.md entries to a CHANGELOG section. Use Keep-a-Changelog categories: Added / Changed / Fixed / Deprecated / Removed / Security.

Don't bump version numbers (project doesn't use semver explicitly). Date-based milestones are the unit.
