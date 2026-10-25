// Общий стаб-харнесс для tests/mail-*.test.cjs (UNIT_EMAIL_PLAN.md Phase 0).
// По образцу tests/sign-link-cf.test.cjs: подменяем firebase-admin / firebase-
// functions / googleapis через Module._load, Firestore и Storage — в памяти,
// Gmail — фикстура. Ничего наружу не ходит. Модули грузятся из functions/.
'use strict';
const Module = require('module');
const path = require('path');

const FN_DIR = process.env.SFA_FN_DIR || path.join(__dirname, '..', 'functions');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- sentinels ----------
const SERVER_TS = { __serverTs: true };
class Timestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
  static fromMillis(ms) { return new Timestamp(ms); }
  static now() { return new Timestamp(Date.now()); }
}
const FieldValue = {
  serverTimestamp: () => SERVER_TS,
  increment: (n) => ({ __inc: n }),
  arrayUnion: (...items) => ({ __arrayUnion: items }),
  arrayRemove: (...items) => ({ __arrayRemove: items }),
  delete: () => ({ __delete: true }),
};

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Timestamp ? { __ts: x.ms } : x)), (k, x) => (x && x.__ts != null ? new Timestamp(x.__ts) : x)); }

function getPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}
function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = value;
}
function deletePath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (cur == null) return; cur = cur[parts[i]]; }
  if (cur) delete cur[parts[parts.length - 1]];
}
function resolveValue(v, prev) {
  if (v === SERVER_TS) return new Timestamp(Date.now());
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp)) {
    if (v.__inc != null) return (+prev || 0) + v.__inc;
    if (v.__arrayUnion) { const arr = Array.isArray(prev) ? prev.slice() : []; for (const it of v.__arrayUnion) if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(it))) arr.push(it); return arr; }
    if (v.__arrayRemove) { const arr = Array.isArray(prev) ? prev.slice() : []; return arr.filter((x) => !v.__arrayRemove.some((it) => JSON.stringify(x) === JSON.stringify(it))); }
    if (v.__delete) return undefined;
    const out = {};
    for (const [k, x] of Object.entries(v)) { const r = resolveValue(x, prev && prev[k]); if (r !== undefined) out[k] = r; }
    return out;
  }
  return v;
}
function applySet(prev, data, merge) {
  const base = merge && prev ? clone(prev) : {};
  for (const [k, v] of Object.entries(data)) {
    if (merge && k.includes('.')) { const r = resolveValue(v, getPath(base, k)); if (r === undefined) deletePath(base, k); else setPath(base, k, r); continue; }
    const r = resolveValue(v, base[k]);
    if (r === undefined) delete base[k]; else base[k] = r;
  }
  return base;
}
function applyUpdate(prev, data) {
  const base = clone(prev);
  for (const [k, v] of Object.entries(data)) {
    const r = resolveValue(v, getPath(base, k));
    if (r === undefined) deletePath(base, k); else setPath(base, k, r);
  }
  return base;
}

function cmp(a, b) {
  const av = a instanceof Timestamp ? a.ms : a;
  const bv = b instanceof Timestamp ? b.ms : b;
  if (av === bv) return 0;
  if (av == null) return -1;
  if (bv == null) return 1;
  return av < bv ? -1 : 1;
}

