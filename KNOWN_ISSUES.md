# KNOWN_ISSUES.md

> Open problems / latent bugs / partially-shipped features. Cross-references SESSION_LOG.md "Open items" section.
>
> **Updated 2026-05-11.**

## How to read this file

| Severity | Meaning |
|---|---|
| 🔴 **CRITICAL** | Affects money / data integrity / auth. Operator should know before using affected feature. |
| 🟡 **MEDIUM** | Visible UX bug or partially-shipped feature. Workaround exists. |
| 🔵 **LOW** | Cosmetic / discoverability / docs gap. |

| Status | Meaning |
|---|---|
| 📌 OPEN | Known, not started |
| 🔧 IN PROGRESS | Started, not finished |
| ⚠️ PROD ISSUE | Currently affecting live users |
| ✅ FIXED (with date) | Resolved — keep entry until next quarter |

---

## 🔴 CRITICAL

### #1. `_unitProrationCredit` not wired into invoice generation 📌 OPEN
**Severity**: 🔴 — affects real billing.
**Where**: `floor-map-editor.html` `_unitProrationCredit(u, ym)` helper exists (commit `68b7687` 2026-05-11), but downstream invoice-generation paths (`runAutoInvoices`, manual invoice creation, Stripe sync, A/R Aging calc) still bill full rent regardless of waiver date range.
**Operator impact**: a "free month" recorded as e.g. May 12 → June 12 will:
  - ✅ Mark May as `status='free'` (full month free)
  - ❌ NOT auto-prorate June's invoice — operator must manually adjust if they want to bill only 18 days
**Workaround**: operator manually creates partial invoice for the spillover month after seeing the "Quick estimate" panel preview.
**Fix path**: audit all rent-calc callsites, apply `× (1 - _unitProrationCredit(u, ym))` consistently. Estimated 30-60 min audit + 4-6 callsite edits + test.
**Tony decision needed**: confirm wiring should be auto-applied (vs operator-controlled per-invoice).

