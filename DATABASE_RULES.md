# DATABASE_RULES.md

> Rules for Firestore + Storage + localStorage. **All schema changes require Tony's explicit approval.**

## Overview

Three storage layers (per ARCHITECTURE.md):

1. **Firestore** — source of truth when online. Single document `workspaces/{WORKSPACE_ID}/data/state` holds the entire workspace state.
2. **localStorage** — offline fallback. JSON dump of state under `sfa_state_v1`.
3. **Firebase Storage** — binary assets (receipts, blueprints, lease PDFs, photos). State only stores Storage URLs, not binary data.

---

## Firestore document layout

```
workspaces/{WORKSPACE_ID}/
├── data/
│   └── state             ← single doc with entire state (see DATA_MODEL.md)
│       {
│         _rev: number,
│         _updatedAt: serverTimestamp,
│         _updatedBy: uid,
│         _size: number,
│         state: { ... }
│       }
├── members/
│   └── {uid}             ← per-member doc with role + ACL
│       {
│         email,
│         role: 'admin' | 'manager' | 'mapeditor' | 'teamviewer' | 'viewer',
│         displayName,
│         allowedBuildings: [...] | null,    // null = all buildings
│         invitedBy: uid,
│         joinedAt: serverTimestamp,
│         lastSeenAt: serverTimestamp
│       }
├── invites/
│   └── {inviteId}        ← pending invite docs
└── backups/
    └── {backupId}        ← snapshot of state at a point in time
```

---

## Single-doc design philosophy

The entire workspace state lives in ONE Firestore document. Why:

- **Atomic writes**: every save is a single transaction. No risk of partial state.
- **Optimistic locking**: `_rev` field on the single doc; one tx = one rev bump.
- **Simple onSnapshot**: one listener delivers all state changes.
- **Easy backup**: dump one doc.

Cost:
- **1 MB Firestore doc limit**. Hard guard at 950 KB in `fbPushNow` refuses to push (would silently fail server-side otherwise).
- All members of a workspace share one doc → one operator's edit invalidates everyone else's working copy until rebase.

