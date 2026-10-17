// Регрессионный тест FIXES_LOG Entry 92: dsCreateSigningLink / dsSigningLinkSession.
// Запуск: node tests/sign-link-cf.test.cjs  (нужен functions/node_modules).
// Грузит functions/index.js с подменёнными firebase-* модулями, Firestore в
// памяти и поддельным DocuSign через global.fetch. Ничего наружу не ходит.
'use strict';
const Module = require('module');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const FN_DIR = process.argv[2] || path.join(__dirname, '..', 'functions');
const realLoad = Module._load;

// ---------- generic stub ----------
const anyFn = new Proxy(function () {}, {
  get: (t, p) => (p === 'then' ? undefined : (p === Symbol.toPrimitive ? () => '' : anyFn)),
  apply: () => anyFn,
  construct: () => anyFn,
});
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- in-memory Firestore ----------
const store = new Map();
const SERVER_TS = { __serverTs: true };
class Timestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  static fromMillis(ms) { return new Timestamp(ms); }
}
function resolveSentinels(obj, prev) {
  const out = Object.assign({}, prev || {});
  for (const [k, v] of Object.entries(obj)) {
    if (v === SERVER_TS) out[k] = new Timestamp(Date.now());
    else if (v && v.__inc != null) out[k] = (+(prev && prev[k]) || 0) + v.__inc;
    else out[k] = v;
  }
  return out;
}
function docRef(p) {
  return {
    path: p,
    async get() { const d = store.get(p); return { exists: !!d, data: () => (d ? Object.assign({}, d) : undefined) }; },
    async set(data, opts) { store.set(p, resolveSentinels(data, opts && opts.merge ? store.get(p) : null)); },
    async update(data) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, resolveSentinels(data, store.get(p))); },
  };
}
const auditLog = [];
const db = {
  doc: (p) => docRef(p),
  collection: (p) => ({ add: async (d) => { auditLog.push(Object.assign({ _col: p }, d)); return { id: 'x' }; } }),
  runTransaction: async (fn) => {
    const pending = [];
    const tx = {
      get: (ref) => ref.get(),
      update: (ref, data) => pending.push(() => ref.update(data)),
      set: (ref, data, o) => pending.push(() => ref.set(data, o)),
    };
    const r = await fn(tx);
    for (const p of pending) await p();
    return r;
  },
};
const firestoreFn = Object.assign(() => db, {
  FieldValue: { serverTimestamp: () => SERVER_TS, increment: (n) => ({ __inc: n }), arrayUnion: anyFn, delete: anyFn },
  Timestamp,
});
const adminStub = { initializeApp: () => {}, firestore: firestoreFn, storage: anyFn, auth: anyFn, app: anyFn };

Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') return adminStub;
  if (request === 'firebase-functions/v2/https') {
    return { onCall: (o, h) => (typeof o === 'function' ? o : h), onRequest: (o, h) => (typeof o === 'function' ? o : h), HttpsError };
  }
  if (request === 'firebase-functions/params') {
    return { defineSecret: (n) => ({ name: n, value: () => 'FAKE-' + n }), defineString: (n, o) => ({ value: () => (o && o.default) || '' }) };
  }
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {}, log() {} };
  if (request.startsWith('firebase-functions')) return anyFn;
  if (request === 'jsonwebtoken') return { sign: () => 'fake-assertion' };
  if (request.startsWith('./') && parent && parent.filename && path.dirname(parent.filename) === FN_DIR) return anyFn;
  return realLoad.apply(this, arguments);
};

