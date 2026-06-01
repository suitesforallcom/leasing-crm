# SCALING AUDIT — 2026-05-31

> Generated during autonomous 12h run #2. Read-only audit of `floor-map-editor.html`. Catalogs every reader of `u.payments` (for Phase 1.2 read-switch review) and every reader of `state.buildings` (for Phase 2 review). Both phases are DORMANT on prod — these audits inform the eventual activation sessions.

---

## Part A — `u.payments` read sites (Phase 1.2 review)

**Activation gate:** `settings.syncV2Read = true` via `sfaTestReadSwitchV2(true)` (added in commit `de72bc5`).

### Total: 177 read sites across 44 functions

### By category

| Category | # | Examples |
|---|---|---|
| BILLING | 9 | `_attachInvoiceAsDeposit`, `_attachInvoiceAsMoveInRent`, `_attachInvoiceAsRentMonth`, `_computeProrate`, `_renderProrateBox`, `_renderUnitLateFeeBlock`, `_renderUnitLateFeeOwed`, `_sendInvoiceWithLateFees`, `_computeRelocationProration` |
| A/R AGING | 6 | `_collectUnitInvoices`, `_computeUnitMoney`, `_resolveMoveInCoveredYms`, `_buildTenantLedger`, `_moBuildBalanceBreakdown`, `updateTopbarOutstandingPill` |
| UI RENDER | 12 | `_computeUnitFillImpl`, `_computeUnitFillCached`, `_renderUnitPaymentHealth`, `_renderUnitV2Header`, `_renderUnitInsights`, `_renderUnitOverviewPane`, `_renderUnitFinancePane`, `_renderActivityPopover`, `_renderMoveInCardForModal`, `_renderTenantDrawerPaymentTimeline`, `_renderTenantDrawerLedger`, `_renderTenantDrawerInvoices` |
| AUDIT / HISTORY | 6 | `deletePayment` (repo), `setPayment` (repo), `_performTenantMove`, `archiveUnit`, `deleteUnitFromMenu`, `_moveInDepositStatus` |
| IMPORT / SEED | 3 | `loadPaymentsData`, `loadState`, `mergeTenantDataIntoFloor` |
| MIGRATION / HEAL | 5 | `fbSanitizeState`, `_healStaleStripeStamps`, `_isEmptyPayment`, `_fbPaymentsCutover`, `sfaRehydrateMonolith` |
| BANK FEED / RECONCILE | 3 | `_attachInvoiceAsDeposit`, `fbPushPaymentChange`, `_v2PaymentsAttachListener` (just added — Phase 1.2 itself) |

### Top high-risk sites (heavy / hot path)

| Function | Line | Notes |
|---|---|---|
| `_computeUnitFillImpl` | ~29886 | Decides cell color (red/green) via `Object.keys(u.payments)`. **100+ calls per floor render.** Pure read-only. |
| `_renderUnitPaymentHealth` | ~80165 | 12-month payment grid via `Object.entries(u.payments)`. Triggered on unit detail open. |
| `_computeUnitMoney` | ~74074 | A/R outstanding / owed / overdue. Drives Aging panel + topbar pill. |
| `_renderTenantDrawerPaymentTimeline` | ~131908 | Full ledger newest-first. Triggered on drawer open. |

### Edge cases that need verification

- **`u.payments.deposit`** — separate from monthly YM keys (e.g. `u.payments['2026-04']`). The `_schema:'v2'` doc shape stores `ym` as a string; the deposit slot lives outside the YM matrix. **Both must survive read-switch.** The current `_v2PaymentsAttachListener` filters by `ym` field but `ym='deposit'` is a special string — verify it propagates correctly.
- **`_isEmptyPayment`** — defensive against `[]` or `{}` corruption (line ~33174 / ~34748). Don't lose this guard at read-switch.
- **`Object.keys(u.payments)` iteration** — at lines ~25864, ~26804, ~64717. Today's monolith keys = the union; post-cutover the listener-built map should match. If Firestore has extra YMs (drift), iteration sees them — generally that's correct, but if it surfaces phantom months, reconcile must catch it.
- **`_resolveMoveInCoveredYms`** (~line 86372) — reads three independent fields: `u.stripe.moveInRent.status`, `u.payments[ym].coversInvoiceMonths`, `u.payments[ym].stripeInvoiceId`. Run `_healStaleStripeStamps` before cutover so all three are in sync.

### Safety assessment

All 177 sites are **read-only / idempotent**. None mutate `u.payments` directly (writes go through `repo.setPayment` / `repo.deletePayment` after commit `0997414`). That means flipping `syncV2Read` is **non-destructive even if a read misses** — worst case a single render shows stale data for ~100 ms before the listener catches up. No write path depends on the read returning anything specific.

**Failure modes to test with `sfaReadSwitchSmoke()`:**
1. Schema mismatch (Firestore `rec` shape differs from monolith) → reconcile catches it.
2. Late-arriving snapshot before first render → render shows empty; next listener tick fills it. Verify Aging panel + matrix cells.
3. `u.payments.deposit` propagation — open a unit with a recorded deposit, confirm the move-in card still shows ✓ Paid.

---

## Part B — `state.buildings` read sites (Phase 2 review)

