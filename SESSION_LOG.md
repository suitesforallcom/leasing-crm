# SESSION LOG — chronological shipping log

> One line per shipped feature/fix. Date + commit hash + 1-sentence summary.
> Read the **tail** for recent context. Read the whole file when in doubt about precedence.
> ⚠️ = bug fix or breaking-impact item · 🆕 = new feature · 🔧 = refactor / polish · 📌 = open / TODO

Format:
```
## YYYY-MM-DD
- ICON `commit-hash` Short title (≤ 70 chars).
```

---

## 📌 Open items (not yet shipped)

- 📌 **Wire `_unitProrationCredit` into invoice generation paths.** Helper exists (commit `68b7687`) and computes the per-month credit fraction from waiver records. Downstream codepaths (runAutoInvoices, manual invoice creation, Stripe sync, A/R Aging calc) still bill full rent — operator's «June 12 spillover should pro-rate June invoice» NOT yet automatic. Pending audit-pass to find all rent-calc callsites and apply `× (1 - credit)` consistently.
- 📌 **Investment Analysis sub-tabs not visually verified.** Hold / Sensitivity / Compare / AI sub-tab markup exists (`_investBuild*HTML`) but operator only saw Overview during today's testing. AI tab uses rule-based heuristics (no LLM) — should work but unconfirmed by operator.
- 📌 **Stripe duplicate void.** Wilbur Brown Jr's $104 duplicate invoice (`in_1TUVW22nq2bZh3q6XdFAu7Wp`) — operator never confirmed void from earlier session. Carried over from 2026-05-09 work.

---

## 2026-05-11

### Mode switch (evening)
- 🔧 `93b3a26` Created 20-file local-only PM operating package (CLAUDE.md mode switched → local-only).
- 🔧 `6552bcf` Re-enabled auto-deploy + auto-push mode per operator request («все правки выгружались сразу онлайн»). Local-only suspended; section preserved in CLAUDE.md as «Alternative Mode (currently inactive)». See DECISION_LOG.md D-2026-05-11-PM2.
- 🔧 _(this commit)_ Loaded canonical Kiwi Rentals financial model (14 markdown + 9 schema files) into `financial-model/`. Created FINANCIAL_MODEL_REFERENCE.md with applicability map (Kiwi rules vs SuitesForAll status). New «Financial-model gate» in CLAUDE.md — all financial code changes now require passing the gate. See DECISION_LOG.md D-2026-05-12-FM1. Logged 4 known discrepancies + 4 pending decisions (DP-FM-1..4).