// ---------- fake DocuSign ----------
const DS = { calls: [], envelopes: new Map(), failPutRecipients: null, failView: false, failGet: false };
function jsonRes(obj, status = 200) {
  return { ok: status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj), arrayBuffer: async () => Buffer.from('%PDF') };
}
global.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  if (url.includes('/oauth/token')) return jsonRes({ access_token: 'tok', expires_in: 3600 });
  DS.calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
  const m = /\/envelopes\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(url);
  if (!m) return jsonRes({ errorCode: 'NOPE', message: 'unknown url ' + url }, 404);
  const id = decodeURIComponent(m[1]);
  const sub = m[2] || '';
  const env = DS.envelopes.get(id);
  if (!env) return jsonRes({ errorCode: 'ENVELOPE_DOES_NOT_EXIST', message: 'secret account 1234 path' }, 400);
  if (method === 'GET' && !sub) {
    if (DS.failGet) return jsonRes({ errorCode: 'INTERNAL', message: 'acct 99999 internal detail' }, 500);
    return jsonRes(JSON.parse(JSON.stringify(env)));
  }
  if (method === 'PUT' && sub === '/recipients') {
    const body = JSON.parse(opts.body);
    if (DS.failPutRecipients) {
      return jsonRes({ recipientUpdateResults: [{ recipientId: '1', errorDetails: { errorCode: DS.failPutRecipients, message: 'nope' } }] });
    }
    for (const s of body.signers) {
      const t = env.recipients.signers.find((x) => x.recipientId === s.recipientId);
      Object.assign(t, { clientUserId: s.clientUserId, embeddedRecipientStartURL: s.embeddedRecipientStartURL });
    }
    return jsonRes({ recipientUpdateResults: body.signers.map((s) => ({ recipientId: s.recipientId, errorDetails: { errorCode: 'SUCCESS', message: '' } })) });
  }
  if (method === 'POST' && sub === '/views/recipient') {
    const body = JSON.parse(opts.body);
    if (DS.failView) return jsonRes({ errorCode: 'UNKNOWN_ENVELOPE_RECIPIENT', message: 'acct 12345 detail' }, 400);
    const s = env.recipients.signers.find((x) => x.recipientId === body.recipientId);
    if (!s || s.clientUserId !== body.clientUserId || s.email !== body.email || s.name !== body.userName) {
      return jsonRes({ errorCode: 'UNKNOWN_ENVELOPE_RECIPIENT', message: 'mismatch' }, 400);
    }
    return jsonRes({ url: 'https://demo.docusign.net/Signing/StartInSession.aspx?t=one-time' });
  }
  return jsonRes({ errorCode: 'UNSUPPORTED' }, 400);
};

// ---------- workspace fixtures ----------
store.set('workspaces/default/integrations/docusign', {
  authMode: 'jwt', integrationKey: 'ik', userId: 'uid', baseUri: 'https://demo.docusign.net', oauthHost: 'account-d.docusign.com', apiAccountId: 'acct',
});
store.set('workspaces/default/members/mgr', { role: 'manager', email: 'mgr@x.com' });
store.set('workspaces/default/members/viewer', { role: 'viewer', email: 'v@x.com' });
const EID = '11111111-2222-4333-8444-555555555555';
function freshEnvelope(over) {
  DS.envelopes.set(EID, Object.assign({
    envelopeId: EID, status: 'sent', emailSubject: 'Lease for Suite 301',
    recipients: { signers: [{ recipientId: '1', routingOrder: '1', email: 'bjoern@example.com', name: 'Bjoern Henning', status: 'sent' }] },
  }, over || {}));
}

const fns = require(path.join(FN_DIR, 'index.js'));
const create = fns.dsCreateSigningLink;
const session = fns.dsSigningLinkSession;
assert.strictEqual(typeof create, 'function', 'dsCreateSigningLink exported');
assert.strictEqual(typeof session, 'function', 'dsSigningLinkSession exported');

const mgrAuth = { uid: 'mgr', token: { email: 'mgr@x.com' } };
async function expectErr(p, code, re) {
  try { await p; } catch (e) {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (re) assert.ok(re.test(e.message), `message ${e.message} !~ ${re}`);
    return e;
  }
  throw new Error(`expected ${code}, got success`);
}
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
}
const tokenOf = (url) => new URL(url).searchParams.get('t');

