# AUTH_AND_PERMISSIONS_RULES.md

> Rules for any code/docs that touch authentication, permissions, roles, or session handling.
> **All changes here require Tony's explicit approval.** See CLAUDE.md "Tony Approval Required".

## Top-line principle

**Defense in depth**: every privileged action has TWO gates — UI gate (CSS body class + JS check) AND server gate (`firestore.rules`). Don't weaken either.

---

## Authentication

### Provider

Firebase Authentication, Google sign-in primary. Anonymous + email/password also supported but not the primary path.

### Identity model

Each authenticated user gets:
- `uid` (Firebase UID; stable string)
- `email` (Google account email)
- `displayName` (from Google profile)
- `role` (resolved server-side from workspace member document)

Role lookup happens at sign-in via `_resolveUserRole(uid)` (or similar). Cached in `fbSync.role` for the session.

### Sign-in flow

1. App boots → checks `fbSync.user` via `onAuthStateChanged`
2. If unauthenticated → shows login overlay (`#authOverlay`)
3. Operator clicks "Sign in with Google" → OAuth popup
4. Returns with `uid` → look up `workspaces/{wsId}/members/{uid}` doc → get role
5. Store role in `fbSync.role`
6. Apply UI gates via `applyRoleVisibility()` — sets body classes (`role-admin`, `role-manager`, etc.)
7. Initial Firestore read → app loads state

### Sign-out

`fbSync.signOut()` → clears local session → reverts to login overlay. Local `state` cleared.

---

## Roles (5-role matrix)

Source: `currentRole()` returns one of:

| Role | Edit | See finance | Manage members | Manage backups | Restore backup | Restructure | See Financial Analytics |
|---|---|---|---|---|---|---|---|
| `admin` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** |
| `manager` | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| `mapeditor` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `teamviewer` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `viewer` | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |

### Role helpers (in `floor-map-editor.html`)

```js
function currentRole() {
  if (!fbSync || !fbSync.enabled) return 'admin';      // offline-only = local admin
  return fbSync.role || 'viewer';
}

function canEdit()                  { ... return r === 'admin' || r === 'manager' || r === 'mapeditor'; }
function canSeeFinance()            { ... return r !== 'teamviewer' && r !== 'mapeditor'; }
function canEditFinance()           { ... return r === 'admin' || r === 'manager'; }
function canSeeFinanceAnalytics()   { ... return r === 'admin'; }                              // admin-only
function canSeeRentRoll()           { return canSeeFinance(); }
function canSeePayments()           { return canSeeFinance(); }
function canManageMembers()         { return currentRole() === 'admin'; }
function canManageBackups()         { ... return r === 'admin' || r === 'manager'; }
function canRestoreBackup()         { return currentRole() === 'admin'; }
function canRestructureWorkspace()  { return currentRole() === 'admin'; }
function canAccessBuilding(buildingId) { ... per-building ACL — admin sees all }
```

### `_assertCanEditFinance(operation)` — defense-in-depth

Throws `PERMISSION_DENIED` if `canEditFinance()` is false. Used by mutating finance code (e.g. `submitManualPayment`) to defend against direct console invocation by a determined user.

```js
_assertCanEditFinance('record manual payments');
// throws if user is not admin/manager
```

---

## UI gates

### Body class application

`applyRoleVisibility()` runs at sign-in + on role change:

```js
document.body.classList.toggle('role-admin',      r === 'admin');
document.body.classList.toggle('role-manager',    r === 'manager');
document.body.classList.toggle('role-teamviewer', r === 'teamviewer');
document.body.classList.toggle('role-viewer',     r === 'viewer');
document.body.classList.toggle('no-finance', !canSeeFinance());
document.body.classList.toggle('no-edit',    !canEdit());
```

### CSS gates (examples)

```css
body:not(.role-admin) #stMembersPanel { display: none !important; }
body:not(.role-admin) #commModelBtn   { display: none !important; }
body:not(.role-admin) #railFin        { display: none !important; }      /* Financial Analytics tab */
body:not(.role-admin) #hvFcstKpiStrip [data-kpi="value"] { display: none !important; }  /* Potential Value card */
body.no-finance #railHome  { display: none !important; }
body.no-finance #railBill  { display: none !important; }
body.no-finance #railRent  { display: none !important; }
body.no-finance #railLeases { display: none !important; }
body.no-finance #railPay   { display: none !important; }
body.no-finance #railFin   { display: none !important; }
body.no-finance #railComm  { display: none !important; }
```

### Auto-bounce on view enter

Some views also call permission check internally and bounce:

```js
function showHome() {
  if (typeof canSeeFinance === 'function' && !canSeeFinance()) {
    try { showFloorPlan(); } catch {}
    return;
  }
  ...
}

function showFinanceAnalytics() {
  if (typeof canSeeFinanceAnalytics === 'function' && !canSeeFinanceAnalytics()) {
    if (typeof toast === 'function') toast('Financial Analytics is admin-only', 'error');
    try { showFloorPlan(); } catch {}
    return;
  }
  ...
}
```

This is the second JS gate — even if CSS hides the rail button, programmatic call (`showFinanceAnalytics()` from console) is still rejected.

---

## Server gates (`firestore.rules`)

Mirror of the role matrix. Don't edit without Tony approval. Key rules:

