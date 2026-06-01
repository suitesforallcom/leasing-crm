# `saveLocalOnly()` Phase 2 Dual-Write Safety Audit — 2026-06-01

> Read-only audit performed during autonomous run #2. Verifies that the Phase 2 saveState hook (commit `1ee8476` — `_mirrorBuildingsToV2` fires inside `saveState`) is not bypassed by `saveLocalOnly` callsites for operator-initiated building mutations.

## Summary

**4 callsites total. Zero gaps requiring action.**

| Site | Function | Classification | Phase 2 mirror needed? |
|---|---|---|---|
| 1 | `fbApplyRemote` (~L33166) | APPLY-REMOTE | NO — remote IS the source of truth |
| 2 | `loadState` (~L26940) | HEAL/MIGRATION | NO — boot heal, will sync via fbApplyRemote later |
| 3 | `openGroupAssignModal` (~L71234) | OPERATOR-UI-FLAG | NO — only touches `state.settings.editMode` |
| 4 | `setMode` (~L71442) | OPERATOR-UI-MODE | NO — only touches `state.ui.mode` (per-device only) |

## Why this matters

`saveLocalOnly()` writes to localStorage but skips `fbSchedulePush` — by design. With the Phase 2 hook now living inside `saveState`, the rule is:

- Callsites that go through `saveState` → automatic Phase 2 building mirror (when flag is on)
- Callsites that go through `saveLocalOnly` → SKIP the mirror

This is the correct contract because:
1. Apply-remote echoes the state we just received — mirroring would create a write loop
2. Boot-time heal mutations are monolith-only fixups; cross-device propagation happens on next `fbApplyRemote`
3. UI-only mutations (`editMode`, `mode`) are per-device by design and should NOT mirror to a workspace-shared collection

## Detail

### Site 1 — `fbApplyRemote` (apply-remote echo)
```js
saveLocalOnly();       // write to localStorage without triggering fbPushNow
if ((healed || migrated || ...) && typeof saveState === 'function') {
  // ... later code uses full saveState when migrations DO need to push
}
```
Correct: the just-applied remote IS the source of truth; mirroring would echo it back.

### Site 2 — `loadState` (boot heal)
Persists heal-driven changes (floor name fixes, duplicate ID cleanup, etc.) to localStorage. Cross-device propagation deliberately deferred to the next `fbApplyRemote` cycle.

Correct: heal mutations on monolith are monolith-only by design; no mirror needed.

### Site 3 — `openGroupAssignModal` (editMode flip)
Mutation: `state.settings.editMode = true` — flips Edit Mode automatically when user opens the Assign-Group modal in View Mode. UI-only flag.

Not a building mutation. No mirror needed. The `_mirrorBuildingsToV2` change-detection hash compare would skip all buildings anyway because none changed.

### Site 4 — `setMode` (tool selection)
Mutation: `state.ui.mode = m` + `saveLocalOnly()`. The whole point of `saveLocalOnly` here is to PERSIST PER-DEVICE — per the inline comment («mode личное на сессию/устройство, не workspace-wide»). Shipping this in commit `77a3b9f` was deliberate.

Not a building mutation. No mirror.

## Conclusion

The Phase 2 saveState hook is **safe as designed**. No new gaps; no follow-up needed for activation.

Building deletions (`deleteBuildingFromModal`, audit-site #2 in [SCALING_AUDIT_BUILDINGS_DELETES_2026-06-01.md](SCALING_AUDIT_BUILDINGS_DELETES_2026-06-01.md)) are explicitly wired to `_mirrorBuildingDeleteV2` (commit `360ccc9`). Building creations / updates go through `saveState` and are caught by the hook automatically.

— End of audit.
