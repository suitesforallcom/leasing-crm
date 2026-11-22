// Тест денежной части agent gateway (AGENT_API_PLAN Этап 1): send_reminder и
// жизненный цикл propose → confirm / Approve для invoice_create / invoice_void /
// invoice_mark_paid_oob. Запуск: node tests/agent-money.test.cjs (нужен functions/node_modules).
// In-memory Firestore, поддельный Stripe (только invoices.list) и поддельные
// реализации callables — наружу ничего не ходит, реальные счета не создаются.
'use strict';
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const FN_DIR = process.argv[2] || path.join(__dirname, '..', 'functions');

// ---------- in-memory Firestore (как в agent-gateway.test.cjs) ----------
const store = new Map();
const SERVER_TS = { __serverTs: true };
class Timestamp { constructor(ms) { this.ms = ms; } toMillis() { return this.ms; } }
function resolveSentinels(obj, prev) {
  const out = Object.assign({}, prev || {});
  for (const [k, v] of Object.entries(obj)) out[k] = (v === SERVER_TS) ? new Timestamp(Date.now()) : v;
  return out;
}
let failSetPrefix = null;   // инъекция сбоя записи: путь, начинающийся с этого префикса, падает
function docRef(p) {
  return {
    path: p, id: p.split('/').pop(),
    async get() { const d = store.get(p); return { exists: !!d, id: p.split('/').pop(), data: () => (d ? Object.assign({}, d) : undefined) }; },
    async set(data, opts) { if (failSetPrefix && p.startsWith(failSetPrefix)) throw new Error('injected write failure'); store.set(p, resolveSentinels(data, opts && opts.merge ? store.get(p) : null)); },
    async update(data) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, resolveSentinels(data, store.get(p))); },
    async delete() { store.delete(p); },
  };
}
function collectionRef(p, filters) {
  const f = filters || [];
  return {
    path: p, doc: (id) => docRef(p + '/' + id),
    where: (k, op, v) => collectionRef(p, f.concat([[k, op, v]])),
    orderBy: () => collectionRef(p, f), limit: () => collectionRef(p, f),
    async add(d) { const id = 'a' + crypto.randomBytes(4).toString('hex'); store.set(p + '/' + id, resolveSentinels(d, null)); return { id }; },
    async get() {
      const docs = [];
      for (const [k, v] of store.entries()) {
        if (!k.startsWith(p + '/') || k.slice(p.length + 1).includes('/')) continue;
        if (f.every(([fk, op, fv]) => (op === '==' ? v[fk] === fv : true))) docs.push({ id: k.split('/').pop(), data: () => Object.assign({}, v), exists: true });
      }
      return { docs, empty: docs.length === 0, forEach: (cb) => docs.forEach(cb) };
    },
  };
}
const db = {
  doc: (p) => docRef(p), collection: (p) => collectionRef(p),
  // Транзакции выполняются строго по очереди (чтение + запись атомарны) — как
  // сериализуемые транзакции Firestore; без этого гонку захвата предложения не проверить.
  runTransaction: (fn) => {
    const run = txChain.then(async () => {
      const pending = [];
      const tx = { get: (r) => r.get(), update: (r, d) => pending.push(() => r.update(d)), set: (r, d, o) => pending.push(() => r.set(d, o)), delete: (r) => pending.push(() => r.delete()) };
      const out = await fn(tx);
      for (const p of pending) await p();
      return out;
    });
    txChain = run.catch(() => {});
    return run;
  },
};
let txChain = Promise.resolve();
const admin = { firestore: { FieldValue: { serverTimestamp: () => SERVER_TS }, Timestamp } };
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; this.httpErrorCode = { status: 400 }; } }
const logs = [];
const logger = { info() {}, debug() {}, log() {}, warn: (...a) => logs.push(['warn', a.join(' ')]), error: (...a) => logs.push(['error', a.join(' ')]) };