- `workspaces/{wsId}/data/state` — read: any signed-in workspace member; write: `canEdit` roles only
- `workspaces/{wsId}/members/{uid}` — read: self or admin; write: admin only
- `workspaces/{wsId}/backups/{backupId}` — read: admin or manager; write: admin only
- Storage paths gated similarly via `storage.rules`

If a UI gate is added (e.g. new admin-only feature), the corresponding `firestore.rules` rule MUST be added in the SAME commit. Otherwise client gates can be bypassed by a determined user with direct API calls.

---

## Per-building access control (`canAccessBuilding`)

Some workspaces split building access (e.g. an outside manager can only see Building B). Implementation:

```js
function canAccessBuilding(buildingId) {
  const r = currentRole();
  if (r === 'admin') return true;
  // Other roles: check if buildingId is in the user's allowed list
  // (stored in workspace member document under `allowedBuildings: [...]`)
  ...
}
```

**Used by every building-iterating loop** (Rent Roll, A/R Aging, Vacancy, Calendar, etc.). Don't skip this check when adding a new iterator.

---

## Special cases

### Offline / no-Firebase mode

`currentRole()` returns `'admin'` when `fbSync.enabled === false`. This is the local-only fallback — if no Firebase is configured, the operator runs as local admin (single-user mode).

This is intentional — the app is usable offline. But it's a "trust the operator's local environment" model, not a security model.

### Auto-link employee on sign-in

When an admin invites an employee via Settings → Members, an invite doc is created. When that employee signs in for the first time, `_autoLinkEmployeeOnSignIn` matches them by email and assigns the invited role.

### Role change requires re-render

If `fbSync.role` changes mid-session (rare — admin demotes someone), call:
1. `applyRoleVisibility()` — re-applies body classes
2. `renderAll()` — re-renders all views (some may bounce)
3. Possibly `showFloorPlan()` or `showHome()` to drop into a safe view

---

## Changing the role matrix

If Tony wants a new role / new permission helper / new gate:

1. **Discuss the impact** — what surfaces does it affect? List them.
2. **Update CLAUDE.md / DECISIONS.md / this file** — document the new matrix.
3. **Add the JS helper** (`canDoX()` or similar).
4. **Add the UI gate** (CSS class + JS gate function).
5. **Add the server gate** in `firestore.rules` SAME COMMIT.
6. **Test with each role** — admin / manager / mapeditor / teamviewer / viewer.
7. **Update Storage rules** if applicable.

ALL of these in the same commit. Don't ship UI gate without server gate.

---

## What requires Tony's explicit approval

ANY change to:

- `currentRole()` logic
- `canEdit()` / `canSeeFinance()` / `canEditFinance()` / `canSeeFinanceAnalytics()` / `canManageMembers()` / `canManageBackups()` / `canRestoreBackup()` / `canRestructureWorkspace()` / `canAccessBuilding()`
- `_assertCanEditFinance` (or any new `_assert*` helper)
- `applyRoleVisibility()` body class set
- CSS gates (`body:not(.role-X) #element { display: none }`)
- `firestore.rules` (any rule)
- `storage.rules` (if exists)
- `cors.json`
- Member invite / approve / role-change logic
- Workspace ownership transfer

## What's safe without approval

- Reading `currentRole()` to display "logged in as admin" badge
- Reading role to choose between two non-privileged display variants
- Adding new roles to the documentation files (DECISIONS.md / this file) — but actual JS / rules require Tony approval

---

## Storage rules (if separate from `firestore.rules`)

If `storage.rules` exists:
- Receipts, blueprints, lease PDFs, photos: read/write require signed-in workspace member
- No public read access on any path
- Check for size caps (e.g. blueprints < 30 MB per `pickFile()` guard)

---

## Common pitfalls

| Pitfall | How to avoid |
|---|---|
| New admin-only feature visible to non-admins | Add `body:not(.role-admin) #X { display: none }` AND JS gate AND `firestore.rules` rule |
| Server gate trusts `request.auth.uid` but UI sends different user data | Validate every request server-side |
| `canAccessBuilding()` skipped in new iterator | Apply at the top of every building-loop |
| New role helper added without `firestore.rules` mirror | Always pair UI gate + server gate in same commit |
| `_assertCanEditFinance` not called in new mutating finance code | Defense-in-depth — add the assertion |
| Gating only on UI (no server gate) | UI is for UX; server is for SECURITY. Both required. |

---

## Auth-related debug paths

If sign-in / role lookup misbehaves:

1. Open DevTools → Application → IndexedDB → Firebase auth tokens
2. Check `fbSync.role` in console (`window.fbSync.role`)
3. Check workspace member doc in Firestore Console: `workspaces/{wsId}/members/{uid}`
4. Verify `applyRoleVisibility()` body classes (`document.body.className`)
5. Check `firestore.rules` deployed version matches expected

Don't fix by editing `state.users` or `fbSync.role` directly in console — those are runtime caches; the source of truth is Firestore.

---

## Doc cross-references

- DECISIONS.md § 2 — role matrix
- ARCHITECTURE.md — auth provider + flow
- DATA_MODEL.md — workspace member doc shape
- DATABASE_RULES.md — `firestore.rules` overview
- USER_FLOWS.md — F1-F20 (each flow notes role gate)
- RISK_MATRIX.md — R-3 (auth bypass)
- SECURITY_AND_SECRETS.md — secret handling