### Critical incident — units stopped clicking
- ⚠️ `035de45` **`_labelFontFor` Infinity → tspan dy SVG parser crash.** Latent bug surfaced when `svg.getBoundingClientRect().width` returned 0 during initial render — `font = 17/0 = Infinity` → `setAttribute('dy', Infinity)` → silent SVG DOMException → `renderUnits()` aborted mid-loop → units after the failure had no event listeners → operator saw «не нажимаются юниты» across the floor. Found via Playwright `console.errors` (Sentry doesn't catch DOM exceptions). Fix: zoom-denom guard + `Number.isFinite` check + clamp to `[0.5, 1000]`.
- ⚠️ `1dc9533` Emergency rollback to `c633834` while diagnosing (later un-needed; the cherry-picks below restored everything).
- ⚠️ `6feed75` Allow unit click in `pan View Mode` + `label+edit` (was rejected by `onUnitPointerDown` gate).

### Building filter scope (re-add after rollback)
- 🆕 `0ba0c9c` All building-scoped tables default to active building (10 surfaces).
- 🆕 `7bc9ac4` Full per-building hard separation — UI lockdown + `_matchesActiveBuilding` data-layer clamp.

### Financial Analytics tab
- 🆕 `e3b0771` New admin-only «Fin. analytics» tab in left rail. Investment Analysis section moved out of Home into `#financeAnalyticsView`. CSS `body:not(.role-admin) #railFin { display: none }` hides for non-admins.
- 🔧 `c3274b9` Revenue Forecast section ALSO moved into Financial Analytics (above Investment Analysis). switchBuilding explicit-renders both when on FA view.
- 🆕 `590dbde` POTENTIAL VALUE card on Forecast hero @ 9% cap · 35% expenses (5th column).
- 🆕 `fa18281` Smart auto-seed for Investment record + inline quick valuation in empty state (4 cards: GPR / EGI / NOI / Building Value).
- 🔧 `96e8c5a` Fixed misleading «Phase A · v1» badge — all 6 sub-tabs are shipped (Overview / Cash Flow / Hold / Sensitivity / Compare / AI).

### Activity pill (top-bar)
- 🆕 `b4024ce` Window switched from rolling 30 days → month-to-date (since 1st of current month).
- 🔧 `c7956af` Inclusion criterion switched from `depositPaidAt` → `leaseStart` AND scope clamped to active building. Excludes legacy tenants whose deposit was just recorded.

### Waiver / free month
- 🆕 `68b7687` Date range picker (Start + End) when method=waived. Defaults to 1st of ym → +1 mo. Live coverage breakdown shows per-month days waived / billable. Helper `_unitProrationCredit(u, ym)` exposed (NOT yet wired into invoice generation — see Open items).

### Blueprint upload
- 🆕 `90a344d` Confirm prompt after PDF/PNG/JPG upload: «Floor outline missing — trace now?» Skipped if outline already exists or source is DXF.
- 🔧 `45e27fb` `calibrate-area` error message rewritten to redirect operator to `floor-outline` tool when they confuse the two. Threshold lowered 10→5 px so a near-zero accidental click still triggers the helpful message. Help bubble for calibrate-area mode adds disambiguation hint.

### UX polish
- 🔧 `0baca69` `.snap-popover` gets `max-height: calc(100vh - 120px)` + `overflow-y: auto` so the Floor area popover (Outline / Capacity / Geometry / Lease template) scrolls inside on shorter viewports — operator complaint «окно меню целиком не видно».

---

## 2026-05-10

### Stats / valuation
- 🆕 `b9cc4d5` Floor area panel: % of total alongside Useful / Other / Unaccounted.
- 🆕 `526196e` Avg rent cards (Window / Interior / Average) switched from proforma-only to **effective** rent (contractRent for occupied, u.rent for vacant). Average derived directly from window+interior buckets — single source of truth.

### Building filter (initial roll-out, then rolled back, then re-added 2026-05-11)
- 🆕 `9d3dbac` Defaults to active building across 10 surfaces.
- 🆕 `43c2d20` Full per-building separation (UI lockdown + data-layer clamp).
- ⚠️ Both reverted in `1dc9533` 2026-05-11 during the units-don't-click incident, then cherry-picked back as `0ba0c9c` and `7bc9ac4` after root cause was found in `_labelFontFor`.

### Layers panel UX
- 🔧 `3a3ef37` Added «(on map)» suffix to LAYER VISIBILITY toggles + section rename «Unit panel» → «Side panel» + hint line «Affects only the unit details panel on the right».
- 🔧 `1a5463d` Removed «Unit price ($/mo)» toggle from UI — was hiding the headline rent and confusing operator. Headline now always renders.

### Sync recovery
- 🆕 `97b0dbf` Inline `↑ Force push` + `↓ Pull cloud` buttons on the cloud-sync error banner. New `fbForceResync()` adopts cloud rev as new base then pushes local.

### Label drag («123» tool)
- 🆕 `229ba6d` Initial label-drag tool — free-form positioning, hotkey L.
- 🆕 `fdd6893` Extended to common-area labels (Office / Mech / Restroom / etc).
- 🔧 `6d962d3` Selected unit highlights when moving its label.
- 🔧 `89b5474` Hit-rect tightly bounds suite-number digits (sized off `_labelFontFor`).
- 🆕 `2a24e07` Alignment snap + green guide lines vs neighbor labels (Figma-style).
- 🔧 `307a760` Allowed unit click in `label+edit` mode (operator complaint «не могу нажать на Unit»).

### Unit borders unification
- 🔧 `8adf037` Polygon stroke matches rect perimeter (dark `#475569` width 2).
- 🔧 `ed7b0dc` Polygon + rotated stroke wins over `vacant-lease` setAttribute branch (was being overridden by CSS `.unit-rect` rule).
- 🔧 `4062290` Vacant rect borders match occupied (no double-stroke from setAttribute losing to CSS).
- 🔧 `be051f3` PASS 2 internal walls unified with perimeter style — single dark `#475569` width 2 for ALL unit edges. Operator: «приведи всё к единому виду».

### Unit labels
- 🆕 `b0548c5` 9-position label-position picker + bulk-apply via Shift-select.
- 🔧 `33a9bda` Polygon labels default to top-left like rect (was centroid → operator wanted unified).

### Map editor polish
- 🆕 `978d6f8` Pan tool default instead of select (operator request).
- 🔧 `e84ed0a` Unit drag works in pan mode + Edit Mode (was blocked, click went to canvas pan handler).
- 🆕 `9a3fd65` Cyan snap-dots visible during unit drag (corner-snap discoverability).
- 🔧 `b988083` Rect drag handles zoom-aware (were 10×10 fixed user-units, ballooned at low zoom).
- 🔧 `afaf4a8` Preserve operator's pan/zoom when switching tools (no auto-fit).
- 🔧 `70f400b` + `5be746a` Universal `vector-effect: non-scaling-stroke` so lines stay thin at high zoom.
- 🔧 `711f5e3` Unit labels stay constant screen-px + cap by unit size.
- 🔧 `4db6239` Two discrete label sizes (normal + 65% small for tight units) — no continuous interpolation.
- 🔧 `1616bcf` Unify rect / polygon selection outline (no inflation, thinner).
- 🔧 `c610436` Smaller corner / vertex / handle dots.
- 🔧 `6d4057c` Preserve view after polygon commit (renderBg no-fit on re-render).

### Files tab + buildings
- 🆕 `06c98ab` New «Files» tab in Building modal — aggregator across all building files.
- 🆕 `550c1b1` Folders in Files tab — create / rename / delete / move.
- 🔧 `6b8edcd` Auto-folders by category + fixed All-chip count casing bug.
- 🆕 `e585bce` Auto-bootstrap new buildings — Edit mode + upload prompt.
- 🔧 `697d26b` Show building NAME (not address) as primary label everywhere.

---

## How to update this file

After every shipped commit (or batch of related commits):
1. Add a one-liner under today's date with `commit-hash` and 1-sentence summary
2. Mark with `🆕 / 🔧 / ⚠️ / 📌`
3. If it un-completed an earlier `📌 Open item`, remove or update that line
4. If it's a critical fix worth remembering, also add to `DECISIONS.md` § 6 (latent bugs)

Keep entries SHORT. Full reasoning lives in commit messages and code comments. This file is the index.
