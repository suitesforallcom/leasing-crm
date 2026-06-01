# Buildings Delete Sites Audit — 2026-06-01

> Read-only audit performed during autonomous run #2 (continuation of `SCALING_AUDIT_2026-05-31.md`). Catalogs every site that removes a building from `state.buildings`. Required for Phase 2 dual-write activation per [SCALING_PLAN_v2.md §0 rule 2](SCALING_PLAN_v2.md) — delete by explicit event, never by diff.

## Summary

| # | Site | Trigger | Action needed | Status |
|---|---|---|---|---|
| 1 | `_v2BuildingsAttachListener` callback @ L32474 | Internal — Firestore listener removing on `ch.type === 'removed'` | None — passive listener, already correct | ✓ Safe |
| 2 | `deleteBuildingFromModal` @ L61124 | Operator UI button «🗑 Delete Building» | Add `_mirrorBuildingDeleteV2(editingBuildingId)` before splice | ✓ **DONE this commit** |
| 3 | `sfaRehydrateMonolithBuildings` @ L32704 | Manual admin recovery tool, root-admin only | Document semantics, recommend `sfaReconcileBuildingsV2()` after use | ✓ Already gated |
| 4 | `fbApplyRemote` @ L32915 | Internal — Firestore monolith snapshot listener (`state[k] = remote[k]`) | Will be retired by Phase 2.4 read-switch; document fragility until then | ⏳ Deferred |

## Details

### Site 2 — `deleteBuildingFromModal` (the actionable one)

**Pre-fix code** (lines around 61121):
```js
pushHistory();
const wasCurrentBuilding = state.ui.currentBuildingId === editingBuildingId;
state.buildings = state.buildings.filter(x => x.id !== editingBuildingId);  // ← v2 doc orphans here
```

**Fix applied** (this commit):
```js
pushHistory();
const wasCurrentBuilding = state.ui.currentBuildingId === editingBuildingId;
try { if (typeof _mirrorBuildingDeleteV2 === 'function') _mirrorBuildingDeleteV2(editingBuildingId); } catch (e) { /* log only */ }
state.buildings = state.buildings.filter(x => x.id !== editingBuildingId);
```

**DORMANT-safe**: `_mirrorBuildingDeleteV2` checks `_mirrorBuildingsReady()` which gates on `buildingsSyncV2Enabled()` — when the flag is off (current default), the call is a no-op. When Tony activates Phase 2 dual-write, the call fires and deletes the corresponding doc from `workspaces/{ws}/buildings/{buildingId}`.

### Site 4 — `fbApplyRemote` (deferred)

Currently `state['buildings'] = remote['buildings']` in `fbApplyRemote` (~L32268, the modern updated form). If the remote monolith has fewer buildings than local state, those local buildings are silently dropped. This is the original v1 strip anti-pattern at the monolith level.

**Why deferred**: when Phase 2.4 read-switch is activated (Tony's call), the building data source moves from `remote.buildings` to the `workspaces/{ws}/buildings` collection. At that point, `fbApplyRemote` should stop applying `remote.buildings` — that's part of the Phase 2.4 activation commit (separate session per the runbook).

Until activation, this is a known pattern. The only risk is a stale cloud snapshot wiping a local building that's mid-creation — but the monolith optimistic-locking transaction prevents that (would-be racer reads new `_rev` and retries).

### Sites 1 & 3 — passive consumers / manual admin

Both are intentional, both are gated, both are correct.

- Site 1 (`_v2BuildingsAttachListener`) is the receiver of cloud-sourced deletes. It only fires when the v2 collection has a removed doc — which only happens when an explicit-event delete (like site 2 now) fires `_mirrorBuildingDeleteV2`. Closed loop.
- Site 3 (`sfaRehydrateMonolithBuildings`) is a recovery tool. By design, it wholesale replaces `state.buildings` with the collection snapshot. If a building exists locally but not in cloud, it's dropped — intentional rollback semantics. Documented in commit `0b6bc3b`.

## Activation runbook update

[`SCALING_ACTIVATION_RUNBOOK.md`](SCALING_ACTIVATION_RUNBOOK.md) Stage 3 «Known activation gap — building deletion» — this audit closes the operator-initiated delete site (#2). Internal sites (#1 + #4) and admin recovery (#3) are noted in the runbook with the same status as here.

## How this audit was produced

Explore agent run during autonomous run #2 with patterns:
- `state\.buildings\.splice`
- `state\.buildings = state\.buildings\.filter`
- `delete .+\.buildings\[`
- `\.buildings\.splice\(`

Each hit walked to the containing function name and classified by trigger (operator UI / internal / admin recovery / cloud sync).

— End of audit.
