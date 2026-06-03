# SCALING ACTIVATION RUNBOOK

> Step-by-step guide for activating the DORMANT scaling infrastructure shipped during autonomous run #2 (2026-05-31 → 2026-06-01).
>
> **Use this when you decide to flip flags.** Everything below is currently OFF on prod — no behavior change yet. Each phase is independently rollbackable via flag flip.

## ⚡ Entry point — type these in the prod browser console

```js
sfaScalingHelp()         // discover every helper (one line each)
sfaScalingStatusV2()     // current flags + next recommended step
sfaInspectState()        // state composition + Phase 3 candidates
```

Then read on for the activation sequence.

---

## Current state of the system (2026-06-01)

| Item | Status | Activation flag | Default |
|---|---|---|---|
| Phase 1 dual-write payments (client) | LIVE | `settings.syncV2` | **on (since 2026-05-31 13:42)** |
| Phase 1 dual-write payments (server) | LIVE | `settings.syncV2` | **on (same flag)** |
| Phase 1.2 read-switch payments (client) | DORMANT | `settings.syncV2Read` | **off** ← flip this |
| Phase 1.3 strip monolith payments | NOT BUILT | (no flag yet) | n/a |
| Phase 2 dual-write buildings (client) | DORMANT | `settings.syncBuildingsV2` | **off** ← flip this |
| Phase 2.4 read-switch buildings (client) | DORMANT | `settings.syncBuildingsRead` | **off** ← flip this |
| Phase 2.5 strip monolith buildings | NOT BUILT | (no flag yet) | n/a |
| Reconcile monitor CF (hourly) | LIVE | (no flag — always runs when `syncV2` is on) | — |

State doc size right now: ~850 KB. Hard ceiling 1 MB → 150 KB headroom = ~2 more buildings before lockup. **Phase 1.3 strip frees ~200 KB.** **Phase 2.5 strip frees ~600 KB.** Both must follow their respective dual-write + read-switch.

---

## Stage 1 — Verify Phase 1 soak

**Goal:** prove that the payments collection and the monolith stay byte-identical over time. Required before any read-switch.

### Step 1.1 — Browser soak (manual, anytime)
```js
sfaReconcilePaymentsV2()
```
Expected: `state платежей: 1276 | v2-доков: 1276 | missing 0 / extra 0 / mismatched 0 | ✓ ЧИСТО`