### #2. Stripe duplicate invoice for Wilbur Brown Jr 📌 OPEN
**Severity**: 🔴 — real money implication.
**Issue**: Wilbur Brown Jr has a duplicate $104 late-fee invoice in Stripe (`in_1TUVW22nq2bZh3q6XdFAu7Wp`). Carried over from earlier session — Tony was asked to confirm void but never did.
**Workaround**: invoice still pending; no double-charge yet (tenant hasn't paid). Operator can void via Stripe Dashboard.
**Fix path**: Tony confirms void. Claude must NOT void Stripe invoices autonomously.
**Tony decision needed**: confirm void.

### #11. Monolithic state doc ~841KB — Firestore 1MB ceiling + write contention ⚠️ ARCHITECTURE CEILING
**Severity**: 🔴 — the whole workspace lives in ONE Firestore doc `workspaces/default/data/state`. Two walls: (1) hard 1MB/doc limit — ~841KB now (82%); was 927KB before the 2026-05-31 phantom cleanup. `fbPushNow` refuses writes >950KB (floor-map-editor.html:31158), warns >900KB (:31167); Synced-state-size panel mirrors thresholds at :55968. (2) Every edit rewrites the whole doc under an optimistic lock → write-contention / version-conflict banner-storm as operators grow.
**Status**: actively addressed by the **SCALING initiative** (document-per-entity decomposition). NOT halted — this is the sanctioned forward path. Active source of truth: [`SCALING_PLAN_v2.md`](SCALING_PLAN_v2.md) (full plan, safety rules, phase status). Earlier draft: [`SCALING_PLAN.md`](SCALING_PLAN.md) (v1, superseded).
**Where it stands (2026-05-30)**: v1 extracted payments into a `payments/{unitId__ym}` collection — Phase 0 + Phase 1 slices 1/2/5/6a shipped & live-validated, then caused TWO live data-loss incidents: (a) diff-on-push strip mass-deleted all 1277 payment docs ×2 (race — stripped monolith loaded before overlay rehydrated → diff read empty → "delete all"); (b) building-agnostic key `unitId__ym` leaked b1 payments onto same-numbered suites in other buildings → 575 phantom docs → 898KB. v1 rolled back. v2 rewrite (building-aware keys `buildingId__unitId__ym`, NEVER delete-by-diff, pointed DAO writes, **test-workspace-first**) is PLANNED, not yet implemented.
**Current runtime (2026-05-31)**: monolith mode, `settings.syncV2 = false`; payments strip hard-disabled (`_fbPaymentsCutover`). The v1 cross-building phantoms **RECURRED** — the read-overlay kept running in any session with the leftover `localStorage['sfa_payments_read_v2']='1'` flag, re-painting b1 payments onto same-numbered suites every load → state climbed back to 927KB. **Fixed**: `paymentsReadV2()` hard-disabled (always returns false, commit 459064d) + `loadPaymentsData` b1-guarded (31f4d98) → regeneration stopped; `sfaCleanCrossBuildingPhantoms()` (commit bf9b164, dry-run-default + backup) removed the 575 residual phantoms → payDocs 1853→1278, v1 collisions 519→0, state 927→841KB; b1's 1277 payments intact. Diagnostics: `sfaScaleV2Audit()` / `sfaSyncStats()`. Banner-storm mitigated by backoff (independent of migration).
**Not to be confused with**: the work HALTED 2026-05-29 was the *old* in-monolith payment-archive/compaction — a different, abandoned approach that broke data by compressing inside the same doc. The scaling decomposition supersedes it and (per v2 safety rules) does not repeat that mistake.
**Approval-gated for v2 impl** (each a separate ask): `firestore.rules` · `firestore.indexes.json` · `functions/index.js` · `state.*` schema.

---

## 🟡 MEDIUM

### #3. Investment Analysis sub-tabs not visually verified by operator 📌 OPEN
**Severity**: 🟡 — feature ships but Hold / Sensitivity / Compare / AI tabs untested in operator's actual workflow.
**Where**: `floor-map-editor.html` — `_investBuildHoldHTML`, `_investBuildSensitivityHTML`, `_investBuildCompareHTML`, `_investBuildAIHTML` exist and the tab bar renders all 6.
**Status**: Overview + quick-estimate cards confirmed working 2026-05-11. Other sub-tabs unknown — render functions exist but visual verification pending.
**Workaround**: open Financial Analytics → click each tab → report what's broken.
**Fix path**: operator does a manual smoke test of each sub-tab; bugs filed as separate issues.

### #4. Cloud sync `_rev` gap caused mass conflict 2026-05-11 ✅ INVESTIGATED 2026-05-12
**Severity**: 🟡 → 🔵 (downgraded — recovery UX adequate; defensive telemetry added).
**Issue (historical)**: at one point during 2026-05-11 session, local `_rev` = `1778437195567912`, cloud `_rev` = `1778437263991457` — gap of 68M revs. Auto-retry couldn't bridge. Operator used new "↑ Force push" recovery button (added that day in `97b0dbf`).
**Investigation (2026-05-12)**:
  - Decoded gap: `1778437195567912` ÷ 1000 ≈ `2026-05-10 18:19:55 UTC` (microsecond timestamp). Both values are timestamps, not counters. Gap = 68 seconds × 1000 = 68M units.
  - Audited current code: `mutateWorkspaceState` in `functions/index.js` and `fbPushPatch` in `floor-map-editor.html` both bump `_rev` by exactly `+1`. NO `Date.now() * 1000` injection found in current codebase.
  - Conclusion: poisoned `_rev` was set by an earlier code revision (now removed) OR by an external process (manual Firestore edit / one-off migration script). Source is no longer reachable from current code paths.
**Mitigation (2026-05-12)**: added defensive telemetry in `fbApplyRemote` — if cloud `_rev > 1e12` we now log a console warning + send Sentry breadcrumb (`cloud_sync._rev_poisoned`). Recovery via «↑ Force push» banner button is unchanged and known to work.
**Status**: closed pending fresh recurrence. If telemetry fires in production, treat as a new issue with the breadcrumb metadata as evidence.

### #5. `mode='label'` doesn't persist across page reload 🔵 (intentional?) but could surprise
**Severity**: 🔵 — but could be 🟡 depending on operator preference.
**Issue**: After Cmd+Shift+R, `mode` resets to `pan` (default per `let mode = 'pan'`). Operator's last-used tool is forgotten.
**Operator impact**: if operator was using «123» label-drag tool before refresh, they need to re-click it after.
**Tony decision**: should `mode` persist via `state.ui.mode`? If yes, ~5 min change.

### #6. PASS 2 internal walls now uniform with perimeter (legacy «building outline thick / divisions thin» lost) 🟡
**Severity**: 🟡 — design tradeoff, deliberate.
**Issue**: Operator asked «приведи всё к единому виду» 2026-05-10 → all walls now `#475569` width 2 round-cap. Lost the visual hierarchy where building outline was thicker than internal divisions.
**Workaround**: if Tony wants hierarchy back, restore the two-style render in `floor-map-editor.html` PASS 2 (was: perimeter `#475569 width 2`, internal `#94a3b8 width 1.2`).
**Tony decision**: keep uniform OR restore hierarchy.

---

## 🔵 LOW

### #7. Activity pill window shows last calendar month if today is the 1st ✅ FIXED 2026-05-12
**Severity**: 🔵 → resolved.
**Issue (historical)**: cutoff = `new Date(today.getFullYear(), today.getMonth(), 1).getTime()`. If today was the 1st, the window was from today to today (~0 hours). Operator saw 0 leases even though they may have signed yesterday.
**Fix**: `_compute30DayActivity` now detects `_today.getDate() === 1` and falls back to a rolling 7-day window. Pill title + popover eyebrow show «Last 7 days · rolling (1st of month — month-to-date is empty by definition)» on that day so the operator understands why the label changed. New return field: `windowKind: 'mtd' | '7d-fallback'`.

### #8. No "Fit to Screen" button in bottom toolbar ✅ FIXED 2026-05-12
**Severity**: 🔵 — discoverability.
**Issue**: operator sometimes couldn't see all units (zoomed in too far). No dedicated button to reset view.
**Fix**: added Fit-to-Screen icon-btn between Delete and Snap settings in `bottomToolbar`, calling `sfaFitToContent()`. Standard 4-corner-bracket icon ([fit-to-content convention]). No keyboard shortcut wired (consistent with other tool-buttons whose title-attr shortcuts are aspirational).

### #9. Common-area label rotated drag (vertical text in elevator shafts) untested 🔵
**Severity**: 🔵 — edge case.
**Issue**: When `setMode('label')` and unit has a vertical-rotated label (narrow vertical column like elevator), the hit-rect is computed for rotated bbox. Logic exists in code (commit `fdd6893`) but not visually verified by operator.
**Fix path**: operator tests with an elevator-shaft unit; report any visual issue.

### #10. Missing «Pending push to GitHub» tracking in local-only mode 🔵
**Severity**: 🔵 — process.
**Issue**: in current local-only mode, commits land locally but don't push. There's no canonical list of "what's pending push when Tony re-enables".
**Workaround**: `git log origin/<branch>..HEAD` shows unpushed commits. SESSION_LOG.md captures shipping intent but not push state.
**Fix path**: when local-only mode activated 2026-05-11, all commits up through `5d01adc` were already pushed. Future commits will pile up. Tony decides when to manually push.

### #12. «N units on wrong floors — auto-fixing» recurs every load (benign false-positive) 🔵 INVESTIGATED 2026-05-31
**Severity**: 🔵 — misleading console log only; verified NO data churn.
**Symptom**: `[init] Detected ~109 units on wrong floors — auto-fixing` on every load (count drifts 108–110).
**Root cause**: the init detection loop (floor-map-editor.html `ensureRealDataSeeded`, ~:145454) scans **ALL buildings**, counting units whose suite-hundreds ≠ floor.number (`Math.floor(sn/100) !== f.number`). But the fix it triggers — `fixFloorAssignments(true)` (~:145324) — operates **only on `currentBuilding()`**. The mismatches live in NON-current buildings (Bay Vista / Crane Nest, whose suite numbering doesn't follow b1's hundreds=floor convention). The fix runs on b1, finds it clean → early-returns (~:145354) with no moves and no saveState. Nothing is relocated; the count recurs because detection over-counts buildings the fix never touches.
**Why NOT fixed**: this auto-heal path caused TWO prior data-loss incidents (phantom 20th floor 2026-04-30; phantom-units 2026-05-01). `fixFloorAssignments` creates floors + moves units by suite number — load-bearing + incident-prone. Silencing a cosmetic log isn't worth the regression risk.
**If ever fixed**: scope the init detection to the fix's scope (`currentBuilding`, or only buildings that follow the hundreds convention) so the false alarm stops — WITHOUT touching the unit-moving logic. Verify first with a read-only diagnostic listing flagged units per building (needs operator live data — non-b1 floor structure unknown).
**Possibly related**: the intermittent 525× `<g>/polygon/text` SVG NaN render errors (units with geometry not matching their floor) — separate confirmation needed.

---

## 🚧 RESOLVED but worth remembering (don't re-introduce)

### `_labelFontFor` Infinity → tspan dy SVG parser crash ✅ FIXED 2026-05-11
**Hash**: `035de45`.
**Symptom**: units stop being clickable; SVG console shows «Expected length, Infinity».
**Root cause**: `svg.getBoundingClientRect().width = 0` on initial render (container hidden) → zoom = 0 → font = Infinity → `setAttribute('dy', Infinity)` → silent SVG DOMException → `renderUnits()` aborts mid-loop → units after the failure get NO event listeners.
**Why Sentry didn't catch**: Sentry hooks `window.onerror`. SVG attribute rejection is a sync DOMException that doesn't bubble to onerror. Console-only.
**Defense in code**: 2-layer guard in `_labelFontFor` — check `_ru_rect.width > 0` AND `Number.isFinite(sizeUnits)`, clamp to `[0.5, 1000]`.
**Lesson**: any `setAttribute(...)` with non-finite numeric on SVG → silent crash. Always guard.

### Activity pill rolling 30d included old leases ✅ FIXED 2026-05-11 (`b4024ce`, `c7956af`)
**Symptom**: «43 new leases» showed Suite 101 (tenant since 2022) because deposit was just recorded.
**Root cause**: criterion was `depositPaidAt` not `leaseStart`.
**Fix**: switched to `leaseStart`; window switched to month-to-date; scope clamped to active building.

### Building filter changes caused mass-click breakage (FALSE alarm) ✅ ROLLED BACK + RE-APPLIED 2026-05-11
**Symptom**: assumed building-filter changes (`9d3dbac`, `43c2d20`) broke unit clicks. Rolled back via `1dc9533`. Click still broken.
**Real cause**: the `_labelFontFor` Infinity bug above. Building-filter changes were innocent — re-applied as `0ba0c9c` and `7bc9ac4` after root cause was confirmed.
**Lesson**: don't blame the most-recent change without proof. Check console errors first (Playwright `console.errors` is the fastest path).

### Vacant rect borders rendered with wrong color due to setAttribute losing to CSS ✅ FIXED 2026-05-10 (`ed7b0dc`, `4062290`, `be051f3`)
**Symptom**: 301/302/304 (vacant polygons) had invisible borders while 303/305 (occupied rects) had visible dark borders.
**Root cause**: `setAttribute('stroke', '#D6D2CA')` on `.unit-rect` element loses specificity to CSS rule `.unit-rect { stroke: #E8E5DF }`. Polygon's dark inline style was set inside an else branch that vacant-lease never hit.
**Fix**: reordered — polygon/rotated branches FIRST (always wins); vacant-lease branch removed entirely (PASS 2 walls handle it).
**Lesson**: in SVG with class-based CSS, presentation attributes lose specificity. Use inline `style` for forced overrides.

### Mass renderUnits() abort due to Infinity tspan (cluster fix) ✅ FIXED 2026-05-11
See top entry. Multiple symptoms (no clicks, no labels, frozen UI) traced to single cause.

---

## How to add new entries

When a bug is discovered:

1. Decide severity: 🔴 / 🟡 / 🔵
2. Add entry under appropriate section with:
   - **Where** (file + line / function name)
   - **Symptom** what operator sees
   - **Workaround** if any
   - **Fix path** what's needed to resolve
   - **Tony decision needed** if the fix requires a business call
3. Cross-link to `SESSION_LOG.md` open items section.
4. When fixed, move to "RESOLVED but worth remembering" with date + commit hash.

Don't let this file balloon — prune ✅ FIXED entries that are >1 quarter old to a separate `KNOWN_ISSUES_ARCHIVE.md` if needed.
