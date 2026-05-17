# DECISION_LOG.md

> Architectural / business / UX decisions ordered chronologically. Companion to **`DECISIONS.md`** (which is the topical reference).
>
> Read **DECISIONS.md** for "what decisions exist" indexed by topic.
> Read **THIS file** for "when + why each decision was made".

---

## How to use

Each entry:
- **Date + commit** when decided / shipped
- **Decision** — one-line statement
- **Context** — why this was needed
- **Alternatives considered** — what was rejected
- **Consequences** — what this enables / forbids going forward

Cross-reference DECISIONS.md sections in `(see DECISIONS.md § N)` notation.

---

## Decisions

### D-2026-05-12-FM1 · Canonical Kiwi financial model loaded as gate
- **Decision**: Tony's Kiwi Rentals financial-rules bundle (14 markdown + 9 schema files, 13.5k+ lines) loaded into `financial-model/` as canonical reference. New `FINANCIAL_MODEL_REFERENCE.md` at repo root maps each Kiwi rule to SuitesForAll status (applies / partial / N/A by architecture). New «Financial-model gate» added to CLAUDE.md «Approval STILL required» — all financial code changes must check against the model before commit.
- **Context**: Tony 2026-05-11 evening: «перед тем как ты придёшь настройкам сайта я хочу тебе загрузить финансовую модель чтобы ты перед тем как выгружать анализировала все финансовые модели как они согласуются». Then sent the kiwi-financial-rules.zip.
- **Alternatives**:
  - Migrate SuitesForAll to Kiwi's full GL architecture immediately (rejected — multi-week schema overhaul; not in scope; Tony hasn't requested);
  - Treat Kiwi rules as "nice to have" reference only (rejected — Tony explicitly wants gate enforcement);
  - Apply selectively per-rule (chosen — § 2 mapping table marks each rule as applies/partial/N/A).
- **Consequences**:
  - Every financial code change in SuitesForAll now requires passing FINANCIAL_MODEL_REFERENCE.md § 6 pre-commit checklist.
  - QA_CHECKLIST.md «Editing financial logic» updated to call this gate.
  - 4 discrepancies logged in FINANCIAL_MODEL_REFERENCE.md § 7 (raw JS number for money math, overpayments not tracked as unapplied cash, pro-rate not wired, valuation defaults differ between hero/Investment Analysis).
  - Architectural gap documented in FINANCIAL_MODEL_REFERENCE.md § 4: SuitesForAll has no GL / period close / bank rec / 5-deposit-categories. Migration is Tony-decision not Claude-decision.
  - The 14 source markdown files + 9 TypeScript schema files in `financial-model/` are READ-ONLY references. Don't edit; refresh by re-importing a new bundle.
- **Tony decisions still pending** (now flagged):
  - DP-FM-1: Enforce 5-deposit-category model (Kiwi §SD5)? Schema change.
  - DP-FM-2: Track overpayments as unapplied cash (Kiwi §OP1)?
  - DP-FM-3: Migrate to GL architecture eventually? Multi-week work.
  - DP-FM-4: Switch all auto-billing flags default-OFF (Kiwi §FF1)?

### D-2026-05-11-PM2 · Project mode → BACK to auto-deploy + auto-push
- **Decision**: Re-enable auto-deploy + auto-push after every commit. Local-only maintenance mode (set earlier today as D-2026-05-11) is suspended.
- **Context**: Tony 2026-05-11 evening: «мне нужно чтобы все правки выгружались сразу онлайн чтобы выгрузка происходило автоматически». Local-only mode lasted only a few hours — was good for the docs-creation task itself but doesn't match Tony's iteration speed needs.
- **Alternatives**: Stay in local-only (rejected — operator wants speed); per-commit ask (rejected — already declined as «option A» on 2026-05-03 — «не запрашивай каждый раз»).
- **Consequences**:
  - Every commit → parse-check → release stamp → `firebase deploy --only hosting` → `git push origin <branch>` automatically.
  - The «Approval STILL required» list in CLAUDE.md still applies (schema / auth / payments / Functions / new deps / etc.).
  - Other docs (DEVELOPMENT_WORKFLOW, AUTOMATION_BOUNDARIES, LOCAL_SETUP, QA_CHECKLIST, etc.) still describe local-only mode as a CONDITIONAL state — those rules apply only when local-only is active. Active mode source of truth = CLAUDE.md § Project Mode (active).