### Step 1.2 — Server soak (passive, hourly cron)
Open Firebase Console → Firestore → `workspaces/default/scaling/reconcileLatest`. Check:
- `clean === true`
- `stateCount === cloudCount`
- `missingInCloudTotal === 0`
- `extraInCloudTotal === 0`
- `mismatchedTotal === 0`
- `v1OrphanCount` — see [KNOWN_ISSUES.md #13](KNOWN_ISSUES.md). If >0, the legacy `mirrorPaymentsOnStateWrite` trigger is still creating v1 records — disable it first (see Stage 1.5).

History: `workspaces/default/scaling/reconcile_*` (append-only, ordered by timestamp). Pick a few from the last 24-48h.

### Step 1.3 — On-demand server reconcile (manual trigger)
From browser console on prod:
```js
const fn = stripeCallable('runReconcilePaymentsV2Now');
const r = await fn({});
console.log(r.data);
```
Same result shape; useful when you want to refresh the snapshot now without waiting for the cron.

### Step 1.4 — Pass criteria for Stage 1
- At least **3 consecutive hourly snapshots** all `clean === true`
- `missingInCloudTotal`, `extraInCloudTotal`, `mismatchedTotal` all zero on every snapshot
- No drift bursts (a single cleanup spike followed by clean is acceptable; persistent or growing drift is not)

### Step 1.5 — RECOMMENDED before Stage 2: disable legacy v1 mirror trigger
Per [KNOWN_ISSUES.md #13](KNOWN_ISSUES.md):

```js
// functions/index.js:8324 — add early return at top
exports.mirrorPaymentsOnStateWrite = onDocumentWritten(
  'workspaces/{wid}/data/{docId}',
  async (event) => {
    return;  // 2026-XX-XX: disabled — superseded by in-handler mirrors (commit ba68a4d)
    // ... old code below now unreachable
```

Then `firebase deploy --only functions` + run `sfaCleanV1OrphanPayments({apply: true})` from prod browser to purge accumulated v1 docs.

Verify on the next `reconcileLatest`: `v1OrphanCount === 0`.

---

## Stage 2 — Activate Phase 1.2 read-switch (payments)

**Effect:** client reads `u.payments[ym]` from the v2 collection in real-time (listener) instead of the monolith state doc. Monolith still has authoritative payments until Phase 1.3 strip.

### Step 2.1 — Pre-flight smoke
```js
sfaReadSwitchSmoke()
```
Expected: `✓ Read-switch SAFE: reconcile clean (0 drift). → next: sfaTestReadSwitchV2(true) to enable.`

If "NOT SAFE", do NOT proceed — investigate drift first.

### Step 2.2 — Flip
```js
sfaTestReadSwitchV2(true)
```
Expected: `[v2-read] ✓ ENABLED. Listener attached, state.settings.syncV2Read = true.`

Behind the scenes:
- `state.settings.syncV2Read = true` (saved to monolith → all your tabs + reload survive)
- onSnapshot listener attached on `workspaces/default/payments`
- First snapshot fires immediately with all 1276 docs → debounced re-render at 100ms
- Renders match the monolith view, so nothing should look different

### Step 2.3 — Observe (15-30 minutes of normal use)
- Open units, look at payment matrix — should match what was there before
- Record a manual payment → see it appear in real-time (both via Phase 1.2 listener AND via existing monolith path)
- Check `sfaTestReadSwitchV2()` status report — `docs applied` should grow with each Firestore write to payments collection

### Step 2.4 — Rollback if needed
```js
sfaTestReadSwitchV2(false)
```
Instant rollback — flag flipped off, listener detached. Monolith continues as source of truth.

### Step 2.5 — Soak for Stage 3
Run `sfaReconcilePaymentsV2()` once a day for 2-3 days. Should stay clean.

---

## Stage 3 — Phase 2 dual-write (buildings)

**Effect:** each building also written as its own doc in `workspaces/{ws}/buildings/{buildingId}`. Monolith still has authoritative `state.buildings`.

### Step 3.1 — Enable flag
```js
state.settings.syncBuildingsV2 = true; saveState();
```

### Step 3.2 — One-time backfill (root admin only)
```js
sfaMirrorBuildingsV2()
```
Confirm dialog — yes to write all current buildings into the collection.

### Step 3.3 — Verify
```js
sfaReconcileBuildingsV2()
```
Expected: `state buildings: N | v2-docs: N | missing 0 / extra 0 / mismatched 0 | ✓ ЧИСТО`

### Step 3.4 — Observe normal use
Now every `saveState()` call automatically mirrors changed buildings (via the hook in commit `1ee8476`). Change-detection means only modified buildings are written — usually 0-1 doc per save.

Run `sfaReconcileBuildingsV2()` after 24-48h of normal operation. Drift should stay zero.

### Known activation gap — building deletion — ✅ VERIFIED CLOSED 2026-06-03
Audit of all building-removal callsites: the ONLY user-initiated delete is `deleteBuildingFromModal` (line ~62570), which already calls `_mirrorBuildingDeleteV2(editingBuildingId)` right before the `state.buildings.filter` (commit `360ccc9`). The other `state.buildings.splice` (in `_v2BuildingsAttachListener`, ~line 33217) is the read-switch listener applying a `removed` change FROM the collection — correctly does NOT mirror (would be circular). No uncovered delete path remains.

### Step 3.5 — Rollback if needed
```js
state.settings.syncBuildingsV2 = false; saveState();
```
The hook in saveState is no-op when this flag is off.

---

## Stage 4 — Phase 2.4 read-switch (buildings)

**Effect:** client reads `state.buildings` from the buildings collection in real-time. Monolith still authoritative until Phase 2.5 strip.

### Step 4.1 — Pre-flight smoke
```js
sfaBuildingsReadSwitchSmoke()
```
Expected: `✓ Buildings read-switch SAFE: reconcile clean.`

### Step 4.2 — Add null guards FIRST (separate commit)
Per [SCALING_AUDIT_2026-05-31.md Part B](SCALING_AUDIT_2026-05-31.md), 5 helper functions need null guards before Stage 4 can be safely flipped:
- `currentBuilding`
- `currentFloor`
- `currentUnits`
- `currentWalls`
- `_investBuildTenantsByBuilding` (memoize candidate, ×5 per investment dashboard render)

These should ship as their own commit BEFORE flipping the read-switch flag. ~30 min work + parse-check + deploy.

### Step 4.3 — Add loading sentinel (separate commit) — ✅ DONE 2026-06-03 (commit `361d3ab`)
Per audit, building selector should show "loading..." during the initial onSnapshot window (100-500ms). Currently it would briefly flash empty. **Shipped DORMANT:** module flag `_v2BuildingsFirstSnapshotDone` (set true after first collection snapshot; reset on detach) + `renderBuildingSelector` early-returns a "Loading buildings…" pill+list ONLY when `syncBuildingsReadEnabled() && !firstSnapshotDone && state.buildings.length===0`. With the read-switch off the condition short-circuits → byte-identical. Verified both branches in-browser.

### Step 4.4 — Flip
```js
sfaTestBuildingsReadSwitchV2(true)
```

### Step 4.5 — Observe
- Building selector populates after ~100-300ms
- Switching buildings still works
- Rent roll, leases, payments matrix all render correctly per building
- `u.payments` should still be live (Phase 1.2 listener restores them after each building swap — see commit `9cb4c9a` for the preservation logic)

### Step 4.6 — Rollback
```js
sfaTestBuildingsReadSwitchV2(false)
```

---

## Stage 5 — Phase 1.3 strip monolith payments

**Effect:** `saveState` STOPS writing `u.payments[ym]` to the monolith. State doc drops ~200 KB. Reads continue from Phase 1.2 listener.

### ✅ BUILT DORMANT 2026-06-01 (commit `25eae58`)

Shipped: flag `settings.syncV2StripPayments` (default **false**) + `_fbStripPaymentsFromPayload()` — **scrub-only** on the `fbSanitizeState` deep-clone payload (collection untouched, NOT delete-by-diff; the dead v1 `_fbPaymentsCutover` stays disabled). Strict gate `_stripPaymentsV2Enabled()` requires dual-write **AND** read-switch ON, so a stray flag alone strips nothing. Enable: `sfaEnableStripPaymentsV2()` (refuses unless read-switch live + warns re soak). Rollback: `sfaDisableStripPaymentsV2()` (monolith re-fattens next push) or `sfaRehydrateMonolithPayments()`. **Activate only after 48h clean soak.**

Implementation notes:
- Use the existing `_fbPaymentsCutover` kill-switch infrastructure (currently always-on, blocks strip)
- New flag: `settings.syncV2StripPayments`
- Hook into `fbPushNow` (or `saveState`'s replacer) to scrub `u.payments` from the outbound state on push
- Reconcile must continue to pass — if Phase 1.2 listener doesn't restore payments fully on next reload, strip caused data loss
- **Rollback path:** `sfaRehydrateMonolithPayments()` — reads collection, writes payments back into state.buildings, fbPushNow. ~5 minutes to recover from a botched strip.

### Risk assessment
**HIGH RISK.** Past v1 strip (`settings.syncV2Strip`) mass-deleted all 1277 docs ×2 (2026-05-30 incidents). Current `_fbPaymentsCutover` explicitly blocks re-enabling the v1 mechanism. Phase 1.3 must be a different, safer design.

Required before implementing:
- 48+ hour clean soak post-Stage 2 (read-switch live, drift 0)
- Documented rollback path with one-command revert
- Staging workspace test FIRST
- Manual paste of one-line strip code, not console flag — keeps it out of operator-trigger paths

---

## Stage 6 — Phase 2.5 strip monolith buildings

**Effect:** `saveState` STOPS writing `state.buildings` to monolith. Reads continue from Phase 2.4 listener. State doc drops ~600 KB → **unlimited buildings unlocked** (each building is its own doc, no shared 1 MB ceiling).

### ✅ BUILT DORMANT 2026-06-01 (commit `25eae58`)

Shipped: flag `settings.syncBuildingsStrip` (default **false**) + `_fbStripBuildingsFromPayload()` — scrubs `payload.buildings` to `[]` on the deep-clone payload (read-switch rehydrates `state.buildings` from the `buildings` collection). Strict gate `_stripBuildingsV2Enabled()` requires buildings dual-write **AND** read-switch ON. Enable: `sfaEnableStripBuildingsV2()`. Rollback: `sfaDisableStripBuildingsV2()` or `sfaRehydrateMonolithBuildings()`. **Activate only after Stage 5 + 48h clean buildings soak.**

Implementation notes — similar to Stage 5 strip but for buildings instead of payments. Requires:
- Phase 2 dual-write live + reconcile clean for 48h+
- Phase 2.4 read-switch live + UI verified for 48h+
- `sfaRehydrateMonolithBuildings()` rollback helper

### After Stage 6
- Monolith `state` doc = ~50 KB (only settings, investments, ui, flags, _rev)
- Each building = ~100 KB own doc
- Adding the 50th building DOES NOT TOUCH the 49 prior docs
- **The original goal — безлимитные здания — is achieved**

---

## Stage 7 (optional) — Phase 3 heavy field migration

Not blocking unlimited buildings. Frees additional ~170 KB per building.

- ✅ **`u.outreach[*]` (66 KB) — BUILT DORMANT 2026-06-01 (commit `a634bc6`).** Full history already mirrored to `workspaces/{ws}/audit` via `recordAuditClient` on every `recordOutreach` (verified, 36+ callsites), so the in-state array is only a cache. Flag `settings.syncOutreachCap` (default false) + `_fbCapOutreachInPayload` caps the tail to N (default 25) on the deep-clone payload. Enable: `sfaEnableOutreachCap(25)`. Preview: `sfaOutreachTailCapPreview(25)`. Rollback: `sfaDisableOutreachCap()`. Low-risk (non-financial, durable mirror). **Activate anytime — no soak gate needed** (history is safe in Audit).
- 🟡 **`u.leaseDocuments[*]` (~113 KB) — DUAL-WRITE MIRROR BUILT DORMANT 2026-06-03 (commit `70cf008`).** Per-unit docs in `workspaces/{ws}/leaseDocs/{bid__fid__uid}` (PDFs already in Storage via pdfStoragePath; the array is metadata + versions + extracted body). Flag `settings.leaseDocsV2` (default false). `_mirrorLeaseDocsToV2` (idempotent shape-hash; upsert non-empty / skip unchanged / delete-on-empty), saveState hook (no-op when off), `sfaMirrorLeaseDocsV2` backfill, `sfaReconcileLeaseDocsV2` (client read). Verified dormant + mirror logic via mock SDK. **STILL DORMANT / TODO:** (a) `match /leaseDocs/{id}` read+write rule in `firestore.rules` (GATED — needed for backfill/reconcile/read); (b) read-switch listener (C1b); (c) strip-from-payload + rehydrate (C1c). **⚠ OVERLAP with Track B (buildings):** `_buildingForV2` currently keeps leaseDocuments in the building doc, so the buildings strip (Stage 6) ALREADY removes leaseDocuments from the monolith. Decide path: either (X) do leaseDocs as a standalone interim lever (−113 KB without the full buildings migration; then if Track B is later activated, update `_buildingForV2` to also strip leaseDocuments to avoid duplication) OR (Y) skip standalone leaseDocs and let Track B carry it. This dual-write is the foundation for path X.
- ⏳ **`state.gmailActivity` + `callActivity` + `calendarEvents` + `dailyHistory` — NOT BUILT.** These are CF-written top-level maps → `workspaces/{ws}/ingest/{type}` needs `functions/index.js` changes (GATED — separate Tony approval). Client-side cap is possible but the real win is server-side ingest.

These are independent migrations — can do one at a time. outreach-cap shipped; the other two are scoped above and need (leaseDocs) a mirror-first build or (activity) gated CF work.

---

## Emergency rollback (any stage)

If anything looks wrong:

```js
// Disable all read switches — instant fallback to monolith reads
state.settings.syncV2Read = false;
state.settings.syncBuildingsRead = false;
saveState();
```

Then detach listeners (they self-detach on flag check but explicit detach is also fine):
```js
sfaTestReadSwitchV2(false);
sfaTestBuildingsReadSwitchV2(false);
```

Dual-write flags can also be disabled to stop further mirror writes (won't affect existing collection docs, just stops new ones):
```js
state.settings.syncV2 = false;            // stops payments mirror
state.settings.syncBuildingsV2 = false;   // stops buildings mirror
saveState();
```

To rebuild collection from monolith (if collection got corrupted somehow):
- Payments: `sfaMirrorPaymentsV2()` — re-runs full backfill
- Buildings: `sfaMirrorBuildingsV2()` — re-runs full backfill
- Both idempotent, both root-admin gated

To rebuild monolith from collection (Phase 1.2 / Phase 2.4 listener corruption recovery):
- Payments: `sfaRehydrateMonolithPayments()` — reads collection, writes back into state, saveState pushes (commit `0b6bc3b`)
- Buildings: `sfaRehydrateMonolithBuildings()` — same for buildings; preserves in-memory u.payments through swap (commit `0b6bc3b`)
- Both root-admin gated, confirm dialog with workspace warning
- Safer than full backup restore — only touches the affected layer

If you genuinely need to roll back POST-STRIP (Stage 5 or 6 went wrong): the rehydrate helpers (when built) read from collection back to monolith. Until those exist, restore from a daily Firestore backup via `fbListBackups()` + `fbRestoreBackup(dateId)` — that's the nuclear option, takes a pre-restore snapshot automatically.

---

## What this run did NOT touch (gated for separate decisions)

- `firestore.rules` — new collections (`scaling/`, etc.) inherit existing rules; if you want client-side reads of reconcile results, add a `match /scaling/{doc}` rule with `allow read: if isMember(wid)`.
- `firestore.indexes.json` — no compound queries in the new code, no index changes needed yet
- `mirrorPaymentsOnStateWrite` disable — flagged in KNOWN_ISSUES #13, recommended before Stage 2 but not auto-applied here
- Strip operations (Stage 5 + Stage 6) — high-risk, separate sessions

---

## Commits delivered this run (oldest → newest)

```
de72bc5 feat(scaling): Phase 1.2 read-switch client core (DORMANT)
ad53f88 feat(scaling): Phase 2 building dual-write mirrors + reconcile (DORMANT)
1d69489 docs(scaling): audit of u.payments + state.buildings read sites
e184d83 feat(scaling): Phase 1 reconcile monitoring CF (hourly + on-call)
fb10e5d docs(scaling): autonomous run #2 journal + KNOWN_ISSUES #13
9cb4c9a feat(scaling): Phase 2.4 building read-switch client core (DORMANT)
1ee8476 feat(scaling): hook saveState → _mirrorBuildingsToV2 (Phase 2 activation wire)
f926e10 docs(scaling): activation runbook (this file)
127a95a perf(scaling): null guards on currentX helpers + memoize _investBuildTenantsByBuilding
0b6bc3b feat(scaling): sfaRehydrateMonolithPayments + sfaRehydrateMonolithBuildings (rollback)
f6c2fa7 feat(scaling): Phase 2 buildings reconcile monitoring CF (symmetric to payments)
360ccc9 feat(scaling): wire deleteBuildingFromModal → _mirrorBuildingDeleteV2 + audit doc
0d3d5db feat(scaling): sfaScalingStatusV2 — combined dashboard
f9942c7 feat(scaling): sfaScalingHelp — discoverability reference
f5b2778 feat(scaling): sfaStripPaymentsPreview + sfaStripBuildingsPreview + saveLocalOnly audit
324214f feat(scaling): sfaInspectState — state composition analyzer
baa95a6 feat(scaling): sfaOutreachTailCapPreview — Phase 3 outreach cap sizing
39d5f51 feat(scaling): sfaScalingReconcileHistory — trend view of hourly snapshots
```

Plus release stamps after every feature commit, and updates to:
- `SCALING_PLAN_v2.md` (journal §9)
- `KNOWN_ISSUES.md` (#13 latent v1 trigger)
- `SCALING_AUDIT_2026-05-31.md` (Part A + B reads audit)
- `SCALING_AUDIT_BUILDINGS_DELETES_2026-06-01.md` (delete sites)
- `SCALING_AUDIT_SAVELOCALONLY_2026-06-01.md` (Phase 2 hook safety)
- `MEMORY.md` + `feedback_dormant_pattern_for_risky_migrations.md`
- `SESSION_LOG.md` (run #2 entry)

— End of runbook. Open an issue or DM when you start activation; happy to walk through it live.