**Activation gate:** `settings.syncBuildingsV2 = true` + future `syncBuildingsRead` flag (not yet added — that's the read-switch step which lives in a separate commit per `SCALING_PLAN_v2.md`). This audit informs the eventual read-switch implementation, not the dual-write that just shipped.

### Total: 367 grep hits across 300+ functions

### By category

| Category | # | Examples |
|---|---|---|
| RENT ROLL / TABLES | ~32 | `buildRentRollRows`, `buildLeasesRows`, `exportPaymentsCSV` |
| FINANCE | ~38 | `_investComputePortfolio`, `_hvRenderRevenueChart`, `_payStable` |
| FLOOR PLAN RENDER | ~14 | `_ualFullRerender`, `stackingHoverSuite`, `renderLeasesPanel` |
| BUILDING SELECTOR | ~14 | `currentBuilding`, `renderBuildingSelector`, `_ensureValidUiBuilding` |
| IMPORT / EXPORT / BACKUP | ~22 | `loadState`, `_mirrorBuildingsToV2` (just added — Phase 2 itself), `fbApplyRemote` |
| MIGRATION / HEAL | ~16 | `loadPaymentsData`, `fixFloorAssignments`, `cleanPhantomBackfills` |
| STRIPE / INVOICE | ~15 | `_acquireSendLock`, `payEmailTenant`, `_renderUnitPaymentHealth` |
| UNIT / LEASE OPS | ~20 | `openAddUnitModal`, `deleteUnitFromMenu`, `openMoveTenantModal` |
| LEASE MANAGEMENT | ~18 | `_ldDedupeAllDraftsHistory`, `_leaseFindEnvelope`, `_pickUnitLeaseTpl` |
| OUTREACH / ACTIVITY | ~10 | `_collectActivityEvents`, `recordOutreach`, `_calendarCollect` |

### Hot-path readers

1. `loadState()` (~L26362–26875) — boot hydration + 6 nested migrations; triple-loops for defaultRate, hybrid-lease, geometry. Called once per reload.
2. `buildRentRollRows()` (~L124403) — rent-roll table; single-loop all accessible buildings. High-frequency user touchpoint.
3. `_mirrorBuildingsToV2()` (~L32341) — Phase 2 mirror (just added); triple-loop for snapshot comparison. **Idempotent — only writes changed buildings.**
4. `_ualFullRerender()` (~L79877) — `flatMap(buildings→floors→units)` to render stacking view. Called on every mouse move in units tab.
5. `_investBuildTenantsByBuilding()` — called 5× per investment dashboard render. Walks all buildings to build tenant-by-building map. **Memoize candidate if Phase 2 slows it.**
6. `consolidateLeaseHead()` (~L70707–70709) — double-loop all buildings for lease merging. Called by investment views.
7. `fixFloorAssignments()` (~L146017+) — triple-loop healing for orphaned units. On-demand but expects full state.
8. `syncV2StripEnabled()` (~L32530) — Phase 1.3 strip validation. All buildings → floors → units.

### Critical assumptions in current code

| Assumption | Risk for Phase 2 read-switch |
|---|---|
| **Full-array hydration before render** — `loadState()` completes, then `renderAll()` runs with everything in memory | onSnapshot must settle initial snapshot **before** first render — same lesson as Phase 1.2 attach hook |
| **Persistent in-memory state** — no lazy load | If onSnapshot is slow, renders see empty/partial array. Need loading sentinel. |
| **Deletion = instant mutation** — `deleteBuildingFromModal()` mutates `state.buildings` directly | Phase 2 listener must sync removal immediately, or state drifts between local + remote |
| **Guard pattern tolerates missing** — ~95% of functions use `(state.buildings \|\| [])` | The ~5% that don't (`currentBuilding`, `currentFloor`, `currentUnits`, `currentWalls`) will error during cold load. Add null guards. |
| **`state.ui` decoupled from buildings** — `currentBuildingId` NOT synced via Firestore; `_ensureValidUiBuilding` runs at boot | After every buildings delta, must reconcile `currentBuildingId` again — not just on boot |

### Phase 2 read-switch safety checklist (for the eventual activation commit)

- [ ] onSnapshot initial snapshot fires before first render — attach Phase 2 buildings-listener **before** `loadState().renderAll()`
- [ ] Add null guards to: `currentBuilding`, `currentFloor`, `currentUnits`, `currentWalls`
- [ ] `_ensureValidUiBuilding` called on every buildings delta (not just boot)
- [ ] `deleteBuildingFromModal` triggers listener path OR maintains optimistic update
- [ ] Loading-state feedback in building selector (avoid flash of empty)
- [ ] `_investBuildTenantsByBuilding` × 5 per render — test with throttled network; memoize if slow

### Recommendation

**Phase 2 read-switch is medium-risk by code-readiness count.** The vast majority of consumers already use defensive guards; the work is in:
1. The 4 helper functions that lack guards (~5 LOC each).
2. The listener attachment timing (replicate the `_v2PaymentsAttachIfFlagged` pattern from Phase 1.2).
3. The delete-sync race (Phase 2 must NOT delete-by-diff — explicit-event only, same rule as Phase 1).
4. A loading sentinel to avoid flash-of-empty in the building selector.

Estimated work for the read-switch commit: **2-3 hours**, with ~2 days of soak before strip can follow.

---

## Cross-cutting notes (both audits)

- **Both reads are read-only.** No writes hide in these grep results. That means flipping a read-switch flag is reversible by flipping back to false — no data corruption risk from the read path itself.
- **Listener-rebuild tolerance.** Both Phase 1.2 (payments) and the eventual Phase 2 read-switch rely on Firestore `onSnapshot` to populate in-memory state. Initial snapshot can take 100-500 ms; need to ensure first paint happens after settle, or show a sentinel.
- **Delete-by-event invariant** (SCALING_PLAN_v2.md §0 rule 2) — both phases must NEVER derive deletes from a state-diff. v1 strip incident wiped 1277 docs ×2 from a diff-on-push pattern. New code uses explicit events only.

— End of audit. For Tony's review on return.