// ---------- in-memory Firestore ----------
function makeFirestore() {
  const store = new Map();          // path → data
  const auditLog = [];              // collection().add() для audit
  let autoId = 0;

  function snapOf(p) {
    const d = store.get(p);
    const id = p.split('/').pop();
    return { exists: !!d, id, ref: docRef(p), data: () => (d ? clone(d) : undefined), get: (f) => (d ? getPath(d, f) : undefined) };
  }
  function docRef(p) {
    return {
      path: p,
      id: p.split('/').pop(),
      parent: { path: p.split('/').slice(0, -1).join('/') },
      collection: (name) => collectionRef(p + '/' + name),
      async get() { return snapOf(p); },
      async set(data, opts) { store.set(p, applySet(store.get(p), data, !!(opts && opts.merge))); },
      async update(data) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, applyUpdate(store.get(p), data)); },
      async delete() { store.delete(p); },
    };
  }
  function matches(data, f) {
    const v = getPath(data, f.field);
    switch (f.op) {
      case '==': return cmp(v, f.value) === 0;
      case '!=': return cmp(v, f.value) !== 0;
      case '<': return v != null && cmp(v, f.value) < 0;
      case '<=': return v != null && cmp(v, f.value) <= 0;
      case '>': return v != null && cmp(v, f.value) > 0;
      case '>=': return v != null && cmp(v, f.value) >= 0;
      case 'array-contains': return Array.isArray(v) && v.some((x) => cmp(x, f.value) === 0);
      case 'array-contains-any': return Array.isArray(v) && v.some((x) => (f.value || []).some((y) => cmp(x, y) === 0));
      case 'in': return (f.value || []).some((y) => cmp(v, y) === 0);
      default: throw new Error('unsupported op ' + f.op);
    }
  }
  function collectionRef(p, q) {
    q = q || { filters: [], order: [], limit: null, startAfter: null, select: null };
    const self = {
      path: p,
      doc: (id) => docRef(p + '/' + (id || ('auto' + (++autoId)))),
      async add(data) {
        const id = 'auto' + (++autoId);
        const full = applySet(null, data, false);
        store.set(p + '/' + id, full);
        if (p.endsWith('/audit')) auditLog.push(Object.assign({ _id: id }, clone(full)));
        return docRef(p + '/' + id);
      },
      where: (field, op, value) => collectionRef(p, Object.assign({}, q, { filters: q.filters.concat([{ field, op, value }]) })),
      orderBy: (field, dir) => collectionRef(p, Object.assign({}, q, { order: q.order.concat([{ field, dir: dir || 'asc' }]) })),
      limit: (n) => collectionRef(p, Object.assign({}, q, { limit: n })),
      startAfter: (...vals) => collectionRef(p, Object.assign({}, q, { startAfter: vals })),
      select: () => collectionRef(p, Object.assign({}, q, { select: true })),
      async get() {
        let rows = [];
        for (const [k, d] of store.entries()) {
          if (!k.startsWith(p + '/')) continue;
          if (k.slice(p.length + 1).includes('/')) continue; // only direct children
          if (q.filters.every((f) => matches(d, f))) rows.push({ path: k, data: d });
        }
        if (q.order.length) {
          rows.sort((a, b) => {
            for (const o of q.order) { const c = cmp(getPath(a.data, o.field), getPath(b.data, o.field)); if (c) return o.dir === 'desc' ? -c : c; }
            return 0;
          });
        }
        if (q.startAfter && q.order.length) {
          const idx = rows.findIndex((r) => q.order.every((o, i) => cmp(getPath(r.data, o.field), q.startAfter[i]) === 0));
          if (idx >= 0) rows = rows.slice(idx + 1);
          else rows = rows.filter((r) => { const c = cmp(getPath(r.data, q.order[0].field), q.startAfter[0]); return q.order[0].dir === 'desc' ? c < 0 : c > 0; });
        }
        if (q.limit != null) rows = rows.slice(0, q.limit);
        const docs = rows.map((r) => snapOf(r.path));
        return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn) };
      },
    };
    return self;
  }
  const db = {
    doc: (p) => docRef(p),
    collection: (p) => collectionRef(p),
    batch: () => {
      const ops = [];
      const b = {
        set: (ref, data, o) => { ops.push(() => ref.set(data, o)); return b; },
        update: (ref, data) => { ops.push(() => ref.update(data)); return b; },
        delete: (ref) => { ops.push(() => ref.delete()); return b; },
        commit: async () => { for (const op of ops) await op(); return []; },
      };
      return b;
    },
    runTransaction: async (fn) => {
      const pending = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, o) => { pending.push(() => ref.set(data, o)); return tx; },
        update: (ref, data) => { pending.push(() => ref.update(data)); return tx; },
        delete: (ref) => { pending.push(() => ref.delete()); return tx; },
      };
      const r = await fn(tx);
      for (const p of pending) await p();
      return r;
    },
  };
  return { db, store, auditLog };
}

// ---------- in-memory Storage ----------
function makeStorage() {
  const files = new Map(); // path → {buf, contentType, metadata}
  const signed = [];
  function file(p) {
    return {
      name: p,
      async save(buf, opts) { files.set(p, { buf: Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)), contentType: opts && opts.contentType, metadata: opts && opts.metadata }); },
      async download() { const f = files.get(p); if (!f) { const e = new Error('No such object: ' + p); e.code = 404; throw e; } return [f.buf]; },
      async exists() { return [files.has(p)]; },
      async delete() { files.delete(p); },
      async getSignedUrl(opts) { signed.push({ path: p, opts }); return ['https://signed.example/' + encodeURIComponent(p) + '?exp=' + (opts && opts.expires)]; },
      async getMetadata() { const f = files.get(p); return [{ contentType: f && f.contentType, size: f ? f.buf.length : 0 }]; },
    };
  }
  const bucket = () => ({ name: 'test-bucket', file });
  return { files, signed, storage: () => ({ bucket }) };
}

