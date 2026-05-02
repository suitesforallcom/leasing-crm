/**
 * SuitesForAll — UniFi Access integration (Phase 1b backend).
 *
 * Exports:
 *   - UnifiClient: thin, typed-ish wrapper around the UniFi Access HTTP API.
 *   - registerUnifiFunctions(): attaches provisionAccessUser / revokeAccessUser
 *     callables to the Firebase Functions module's exports.
 *
 * Secrets / config:
 *   - UNIFI_API_TOKEN   (Secret Manager) — Bearer token; set via
 *                       `firebase functions:secrets:set UNIFI_API_TOKEN`.
 *   - UNIFI_BASE_URL    (parameter)     — controller URL, e.g.
 *                       https://unifi.example.com:12445 — prompted at deploy
 *                       time via defineString, stored in .env.
 *
 * API version notes:
 *   Paths below target the /api/v1/developer surface documented for UniFi
 *   Access 1.20+ (2024). If your controller exposes /api/v2/ instead,
 *   flip BASE_PATH below and the path constants — the shapes are nearly
 *   identical across versions, only the URL prefix changed.
 *
 * Safety notes:
 *   - revokeCredential() deactivates; it does NOT DELETE. History stays
 *     on the controller for audit.
 *   - All mutating ops use an external_id convention `sfa:unit:<unitId>`
 *     so a retried provision updates the existing UniFi user instead of
 *     creating a duplicate.
 */

'use strict';

// ---------------------------------------------------------------------------
// UniFi Access HTTP client
// ---------------------------------------------------------------------------

const BASE_PATH = '/api/v1/developer';           // flip to '/api/v2' for newer versions
const EP = {
  users:        `${BASE_PATH}/users`,            // GET list, POST create
  user:         (id) => `${BASE_PATH}/users/${encodeURIComponent(id)}`,
  userPolicy:   (id) => `${BASE_PATH}/users/${encodeURIComponent(id)}/access_policies`,
  credentials:  `${BASE_PATH}/credentials`,      // POST issue
  credential:   (id) => `${BASE_PATH}/credentials/${encodeURIComponent(id)}`,
  invitations:  `${BASE_PATH}/invitations`,      // POST invite (mobile)
};

class UnifiClient {
  /**
   * @param {{ baseUrl: string, apiToken: string, timeoutMs?: number }} opts
   */
  constructor(opts) {
    if (!opts || !opts.baseUrl)  throw new Error('UnifiClient: baseUrl is required');
    if (!opts.apiToken)          throw new Error('UnifiClient: apiToken is required');
    this.baseUrl   = opts.baseUrl.replace(/\/+$/, '');
    this.apiToken  = opts.apiToken;
    this.timeoutMs = opts.timeoutMs || 20_000;
  }