When workspace state approaches limit:
- Operator should archive old buildings (Settings → Archive)
- Trim large photos / receipts (verify they're Storage URLs, not inline dataURLs)
- Future migration: split off `recoveryCases` / `tenantHistory` into sub-collections (REQUIRES TONY APPROVAL — schema change)

---

## Optimistic locking via `_rev`

### Write flow

`fbPushNow()`:

1. Capture current local `_rev` as `baseRev`
2. Run Firestore transaction:
   - Read current cloud doc → get `remoteRev`
   - If `remoteRev > baseRev` AND `remoteUpdatedBy !== ourUid` → **CONFLICT** (set flag, abort tx)
   - If `remoteRev > baseRev` AND `remoteUpdatedBy === ourUid` → **silent rebase** (set `newRev = remoteRev + 1`)
   - Else → `newRev = baseRev + 1`
   - Write `{ _rev: newRev, _updatedAt, _updatedBy, _size, state: payload }`
3. On success: update local `state._rev = newRev`
4. On conflict: surface red banner with recovery buttons (↑ Force push / ↓ Pull cloud)

### Read flow

`onSnapshot` listener triggers `fbApplyRemote(snapshot.data())`:

1. If `remoteRev > local._rev` → apply remote state to local + bump local `_rev`
2. If `remoteRev === local._rev` (echo of own write) → skip
3. If `remoteRev < local._rev` → out-of-order → ignore

### Auto-retry policy

`fbPushNow` auto-retries ONCE with 2-second pause for "transient" version conflicts (Firestore SDK retry-budget exhaustion under burst load). Real cross-user conflicts surface immediately.

### Recovery buttons (added 2026-05-10)

When real conflict surfaces (red banner):

- **↑ Force push** (`fbForceResync()`) — adopts cloud `_rev` as new base, pushes local. Destructive to cloud-side divergence.
- **↓ Pull cloud** (`fbPullNow()`) — discards local unsaved changes, pulls cloud state.

Both have confirm dialogs.

---

## Backwards compatibility

**Rule**: never break operator's saved state.

### Adding a field

Safe — add as OPTIONAL with runtime fallback:

```js
const _hasCustomLabel = (typeof u.labelDX === 'number' && typeof u.labelDY === 'number');
```

### Removing a field

Don't actively remove — leave the field in old data, ignore it. If memory pressure becomes a real issue, add a one-shot migration step gated behind `state._schemaVersion`.

### Renaming a field

DON'T. If absolutely needed:

1. Add new field
2. Migration step: read old field if new is missing, write new
3. Leave old field for one revision (in case rollback needed)
4. After confirmed stable, schedule cleanup commit

### Type changes

DON'T. If the type of a value needs to change (e.g. `u.rent` from string to number), add a runtime coercion:

```js
const rentNum = +u.rent || 0;  // coerces strings, handles undefined
```

Don't aggressively rewrite stored values during read — the next save would persist the new type, but a stale tab might overwrite with the old.

### Schema versioning

There's no formal `state._schemaVersion` field. Each new field is added with runtime fallback. If a real schema migration is needed, Tony designs it explicitly + adds the version field.

---

## localStorage cap

5 MB per origin per browser. State writes are debounced to avoid overshooting.

If `localStorage.setItem(key, big_value)` throws `QuotaExceededError`:
- Write to console, don't toast (toast would re-trigger render → infinite loop)
- Operator might miss it — design assumption is "Storage URLs, not dataURLs" keeps state slim

The hard guard at 950 KB in `fbPushNow` (Firestore size cap) usually catches before localStorage does.

---

## Firebase Storage paths

| Path | Contents |
|---|---|
| `receipts/{ts-uuid}.jpg` | Operator-uploaded payment receipts |
| `blueprints/{ts-uuid}.jpg` | Floor blueprints (after PDF/PNG/JPG conversion) |
| `lease-pdfs/{envelopeId}.pdf` | DocuSign-completed lease PDFs |
| `building-photos/{ts-uuid}.jpg` | Building card photos |
| `backups/{ts}.json` | Point-in-time state snapshots |

### Storage URL handling

State stores `{ url, storagePath }` pairs:
- `url` for display (Storage download URL with token)
- `storagePath` for cleanup (delete the old blob when replacing)

Don't store raw dataURLs in state — defeats the cap-protection model.

### Orphan cleanup

When a payment receipt is replaced:
```js
const prior = u.payments[ym]?.receiptPath;
if (prior && prior !== newPath) {
  try { await fbSync.sdk.deleteObject(fbSync.sdk.storageRef(fbSync.storage, prior)); } catch { /* best-effort */ }
}
```

When a building / unit is hard-deleted, scan its associated Storage paths and delete (best-effort). Soft-delete (archive) doesn't trigger cleanup.

---

## Firestore Security Rules (`firestore.rules`)

Mirror of role matrix in DECISIONS.md § 2 and AUTH_AND_PERMISSIONS_RULES.md.

Key principles:

- All paths require `request.auth != null` (no public access)
- Workspace membership check: `request.auth.uid in get(/databases/$(database)/documents/workspaces/$(wsId)/members/$(uid)).data` (or similar)
- Per-path role checks (e.g. members/{uid} write requires admin role)
- No `allow read, write: if true` ANYWHERE

### Editing rules

Tony only. When changing:

1. Open `firestore.rules` in editor (read-only inspection by Claude is OK)
2. Make change
3. Tony deploys via `firebase deploy --only firestore:rules` (manual)
4. Verify in Firebase Console → Firestore → Rules tab → "Rules playground" with sample requests

NEVER:
- Add `allow read, write: if true` anywhere
- Remove auth checks
- Comment out the deny-by-default rules
- Use `request.auth.uid == null` to allow anonymous (this app requires sign-in)

---

## Composite indexes (`firestore.indexes.json`)

Currently minimal — main app uses single-doc reads, not queries. If a new query is added that requires a composite index:

1. Add to `firestore.indexes.json`
2. Tony deploys via `firebase deploy --only firestore:indexes`
3. Verify in Firebase Console → Firestore → Indexes

If a query fails with "the query requires an index", Firebase Console error message includes a "Click to create" link. Tony reviews + creates.

---

## CORS (`cors.json`)

Configures Firebase Storage CORS for direct-from-browser reads.

Currently allows `https://suitesforall.web.app`. If Tony wants `localhost:5577` added for local dev:

```bash
gsutil cors set cors.json gs://<bucket>
```

Tony does this manually. Claude doesn't run `gsutil`.

---

## Backup snapshots

`workspaces/{wsId}/backups/{backupId}` — periodic snapshots of `state` doc. Created via:

- **Manual**: Settings → Backups → "Backup now"
- **Auto**: Cloud Function scheduled (daily? configurable)
- **Pre-mutation**: `_localBackupCreate('pre-mutation', label)` snapshots BEFORE risky operations (DXF auto-create, restore from backup, etc.)

Restore: admin only via Settings → Backups → click backup → Restore. Confirms with explicit dialog.

---

## Common pitfalls

| Pitfall | How to avoid |
|---|---|
| Pushing a state > 950 KB | Hard guard already refuses; archive old buildings or trim photos |
| Storing dataURL in `f.bg.src` | Always upload to Storage and store URL |
| Renaming a field | Don't. Ever. Without Tony approval + migration plan. |
| Bulk-deleting Firestore docs | Don't. Use soft-delete via `archivedAt` field. |
| Writing without optimistic-lock check | All writes go through `fbPushNow`; don't bypass via `setDoc` directly |
| Modifying `firestore.rules` without Tony | Auth bypass risk. Always Tony approval. |
| Treating local `state` as authoritative when online | Cloud is truth. `fbApplyRemote` rebases. |
| Editing `cors.json` without Tony | Affects Storage access from new origins. |

---

## Migration strategy (for future schema changes)

If Tony approves a real schema change:

1. **Add new field** with optional fallback in same release
2. **Deploy** — old clients keep working
3. **Wait** for all sessions to refresh (or push notification)
4. **Add migration step** that copies old → new on next read
5. **Deploy migration** — old clients still work, new clients use new field
6. **Remove old-field-read fallback** in next release (after migration confirmed)
7. **Optional: cleanup** — remove old field in a final release

Don't shortcut this. Single-doc design means partial state is fragile — atomic per-doc but no per-field migration.

---

## Doc cross-references

- DATA_MODEL.md — full state shape
- ARCHITECTURE.md — Firestore single-doc design
- AUTH_AND_PERMISSIONS_RULES.md — rules content
- USER_FLOWS.md — F20 (cloud sync conflict recovery)
- RISK_MATRIX.md — R-2 (schema break), R-4 (sync conflict), R-5 (localStorage cap)
- SECURITY_AND_SECRETS.md — Firestore rule editing