// ---------- fake Gmail (googleapis) ----------
// fixture.mailboxes[address] = { historyId, messages: Map(id → gmail message), history: [{id, messagesAdded:[ids]}], expiredBefore }
function makeGoogle(fixture) {
  const calls = [];
  class JWT { constructor(o) { Object.assign(this, o); } }
  function err(status, message) { const e = new Error(message || ('HTTP ' + status)); e.code = status; e.status = status; e.response = { status }; return e; }
  function gmail({ auth }) {
    const address = auth && auth.subject;
    const box = () => {
      const b = fixture.mailboxes[address];
      if (!b) throw err(401, 'unauthorized_client (no fixture mailbox for ' + address + ')');
      if (b.failWith) throw err(b.failWith, 'fixture failure');
      return b;
    };
    const rec = (name, args) => calls.push({ address, name, args: clone(args) });
    const users = {
      async getProfile(a) { rec('getProfile', a); const b = box(); return { data: { emailAddress: address, historyId: String(b.historyId), messagesTotal: b.messages.size } }; },
      async watch(a) { rec('watch', a); const b = box(); b.watched = clone(a.requestBody); return { data: { historyId: String(b.historyId), expiration: String(Date.now() + 7 * 86400000) } }; },
      async stop(a) { rec('stop', a); const b = box(); b.watched = null; return { data: {} }; },
      history: {
        async list(a) {
          rec('history.list', a); const b = box();
          const start = +a.startHistoryId;
          if (b.expiredBefore != null && start < b.expiredBefore) throw err(404, 'Requested entity was not found.');
          const page = +(a.pageToken || 0);
          const size = a.maxResults || 100;
          const recs = (b.history || []).filter((h) => +h.id > start).sort((x, y) => +x.id - +y.id);
          const slice = recs.slice(page * size, (page + 1) * size).map((h) => ({ id: String(h.id), messagesAdded: (h.messagesAdded || []).map((id) => { const m = b.messages.get(id); return { message: { id, threadId: m ? m.threadId : 't?', labelIds: m ? m.labelIds : [] } }; }) }));
          const out = { history: slice, historyId: String(b.historyId) };
          if ((page + 1) * size < recs.length) out.nextPageToken = String(page + 1);
          return { data: out };
        },
      },
      messages: {
        async list(a) {
          rec('messages.list', a); const b = box();
          const page = +(a.pageToken || 0);
          const size = a.maxResults || 100;
          let all = Array.from(b.messages.values());
          if (b.listFilter) all = all.filter((m) => b.listFilter(m, a.q));
          all.sort((x, y) => +y.internalDate - +x.internalDate);
          const slice = all.slice(page * size, (page + 1) * size).map((m) => ({ id: m.id, threadId: m.threadId }));
          const out = { messages: slice, resultSizeEstimate: all.length };
          if ((page + 1) * size < all.length) out.nextPageToken = String(page + 1);
          return { data: out };
        },
        async get(a) { rec('messages.get', a); const b = box(); const m = b.messages.get(a.id); if (!m) throw err(404, 'Not Found'); return { data: clone(m) }; },
        attachments: {
          async get(a) { rec('attachments.get', a); const b = box(); const att = (b.attachments || {})[a.id]; if (!att) throw err(404, 'Not Found'); return { data: { size: att.length, data: Buffer.from(att).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } }; },
        },
        async send(a) { rec('messages.send', a); const b = box(); const id = 'sent' + (b.messages.size + 1); const m = { id, threadId: a.requestBody.threadId || ('t' + id), labelIds: ['SENT'], internalDate: String(Date.now()), payload: { headers: [{ name: 'Message-ID', value: '<' + id + '@fake>' }] }, raw: a.requestBody.raw }; b.messages.set(id, m); return { data: { id, threadId: m.threadId, labelIds: m.labelIds } }; },
      },
      threads: { async get(a) { rec('threads.get', a); throw err(501, 'not in fixture'); } },
    };
    return { users };
  }
  return { google: { auth: { JWT }, gmail }, calls };
}