  /**
   * Generic request helper. Throws an Error with `.code` and `.details` set
   * so the Firebase callable can map it to an HttpsError cleanly.
   */
  async _req(method, path, body) {
    const url = this.baseUrl + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Accept':        'application/json',
          ...(body != null ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const e = new Error(`UniFi ${method} ${path} failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
      e.code = err.name === 'AbortError' ? 'timeout' : 'network';
      throw e;
    } finally {
      clearTimeout(timer);
    }

    let parsed = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { parsed = await res.json(); } catch { /* tolerate empty bodies */ }
    } else {
      try { parsed = await res.text(); } catch { /* ignore */ }
    }

    if (!res.ok) {
      const msg = (parsed && typeof parsed === 'object' && (parsed.msg || parsed.message || parsed.error))
                || (typeof parsed === 'string' && parsed)
                || `HTTP ${res.status}`;
      const e = new Error(`UniFi ${method} ${path} → ${res.status}: ${msg}`);
      e.code = `http_${res.status}`;
      e.details = parsed;
      throw e;
    }
    // UniFi wraps responses as { code, msg, data } on v1; data lives at top
    // level on v2. Prefer .data when present.
    if (parsed && typeof parsed === 'object' && 'data' in parsed) return parsed.data;
    return parsed;
  }

  // -----------------------------------------------------------------------
  // Users
  // -----------------------------------------------------------------------

  /** Find a user by our external_id convention. Null if not found. */
  async findUserByExternalId(externalId) {
    // The /users endpoint on v1 supports a `q` query param; on v2 it's
    // `employee_number=`. We try both shapes — harmless extra call but
    // removes version coupling.
    try {
      const list = await this._req('GET', `${EP.users}?employee_number=${encodeURIComponent(externalId)}`);
      const arr = Array.isArray(list) ? list : (list && list.items) || [];
      const hit = arr.find(u =>
        u.employee_number === externalId ||
        u.external_id    === externalId ||
        u.ref            === externalId
      );
      if (hit) return hit;
    } catch (err) {
      if (err.code !== 'http_404') throw err;
    }
    return null;
  }

  /**
   * Create or update a user. Idempotent via externalId: if a user with
   * that employee_number already exists, update it instead of creating a
   * duplicate. Returns the UniFi user record.
   */
  async upsertUser({ externalId, firstName, lastName, email, title }) {
    const existing = await this.findUserByExternalId(externalId);
    if (existing && existing.id) {
      // Patch — keep the employee_number stable.
      return this._req('PUT', EP.user(existing.id), {
        first_name: firstName || existing.first_name || '',
        last_name:  lastName  || existing.last_name  || '',
        email,
        employee_number: externalId,
        title: title || existing.title,
        status: 'active',
      });
    }
    return this._req('POST', EP.users, {
      first_name: firstName || '',
      last_name:  lastName  || (email ? email.split('@')[0] : 'Tenant'),
      email,
      employee_number: externalId,
      title,
      status: 'active',
    });
  }

  /** Deactivate (do NOT delete) — preserves audit history. */
  async disableUser(userId) {
    return this._req('PUT', EP.user(userId), { status: 'inactive' });
  }

  // -----------------------------------------------------------------------
  // Access policies / door groups
  // -----------------------------------------------------------------------

  /**
   * Attach a user to one or more access policies (door groups in our UI
   * terms). Replaces the previous set — we treat the UniFi policy as the
   * single source of truth to avoid drift.
   */
  async setUserAccessPolicies(userId, policyIds) {
    return this._req('PUT', EP.userPolicy(userId), {
      policy_ids: Array.isArray(policyIds) ? policyIds : [policyIds],
    });
  }

  // -----------------------------------------------------------------------
  // Credentials
  // -----------------------------------------------------------------------

  /** Issue an NFC credential. cardUid is the hex UID scanned on the encoder. */
  async issueNfcCredential(userId, cardUid, label) {
    return this._req('POST', EP.credentials, {
      user_id: userId,
      credential_type: 'nfc',
      nfc_card: { token: cardUid },
      alias: label || `SFA NFC ${new Date().toISOString().slice(0,10)}`,
      status: 'active',
    });
  }

  /** Issue a PIN credential. */
  async issuePinCredential(userId, pin, label) {
    return this._req('POST', EP.credentials, {
      user_id: userId,
      credential_type: 'pin',
      pin_code: pin,
      alias: label || `SFA PIN ${new Date().toISOString().slice(0,10)}`,
      status: 'active',
    });
  }

  /**
   * Invite the tenant to enroll a mobile credential (UniFi Identity app).
   * The controller emails the tenant an enrollment link.
   */
  async inviteMobileCredential(userId, email) {
    return this._req('POST', EP.invitations, {
      user_id: userId,
      email,
      methods: ['touch_access', 'wave_access'],
    });
  }

  /** Revoke a credential (deactivate, not delete). */
  async revokeCredential(credentialId) {
    return this._req('PUT', EP.credential(credentialId), { status: 'inactive' });
  }
}

// ---------------------------------------------------------------------------
// Firebase Functions wiring
// ---------------------------------------------------------------------------

/**
 * Registers the two callables on the provided `exports` object. We take a
 * deps bag from index.js (rather than re-importing) so we don't have to
 * duplicate `admin.initializeApp()` or recompute WORKSPACE_ID.
 *
 * @param {object} deps
 * @param {object} deps.exports       — the index.js module.exports
 * @param {object} deps.HttpsError
 * @param {Function} deps.onCall
 * @param {Function} deps.defineSecret
 * @param {Function} deps.defineString
 * @param {object} deps.admin
 * @param {Function} deps.requireEditor  — async (auth) => {role, email}
 * @param {object} deps.logger
 * @param {string} deps.workspaceId
 */
function registerUnifiFunctions(deps) {
  const { exports: exp, HttpsError, onCall, defineSecret, defineString, admin, requireEditor, logger, workspaceId } = deps;

  const UNIFI_API_TOKEN = defineSecret('UNIFI_API_TOKEN');
  const UNIFI_BASE_URL  = defineString('UNIFI_BASE_URL', {
    description: 'UniFi Access controller base URL, e.g. https://unifi.example.com:12445',
  });

  const db = admin.firestore();
  const stateDocRef = () => db.doc(`workspaces/${workspaceId}/data/state`);

  let _client = null;
  function getUnifi() {
    if (_client) return _client;
    const baseUrl  = UNIFI_BASE_URL.value();
    const apiToken = UNIFI_API_TOKEN.value();
    if (!baseUrl) {
      throw new HttpsError('failed-precondition',
        'UNIFI_BASE_URL is not configured. Run: firebase deploy --only functions (you will be prompted), or edit functions/.env to set it.');
    }
    if (!apiToken) {
      throw new HttpsError('failed-precondition',
        'UNIFI_API_TOKEN is not set. Run: firebase functions:secrets:set UNIFI_API_TOKEN');
    }
    _client = new UnifiClient({ baseUrl, apiToken });
    return _client;
  }

  /** Find a unit by (buildingId, floorId, unitId) inside the workspace state. */
  async function readUnitFromState(buildingId, floorId, unitId) {
    const snap = await stateDocRef().get();
    if (!snap.exists) throw new HttpsError('failed-precondition', 'No workspace state yet — first sync from the client.');
    const envelope = snap.data();
    const state    = envelope.state || {};
    const b = (state.buildings || []).find(x => x.id === buildingId);
    if (!b) throw new HttpsError('not-found', `Building ${buildingId} not found`);
    const f = (b.floors || []).find(x => x.id === floorId);
    if (!f) throw new HttpsError('not-found', `Floor ${floorId} not found`);
    const u = (f.units || []).find(x => x.id === unitId);
    if (!u) throw new HttpsError('not-found', `Unit ${unitId} not found`);
    return { state, envelope, b, f, u };
  }

  /** Persist updated state back to Firestore with rev bump. */
  async function writeStateBack(envelope, state, actor) {
    envelope.state = state;
    envelope._rev  = (envelope._rev || 0) + 1;
    envelope._updatedAt = admin.firestore.FieldValue.serverTimestamp();
    envelope._updatedBy = actor || 'provisionAccessUser';
    await stateDocRef().set(envelope, { merge: true });
  }

  // ======================================================================
  // provisionAccessUser — create/update UniFi user + issue credential
  // ======================================================================
  exp.provisionAccessUser = onCall(
    { secrets: [UNIFI_API_TOKEN] },
    async (request) => {
      const actor = await requireEditor(request.auth);
      const {
        buildingId, floorId, unitId,
        credType,     // 'nfc' | 'mobile' | 'pin' | 'wallet'
        doorGroupId,  // maps to UniFi access_policy id
        nfcCardUid,   // required when credType === 'nfc'
        pin,          // required when credType === 'pin'
      } = request.data || {};

      // --- Argument validation ------------------------------------------
      if (!buildingId || !floorId || !unitId) throw new HttpsError('invalid-argument', 'buildingId, floorId, unitId required');
      if (!['nfc', 'mobile', 'pin', 'wallet'].includes(credType)) {
        throw new HttpsError('invalid-argument', `Unsupported credType: ${credType}`);
      }
      if (!doorGroupId) throw new HttpsError('invalid-argument', 'doorGroupId required');
      if (credType === 'nfc' && !/^[0-9a-fA-F]{6,16}$/.test(nfcCardUid || '')) {
        throw new HttpsError('invalid-argument', 'nfcCardUid must be 6–16 hex chars');
      }
      if (credType === 'pin' && !/^[0-9]{4,8}$/.test(pin || '')) {
        throw new HttpsError('invalid-argument', 'pin must be 4–8 digits');
      }
      if (credType === 'wallet') {
        throw new HttpsError('unimplemented',
          'Apple/Google Wallet pass provisioning is Phase 3. Pick nfc / mobile / pin for now.');
      }

      // --- Load unit / tenant data --------------------------------------
      const { state, envelope, u } = await readUnitFromState(buildingId, floorId, unitId);
      if (u.status !== 'occupied' || !u.tenant) {
        throw new HttpsError('failed-precondition', 'Unit has no tenant — assign one first.');
      }
      if (!u.email && credType === 'mobile') {
        throw new HttpsError('failed-precondition', 'Mobile invite needs tenant email — add it in the Tenant tab first.');
      }

      const externalId = `sfa:unit:${unitId}`;
      const [firstName, ...rest] = String(u.tenant || '').trim().split(/\s+/);
      const lastName = rest.join(' ');

      const unifi = getUnifi();
      logger.info(`[unifi] provision: unit=${unitId} credType=${credType} doorGroup=${doorGroupId} actor=${actor.email}`);

      // --- 1. Upsert user on the controller -----------------------------
      let userRec;
      try {
        userRec = await unifi.upsertUser({
          externalId,
          firstName, lastName,
          email: u.email,
          title: u.company || undefined,
        });
      } catch (err) {
        logger.error('[unifi] upsertUser failed:', err.message || err, err.details || '');
        throw new HttpsError('unavailable', `Controller user upsert failed: ${err.message}`);
      }
      const unifiUserId = userRec.id || userRec.user_id;
      if (!unifiUserId) {
        logger.error('[unifi] upsertUser returned no id:', userRec);
        throw new HttpsError('internal', 'Controller returned user record without id');
      }

      // --- 2. Assign door group (access policy) -------------------------
      try {
        await unifi.setUserAccessPolicies(unifiUserId, [doorGroupId]);
      } catch (err) {
        logger.error('[unifi] setUserAccessPolicies failed:', err.message || err);
        throw new HttpsError('unavailable', `Controller access-policy assignment failed: ${err.message}`);
      }

      // --- 3. Issue credential of the requested type --------------------
      let credRec = null;
      try {
        if (credType === 'nfc')    credRec = await unifi.issueNfcCredential(unifiUserId, nfcCardUid, `Unit ${u.id}`);
        else if (credType === 'pin')  credRec = await unifi.issuePinCredential(unifiUserId, pin, `Unit ${u.id}`);
        else if (credType === 'mobile') credRec = await unifi.inviteMobileCredential(unifiUserId, u.email);
      } catch (err) {
        logger.error(`[unifi] issue(${credType}) failed:`, err.message || err);
        // Write back an error status so the UI can show it.
        u.access = {
          ...(u.access || {}),
          provider: 'unifi',
          userId: unifiUserId,
          credType,
          doorGroupId,
          status: 'error',
          lastSyncAt: new Date().toISOString(),
          lastError: err.message || 'Credential issue failed',
        };
        await writeStateBack(envelope, state, actor.email);
        throw new HttpsError('unavailable', `Credential issue failed: ${err.message}`);
      }
      const credentialId = credRec && (credRec.id || credRec.credential_id || credRec.invitation_id);

      // --- 4. Mirror into u.access and persist --------------------------
      u.access = {
        provider: 'unifi',
        userId: unifiUserId,
        credentialId: credentialId || (u.access && u.access.credentialId) || '',
        credType,
        doorGroupId,
        cardUid: credType === 'nfc' ? nfcCardUid : '',
        pin:     credType === 'pin' ? pin : '',  // stored only for operator reference; hashed on controller
        status: credType === 'mobile' ? 'pending' : 'active',  // mobile needs enrollment
        lastSyncAt: new Date().toISOString(),
        lastError: '',
      };
      await writeStateBack(envelope, state, actor.email);

      logger.info(`[unifi] provisioned: unit=${unitId} user=${unifiUserId} credential=${credentialId || '—'}`);
      return {
        status: u.access.status,
        unifiUserId,
        credentialId: credentialId || null,
        credType,
        // For mobile invites the controller returns an enrollment URL —
        // surface it so the operator can copy-paste to the tenant.
        inviteUrl: (credRec && (credRec.enrollment_url || credRec.invite_url)) || null,
      };
    }
  );

  // ======================================================================
  // revokeAccessUser — deactivate credential + optionally user
  // ======================================================================
  exp.revokeAccessUser = onCall(
    { secrets: [UNIFI_API_TOKEN] },
    async (request) => {
      const actor = await requireEditor(request.auth);
      const { buildingId, floorId, unitId, disableUser: disableUserOpt } = request.data || {};
      if (!buildingId || !floorId || !unitId) throw new HttpsError('invalid-argument', 'buildingId, floorId, unitId required');

      const { state, envelope, u } = await readUnitFromState(buildingId, floorId, unitId);
      const acc = u.access || {};
      if (!acc.credentialId && !acc.userId) {
        throw new HttpsError('failed-precondition', 'Nothing to revoke — unit has no active credential.');
      }

      const unifi = getUnifi();
      logger.info(`[unifi] revoke: unit=${unitId} cred=${acc.credentialId} user=${acc.userId} actor=${actor.email}`);

      if (acc.credentialId) {
        try { await unifi.revokeCredential(acc.credentialId); }
        catch (err) {
          logger.error('[unifi] revokeCredential failed:', err.message || err);
          // Record the error but keep going to user-disable — operator
          // probably still wants the tenant's access pulled.
          acc.lastError = `Credential revoke failed: ${err.message}`;
        }
      }
      if (disableUserOpt && acc.userId) {
        try { await unifi.disableUser(acc.userId); }
        catch (err) {
          logger.error('[unifi] disableUser failed:', err.message || err);
          acc.lastError = (acc.lastError ? acc.lastError + ' | ' : '') + `User disable failed: ${err.message}`;
        }
      }

      u.access = {
        ...acc,
        status: 'revoked',
        lastSyncAt: new Date().toISOString(),
      };
      await writeStateBack(envelope, state, actor.email);
      return { status: 'revoked', credentialId: acc.credentialId, userId: acc.userId };
    }
  );
}

module.exports = { UnifiClient, registerUnifiFunctions };