### D-2026-05-11 · Project mode → local-only maintenance (SUPERSEDED by D-2026-05-11-PM2 same day)
- **Decision**: Suspend auto-deploy + auto-push. Document local-only operating mode via 17-file PM package.
- **Context**: Tony explicitly asked for a conservative maintenance setup; the project is "completed" and shouldn't be touching production unsupervised.
- **Alternatives**: Stay in legacy auto-deploy mode; add a per-deploy approval gate but keep auto-push; do nothing.
- **Consequences**: 
  - Claude commits locally, doesn't deploy or push without explicit per-action approval.
  - All external service config is frozen.
  - Documentation surface area grows substantially (17 new files).
  - Faster iteration speed lost; safety + auditability gained.

### D-2026-05-11 · Activity pill scope = active building, criterion = leaseStart
- **Decision**: Top-bar "N new leases +$X/mo" pill scopes to active building AND uses `leaseStart` (not `depositPaidAt`) for inclusion.
- **Context**: Operator screenshot showed Suite 101 (long-time tenant) lighting up the pill because its deposit was just recorded.
- **Alternatives**: Keep deposit-paid criterion (rejected: triggers on data entry not real signing); pill scope all-buildings (rejected: contradicts top-bar source-of-truth model).
- **Consequences**: Pill counts ONLY truly new leases this month. (See DECISIONS.md § 3 «Activity pill».)

### D-2026-05-11 · Financial Analytics tab is admin-only
- **Decision**: New `canSeeFinanceAnalytics()` permission, returns `currentRole() === 'admin'`. Investment Analysis + Revenue Forecast (incl. Potential Value KPI) gated to admins only via JS + CSS.
- **Context**: Tony: "давать доступ только админу. Менеджеры не должны иметь доступ".
- **Alternatives**: Manager also sees (rejected per operator request); make toggleable per-user (rejected: complexity not warranted).
- **Consequences**: Managers see operational forecast (12-mo total / avg / max potential / utilization) but NOT building valuation or BRRRR underwriting. (See DECISIONS.md § 2 «Roles matrix».)

### D-2026-05-11 · Building filter scope is hard-clamped to active building
- **Decision**: All 10 building-scoped surfaces (Rent Roll / Aging / Vacancy / Calendar / Recovery / DocuSign / Auto-billing / Pipeline / Leases / Payments) hard-filter via `_matchesActiveBuilding()` predicate AND lock UI dropdowns to single-only where applicable.
- **Context**: Operator: "вся информация во всех таблицах должна показываться по конкретному дому". Single source of truth = top-bar pick.
- **Alternatives**: Default-only (rejected: stale UI selections leaked through); per-tab opt-out (rejected: violates simplicity).
- **Consequences**: No path to view cross-building data without switching top-bar. Stacking + Commissions remain intentional exceptions. (See DECISIONS.md § 4 «Building filter scope».)

### D-2026-05-11 · Waiver date range with pro-rate helper (helper only — wiring deferred)
- **Decision**: Capture `waiverStart` + `waiverEnd` on payment record. Expose `_unitProrationCredit(u, ym)` helper. Defer wiring into invoice generation paths.
- **Context**: Operator: "если бесплатный месяц с 12 мая по 12 июня то за июнь месяц счёт должен быть про Rated."
- **Alternatives**: Auto-wire pro-rate in same commit (rejected: requires audit-pass of all rent-calc callsites; risky to bundle); operator-only manual prorate (still possible — pro-rate is currently a preview only).
- **Consequences**: Helper available for future wiring; operator must manually adjust spillover-month invoices for now. Tracked as KNOWN_ISSUES.md #1. (See DECISIONS.md § 3 «Waiver pro-rate credit».)

### D-2026-05-11 · Building Valuation defaults: 7%/35% for full underwriting, 9%/35% for Forecast hero
- **Decision**: Two different cap rate defaults:
  - Investment Analysis quick-estimate / seed: **7% cap, 5% vacancy, 35% opex** (industry-typical for US commercial office)
  - Forecast hero «Potential Value» card: **9% cap, 0% vacancy (proforma 100% leased), 35% expenses** (operator-chosen conservative ceiling)