(async () => {
  let token;
  await test('create: converts remote signer + stores only hash', async () => {
    freshEnvelope(); DS.calls.length = 0;
    const r = await create({ auth: mgrAuth, data: { envelopeId: EID, unitId: '301', buildingId: 'b1', floorId: 'f1' } });
    assert.ok(r.url.startsWith('https://suitesforall.web.app/sign.html?t='));
    token = tokenOf(r.url);
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token), 'token is 43-char base64url');
    assert.strictEqual(r.converted, true);
    assert.strictEqual(r.recipientEmail, 'bjoern@example.com');
    const put = DS.calls.find((c) => c.method === 'PUT');
    assert.ok(put && /\/recipients$/.test(put.url));
    assert.strictEqual(put.body.signers[0].embeddedRecipientStartURL, 'SIGN_AT_DOCUSIGN');
    assert.ok(/^sfa-/.test(put.body.signers[0].clientUserId));
    assert.deepStrictEqual(Object.keys(put.body.signers[0]).sort(), ['clientUserId', 'embeddedRecipientStartURL', 'recipientId'], 'PUT must not send email/name (DocuSign treats any email as new → correction email)');
    const testView = DS.calls.find((c) => c.method === 'POST' && /views\/recipient$/.test(c.url));
    assert.ok(testView, 'test recipient view is created before handing out the link');
    assert.ok(testView.body.returnUrl.endsWith(token), 'test view returnUrl carries the same token');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const doc = store.get(`workspaces/default/docusign_sign_links/${hash}`);
    assert.ok(doc, 'link doc keyed by sha256(token)');
    assert.ok(!JSON.stringify(doc).includes(token), 'plaintext token not stored');
    assert.strictEqual(doc.envelopeId, EID);
    assert.ok(auditLog.some((a) => a.action === 'sign-link-create'));
  });
  await test('create: second link reuses embedded signer (no PUT)', async () => {
    DS.calls.length = 0;
    const r = await create({ auth: mgrAuth, data: { envelopeId: EID } });
    assert.strictEqual(r.converted, false);
    assert.ok(!DS.calls.some((c) => c.method === 'PUT'));
    assert.notStrictEqual(tokenOf(r.url), token, 'new token each time');
  });
  await test('create: bounced signer still gets a link + bounced flag', async () => {
    freshEnvelope(); DS.envelopes.get(EID).recipients.signers[0].status = 'autoresponded';
    const r = await create({ auth: mgrAuth, data: { envelopeId: EID } });
    assert.strictEqual(r.bounced, true);
    token = tokenOf(r.url);
  });
  await test('create: viewer is refused', async () => {
    await expectErr(create({ auth: { uid: 'viewer', token: {} }, data: { envelopeId: EID } }), 'permission-denied');
  });
  await test('create: anonymous refused', async () => {
    await expectErr(create({ auth: null, data: { envelopeId: EID } }), 'unauthenticated');
  });
  await test('create: bad envelopeId', async () => {
    await expectErr(create({ auth: mgrAuth, data: { envelopeId: '../../x' } }), 'invalid-argument');
  });
  await test('create: completed envelope refused', async () => {
    freshEnvelope({ status: 'completed' });
    await expectErr(create({ auth: mgrAuth, data: { envelopeId: EID } }), 'failed-precondition', /completed/);
  });
  await test('create: DocuSign rejects recipient update → failed-precondition', async () => {
    freshEnvelope(); DS.failPutRecipients = 'RECIPIENT_UPDATE_FAILED';
    await expectErr(create({ auth: mgrAuth, data: { envelopeId: EID } }), 'failed-precondition', /RECIPIENT_UPDATE_FAILED/);
    DS.failPutRecipients = null;
  });

  await test('create: account refuses embedded signing → no link, no doc, operator told reminders are off', async () => {
    freshEnvelope(); DS.failView = true;
    const before = [...store.keys()].filter((k) => k.includes('docusign_sign_links')).length;
    const e = await expectErr(create({ auth: mgrAuth, data: { envelopeId: EID } }), 'failed-precondition', /would not open/);
    assert.ok(/reminders are off/.test(e.message), 'message says the signer is already switched');
    assert.ok(auditLog.some((a) => a.action === 'sign-link-view-failed'));
    const after = [...store.keys()].filter((k) => k.includes('docusign_sign_links')).length;
    assert.strictEqual(after, before, 'no link stored when DocuSign refuses');
    DS.failView = false;
  });
  await test('create: bounce reason surfaced to operator', async () => {
    freshEnvelope(); Object.assign(DS.envelopes.get(EID).recipients.signers[0], { status: 'autoresponded', autoRespondedReason: '550 5.1.1 mailbox unavailable' });
    const r = await create({ auth: mgrAuth, data: { envelopeId: EID } });
    assert.strictEqual(r.bounced, true);
    assert.ok(/550/.test(r.bounceReason));
  });

  await test('create: two operators at once → both links stay valid (same clientUserId)', async () => {
    freshEnvelope();
    const [r1, r2] = await Promise.all([
      create({ auth: mgrAuth, data: { envelopeId: EID } }),
      create({ auth: mgrAuth, data: { envelopeId: EID } }),
    ]);
    const puts = DS.calls.filter((c) => c.method === 'PUT').slice(-2).map((c) => c.body.signers[0].clientUserId);
    assert.strictEqual(new Set(puts).size, 1, 'both PUTs carry the same clientUserId');
    for (const r of [r1, r2]) {
      const o = await session({ auth: null, data: { t: tokenOf(r.url), action: 'open' } });
      assert.ok(o.url, 'link opens');
    }
  });

  // ---------- public session ----------
  freshEnvelope();
  const c = await create({ auth: mgrAuth, data: { envelopeId: EID } });
  token = tokenOf(c.url);
  await test('session: peek → ready + first name only, no email', async () => {
    DS.calls.length = 0;
    const r = await session({ auth: null, data: { t: token, action: 'peek' } });
    assert.strictEqual(DS.calls.length, 0, 'peek must not call DocuSign');
    assert.deepStrictEqual(Object.keys(r).sort(), ['recipientName', 'status', 'subject']);
    assert.strictEqual(r.status, 'ready');
    assert.strictEqual(r.recipientName, 'Bjoern');
    assert.ok(!JSON.stringify(r).includes('@'));
  });
  await test('session: open → one-time DocuSign url; returnUrl carries token', async () => {
    DS.calls.length = 0;
    const r = await session({ auth: null, data: { t: token, action: 'open' } });
    assert.ok(/^https:\/\/demo\.docusign\.net\//.test(r.url));
    const post = DS.calls.find((x) => x.method === 'POST');
    assert.strictEqual(post.body.returnUrl, `https://suitesforall.web.app/sign.html?t=${token}`);
    assert.ok(post.body.clientUserId && post.body.authenticationMethod);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    assert.strictEqual(store.get(`workspaces/default/docusign_sign_links/${hash}`).opens, 1);
  });
  await test('session: unknown token → not-found', async () => {
    await expectErr(session({ auth: null, data: { t: 'Z'.repeat(43), action: 'peek' } }), 'not-found');
  });
  await test('session: malformed token → invalid-argument', async () => {
    await expectErr(session({ auth: null, data: { t: 'abc', action: 'peek' } }), 'invalid-argument');
    await expectErr(session({ auth: null, data: { t: { $gt: '' }, action: 'peek' } }), 'invalid-argument');
  });
  await test('session: completed envelope → status completed (no url)', async () => {
    DS.envelopes.get(EID).status = 'completed';
    const r = await session({ auth: null, data: { t: token, action: 'open' } });
    assert.deepStrictEqual(r, { status: 'completed' });
    DS.envelopes.get(EID).status = 'sent';
    store.get(`workspaces/default/docusign_sign_links/${crypto.createHash('sha256').update(token).digest('hex')}`).deadStatus = null;
  });
  await test('session: signer already signed (envelope still sent) → completed', async () => {
    DS.envelopes.get(EID).recipients.signers[0].status = 'completed';
    const r = await session({ auth: null, data: { t: token, action: 'open' } });
    assert.deepStrictEqual(r, { status: 'completed' });
    DS.envelopes.get(EID).recipients.signers[0].status = 'sent';
    store.get(`workspaces/default/docusign_sign_links/${crypto.createHash('sha256').update(token).digest('hex')}`).deadStatus = null;
  });
  await test('session: voided → open says voided, link marked dead, peek then answers without DocuSign', async () => {
    DS.envelopes.get(EID).status = 'voided';
    const r = await session({ auth: null, data: { t: token, action: 'open' } });
    assert.deepStrictEqual(r, { status: 'voided' });
    DS.calls.length = 0;
    const r2 = await session({ auth: null, data: { t: token, action: 'peek' } });
    assert.deepStrictEqual(r2, { status: 'voided' });
    assert.strictEqual(DS.calls.length, 0);
    // восстановление для дальнейших тестов
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    store.get(`workspaces/default/docusign_sign_links/${hash}`).deadStatus = null;
    DS.envelopes.get(EID).status = 'sent';
  });
  await test('session: signer clientUserId changed → status replaced, link dead', async () => {
    const s = DS.envelopes.get(EID).recipients.signers[0];
    const keep = s.clientUserId; s.clientUserId = 'someone-else';
    const r = await session({ auth: null, data: { t: token, action: 'open' } });
    assert.deepStrictEqual(r, { status: 'replaced' });
    s.clientUserId = keep;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    store.get(`workspaces/default/docusign_sign_links/${hash}`).deadStatus = null;
  });
  await test('session: recipient corrected to another email (same clientUserId) → old link cannot sign as the new person; new link works', async () => {
    const s = DS.envelopes.get(EID).recipients.signers[0];
    const keep = { email: s.email, name: s.name };
    Object.assign(s, { email: 'bob@other.com', name: 'Bob Other' });
    DS.calls.length = 0;
    const r = await session({ auth: null, data: { t: token, action: 'open' } });
    assert.deepStrictEqual(r, { status: 'replaced' });
    assert.ok(!DS.calls.some((c) => c.method === 'POST'), 'no recipient view for the old link');
    const r2 = await session({ auth: null, data: { t: token, action: 'peek' } });
    assert.deepStrictEqual(r2, { status: 'replaced' }, 'peek now also says replaced');
    // оператор создаёт новую ссылку — та работает для Bob
    const n = await create({ auth: mgrAuth, data: { envelopeId: EID } });
    assert.strictEqual(n.recipientEmail, 'bob@other.com');
    const o = await session({ auth: null, data: { t: tokenOf(n.url), action: 'open' } });
    assert.ok(o.url);
    // email только в другом регистре — та же персона, ссылка жива
    s.email = 'BOB@Other.com ';
    const o2 = await session({ auth: null, data: { t: tokenOf(n.url), action: 'open' } });
    assert.ok(o2.url, 'case/space-insensitive email match');
    Object.assign(s, keep);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    store.get(`workspaces/default/docusign_sign_links/${hash}`).deadStatus = null;
  });
  await test('session: DocuSign errors are not leaked', async () => {
    DS.failView = true;
    const e = await expectErr(session({ auth: null, data: { t: token, action: 'open' } }), 'unavailable');
    assert.ok(!/acct|12345|UNKNOWN/.test(e.message), 'no DocuSign detail in message');
    DS.failView = false;
    DS.failGet = true;
    const e2 = await expectErr(session({ auth: null, data: { t: token, action: 'open' } }), 'unavailable');
    assert.ok(!/acct|99999/.test(e2.message));
    DS.failGet = false;
  });
  await test('session: revoked / expired', async () => {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const p = `workspaces/default/docusign_sign_links/${hash}`;
    store.get(p).revoked = true;
    await expectErr(session({ auth: null, data: { t: token, action: 'peek' } }), 'failed-precondition', /turned off/);
    store.get(p).revoked = false;
    store.get(p).expiresAt = Timestamp.fromMillis(Date.now() - 1000);
    await expectErr(session({ auth: null, data: { t: token, action: 'peek' } }), 'failed-precondition', /expired/);
    store.get(p).expiresAt = Timestamp.fromMillis(Date.now() + 86400000);
  });
  await test('session: rate limit per link per hour', async () => {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const p = `workspaces/default/docusign_sign_links/${hash}`;
    store.get(p).rlCount = 0; store.get(p).rlWindowStart = Timestamp.fromMillis(Date.now());
    let ok = 0;
    for (let i = 0; i < 40; i++) { await session({ auth: null, data: { t: token, action: 'peek' } }); ok++; }
    await expectErr(session({ auth: null, data: { t: token, action: 'peek' } }), 'resource-exhausted');
    // окно истекло → снова можно
    store.get(p).rlWindowStart = Timestamp.fromMillis(Date.now() - 3600 * 1000 - 1);
    const r = await session({ auth: null, data: { t: token, action: 'peek' } });
    assert.strictEqual(r.status, 'ready');
    assert.strictEqual(store.get(p).rlCount, 1);
    assert.strictEqual(ok, 40);
  });

  for (const r of results) console.log(r.join(' — '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