// ---------- harness ----------
function makeHarness(opts) {
  opts = opts || {};
  const fs = makeFirestore();
  const st = makeStorage();
  const fixture = { mailboxes: {} };
  const g = makeGoogle(fixture);
  const firestoreFn = Object.assign(() => fs.db, { FieldValue, Timestamp });
  const adminStub = { initializeApp: () => {}, firestore: firestoreFn, storage: st.storage, auth: () => ({}), app: () => ({}) };
  const logs = [];
  const logger = { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]), debug() {}, log() {} };
  const secrets = Object.assign({ MAIL_SA_KEY: JSON.stringify({ client_email: 'sa@test.iam', private_key: '-----BEGIN KEY-----', project_id: 'test-proj' }) }, opts.secrets || {});
  const realLoad = Module._load;
  const scheduled = [];
  const pubsub = [];
  function install() {
    Module._load = function (request, parent, isMain) {
      if (request === 'firebase-admin') return adminStub;
      if (request === 'firebase-functions/v2/https') return { onCall: (o, h) => (typeof o === 'function' ? o : h), onRequest: (o, h) => (typeof o === 'function' ? o : h), HttpsError };
      if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (o, h) => { const fn = typeof o === 'function' ? o : h; scheduled.push({ opts: o, fn }); return fn; } };
      if (request === 'firebase-functions/v2/pubsub') return { onMessagePublished: (o, h) => { const fn = typeof o === 'function' ? o : h; pubsub.push({ opts: o, fn }); return fn; } };
      if (request === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => secrets[n] }), defineString: (n, o) => ({ value: () => (o && o.default) || '' }) };
      if (request === 'firebase-functions/logger') return logger;
      if (request.startsWith('firebase-functions')) return new Proxy({}, { get: () => () => {} });
      if (request === 'googleapis') return { google: g.google };
      return realLoad.apply(this, arguments);
    };
  }
  function uninstall() { Module._load = realLoad; }
  function loadModule(name) {
    const full = path.join(FN_DIR, name.endsWith('.js') ? name : name + '.js');
    delete require.cache[require.resolve(full)];
    return require(full);
  }
  function loadFresh(names) {
    for (const n of names) { const full = path.join(FN_DIR, n.endsWith('.js') ? n : n + '.js'); delete require.cache[require.resolve(full)]; }
    const out = {};
    for (const n of names) out[n.replace(/\.js$/, '')] = require(path.join(FN_DIR, n.endsWith('.js') ? n : n + '.js'));
    return out;
  }
  return { store: fs.store, db: fs.db, auditLog: fs.auditLog, files: st.files, signed: st.signed, fixture, gmailCalls: g.calls, logs, secrets, scheduled, pubsub, install, uninstall, loadModule, loadFresh, HttpsError, Timestamp, FieldValue, FN_DIR };
}

// base64url helper для фикстур Gmail
function b64url(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

// Готовое Gmail-сообщение (format=full) для фикстур.
function gmailMessage(o) {
  const headers = [];
  const h = (n, v) => { if (v != null && v !== '') headers.push({ name: n, value: v }); };
  h('From', o.from); h('To', o.to); h('Cc', o.cc); h('Bcc', o.bcc); h('Subject', o.subject);
  h('Date', o.date || new Date(+o.internalDate || Date.now()).toUTCString());
  h('Message-ID', o.messageId || ('<' + o.id + '@fake>')); h('In-Reply-To', o.inReplyTo); h('References', o.references); h('Reply-To', o.replyTo);
  if (o.autoSubmitted) h('Auto-Submitted', o.autoSubmitted);
  const parts = [];
  if (o.text != null) parts.push({ partId: '0', mimeType: 'text/plain', body: { size: o.text.length, data: b64url(o.text) } });
  if (o.html != null) parts.push({ partId: '1', mimeType: 'text/html', body: { size: o.html.length, data: b64url(o.html) } });
  for (const a of (o.attachments || [])) {
    const p = { partId: 'a' + parts.length, mimeType: a.mime || 'application/octet-stream', filename: a.filename, body: { size: a.size || 10, attachmentId: a.attachmentId } };
    if (a.contentId) p.headers = [{ name: 'Content-ID', value: '<' + a.contentId + '>' }, { name: 'Content-Disposition', value: a.inline ? 'inline' : 'attachment' }];
    parts.push(p);
  }
  const payload = parts.length === 1 && !o.forceMultipart
    ? Object.assign({ headers }, parts[0])
    : { mimeType: o.attachments && o.attachments.length ? 'multipart/mixed' : 'multipart/alternative', headers, body: { size: 0 }, parts };
  return { id: o.id, threadId: o.threadId || o.id, labelIds: o.labelIds || ['INBOX'], snippet: o.snippet || (o.text || '').slice(0, 80), internalDate: String(o.internalDate || Date.now()), historyId: String(o.historyId || 1), sizeEstimate: 1000, payload };
}

module.exports = { makeHarness, gmailMessage, b64url, HttpsError, Timestamp, FieldValue };