- **Context**: Operator wanted both — a conservative sanity-check on the Home page, AND a configurable underwriting record on the analytics tab.
- **Alternatives**: Single cap rate (rejected: different purposes); per-building configurable everywhere (rejected: too many sliders for a quick-glance card).
- **Consequences**: Two visible figures may differ for the same building (e.g. $8.88M vs $10.85M). Documented in DECISIONS.md § 3 to prevent confusion.

### D-2026-05-11 · `_labelFontFor` defensive guards (Infinity prevention)
- **Decision**: 2-layer guard in `_labelFontFor`: zoom denom must be > 0 + result must pass `Number.isFinite` check, clamped to `[0.5, 1000]`.
- **Context**: Latent bug surfaced 2026-05-11 — `svg.getBoundingClientRect().width = 0` during initial render → font = Infinity → `setAttribute('dy', Infinity)` → silent SVG `DOMException` → `renderUnits()` aborted mid-loop → units after the failure had no event listeners → operator saw "не нажимаются юниты".
- **Alternatives**: Lazy-init the SVG sizing (rejected: bigger refactor); skip render until measured (rejected: race-prone).
- **Consequences**: Latent crash class neutralized. Documented in DECISIONS.md § 6 «Latent bugs / pitfalls». **Don't regress this guard.**

### D-2026-05-10 · Per-building separation rolled out
- **Decision**: Default building filter to active building across 10 surfaces (commit `9d3dbac`); later upgraded to hard-separation (commit `43c2d20`).
- **Context**: Operator wanted top-bar pick to drive every table.
- **Alternatives**: Per-tab default only (initial attempt — superseded by hard-clamp).
- **Consequences**: Eliminated cross-building data leakage. (See DECISIONS.md § 4.)

### D-2026-05-10 · PASS 2 walls unified (perimeter + internal use same dark slate)
- **Decision**: All wall edges in PASS 2 use the same `#475569 width 2 round-cap` style. Lost the "thick perimeter / thin internal" hierarchy.
- **Context**: Operator: "приведи всё к единому виду".
- **Alternatives**: Restore hierarchy (rejected per operator request).
- **Consequences**: CAD-uniform look across all units. If hierarchy ever wanted back, restore is one-line in `renderUnits()` PASS 2. (See DECISIONS.md § 4 «Unit border styling».)

### D-2026-05-10 · Avg rent uses effective rent (contract for occupied + proforma for vacant)
- **Decision**: Window / Interior / Average $/ft²/yr cards switched from `u.rent × 12` (proforma-only) to `effectiveRent × 12` (contract for occupied, proforma for vacant). Average derived from `(window + interior) / sqft`.
- **Context**: Operator: "эти цифры должны пересчитываться в зависимости от проформы и реальной аренды".
- **Alternatives**: Show both (rejected: visual clutter); leave proforma-only (rejected: misleading).
- **Consequences**: Three cards always math-consistent (Average is the sqft-weighted blend). (See DECISIONS.md § 3 «Effective rent».)

### D-2026-05-10 · «123» label-drag tool added to bottom toolbar
- **Decision**: New tool mode `label`, hotkey `L`, adds free-form positioning for unit labels via `u.labelDX` / `u.labelDY` fields.
- **Context**: Operator: "хочу двигать название юнита куда хочу но в пределах юнита плюс небольшой отступ снаружи".
- **Alternatives**: 9-position picker only (already existed; operator wanted free-form too).
- **Consequences**: New BC-friendly fields. Hit-rect tightly bounds digits (after operator iteration). Snap to neighbor labels via existing `drawSnapGuides`. (See DECISIONS.md § 4 «Label drag tool».)

### D-2026-05-10 · Pan tool default
- **Decision**: Default mode on app boot = `pan` (instead of `select`).
- **Context**: Operator's most common action is panning the canvas, not selecting.
- **Alternatives**: Keep `select` default.
- **Consequences**: Required gate update to allow unit click in `pan + edit` mode. Click + drag of unit body still works (handler routes through `onUnitPointerDown` for pan-mode-with-edit too).

### D-2026-05-10 · Vacant rect borders rely on PASS 2 (no own setAttribute)
- **Decision**: Removed `if (isVacantLease) { setAttribute('stroke', '#D6D2CA') }` branch. Vacant rect uses `stroke: none` like occupied rect; PASS 2 paints the borders.
- **Context**: The setAttribute was losing CSS specificity battle to `.unit-rect { stroke: #E8E5DF }`, leaving vacant units with pale borders + double-stroke at corners.
- **Alternatives**: Use inline `style` for vacant (rejected: redundant with PASS 2 walls).
- **Consequences**: Vacancy distinguished by FILL color, not stroke. (See DECISIONS.md § 6 «CSS specificity beats setAttribute on .unit-rect».)