// ---------- даты: фикстура строится от «сегодня по Нью-Йорку», чтобы тест не протухал ----------
function nyYm(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).formatToParts(d || new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}`;
}
function addYm(ym, n) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
const CUR = nyYm();
const PREV = addYm(CUR, -1);
const START = addYm(CUR, -4) + '-01';
function paidThrough(ym, amount) { const o = {}; for (let i = 4; i >= 1; i--) { const m = addYm(CUR, -i); if (m <= ym) o[m] = { status: 'paid', amount }; } return o; }

// ---------- workspace ----------
const unit = (id, extra) => Object.assign({ id, type: 'office', rentable: true, status: 'occupied', sqft: 300 }, extra);
const STATE = {
  settings: { syncBuildingsStrip: true, lateFee: { graceDays: 5 } },
  buildings: [
    { id: 'b1', name: 'Bay Vista', code: 'BAY', floors: [{ id: 'f1', name: '2nd', units: [
      // 204 — чистый арендатор: прошлые месяцы оплачены, текущий должен, счетов нет.
      unit('204', { tenant: 'Acme LLC', email: 't204@example.com', contractRent: 1350, rent: 1400, leaseStart: START, payments: paidThrough(PREV, 1350), stripe: { customerId: 'cus_204' } }),
      // 205 — открытый счёт за прошлый месяц (для напоминаний / void / mark-paid).
      unit('205', { tenant: 'Beta Inc', email: 't205@example.com', contractRent: 900, leaseStart: START, payments: paidThrough(addYm(CUR, -2), 900), stripe: { customerId: 'cus_205', lastInvoiceId: 'in_205prev', lastInvoiceYm: PREV } }),
      // 206 — открытый счёт за текущий месяц (напоминание со сбоем записи).
      unit('206', { tenant: 'Gamma Co', email: 't206@example.com', contractRent: 700, leaseStart: START, payments: paidThrough(PREV, 700), stripe: { customerId: 'cus_206', lastInvoiceId: 'in_206cur', lastInvoiceYm: CUR } }),
      // 207 (head) + 208 (member) — одна лиза на два сьюта.
      unit('207', { tenant: 'Delta Group', email: 't207@example.com', contractRent: 2000, leaseStart: START, payments: paidThrough(PREV, 2000), groupId: 'g1', groupRole: 'primary', stripe: { customerId: 'cus_207' } }),
      unit('208', { groupId: 'g1', groupRole: 'member' }),
      // 209 — арендатор без даты начала лизы (lease-start gate).
      unit('209', { tenant: 'No Start LLC', email: 't209@example.com', contractRent: 500, stripe: { customerId: 'cus_209' } }),
      // 210 — без email на файле.
      unit('210', { tenant: 'No Mail LLC', contractRent: 500, leaseStart: START, payments: paidThrough(PREV, 500) }),
      // 211 — для dead-letter / чистого отказа исполнения.
      unit('211', { tenant: 'Epsilon LLC', email: 't211@example.com', contractRent: 800, leaseStart: START, payments: paidThrough(PREV, 800), stripe: { customerId: 'cus_211' }, additionalServices: [{ name: 'Parking', amount: 50, frequency: 'monthly', active: true, autoInvoice: true }, { name: 'Off', amount: 99, frequency: 'monthly', active: false, autoInvoice: true }] }),
      // 212 — более поздний месяц уже выставлен (Entry 71: штамп не двигается назад).
      unit('212', { tenant: 'Zeta LLC', email: 't212@example.com', contractRent: 600, leaseStart: START, payments: paidThrough(addYm(CUR, -2), 600), stripe: { customerId: 'cus_212', lastInvoiceId: 'in_212cur', lastInvoiceYm: CUR } }),
      unit('213', { status: 'vacant', rent: 1200 }),
      // 222 — лиза 9 месяцев; месяц «7 месяцев назад» закрыт ТОЛЬКО счётом Stripe (локальной записи нет),
      // остальные оплачены локально, включая текущий. Должником он быть не должен.
      unit('222', { tenant: 'Old Stripe LLC', email: 't222@example.com', contractRent: 400, leaseStart: addYm(CUR, -9) + '-01', stripe: { customerId: 'cus_222' },
        payments: (() => { const o = {}; for (let i = 9; i >= 0; i--) if (i !== 7) o[addYm(CUR, -i)] = { status: 'paid', amount: 400 }; return o; })() }),
      // 214 — въезд 15-го числа текущего месяца: программа считает этот месяц с прорейтом.
      unit('214', { tenant: 'Move In LLC', email: 't214@example.com', contractRent: 3000, leaseStart: CUR + '-15', payments: {}, stripe: { customerId: 'cus_214' } }),
      // 215 — НОВЫЙ арендатор, а customerId на юните остался от прежнего (штампы чистятся, клиент — нет).
      unit('215', { tenant: 'New Tenant LLC', email: 'new215@example.com', contractRent: 800, leaseStart: START, payments: paidThrough(PREV, 800), stripe: { customerId: 'cus_old215' } }),
      // 216 — новый арендатор без Stripe-клиента; открытый счёт прежнего арендатора того же сьюта.
      unit('216', { tenant: 'Fresh LLC', email: 'fresh216@example.com', contractRent: 800, leaseStart: START, payments: paidThrough(PREV, 800) }),
      // 217–219 — чистые арендаторы для сценариев исполнения.
      unit('217', { tenant: 'Eta LLC', email: 't217@example.com', contractRent: 1100, leaseStart: START, payments: paidThrough(PREV, 1100), stripe: { customerId: 'cus_217' } }),
      unit('218', { tenant: 'Theta LLC', email: 't218@example.com', contractRent: 1100, leaseStart: START, payments: paidThrough(PREV, 1100), stripe: { customerId: 'cus_218' }, autoCharge: 'on' }),
      unit('219', { tenant: 'Iota LLC', email: 't219@example.com', contractRent: 1100, leaseStart: START, payments: paidThrough(PREV, 1100), stripe: { customerId: 'cus_219' } }),
      unit('220', { tenant: 'Kappa LLC', email: 't220@example.com', contractRent: 1100, leaseStart: START, payments: paidThrough(PREV, 1100), stripe: { customerId: 'cus_220' } }),
      unit('221', { tenant: 'Lambda LLC', email: 't221@example.com', contractRent: 1100, leaseStart: START, payments: paidThrough(PREV, 1100), stripe: { customerId: 'cus_221' } }),
    ] }] },
    { id: 'b2', name: 'Crane Nest', code: 'CRN', floors: [{ id: 'f1', name: '1st', units: [
      // Тот же номер 205 в другом здании — его счёт не должен подойти к b1/205.
      unit('205', { tenant: 'Other Co', email: 'other205@example.com', contractRent: 1000, leaseStart: START, payments: paidThrough(PREV, 1000), stripe: { customerId: 'cus_b2_205' } }),
    ] }] },
  ],
};
// Поддельные счета Stripe (форма Stripe API; в строку UI превращает toRow ниже).
const sec = (daysAgo) => Math.floor(Date.now() / 1000) - daysAgo * 86400;
const stripeInvoices = [
  { id: 'in_205prev', number: 'R-205-1', status: 'open', total: 90000, amount_remaining: 90000, amount_paid: 0, customer: 'cus_205', customer_email: 't205@example.com', created: sec(35), due_date: sec(25), hosted_invoice_url: 'https://stripe.test/in_205prev', metadata: { source: 'suitesforall', unitId: '205', buildingId: 'b1', purpose: 'rent', ym: PREV }, lines: { total_count: 1 } },
  { id: 'in_206cur', number: 'R-206-1', status: 'open', total: 70000, amount_remaining: 70000, amount_paid: 0, customer: 'cus_206', customer_email: 't206@example.com', created: sec(3), due_date: sec(-5), hosted_invoice_url: 'https://stripe.test/in_206cur', metadata: { source: 'suitesforall', unitId: '206', buildingId: 'b1', purpose: 'rent', ym: CUR }, lines: { total_count: 1 } },
  { id: 'in_212cur', number: 'R-212-1', status: 'open', total: 60000, amount_remaining: 60000, amount_paid: 0, customer: 'cus_212', customer_email: 't212@example.com', created: sec(2), due_date: sec(-5), metadata: { source: 'suitesforall', unitId: '212', buildingId: 'b1', purpose: 'rent', ym: CUR }, lines: { total_count: 1 } },
  { id: 'in_b2x205', number: 'R-205-9', status: 'open', total: 100000, amount_remaining: 100000, amount_paid: 0, customer: 'cus_b2_205', customer_email: 'other205@example.com', created: sec(4), due_date: sec(-5), metadata: { source: 'suitesforall', unitId: '205', buildingId: 'b2', purpose: 'rent', ym: CUR }, lines: { total_count: 1 } },
  { id: 'in_215old', number: 'R-215-1', status: 'open', total: 80000, amount_remaining: 80000, amount_paid: 0, customer: 'cus_old215', customer_email: 'old215@example.com', created: sec(40), due_date: sec(30), metadata: { source: 'suitesforall', unitId: '215', buildingId: 'b1', purpose: 'rent', ym: PREV }, lines: { total_count: 1 } },
  { id: 'in_216old', number: 'R-216-1', status: 'open', total: 80000, amount_remaining: 80000, amount_paid: 0, customer: 'cus_old216', customer_email: 'old216@example.com', created: sec(40), due_date: sec(30), metadata: { source: 'suitesforall', unitId: '216', buildingId: 'b1', purpose: 'rent', ym: PREV }, lines: { total_count: 1 } },
  { id: 'in_222old', number: 'R-222-1', status: 'paid', total: 40000, amount_remaining: 0, amount_paid: 40000, customer: 'cus_222', customer_email: 't222@example.com', created: sec(7 * 30 + 12), due_date: sec(7 * 30 + 2), metadata: { source: 'suitesforall', unitId: '222', buildingId: 'b1', purpose: 'rent', ym: addYm(CUR, -7) }, lines: { total_count: 1 } },
  { id: 'in_205paid', number: 'R-205-0', status: 'paid', total: 90000, amount_remaining: 0, amount_paid: 90000, customer: 'cus_205', customer_email: 't205@example.com', created: sec(70), due_date: sec(60), metadata: { source: 'suitesforall', unitId: '205', buildingId: 'b1', purpose: 'rent', ym: addYm(CUR, -2) }, lines: { total_count: 1 } },
];
const fakeStripe = { invoices: { list: async (q) => ({ data: stripeInvoices.filter((i) => (!q.status || i.status === q.status) && (!(q.created && q.created.gte) || i.created >= q.created.gte)), has_more: false }) } };
// Форма строки — как _stripeInvoiceToRow в functions/index.js.
function toRow(inv, nowSec) {
  const isPastDue = inv.status === 'open' && inv.due_date && inv.due_date < nowSec;
  return { id: inv.id, number: inv.number || inv.id, status: inv.status, bucket: isPastDue ? 'past_due' : inv.status, total: (inv.total || 0) / 100, amountRemaining: (inv.amount_remaining || 0) / 100, amountPaid: (inv.amount_paid || 0) / 100, currency: 'USD', customerId: inv.customer, customerName: '', customerEmail: inv.customer_email || '', description: '', created: inv.created * 1000, dueDate: inv.due_date ? inv.due_date * 1000 : null, hostedUrl: inv.hosted_invoice_url || null, pdfUrl: null, metadata: inv.metadata || {} };
}

// Поддельные серверные реализации: только записывают вызовы.
const calls = { create: [], void: [], oob: [], resend: [], mutate: 0 };
let createBehaviour = 'ok';     // 'ok' | 'dirty' (ошибка после возможного эффекта) | 'clean' (отказ до Stripe)
let failMutate = false;
const impls = {
  createStripeInvoice: async (req) => {
    calls.create.push(req);
    if (createBehaviour === 'clean') throw new HttpsError('already-exists', 'A open rent invoice already exists');
    if (createBehaviour === 'dirty') throw new Error('[mirror-failed] building mirror failed for: b1');
    if (createBehaviour === 'finalize') throw new HttpsError('invalid-argument', 'Stripe rejected the request (finalize): nothing to bill');
    if (createBehaviour === 'invoice') throw new HttpsError('resource-exhausted', 'Stripe rejected the request (invoice): rate limit on the line item');
    if (createBehaviour === 'customer') throw new HttpsError('invalid-argument', 'Stripe rejected the request (customer): bad email');
    if (createBehaviour === 'slow') await new Promise((r) => setTimeout(r, 40));
    return { invoiceId: 'in_new' + calls.create.length, hostedUrl: 'https://stripe.test/new', status: 'open', amount: 135000, customerId: 'cus_x' };
  },
  voidOrDeleteStripeInvoice: async (req) => { calls.void.push(req); const i = stripeInvoices.find((x) => x.id === req.data.invoiceId); if (i) i.status = 'void'; return { invoiceId: req.data.invoiceId, action: 'voided', status: 'void' }; },
  markInvoicePaidOutOfBand: async (req) => { calls.oob.push(req); return { invoiceId: req.data.invoiceId, action: 'marked-paid-oob', status: 'paid', amountPaid: 9 }; },
  stripeResendInvoice: async (req) => { calls.resend.push(req); return { invoiceId: req.data.invoiceId, status: 'open', hostedUrl: 'https://stripe.test/' + req.data.invoiceId }; },
};

for (const [uid, m] of Object.entries({ u_mgr: { role: 'manager', email: 'mgr@x.com' }, u_admin: { role: 'admin', email: 'admin@x.com' }, u_viewer: { role: 'viewer', email: 'v@x.com' }, u_b2mgr: { role: 'manager', email: 'b2@x.com', buildings: ['b2'] } })) store.set('workspaces/default/members/' + uid, m);

// Тест делает сотни вызовов за секунды — общие лимиты частоты поднимаем (их проверяет
// agent-gateway.test.cjs); лимиты напоминаний (1/сьют/сутки) и денег остаются настоящими.
store.set('workspaces/default/agentConfig/_config', { perKeyHour: 100000, perKeyDay: 100000, perKeyWriteHour: 100000 });

const gw = require(path.join(FN_DIR, 'agent-gateway.js'));
const g = gw.create({
  db, admin, logger, HttpsError, WORKSPACE_ID: 'default',
  onCall: (o, h) => (typeof o === 'function' ? o : h), onRequest: (o, h) => (typeof o === 'function' ? o : h),
  readWorkspaceState: async () => JSON.parse(JSON.stringify(STATE)),
  mutateWorkspaceState: async (fn) => { calls.mutate++; if (failMutate) throw new Error('[mirror-failed] injected'); await fn(STATE); },
  getStripe: () => fakeStripe, stripeInvoiceToRow: toRow, stripeInvoiceFilter: () => true,
  unitRentCents: (u) => Math.round((Number(u.contractRent) || Number(u.rent) || 0) * 100),
  secrets: [], impls,
});
const core = g._core;
let clockSkew = 0;
core.clock = () => Date.now() + clockSkew;

// ---------- helpers ----------
async function keyFor(uid, extra) {
  const k = g._internal.mintKey();
  store.set('workspaces/default/agentKeys/' + k.keyId, Object.assign({ uid, email: store.get('workspaces/default/members/' + uid).email, client: 'grok', label: 't', scopes: gw.ALL_SCOPES.slice(), buildings: null, hash: k.hash, expiresAt: new Timestamp(Date.now() + 86400_000), revoked: false }, extra || {}));
  return k;
}
function fakeRes() {
  const r = { statusCode: 200, headers: {}, chunks: [], headersSent: false, _l: {} };
  r.set = (k, v) => { r.headers[String(k).toLowerCase()] = v; return r; };
  r.status = (s) => { r.statusCode = s; return r; };
  const buf = (b) => (Buffer.isBuffer(b) ? b : (b instanceof Uint8Array ? Buffer.from(b) : Buffer.from(String(b))));
  r.send = (b) => { r.headersSent = true; r.chunks.push(buf(b)); return r; };
  r.end = (b) => { if (b) r.chunks.push(buf(b)); r.headersSent = true; (r._l.close || []).forEach((f) => f()); return r; };
  r.write = (b) => { r.headersSent = true; r.chunks.push(buf(b)); return true; };
  r.writeHead = (s, hd) => { r.statusCode = s; Object.assign(r.headers, Object.fromEntries(Object.entries(hd || {}).map(([k, v]) => [k.toLowerCase(), v]))); r.headersSent = true; return r; };
  r.on = (ev, f) => { (r._l[ev] = r._l[ev] || []).push(f); return r; };
  r.json = () => { const b = Buffer.concat(r.chunks).toString('utf8'); if (/^\s*[[{]/.test(b)) return JSON.parse(b); const m = /^data:\s*(.+)$/m.exec(b); return JSON.parse(m[1]); };
  return r;
}
async function call(key, method, p, body, headers) {
  const h = Object.assign({ host: 'x.cloudfunctions.net', authorization: 'Bearer ' + key.token }, headers || {});
  const req = { method, path: p, url: '/agentApi' + p, originalUrl: '/agentApi' + p, query: method === 'GET' ? (body || {}) : {}, body: method === 'GET' ? undefined : body, headers: h, get: (n) => h[String(n).toLowerCase()], ip: '1.2.3.4' };
  const res = fakeRes();
  await g._internal.restHandler(req, res);
  core.invalidateSnapshot();                      // каждый запрос теста видит свежие данные
  return { status: res.statusCode, body: res.json() };
}
const propose = (key, action, args, extra) => call(key, 'POST', '/v1/proposals', Object.assign({ action, args }, extra || {}));
const confirm = (key, id, prefix) => call(key, 'POST', `/v1/proposals/${id}/confirm`, { confirmedBy: 'user', summaryPrefix: prefix });
const PFX = (p) => p.summary.slice(0, 48);       // начало summary с суммой — как его повторил бы агент
const prop = (id) => store.get('workspaces/default/agentProposals/' + id);
const deadLetters = () => Array.from(store.keys()).filter((k) => k.startsWith('workspaces/default/agentDeadLetter/'));
const audits = (action) => Array.from(store.entries()).filter(([k, v]) => k.startsWith('workspaces/default/audit/') && v.action === action);
const stateUnit = (bid, uid) => STATE.buildings.find((b) => b.id === bid).floors[0].units.find((u) => u.id === uid);
let idemN = 0;
const idem = () => ({ 'idempotency-key': 'idem-test-' + String(++idemN).padStart(4, '0') });

const results = [];
async function test(name, fn) { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, (e && e.message) || String(e)]); } }

(async () => {
  const mgr = await keyFor('u_mgr');
  const mgr2 = await keyFor('u_mgr');
  const viewer = await keyFor('u_viewer');
  const b2mgr = await keyFor('u_b2mgr');
  const noChat = await keyFor('u_mgr', { scopes: gw.ALL_SCOPES.filter((s) => s !== 'confirm:chat') });
  const adminAuth = { uid: 'u_admin', token: { email: 'admin@x.com' } };

  await test('modules loaded: tools + actions + proposal callables registered', async () => {
    for (const t of ['send_reminder', 'propose_action', 'confirm_action', 'list_proposals']) assert.ok(g._internal.TOOLS.has(t), t);
    for (const a of ['invoice_create', 'invoice_void', 'invoice_mark_paid_oob']) assert.ok(g._internal.ACTIONS.has(a), a);
    assert.strictEqual(typeof g.agentProposalList, 'function'); assert.strictEqual(typeof g.agentProposalDecide, 'function');
  });

  await test('classC is OFF by default: money tools hidden and refused (503), reminders still work', async () => {
    const who = await call(mgr, 'GET', '/v1/whoami');
    const names = who.body.structured.tools.map((t) => t.name);
    assert.ok(names.includes('send_reminder') && !names.includes('propose_action') && !names.includes('confirm_action') && !names.includes('list_proposals'), names.join(','));
    assert.deepStrictEqual(who.body.structured.actions, []);
    const r = await propose(mgr, 'invoice_create', { buildingId: 'b1', unitId: '204', purpose: 'rent', ym: CUR });
    assert.strictEqual(r.status, 503, JSON.stringify(r.body));
  });

  // ─── send_reminder ───
  await test('send_reminder: Idempotency-Key required; dryRun needs none and sends nothing', async () => {
    const r1 = await call(mgr, 'POST', '/v1/units/b1/205/reminder', {});
    assert.strictEqual(r1.status, 400, JSON.stringify(r1.body)); assert.ok(/Idempotency-Key is required/.test(r1.body.error.message));
    const r2 = await call(mgr, 'POST', '/v1/units/b1/205/reminder', { dryRun: true });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body)); assert.strictEqual(r2.body.structured.invoiceId, 'in_205prev');
    assert.strictEqual(calls.resend.length, 0); assert.strictEqual(calls.mutate, 0);
  });
  await test('send_reminder: viewer → 403; member suite → points at lease head; no open invoice → 409', async () => {
    assert.strictEqual((await call(viewer, 'POST', '/v1/units/b1/205/reminder', {}, idem())).status, 403);
    const m = await call(mgr, 'POST', '/v1/units/b1/208/reminder', {}, idem());
    assert.strictEqual(m.status, 409); assert.strictEqual(m.body.error.details.leaseHeadUnitId, '207');
    const n = await call(mgr, 'POST', '/v1/units/b1/204/reminder', {}, idem());
    assert.strictEqual(n.status, 409); assert.ok(/no open Stripe invoice/.test(n.body.error.message));
    assert.strictEqual(calls.resend.length, 0);
  });
  await test('send_reminder: another building\'s invoice with the same suite number is never used', async () => {
    const r = await call(mgr, 'POST', '/v1/units/b1/205/reminder', { invoiceId: 'in_b2x205' }, idem());
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(calls.resend.length, 0);
  });
  await test('send_reminder: sends via stripeResendInvoice as the real member, logs outreach, sets reminded, audits', async () => {
    const h = idem();
    const r = await call(mgr, 'POST', '/v1/units/b1/205/reminder', {}, h);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(calls.resend.length, 1);
    assert.deepStrictEqual(calls.resend[0].data, { invoiceId: 'in_205prev' });
    assert.strictEqual(calls.resend[0].auth.uid, 'u_mgr'); assert.strictEqual(calls.resend[0].auth.token.email, 'mgr@x.com');
    const u = stateUnit('b1', '205');
    assert.strictEqual(u.collectionStatus, 'reminded');
    assert.strictEqual(u.outreach.length, 1); assert.strictEqual(u.outreach[0].kind, 'reminder'); assert.strictEqual(u.outreach[0].via, 'agent:grok');
    assert.strictEqual(audits('agent.reminder.sent').length, 1);
    // повтор с тем же ключом — сохранённый ответ, второго письма нет
    const again = await call(mgr, 'POST', '/v1/units/b1/205/reminder', {}, h);
    assert.strictEqual(again.status, 200); assert.strictEqual(again.body.replayed, true); assert.strictEqual(calls.resend.length, 1);
    // новый ключ в тот же день — лимит 1/сьют/сутки
    const limited = await call(mgr2, 'POST', '/v1/units/b1/205/reminder', {}, idem());
    assert.strictEqual(limited.status, 429, JSON.stringify(limited.body)); assert.strictEqual(calls.resend.length, 1);
  });
  await test('send_reminder: email sent but log write fails → 502 + dead-letter; same key is blocked, not re-sent', async () => {
    failMutate = true;
    const h = idem();
    const r = await call(mgr, 'POST', '/v1/units/b1/206/reminder', {}, h);
    failMutate = false;
    assert.strictEqual(r.status, 502, JSON.stringify(r.body)); assert.strictEqual(r.body.error.code, 'side_effect_unconfirmed');
    assert.strictEqual(calls.resend.length, 2);
    assert.strictEqual(deadLetters().length, 1); assert.strictEqual(audits('agent.dead-letter').length, 1);
    const retry = await call(mgr, 'POST', '/v1/units/b1/206/reminder', {}, h);
    assert.strictEqual(retry.status, 409, JSON.stringify(retry.body)); assert.strictEqual(calls.resend.length, 2);
  });

  await test('send_reminder never goes to a previous tenant: stale customerId or no customerId on the unit → refused, nothing sent', async () => {
    const n = calls.resend.length;
    // 215: customerId на юните остался от прежнего арендатора, счёт выставлен на его email
    const a = await call(mgr, 'POST', '/v1/units/b1/215/reminder', {}, idem());
    assert.strictEqual(a.status, 409, JSON.stringify(a.body)); assert.ok(/none was issued to the tenant email on file/.test(a.body.error.message), a.body.error.message);
    const a2 = await call(mgr, 'POST', '/v1/units/b1/215/reminder', { invoiceId: 'in_215old' }, idem());
    assert.strictEqual(a2.status, 409); assert.ok(/different email/.test(a2.body.error.message));
    // 216: у юнита нет customerId вовсе
    const b = await call(mgr, 'POST', '/v1/units/b1/216/reminder', {}, idem());
    assert.strictEqual(b.status, 409, JSON.stringify(b.body));
    const d = await call(mgr, 'POST', '/v1/units/b1/216/reminder', { dryRun: true });
    assert.strictEqual(d.status, 409);
    assert.strictEqual(calls.resend.length, n);
    assert.ok(!stateUnit('b1', '215').outreach && !stateUnit('b1', '216').outreach);
  });
  await test('send_reminder: the same Idempotency-Key for another suite is refused (409), not answered with the first suite\'s "Sent"', async () => {
    const h = { 'idempotency-key': 'idem-test-0001' };       // ключ первого запроса теста (b1/208)
    const r = await call(mgr, 'POST', '/v1/units/b1/205/reminder', {}, { 'idempotency-key': 'reuse-key-000001' });
    assert.ok([429, 200].includes(r.status));               // 205 уже напоминали сегодня → 429
    const again = await call(mgr, 'POST', '/v1/units/b1/217/reminder', {}, { 'idempotency-key': 'reuse-key-000001' });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body)); assert.ok(/different request/.test(again.body.error.message));
    void h;
  });

  // ─── включаем деньги ───
  await test('agentConfigSet classC=true (admin) makes money tools visible to a manager key', async () => {
    await g.agentConfigSet({ auth: adminAuth, data: { classC: true } });
    const names = (await call(mgr, 'GET', '/v1/whoami')).body.structured;
    assert.ok(names.tools.some((t) => t.name === 'propose_action') && names.actions.some((a) => a.name === 'invoice_create'));
    const v = (await call(viewer, 'GET', '/v1/whoami')).body.structured;
    assert.ok(!v.tools.some((t) => t.name === 'propose_action'), 'viewer never sees money tools');
  });

  const RENT = (unitId, extra) => Object.assign({ buildingId: 'b1', unitId, purpose: 'rent', ym: CUR }, extra || {});
  let p204;
  await test('propose rent invoice: effect to the cent, chat confirmation, nothing executed, nothing written to state', async () => {
    const before = JSON.stringify(STATE); const m0 = calls.mutate;
    const dry = await propose(mgr, 'invoice_create', RENT('204'), { dryRun: true });
    assert.strictEqual(dry.status, 200, JSON.stringify(dry.body)); assert.strictEqual(dry.body.structured.dryRun, true);
    const r = await propose(mgr, 'invoice_create', RENT('204'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    p204 = r.body.structured;
    assert.ok(/^ap_[a-f0-9]{16}$/.test(p204.proposalId));
    assert.strictEqual(p204.effect.amountUsd, 1350); assert.strictEqual(p204.effect.customerEmail, 't204@example.com');
    assert.ok(p204.summary.startsWith(`Send a Stripe rent invoice for $1,350.00 for ${CUR}`), p204.summary);
    assert.ok(p204.summary.includes('suite 204') && p204.summary.includes('Bay Vista') && p204.summary.includes('Stripe emails the invoice to the tenant.'), p204.summary);
    assert.strictEqual(p204.requiredConfirmation, 'chat');
    assert.strictEqual(prop(p204.proposalId).status, 'pending');
    assert.strictEqual(Array.from(store.keys()).filter((k) => k.includes('/agentProposals/')).length, 1, 'dry run created no proposal');
    assert.strictEqual(calls.create.length, 0); assert.strictEqual(calls.mutate, m0); assert.strictEqual(JSON.stringify(STATE), before);
  });
  await test('confirm barriers: too fast → 409; a summary with the right opening words but another amount → 400; short prefix → 400; another key → 404; viewer → 403', async () => {
    const fast = await confirm(mgr, p204.proposalId, PFX(p204));
    assert.strictEqual(fast.status, 409, JSON.stringify(fast.body)); assert.ok(/Too fast/.test(fast.body.error.message));
    clockSkew += 4000;
    const wrongAmount = await confirm(mgr, p204.proposalId, `Send a Stripe rent invoice for $9,350.00 for ${CUR}, due`);
    assert.strictEqual(wrongAmount.status, 400, JSON.stringify(wrongAmount.body));
    assert.strictEqual((await confirm(mgr, p204.proposalId, 'Send a Stripe rent invoice')).status, 400);
    assert.strictEqual((await confirm(mgr2, p204.proposalId, PFX(p204))).status, 404);
    assert.strictEqual((await confirm(viewer, p204.proposalId, PFX(p204))).status, 403);
    assert.strictEqual(calls.create.length, 0); assert.strictEqual(prop(p204.proposalId).status, 'pending');
  });
  await test('confirm executes ONCE through createStripeInvoice: rent only, file email, per-proposal Stripe key, member auth without root shortcut', async () => {
    const r = await confirm(mgr, p204.proposalId, PFX(p204));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.structured.status, 'executed');
    assert.strictEqual(calls.create.length, 1);
    const d = calls.create[0].data;
    assert.deepStrictEqual(Object.keys(d).sort(), ['buildingId', 'dueDateUnix', 'floorId', 'idempotencyKey', 'privateNote', 'purpose', 'unitId', 'ym']);
    assert.strictEqual(d.buildingId, 'b1'); assert.strictEqual(d.floorId, 'f1'); assert.strictEqual(d.unitId, '204');
    assert.strictEqual(d.purpose, 'rent'); assert.strictEqual(d.ym, CUR); assert.strictEqual(d.idempotencyKey, 'ag-' + p204.proposalId);
    assert.ok(Number.isFinite(d.dueDateUnix), 'rent due date passed like the UI (Entry 60)');
    assert.strictEqual(calls.create[0].auth.uid, 'u_mgr'); assert.strictEqual(calls.create[0].auth.token.email_verified, false);
    assert.ok(/created in Stripe \(status: open\)/.test(r.body.text), r.body.text);
    assert.strictEqual(prop(p204.proposalId).status, 'executed');
    assert.strictEqual(audits('agent.proposal.executed').length, 1);
    const again = await confirm(mgr, p204.proposalId, PFX(p204));
    assert.strictEqual(again.status, 409); assert.strictEqual(calls.create.length, 1, 'one-time');
    const list = await call(mgr, 'GET', '/v1/proposals');
    assert.strictEqual(list.body.structured.proposals[0].status, 'executed');
  });
  await test('agents invoice RENT only: late_fee / custom / own amount / description are rejected by the schema', async () => {
    assert.strictEqual((await propose(mgr, 'invoice_create', { buildingId: 'b1', unitId: '207', purpose: 'custom', ym: CUR })).status, 400);
    assert.strictEqual((await propose(mgr, 'invoice_create', { buildingId: 'b1', unitId: '207', purpose: 'late_fee', ym: CUR })).status, 400);
    assert.strictEqual((await propose(mgr, 'invoice_create', RENT('207', { amountUsd: 1 }))).status, 400);
    assert.strictEqual((await propose(mgr, 'invoice_create', RENT('207', { description: 'Key card deposit' }))).status, 400);
    assert.strictEqual((await propose(mgr, 'invoice_create', RENT('207', { emailOverride: 'x@y.com' }))).status, 400);
    assert.strictEqual((await propose(mgr, 'invoice_create', { buildingId: 'b1', unitId: '207', purpose: 'rent' })).status, 400, 'ym required');
  });
  await test('move-in month: the program prorates, a standard invoice would bill full rent → the agent refuses instead of billing the wrong amount', async () => {
    const r = await propose(mgr, 'invoice_create', RENT('214'), { dryRun: true });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.ok(/not a plain full-rent month/.test(r.body.error.message), r.body.error.message);
    assert.strictEqual(r.body.error.details.standardAmountUsd, 3000);
    assert.ok(r.body.error.details.programAmountUsd > 0 && r.body.error.details.programAmountUsd < 3000, JSON.stringify(r.body.error.details));
  });
  await test('rent guards: lease-start gate, no email, settled month, back-month stamp, member suite, vacant, duplicate, month window', async () => {
    const P = (unitId, extra) => propose(mgr, 'invoice_create', RENT(unitId, extra));
    const a = await P('209'); assert.strictEqual(a.status, 409); assert.ok(/lease start/.test(a.body.error.message), a.body.error.message);
    const b = await P('210'); assert.strictEqual(b.status, 409); assert.ok(/email/.test(b.body.error.message));
    const c = await P('204', { ym: PREV }); assert.strictEqual(c.status, 409); assert.ok(/already settled|already invoiced/.test(c.body.error.message), c.body.error.message);
    const d = await P('212', { ym: PREV }); assert.strictEqual(d.status, 409); assert.ok(/back-month/.test(d.body.error.message), d.body.error.message);
    const e = await P('208'); assert.strictEqual(e.status, 409); assert.strictEqual(e.body.error.details.leaseHeadUnitId, '207');
    const v = await P('213'); assert.strictEqual(v.status, 409);
    const dup = await P('206'); assert.strictEqual(dup.status, 409); assert.ok(/already exists/.test(dup.body.error.message), dup.body.error.message);
    const far = await P('207', { ym: addYm(CUR, 2) }); assert.strictEqual(far.status, 409); assert.ok(/previous, current or next month/.test(far.body.error.message));
    const old = await P('207', { ym: addYm(CUR, -2) }); assert.strictEqual(old.status, 409, 'two months back is refused'); assert.ok(/previous, current or next month/.test(old.body.error.message), old.body.error.message);
    const bad = await P('207', { ym: '2026-13' }); assert.strictEqual(bad.status, 400);
    assert.strictEqual(calls.create.length, 1);
  });
  await test('building scope on a WRITE: member-level and key-level restrictions both stop a proposal for another building (403)', async () => {
    assert.strictEqual((await propose(b2mgr, 'invoice_create', RENT('207'))).status, 403);
    const keyB2 = await keyFor('u_mgr', { buildings: ['b2'] });       // сотрудник видит всё, ключ — только b2
    assert.strictEqual((await propose(keyB2, 'invoice_create', RENT('207'))).status, 403);
    assert.strictEqual((await call(keyB2, 'POST', '/v1/units/b1/217/reminder', { dryRun: true })).status, 403);
    assert.strictEqual((await propose(keyB2, 'invoice_void', { buildingId: 'b2', unitId: '205', invoiceId: 'in_205prev' })).status, 404, 'b1 invoice id is not visible through b2/205');
  });
  let appProposal;
  await test('thresholds: services ride on the total; over the cap → app; key without confirm:chat → app; auto-pay suite says so in the summary', async () => {
    const s = await propose(mgr, 'invoice_create', RENT('211'), { dryRun: true });
    assert.strictEqual(s.body.structured.effect.amountUsd, 850); assert.strictEqual(s.body.structured.effect.servicesUsd, 50);
    assert.strictEqual(s.body.structured.requiredConfirmation, 'chat');
    const auto = await propose(mgr, 'invoice_create', RENT('218'), { dryRun: true });
    assert.ok(/Auto-pay is enabled for this suite/.test(auto.body.structured.summary) && !/Stripe emails the invoice to the tenant\.$/.test(auto.body.structured.summary), auto.body.structured.summary);
    const nc = await propose(noChat, 'invoice_create', RENT('207'), { dryRun: true });
    assert.strictEqual(nc.body.structured.requiredConfirmation, 'app');
    // порог чата опущен до $1,000 → рента $2,000 требует Approve в программе
    await g.agentConfigSet({ auth: adminAuth, data: { maxInvoiceUsd: 1000 } });
    const x = await propose(mgr, 'invoice_create', RENT('207'));
    assert.strictEqual(x.status, 200, JSON.stringify(x.body)); assert.strictEqual(x.body.structured.requiredConfirmation, 'app');
    assert.ok(x.body.structured.confirmationReasons.some((t) => /chat limit/.test(t)));
    appProposal = x.body.structured;
    clockSkew += 4000;
    const c = await confirm(mgr, appProposal.proposalId, PFX(appProposal));
    assert.strictEqual(c.status, 409, JSON.stringify(c.body)); assert.strictEqual(calls.create.length, 1);
    await g.agentConfigSet({ auth: adminAuth, data: { maxInvoiceUsd: 5000 } });
  });
  await test('a chat proposal created under the old cap moves to "app" when the cap is lowered before confirmation; nothing executes', async () => {
    const r = await propose(mgr, 'invoice_create', RENT('217'));
    assert.strictEqual(r.body.structured.requiredConfirmation, 'chat');
    clockSkew += 4000;
    store.set('workspaces/default/agentConfig/_config', Object.assign({}, store.get('workspaces/default/agentConfig/_config'), { maxInvoiceUsd: 500 }));   // другой инстанс
    const n = calls.create.length;
    const c = await confirm(mgr, r.body.structured.proposalId, PFX(r.body.structured));
    assert.strictEqual(c.status, 409, JSON.stringify(c.body)); assert.strictEqual(calls.create.length, n);
    assert.strictEqual(prop(r.body.structured.proposalId).requiredConfirmation, 'app'); assert.strictEqual(prop(r.body.structured.proposalId).status, 'pending');
    await g.agentConfigSet({ auth: adminAuth, data: { maxInvoiceUsd: 5000 } });
    await g.agentProposalDecide({ auth: adminAuth, data: { proposalId: r.body.structured.proposalId, decision: 'reject' } });
  });
  await test('Approve in the program: listed for admin/manager, viewer denied, b2-only manager cannot see it, admin approves → executed with the approver\'s real auth', async () => {
    const id = appProposal.proposalId;
    const list = await g.agentProposalList({ auth: adminAuth, data: {} });
    assert.ok(list.canDecide && list.proposals.some((p) => p.proposalId === id && p.status === 'pending' && p.requiredConfirmation === 'app' && p.requestedBy.email === 'mgr@x.com'));
    await assert.rejects(g.agentProposalList({ auth: { uid: 'u_viewer', token: {} }, data: {} }), (e) => e.code === 'permission-denied');
    const b2 = await g.agentProposalList({ auth: { uid: 'u_b2mgr', token: {} }, data: { status: 'all' } });
    assert.ok(!b2.proposals.some((p) => p.proposalId === id), 'proposal for b1 hidden from b2-only manager');
    await assert.rejects(g.agentProposalDecide({ auth: { uid: 'u_b2mgr', token: {} }, data: { proposalId: id, decision: 'approve' } }), (e) => e.code === 'not-found');
    await assert.rejects(g.agentProposalDecide({ auth: { uid: 'u_viewer', token: {} }, data: { proposalId: id, decision: 'approve' } }), (e) => e.code === 'permission-denied');
    const out = await g.agentProposalDecide({ auth: adminAuth, data: { proposalId: id, decision: 'approve' } });
    assert.strictEqual(out.status, 'executed');
    assert.strictEqual(calls.create.length, 2);
    const req = calls.create[1];
    assert.strictEqual(req.auth, adminAuth, 'the approver\'s own auth object, not a synthetic one');
    assert.strictEqual(req.data.purpose, 'rent'); assert.strictEqual(req.data.unitId, '207'); assert.ok(!('emailOverride' in req.data) && !('amountOverride' in req.data));
    assert.strictEqual(prop(id).decidedBy, 'app:admin@x.com');
    await assert.rejects(g.agentProposalDecide({ auth: adminAuth, data: { proposalId: id, decision: 'approve' } }), (e) => e.code === 'failed-precondition');
    assert.strictEqual(calls.create.length, 2);
  });
  await test('RACE: two chat confirms and an in-app Approve at the same moment → exactly one execution, the others are refused', async () => {
    const r = await propose(mgr, 'invoice_create', RENT('219'));
    clockSkew += 4000;
    const id = r.body.structured.proposalId; const n = calls.create.length;
    createBehaviour = 'slow';
    const settled = await Promise.allSettled([
      confirm(mgr, id, PFX(r.body.structured)),
      confirm(mgr, id, PFX(r.body.structured)),
      g.agentProposalDecide({ auth: adminAuth, data: { proposalId: id, decision: 'approve' } }),
      g.agentProposalDecide({ auth: adminAuth, data: { proposalId: id, decision: 'reject' } }),
    ]);
    createBehaviour = 'ok';
    const ok = settled.filter((x) => x.status === 'fulfilled' && (x.value.status === 200 || x.value.ok === true));
    assert.ok(calls.create.length - n <= 1, `executed ${calls.create.length - n} times`);
    assert.strictEqual(ok.length, 1, JSON.stringify(settled.map((x) => (x.status === 'fulfilled' ? (x.value.status || x.value) : x.reason.code))));
    const st = prop(id).status;
    assert.ok((st === 'executed' && calls.create.length - n === 1) || (st === 'rejected' && calls.create.length - n === 0), `final status ${st}, executions ${calls.create.length - n}`);
  });
  await test('Reject in the program closes the proposal; it can no longer be confirmed', async () => {
    const r = await propose(mgr, 'invoice_create', RENT('220'));
    const id = r.body.structured.proposalId; const n = calls.create.length;
    const out = await g.agentProposalDecide({ auth: adminAuth, data: { proposalId: id, decision: 'reject', note: 'not now' } });
    assert.strictEqual(out.status, 'rejected');
    clockSkew += 4000;
    assert.strictEqual((await confirm(mgr, id, PFX(r.body.structured))).status, 409);
    assert.strictEqual(calls.create.length, n);
  });
  await test('expired proposal (15 min in chat) cannot be confirmed', async () => {
    const r = await propose(mgr, 'invoice_create', RENT('220'));
    clockSkew += 16 * 60_000;
    const n = calls.create.length;
    const c = await confirm(mgr, r.body.structured.proposalId, PFX(r.body.structured));
    assert.strictEqual(c.status, 409, JSON.stringify(c.body)); assert.ok(/expired/.test(c.body.error.message));
    assert.strictEqual(calls.create.length, n);
  });
  for (const [mode, label] of [['dirty', 'state write fails after Stripe'], ['finalize', 'Stripe refuses at finalize (draft exists)'], ['invoice', 'Stripe refuses while the invoice is being created (a draft may exist)']]) {
    await test(`possible side effect — ${label} → 502 + dead-letter, proposal failed, never re-run`, async () => {
      const r = await propose(mgr, 'invoice_create', RENT('220'));
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      clockSkew += 4000;
      createBehaviour = mode;
      const dl0 = deadLetters().length; const n = calls.create.length;
      const c = await confirm(mgr, r.body.structured.proposalId, PFX(r.body.structured));
      createBehaviour = 'ok';
      assert.strictEqual(c.status, 502, JSON.stringify(c.body)); assert.strictEqual(c.body.error.code, 'side_effect_unconfirmed');
      assert.strictEqual(deadLetters().length, dl0 + 1);
      assert.strictEqual(prop(r.body.structured.proposalId).status, 'failed');
      const again = await confirm(mgr, r.body.structured.proposalId, PFX(r.body.structured));
      assert.strictEqual(again.status, 409); assert.strictEqual(calls.create.length, n + 1);
    });
  }
  await test('dead-letter rows are written as critical audit entries', async () => {
    const rows = audits('agent.dead-letter');
    assert.ok(rows.length >= 4 && rows.every(([, v]) => v.severity === 'critical'));
  });
  for (const [mode, label, code] of [['clean', 'duplicate found before Stripe', 409], ['customer', 'Stripe refuses the customer step (before any invoice)', 400]]) {
    await test(`clean refusal — ${label} → ${code}, proposal failed, NO dead-letter`, async () => {
      const r = await propose(mgr, 'invoice_create', RENT('220'));
      clockSkew += 4000;
      createBehaviour = mode;
      const dl0 = deadLetters().length;
      const c = await confirm(mgr, r.body.structured.proposalId, PFX(r.body.structured));
      createBehaviour = 'ok';
      assert.strictEqual(c.status, code, JSON.stringify(c.body)); assert.strictEqual(deadLetters().length, dl0);
      assert.strictEqual(prop(r.body.structured.proposalId).status, 'failed');
    });
  }

  // ─── mark paid out of band: всегда Approve в программе ───
  await test('invoice_mark_paid_oob always needs Approve in the program; the summary says where method and date end up', async () => {
    const r = await propose(mgr, 'invoice_mark_paid_oob', { buildingId: 'b1', unitId: '206', invoiceId: 'in_206cur', paymentMethod: 'check', paidAt: '2026-11-20', note: 'chk 1001' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.structured.requiredConfirmation, 'app');
    assert.ok(r.body.structured.confirmationReasons.some((t) => /always needs approval/.test(t)));
    assert.ok(r.body.structured.summary.includes('PAID outside Stripe by check') && /audit log only/.test(r.body.structured.summary), r.body.structured.summary);
    clockSkew += 4000;
    assert.strictEqual((await confirm(mgr, r.body.structured.proposalId, PFX(r.body.structured))).status, 409);
    assert.strictEqual(calls.oob.length, 0);
    global.__oob = r.body.structured;
  });
  await test('proposal status write fails after the action → aborted + dead-letter (never a silent success)', async () => {
    const id = global.__oob.proposalId;
    const dl0 = deadLetters().length;
    const origRun = core.impls.markInvoicePaidOutOfBand;
    core.impls.markInvoicePaidOutOfBand = async (req) => { const out = await origRun(req); failSetPrefix = 'workspaces/default/agentProposals/' + id; return out; };
    await assert.rejects(g.agentProposalDecide({ auth: adminAuth, data: { proposalId: id, decision: 'approve' } }), (e) => e.code === 'aborted');
    failSetPrefix = null; core.impls.markInvoicePaidOutOfBand = origRun;
    assert.strictEqual(calls.oob.length, 1);
    assert.deepStrictEqual({ invoiceId: calls.oob[0].data.invoiceId, suiteId: calls.oob[0].data.suiteId, ym: calls.oob[0].data.ym, paymentMethod: calls.oob[0].data.paymentMethod, paidAt: calls.oob[0].data.paidAt }, { invoiceId: 'in_206cur', suiteId: '206', ym: CUR, paymentMethod: 'check', paidAt: '2026-11-20' });
    assert.strictEqual(deadLetters().length, dl0 + 1);
  });
  await test('mark-paid on an invoice that Stripe reports as already paid is reported as "nothing changed", not as a recorded payment', async () => {
    const r = await propose(mgr, 'invoice_mark_paid_oob', { buildingId: 'b1', unitId: '212', invoiceId: 'in_212cur', paymentMethod: 'cash' });
    const origRun = core.impls.markInvoicePaidOutOfBand;
    core.impls.markInvoicePaidOutOfBand = async (req) => { calls.oob.push(req); return { invoiceId: req.data.invoiceId, action: 'noop', status: 'paid', alreadyPaid: true }; };
    const out = await g.agentProposalDecide({ auth: adminAuth, data: { proposalId: r.body.structured.proposalId, decision: 'approve' } });
    core.impls.markInvoicePaidOutOfBand = origRun;
    assert.ok(/ALREADY paid/.test(out.result.text) && /nothing was changed/.test(out.result.text), out.result.text);
  });

  // ─── void ───
  await test('invoice_void guards: paid → 409 (refund needed), other building\'s invoice → 404, unknown → 404, bad id → 400', async () => {
    const paid = await propose(mgr, 'invoice_void', { buildingId: 'b1', unitId: '205', invoiceId: 'in_205paid' });
    assert.strictEqual(paid.status, 409, JSON.stringify(paid.body)); assert.ok(/refund/.test(paid.body.error.message));
    assert.strictEqual((await propose(mgr, 'invoice_void', { buildingId: 'b1', unitId: '205', invoiceId: 'in_b2x205' })).status, 404);
    assert.strictEqual((await propose(mgr, 'invoice_void', { buildingId: 'b1', unitId: '205', invoiceId: 'in_nope' })).status, 404);
    assert.strictEqual((await propose(mgr, 'invoice_void', { buildingId: 'b1', unitId: '205', invoiceId: 'cus_205' })).status, 400);
  });
  await test('void of a previous tenant\'s invoice: the summary warns that it was issued to another email', async () => {
    const r = await propose(mgr, 'invoice_void', { buildingId: 'b1', unitId: '215', invoiceId: 'in_215old' }, { dryRun: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(/NOT the email of the tenant on file/.test(r.body.structured.summary) && r.body.structured.summary.includes('old215@example.com'), r.body.structured.summary);
    assert.strictEqual(r.body.structured.effect.issuedToAnotherEmail, true);
  });
  await test('a key without read:contacts gets a masked recipient, the approver in the program sees the full one', async () => {
    const noContacts = await keyFor('u_mgr', { scopes: gw.ALL_SCOPES.filter((s) => s !== 'read:contacts') });
    const r = await propose(noContacts, 'invoice_create', RENT('221'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.structured.summary.includes('t***@example.com') && !r.body.structured.summary.includes('t221@example.com'), r.body.structured.summary);
    assert.strictEqual(r.body.structured.effect.customerEmail, 't***@example.com');
    const list = await g.agentProposalList({ auth: adminAuth, data: {} });
    const row = list.proposals.find((p) => p.proposalId === r.body.structured.proposalId);
    assert.ok(row.summary.includes('t221@example.com')); assert.strictEqual(row.effect.customerEmail, 't221@example.com');
    const mine = await call(noContacts, 'GET', '/v1/proposals', { proposalId: r.body.structured.proposalId });
    assert.ok(!JSON.stringify(mine.body).includes('t221@example.com'), 'agent never receives the full address');
    // подтверждение сверяется с тем текстом, который агент реально показал (маскированным)
    clockSkew += 4000;
    const c = await confirm(noContacts, r.body.structured.proposalId, PFX(r.body.structured));
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  });
  await test('stale proposal: invoice paid between propose and confirm → 409 stale_proposal, closed, nothing executed', async () => {
    const r = await propose(mgr, 'invoice_void', { buildingId: 'b1', unitId: '212', invoiceId: 'in_212cur', reason: 'wrong month' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    clockSkew += 4000;
    const inv = stripeInvoices.find((x) => x.id === 'in_212cur');
    inv.status = 'paid'; inv.amount_remaining = 0; inv.amount_paid = inv.total;
    const c = await confirm(mgr, r.body.structured.proposalId, PFX(r.body.structured));
    assert.strictEqual(c.status, 409, JSON.stringify(c.body)); assert.strictEqual(c.body.error.details.reason, 'stale_proposal');
    assert.strictEqual(calls.void.length, 0); assert.strictEqual(prop(r.body.structured.proposalId).status, 'stale');
  });
  await test('stale proposal: amount changed between propose and confirm → stale, closed', async () => {
    const r = await propose(mgr, 'invoice_void', { buildingId: 'b1', unitId: '205', invoiceId: 'in_205prev' });
    clockSkew += 4000;
    const inv = stripeInvoices.find((x) => x.id === 'in_205prev');
    inv.amount_remaining = 50000;                 // частичная оплата пришла, пока человек думал
    const c = await confirm(mgr, r.body.structured.proposalId, PFX(r.body.structured));
    assert.strictEqual(c.status, 409, JSON.stringify(c.body)); assert.strictEqual(c.body.error.details.reason, 'stale_proposal');
    assert.strictEqual(prop(r.body.structured.proposalId).status, 'stale'); assert.strictEqual(calls.void.length, 0);
    inv.amount_remaining = 90000;
  });
  await test('invoice_void executes through voidOrDeleteStripeInvoice and clears the unit stamp that pointed at it (Entry 88)', async () => {
    const r = await propose(mgr, 'invoice_void', { buildingId: 'b1', unitId: '205', invoiceId: 'in_205prev' });
    clockSkew += 4000;
    assert.strictEqual(stateUnit('b1', '205').stripe.lastInvoiceId, 'in_205prev');
    const c = await confirm(mgr, r.body.structured.proposalId, PFX(r.body.structured));
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.deepStrictEqual(calls.void[0].data, { invoiceId: 'in_205prev' });
    const st = stateUnit('b1', '205').stripe;
    assert.ok(!('lastInvoiceId' in st) && !('lastInvoiceYm' in st)); assert.strictEqual(st.customerId, 'cus_205');
    assert.strictEqual(stateUnit('b2', '205').stripe.customerId, 'cus_b2_205', 'other building untouched');
  });
  await test('a proposal whose agent key was revoked cannot be approved', async () => {
    const tmp = await keyFor('u_mgr', { scopes: gw.ALL_SCOPES.filter((s) => s !== 'confirm:chat') });
    const r = await propose(tmp, 'invoice_create', RENT('221', { ym: addYm(CUR, 1) }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.structured.requiredConfirmation, 'app');
    store.get('workspaces/default/agentKeys/' + tmp.keyId).revoked = true;
    const n = calls.create.length;
    await assert.rejects(g.agentProposalDecide({ auth: adminAuth, data: { proposalId: r.body.structured.proposalId, decision: 'approve' } }), (e) => e.code === 'failed-precondition');
    assert.strictEqual(calls.create.length, n); assert.strictEqual(prop(r.body.structured.proposalId).status, 'stale');
  });
  await test('member downgraded to viewer after proposing (another instance, cache still says manager) → proposal is stale, nothing executes', async () => {
    store.set('workspaces/default/members/u_tmp', { role: 'manager', email: 'tmp@x.com' });
    const tmp = await keyFor('u_tmp');
    const r = await propose(tmp, 'invoice_create', RENT('221', { ym: addYm(CUR, 1) }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    clockSkew += 4000;
    store.set('workspaces/default/members/u_tmp', { role: 'viewer', email: 'tmp@x.com' });   // кэш инстанса ещё «manager»
    const n = calls.create.length;
    const c = await confirm(tmp, r.body.structured.proposalId, PFX(r.body.structured));
    assert.strictEqual(c.status, 409, JSON.stringify(c.body)); assert.strictEqual(calls.create.length, n);
    assert.strictEqual(prop(r.body.structured.proposalId).status, 'stale');
    // то же для архивированного: предложение не утверждается и в программе
    store.set('workspaces/default/members/u_tmp2', { role: 'manager', email: 'tmp2@x.com' });
    const tmp2 = await keyFor('u_tmp2', { scopes: gw.ALL_SCOPES.filter((s) => s !== 'confirm:chat') });
    const r2 = await propose(tmp2, 'invoice_create', RENT('221', { ym: addYm(CUR, 1) }));
    store.set('workspaces/default/members/u_tmp2', { role: 'manager', email: 'tmp2@x.com', archived: true });
    await assert.rejects(g.agentProposalDecide({ auth: adminAuth, data: { proposalId: r2.body.structured.proposalId, decision: 'approve' } }), (e) => e.code === 'failed-precondition');
    assert.strictEqual(calls.create.length, n);
  });
  await test('kill switch flipped on ANOTHER instance (this instance\'s cache still says classC:true) stops execution', async () => {
    const r = await propose(mgr, 'invoice_create', RENT('221', { ym: addYm(CUR, 1) }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    clockSkew += 4000;
    const cfgPath = 'workspaces/default/agentConfig/_config';
    const saved = store.get(cfgPath);
    store.set(cfgPath, Object.assign({}, saved, { classC: false }));          // без agentConfigSet → кэш не обновлён
    const n = calls.create.length;
    const c = await confirm(mgr, r.body.structured.proposalId, PFX(r.body.structured));
    assert.strictEqual(c.status, 503, JSON.stringify(c.body)); assert.strictEqual(calls.create.length, n);
    await assert.rejects(g.agentProposalDecide({ auth: adminAuth, data: { proposalId: r.body.structured.proposalId, decision: 'approve' } }), (e) => e.code === 'unavailable');
    store.set(cfgPath, saved);
    await g._internal.config(true);
  });
  await test('MCP: write tools publish idempotencyKey; propose/confirm are listed; dry-run call with the key works', async () => {
    const h = { host: 'x', authorization: 'Bearer ' + mgr.token, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const mk = (body) => ({ method: 'POST', path: '/', url: '/agentMcp', originalUrl: '/agentMcp', query: {}, body, headers: h, rawBody: Buffer.from(JSON.stringify(body)), get: (n) => h[String(n).toLowerCase()], ip: '1.2.3.4' });
    const res = fakeRes(); await g._internal.mcpHandler(mk({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), res);
    const tools = res.json().result.tools;
    const rem = tools.find((t) => t.name === 'send_reminder');
    assert.ok(rem && rem.inputSchema.properties.idempotencyKey, 'idempotencyKey in MCP schema');
    assert.strictEqual(rem.annotations.readOnlyHint, false);
    assert.ok(tools.some((t) => t.name === 'propose_action') && tools.some((t) => t.name === 'confirm_action'));
    const res2 = fakeRes(); await g._internal.mcpHandler(mk({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_reminder', arguments: { buildingId: 'b1', unitId: '206', dryRun: true, idempotencyKey: 'mcp-idem-0001' } } }), res2);
    const out = res2.json().result;
    assert.ok(!out.isError, JSON.stringify(out)); assert.strictEqual(out.structuredContent.structured.dryRun, true);
  });
  await test('legacy invoice without buildingId for a suite number that exists in two buildings is shown only with proof', async () => {
    stripeInvoices.push(
      { id: 'in_legacyB2', number: 'OLD-1', status: 'open', total: 11100, amount_remaining: 11100, amount_paid: 0, customer: 'cus_b2_205', customer_email: 'other205@example.com', created: sec(90), due_date: sec(80), hosted_invoice_url: 'https://stripe.test/legacyB2', metadata: { source: 'suitesforall', unitId: '205', purpose: 'rent', ym: addYm(CUR, -3) }, lines: { total_count: 1 } },
      { id: 'in_legacyB1', number: 'OLD-2', status: 'open', total: 22200, amount_remaining: 22200, amount_paid: 0, customer: 'cus_205', customer_email: 't205@example.com', created: sec(91), due_date: sec(81), metadata: { source: 'suitesforall', unitId: '205', purpose: 'rent', ym: addYm(CUR, -3) }, lines: { total_count: 1 } });
    const b1only = await keyFor('u_mgr', { buildings: ['b1'] });
    const ids = (await call(b1only, 'GET', '/v1/invoices', {})).body.structured.rows.map((r) => r.id);
    assert.ok(ids.includes('in_legacyB1'), ids.join(','));
    assert.ok(!ids.includes('in_legacyB2') && !ids.includes('in_b2x205'), 'b2 invoices hidden from a b1-only key: ' + ids.join(','));
    const b2ids = (await call(b2mgr, 'GET', '/v1/invoices', {})).body.structured.rows.map((r) => r.id);
    assert.ok(b2ids.includes('in_legacyB2') && !b2ids.includes('in_legacyB1'), b2ids.join(','));
    // карточка офиса: список открытых счетов со ссылками — по тому же правилу
    const card = (await call(b1only, 'GET', '/v1/units/b1/205')).body.structured;
    const open = card.stripe.openInvoices.map((x) => x.id);
    assert.ok(open.includes('in_legacyB1') && !open.includes('in_legacyB2'), open.join(','));
  });
  await test('a month 7 months back that was settled ONLY by a Stripe invoice is not a debt (paid-invoice window covers the 12-month lookback)', async () => {
    const o = (await call(mgr, 'GET', '/v1/overdue', {})).body.structured;
    assert.ok(!o.rows.some((r) => r.unitId === '222'), 'suite 222 must not be overdue: ' + JSON.stringify(o.rows.filter((r) => r.unitId === '222').map((r) => r.months)));
    const led = (await call(mgr, 'GET', '/v1/units/b1/222/ledger', { months: 12 })).body.structured;
    const m = led.months.find((x) => x.ym === addYm(CUR, -7));
    assert.ok(m && m.status === 'paid' && m.settledVia === 'stripe-paid', JSON.stringify(m));
    assert.strictEqual(led.totals.owedUsd, 0);
    // леджер не уходит дальше окна, которое видит снимок счетов
    assert.strictEqual((await call(mgr, 'GET', '/v1/units/b1/222/ledger', { months: 24 })).status, 400);
  });
  await test('Stripe invoice snapshot is read to the end; hitting the page cap is reported, never silent', async () => {
    const realList = fakeStripe.invoices.list;
    let pages = 0;
    fakeStripe.invoices.list = async (q) => {
      if (q.status !== 'open') return { data: [], has_more: false };
      pages++;
      const n = q.starting_after ? Number(q.starting_after.split('_')[2]) + 1 : 0;
      return { data: [{ id: 'in_pg_' + n, number: 'P-' + n, status: 'open', total: 100, amount_remaining: 100, amount_paid: 0, customer: 'cus_204', created: sec(1), due_date: sec(-9), metadata: { source: 'suitesforall', unitId: '204', buildingId: 'b1', purpose: 'custom' }, lines: { total_count: 1 } }], has_more: n < 4 };
    };
    const r = await call(mgr, 'GET', '/v1/invoices', { buildingId: 'b1', unitId: '204' });
    assert.strictEqual(r.body.structured.total, 5, JSON.stringify(r.body.structured.rows.map((x) => x.id)));
    assert.strictEqual(pages, 5); assert.ok(!r.body.structured.warnings);
    fakeStripe.invoices.list = async (q) => {
      if (q.status !== 'open') return { data: [], has_more: false };
      const n = q.starting_after ? Number(q.starting_after.split('_')[2]) + 1 : 0;
      return { data: [{ id: 'in_inf_' + n, number: 'I-' + n, status: 'open', total: 100, amount_remaining: 100, amount_paid: 0, customer: 'cus_204', created: sec(1), due_date: sec(-9), metadata: { source: 'suitesforall', unitId: '204', buildingId: 'b1', purpose: 'custom' }, lines: { total_count: 1 } }], has_more: true };
    };
    const t = await call(mgr, 'GET', '/v1/overdue', {});
    fakeStripe.invoices.list = realList;
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.ok(Array.isArray(t.body.structured.warnings) && /incomplete/.test(t.body.structured.warnings[0]), JSON.stringify(t.body.structured.warnings));
    assert.ok(/^WARNING/.test(t.body.text));
  });

  const fails = results.filter((r) => r[0] === 'FAIL');
  for (const r of results) console.log(r[0], r[1], r[2] ? '— ' + r[2] : '');
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  if (fails.length) { for (const l of logs.filter((x) => x[0] === 'error').slice(-8)) console.log('  log:', l[1].slice(0, 300)); process.exit(1); }
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