### D-2026-05-10 · Cloud-sync recovery banner inline buttons
- **Decision**: Add `↑ Force push` and `↓ Pull cloud` action buttons directly on the red `#syncBanner` (instead of buried in Settings → Firebase).
- **Context**: After a real conflict, operator was stuck — auto-retry didn't help and the recovery path was 3 menus deep.
- **Alternatives**: Auto-resolve (rejected: data loss risk); status quo (rejected: blocks operator).
- **Consequences**: Operator has 1-click recovery for 99% of conflict scenarios. Both buttons are destructive in opposite directions — confirm dialog warns. Force push function = `fbForceResync()`.

### D-2026-05-10 · Polygon stroke matches rect perimeter (uniform appearance)
- **Decision**: Polygon units get inline `style="stroke: #475569; stroke-width: 2"` to match the dark slate perimeter that PASS 2 paints around rect units.
- **Context**: Operator: "приведи всё к единому виду" — wanted polygons and rects to look consistent.
- **Alternatives**: Lighter polygon stroke (rejected: too subtle); skip polygon styling (rejected: looked broken).
- **Consequences**: Rect + polygon visually equivalent. Inline `style` (not `setAttribute`) needed to win CSS specificity. (See D-2026-05-10 «Vacant rect borders» entry — same root cause.)

### D-2026-05-10 · Building NAME as primary label (not address)
- **Decision**: Show `b.name` everywhere as primary label; address only on hover / details.
- **Context**: Operator preference; addresses are long, names are scannable.
- **Consequences**: All building dropdowns / cards / breadcrumbs use name. Address still searchable + visible in detail panels.

### D-2026-05-10 · Multi-suite leases collapse to one set everywhere
- **Decision**: For grouped units (`u.groupId` set), invoices / overdue counts / payments show as ONE per group (head suite), not per-member.
- **Context**: From MEMORY.md → `feedback_grouped_suites_one_lease.md`. Operator's mental model: "this is one tenant on one contract".
- **Implementation**: `_isFinanceShadow(u)` returns true for non-head members; finance code skips them.
- **Consequences**: Finance tables show 1 row per multi-suite lease. Per-suite breakdown lives in tenant-group banner only.

### D-2026-05-10 · «Unit price» toggle removed from Layers panel (UI confusion)
- **Decision**: Remove the toggle from UI; headline `$X/mo` always renders. State key `state.settings.showUnitPrice` + `toggleUnitPrice()` function preserved for back-compat.
- **Context**: Operator turned off the toggle thinking it would hide map prices (it controls ONLY the right-panel headline). Repeat confusion across multiple sessions.
- **Alternatives**: Rename + keep (rejected: still ambiguous); make it a single dual-purpose toggle (rejected: feature creep).
- **Consequences**: One fewer ambiguous control. Map-price visibility uses dedicated `Show price (on map)` toggle only.

---

## Decisions still pending (Tony decision needed)

These are flagged in KNOWN_ISSUES.md but not resolved:

- **DP-1**: Should `_unitProrationCredit` auto-apply at invoice-generation time, or stay operator-controlled? (KNOWN_ISSUES.md #1)
- **DP-2**: Should `mode` persist across page reload via `state.ui.mode`? (KNOWN_ISSUES.md #5)
- **DP-3**: Restore PASS 2 wall hierarchy (perimeter thick / internal thin) or keep uniform? (KNOWN_ISSUES.md #6)
- **DP-4**: Re-enable auto-deploy mode? (Currently SUSPENDED per local-only mode switch.)

---

## How to add a decision

Whenever a non-trivial decision is made (formula change, UX convention, new role, new field, deprecation):

1. Add an entry above with date + commit hash + decision + context + alternatives + consequences
2. Update DECISIONS.md if the decision changes a topical reference (terminology / formula / convention)
3. Reference this entry in commit message (`per D-YYYY-MM-DD entry in DECISION_LOG.md`)
4. If the decision changes user-facing behavior, also note in CHANGELOG.md
5. If the decision was difficult (multiple Tony Q&A turns), include those Q&A in the Context section
