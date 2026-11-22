// Сквозной прогон agent gateway через НАСТОЯЩИЙ серверный путь счетов (FIXES_LOG Entry 106,
// AGENT_API_PLAN § 5 Этап 1, «Готово, когда» п. 4): шлюз → agent-proposals → agent-tools-money
// → _createStripeInvoiceImpl / _stripeResendInvoiceImpl / _voidOrDeleteStripeInvoiceImpl /
// _markInvoicePaidOutOfBandImpl из functions/index.js. Firestore — в памяти, продовые данные
// не читаются и не пишутся.
//
// Два режима:
//   node tests/agent-stripe-e2e.cjs
//       Stripe поддельный (в памяти). Входит в `npm run test:agent`. Наружу ничего не ходит.
//   node tests/agent-stripe-e2e.cjs --stripe-test-mode
//       Stripe НАСТОЯЩИЙ, но только ТЕСТОВЫЙ режим. Ключ берётся из переменной окружения
//       SFA_STRIPE_TEST_KEY или из файла ~/.config/suitesforall/stripe-test-key и обязан
//       начинаться с sk_test_ / rk_test_ — с любым другим ключом прогон отказывается стартовать,
//       а живой ключ (STRIPE_SECRET_KEY) в процессе не существует вовсе. В тестовом аккаунте
//       Stripe появятся тестовый клиент и два счёта (один аннулируется, второй помечается
//       оплаченным вне Stripe). Писем арендаторам Stripe в тестовом режиме не шлёт.
//       Необязательно: SFA_TEST_TENANT_EMAIL — адрес «арендатора» (по умолчанию
//       agent-gateway-test@example.com).
//
// Ключ никогда не печатается. Чего этот прогон НЕ покрывает: вебхук invoice.paid (запись
// леджера после оплаты) — его Stripe доставляет только задеплоенной функции.
'use strict';
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const FN_DIR = path.join(__dirname, '..', 'functions');
const REAL = process.argv.includes('--stripe-test-mode');
const realLoad = Module._load;

// ---------- ключ тестового режима (только для --stripe-test-mode) ----------
const TEST_KEY_RE = /^(sk|rk)_test_[A-Za-z0-9]{10,}$/;
let TEST_KEY = 'sk_test_FAKEFAKEFAKEFAKE';
if (REAL) {
  let k = (process.env.SFA_STRIPE_TEST_KEY || '').trim();
  const f = path.join(os.homedir(), '.config', 'suitesforall', 'stripe-test-key');
  if (!k && fs.existsSync(f)) k = fs.readFileSync(f, 'utf8').trim();
  if (!k) { console.error('No Stripe TEST key: set SFA_STRIPE_TEST_KEY or put it into ~/.config/suitesforall/stripe-test-key'); process.exit(2); }
  if (!TEST_KEY_RE.test(k)) { console.error('REFUSING TO RUN: the key is not a Stripe test-mode key (it must start with sk_test_ or rk_test_). Nothing was called.'); process.exit(2); }
  TEST_KEY = k;
}

// ---------- generic stub ----------
const anyFn = new Proxy(function () {}, {
  get: (t, p) => (p === 'then' ? undefined : (p === Symbol.toPrimitive ? () => '' : anyFn)),
  apply: () => anyFn, construct: () => anyFn,
});
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; this.httpErrorCode = { status: 400 }; } }

// ---------- in-memory Firestore (сериализуемые транзакции, where ==) ----------
const store = new Map();
const SERVER_TS = { __serverTs: true };
class Timestamp { constructor(ms) { this.ms = ms; } toMillis() { return this.ms; } }
function resolve(obj, prev) {
  const out = Object.assign({}, prev || {});
  for (const [k, v] of Object.entries(obj)) out[k] = (v === SERVER_TS) ? new Timestamp(Date.now()) : v;
  return out;
}
function docRef(p) {
  return {
    path: p, id: p.split('/').pop(),
    async get() { const d = store.get(p); return { exists: !!d, id: p.split('/').pop(), data: () => (d ? Object.assign({}, d) : undefined) }; },
    async set(data, opts) { store.set(p, resolve(data, opts && opts.merge ? store.get(p) : null)); },
    async update(data) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, resolve(data, store.get(p))); },
    async delete() { store.delete(p); },
  };
}
function collectionRef(p, filters) {
  const f = filters || [];
  const self = {
    path: p, doc: (id) => docRef(p + '/' + id),
    where: (k, op, v) => collectionRef(p, f.concat([[k, op, v]])),
    orderBy: () => self, limit: () => self, select: () => self,
    async add(d) { const id = 'a' + crypto.randomBytes(4).toString('hex'); store.set(p + '/' + id, resolve(d, null)); return { id }; },
    async get() {
      const docs = [];
      for (const [k, v] of store.entries()) {
        if (!k.startsWith(p + '/') || k.slice(p.length + 1).includes('/')) continue;
        if (f.every(([fk, op, fv]) => (op === '==' ? v[fk] === fv : true))) docs.push({ id: k.split('/').pop(), exists: true, data: () => Object.assign({}, v) });
      }
      return { docs, empty: docs.length === 0, size: docs.length, forEach: (cb) => docs.forEach(cb) };
    },
  };
  return self;
}
let txChain = Promise.resolve();
const db = {
  doc: (p) => docRef(p), collection: (p) => collectionRef(p),
  runTransaction: (fn) => {
    const run = txChain.then(async () => {
      const pending = [];
      const tx = { get: (r) => r.get(), update: (r, d) => pending.push(() => r.update(d)), set: (r, d, o) => pending.push(() => r.set(d, o)), delete: (r) => pending.push(() => r.delete()) };
      const out = await fn(tx);
      for (const w of pending) await w();
      return out;
    });
    txChain = run.catch(() => {});
    return run;
  },
};
const firestoreFn = Object.assign(() => db, { FieldValue: { serverTimestamp: () => SERVER_TS, increment: (n) => n, arrayUnion: anyFn, delete: anyFn }, Timestamp });
const adminStub = { initializeApp: () => {}, firestore: firestoreFn, storage: anyFn, auth: anyFn, app: anyFn };

// ---------- поддельный Stripe (режим по умолчанию) ----------
const F = { invoices: new Map(), customers: new Map(), seq: 0 };
const nowSec = () => Math.floor(Date.now() / 1000);
const cp = (v) => JSON.parse(JSON.stringify(v));
const fakeStripe = {
  customers: {
    search: async ({ query }) => { const email = (/email:"([^"]*)"/.exec(query) || [])[1]; return { data: [...F.customers.values()].filter((c) => c.email === email).map(cp) }; },
    create: async (p) => { const c = { id: 'cus_fake' + (F.customers.size + 1), email: p.email, name: p.name, metadata: p.metadata || {}, invoice_settings: {} }; F.customers.set(c.id, c); return cp(c); },
    retrieve: async (id) => cp(F.customers.get(id) || { id, metadata: { workspaceId: 'default' }, invoice_settings: {} }),
  },
  invoices: {
    search: async ({ query }) => {
      const cust = (/customer:"([^"]*)"/.exec(query) || [])[1];
      const meta = [...query.matchAll(/metadata\["(\w+)"\]:"([^"]*)"/g)].map((m) => [m[1], m[2]]);
      return { data: [...F.invoices.values()].filter((i) => (!cust || i.customer === cust) && meta.every(([k, v]) => String((i.metadata || {})[k] || '') === v)).map(cp) };
    },
    list: async (a) => {
      let rows = [...F.invoices.values()];
      if (a && a.customer) rows = rows.filter((i) => i.customer === a.customer);
      if (a && a.status) rows = rows.filter((i) => i.status === a.status);
      if (a && a.created && a.created.gte) rows = rows.filter((i) => i.created >= a.created.gte);
      return { data: rows.map(cp), has_more: false };
    },
    create: async (p) => {
      const id = 'in_fake' + (++F.seq);
      const c = F.customers.get(p.customer) || {};
      const due = p.due_date != null ? p.due_date : (p.days_until_due != null ? nowSec() + p.days_until_due * 86400 - (p.days_until_due === 0 ? 60 : 0) : null);
      const inv = { id, object: 'invoice', status: 'draft', customer: p.customer, customer_email: c.email || '', collection_method: p.collection_method, description: p.description || '', footer: p.footer, metadata: Object.assign({}, p.metadata), created: nowSec(), due_date: due, total: 0, amount_due: 0, amount_paid: 0, amount_remaining: 0, currency: 'usd', lines: { total_count: 0, data: [] }, status_transitions: {}, hosted_invoice_url: 'https://stripe.fake/' + id, number: null, paid_out_of_band: false };
      F.invoices.set(id, inv); return cp(inv);
    },
    update: async (id, p) => { const inv = F.invoices.get(id); if (p.number) inv.number = p.number; if (p.metadata) Object.assign(inv.metadata, p.metadata); return cp(inv); },
    finalizeInvoice: async (id) => { const inv = F.invoices.get(id); inv.status = 'open'; inv.amount_due = inv.amount_remaining = inv.total; return cp(inv); },
    sendInvoice: async (id) => cp(F.invoices.get(id)),
    retrieve: async (id) => { const inv = F.invoices.get(id); if (!inv) { const e = new Error('No such invoice'); e.statusCode = 404; throw e; } return cp(inv); },
    voidInvoice: async (id) => { const inv = F.invoices.get(id); inv.status = 'void'; return cp(inv); },
    del: async (id) => { F.invoices.delete(id); return { id, deleted: true }; },
    pay: async (id, p) => { const inv = F.invoices.get(id); inv.status = 'paid'; inv.amount_paid = inv.total; inv.amount_remaining = 0; inv.paid_out_of_band = !!(p && p.paid_out_of_band); return cp(inv); },
  },
  invoiceItems: { create: async (p) => { const inv = F.invoices.get(p.invoice); inv.total += p.amount; inv.lines.total_count++; inv.lines.data.push({ amount: p.amount, description: p.description, metadata: p.metadata || {} }); return { id: 'ii_' + inv.lines.total_count }; } },
};

// ---------- перехват модулей ----------
let stripeClient = null;                      // клиент, которым проверяем результат в Stripe
const realAgentModules = new Set(['./agent-gateway', './agent-tools-read', './agent-tools-money', './agent-proposals', './agent-help.json']);
Module._load = function (request, parent) {
  if (request === 'firebase-admin') return adminStub;
  if (request === 'stripe') {
    if (!REAL) return () => { stripeClient = fakeStripe; return fakeStripe; };
    const realStripe = realLoad.apply(this, arguments);
    // Последняя линия защиты: клиент Stripe создаётся ТОЛЬКО с ключом тестового режима.
    return (key, opts) => {
      if (!TEST_KEY_RE.test(String(key || ''))) throw new Error('agent-stripe-e2e: refusing to create a Stripe client with a non-test key');
      stripeClient = realStripe(key, opts); return stripeClient;
    };
  }
  if (request === 'firebase-functions/v2/https') return { onCall: (o, h) => (typeof o === 'function' ? o : h), onRequest: (o, h) => (typeof o === 'function' ? o : h), HttpsError };
  if (request === 'firebase-functions/params') {
    return {
      // Живого ключа в процессе НЕТ: STRIPE_SECRET_KEY пуст, режим — test.
      defineSecret: (n) => ({ name: n, value: () => (n === 'STRIPE_TEST_KEY' ? TEST_KEY : (n === 'STRIPE_SECRET_KEY' ? '' : 'FAKE-' + n)) }),
      defineString: (n, o) => ({ value: () => (n === 'ENV' ? 'test' : ((o && o.default) || '')) }),
    };
  }
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {}, log() {} };
  if (request.startsWith('firebase-functions')) return anyFn;
  if (request === 'jsonwebtoken') return { sign: () => 'fake-assertion' };
  // Из локальных модулей functions/*.js настоящие — только шлюз и lib/*; остальные (почта,
  // HubSpot, UniFi…) этому прогону не нужны и наружу ходить не должны.
  if (request.startsWith('./') && !request.startsWith('./lib/') && !realAgentModules.has(request)
      && parent && parent.filename && path.dirname(parent.filename) === FN_DIR) return anyFn;
  return realLoad.apply(this, arguments);
};

// ---------- workspace в памяти: одно тестовое здание, один арендатор ----------
function addYm(ym, n) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
const _ny = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
const CUR = `${_ny.year}-${_ny.month}`;
const NEXT = addYm(CUR, 1);
// Уникальный номер офиса на прогон: дедуп счетов в Stripe идёт по (клиент, офис, месяц).
const UNIT = 'AG' + Date.now().toString(36).slice(-5).toUpperCase();
const BLD = 'agent-e2e-bld';
const TENANT_EMAIL = (process.env.SFA_TEST_TENANT_EMAIL || 'agent-gateway-test@example.com').trim().toLowerCase();
const RENT = 137.5;                                   // приметная сумма: $137.50
const payments = {}; for (let i = 4; i >= 1; i--) payments[addYm(CUR, -i)] = { status: 'paid', amount: RENT };
store.set('workspaces/default/data/state', {
  _rev: 1,
  state: {
    settings: { lateFee: { graceDays: 5 } },
    buildings: [{ id: BLD, name: 'Agent E2E Test Building', code: 'AGT', address: '1 Test Way', floors: [{ id: 'f1', name: '1st', units: [
      { id: UNIT, type: 'office', rentable: true, status: 'occupied', sqft: 120, tenant: 'Agent Gateway Test Tenant', email: TENANT_EMAIL, contractRent: RENT, leaseStart: addYm(CUR, -4) + '-01', payments },
    ] }] }],
  },
});
store.set('workspaces/default/members/u_mgr', { role: 'manager', email: 'secretary@example.com' });
store.set('workspaces/default/members/u_admin', { role: 'admin', email: 'owner@example.com' });
const mgrAuth = { uid: 'u_mgr', token: { email: 'secretary@example.com' } };
const adminAuth = { uid: 'u_admin', token: { email: 'owner@example.com' } };

const fns = require(path.join(FN_DIR, 'index.js'));

// ---------- helpers ----------
function fakeRes() {
  const r = { statusCode: 200, headers: {}, chunks: [] };
  r.set = (k, v) => { r.headers[String(k).toLowerCase()] = v; return r; };
  r.status = (s) => { r.statusCode = s; return r; };
  r.send = (b) => { r.chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b))); return r; };
  r.end = (b) => { if (b) r.chunks.push(Buffer.from(String(b))); return r; };
  r.json = () => JSON.parse(Buffer.concat(r.chunks).toString('utf8'));
  return r;
}
let TOKEN = null; let idemN = 0;
async function call(method, p, body, extraHeaders) {
  const h = Object.assign({ host: 'local.test', authorization: 'Bearer ' + TOKEN }, extraHeaders || {});
  const req = { method, path: p, url: p, originalUrl: p, query: method === 'GET' ? (body || {}) : {}, body: method === 'GET' ? undefined : body, headers: h, get: (n) => h[String(n).toLowerCase()], ip: '127.0.0.1' };
  const res = fakeRes();
  await fns.agentApi(req, res);
  return { status: res.statusCode, body: res.json() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateUnit = () => store.get('workspaces/default/data/state').state.buildings[0].floors[0].units[0];
const created = [];                                   // id счетов, созданных этим прогоном
const results = [];
async function step(name, fn) {
  try { const note = await fn(); results.push(['PASS', name, note || '']); console.log('PASS', name, note ? '— ' + note : ''); }
  catch (e) { results.push(['FAIL', name, (e && e.message) || String(e)]); console.log('FAIL', name, '—', (e && e.message) || e); throw e; }
}
async function proposeAndConfirm(action, args) {
  const pr = await call('POST', '/v1/proposals', { action, args });
  assert.strictEqual(pr.status, 200, JSON.stringify(pr.body));
  const p = pr.body.structured;
  if (p.requiredConfirmation !== 'chat') return { proposal: p };
  await sleep(3200);                                   // барьер шлюза: не раньше 3 с после предложения
  const c = await call('POST', `/v1/proposals/${p.proposalId}/confirm`, { confirmedBy: 'user', summaryPrefix: p.summary.slice(0, 48) });
  return { proposal: p, confirm: c };
}

(async () => {
  console.log(REAL ? `MODE: REAL Stripe, TEST mode key (${TEST_KEY.slice(0, 8)}…), tenant ${TENANT_EMAIL}, suite ${UNIT}` : `MODE: fake Stripe (in memory), suite ${UNIT}`);
  let invRent = null; let invNext = null;
  try {
    await step('gateway is wired into the real functions entry point', async () => {
      for (const n of ['agentApi', 'agentMcp', 'agentKeyCreate', 'agentConfigSet', 'agentProposalList', 'agentProposalDecide']) assert.strictEqual(typeof fns[n], 'function', n);
    });
    await step('a manager creates a key through agentKeyCreate; an admin turns money on in this in-memory workspace only', async () => {
      const k = await fns.agentKeyCreate({ auth: mgrAuth, data: { client: 'script', label: 'e2e', scopes: ['read:units', 'read:contacts', 'read:finance', 'write:reminders', 'money:invoices', 'confirm:chat'], ttlDays: 1 } });
      TOKEN = k.token; assert.ok(/^sfa_ak_/.test(TOKEN));
      const cfg = await fns.agentConfigSet({ auth: adminAuth, data: { classC: true } });
      assert.strictEqual(cfg.config.classC, true);
      const who = await call('GET', '/v1/whoami');
      assert.strictEqual(who.body.structured.role, 'manager'); assert.ok(who.body.structured.actions.some((a) => a.name === 'invoice_create'));
    });
    await step('the tenant is a debtor before anything is invoiced', async () => {
      const o = await call('GET', '/v1/overdue', { buildingId: BLD });
      assert.strictEqual(o.status, 200, JSON.stringify(o.body));
      const now = new Date(); const nyDay = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', day: 'numeric' }).format(now);
      const row = o.body.structured.rows.find((r) => r.unitId === UNIT);
      if (nyDay > 6) { assert.ok(row, 'current month is past the grace day — the suite must be overdue'); assert.strictEqual(row.totalOwedUsd, RENT); return `overdue ${row.totalOwedUsd}`; }
      return 'within the grace period — not overdue yet';
    });
    await step('rent invoice: propose → confirm in chat → real server path creates, finalizes and sends it', async () => {
      const { proposal, confirm } = await proposeAndConfirm('invoice_create', { buildingId: BLD, unitId: UNIT, purpose: 'rent', ym: CUR });
      assert.strictEqual(proposal.requiredConfirmation, 'chat', JSON.stringify(proposal.confirmationReasons));
      assert.strictEqual(proposal.effect.amountUsd, RENT);
      assert.ok(proposal.summary.includes('$137.50') && proposal.summary.includes(CUR), proposal.summary);
      assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
      invRent = confirm.body.structured.result.invoiceId; created.push(invRent);
      assert.ok(/^in_/.test(invRent));
      return invRent;
    });
    await step('Stripe has exactly that invoice: open, send_invoice, total $137.50, our metadata, custom number', async () => {
      const inv = await stripeClient.invoices.retrieve(invRent);
      assert.strictEqual(inv.status, 'open'); assert.strictEqual(inv.collection_method, 'send_invoice');
      assert.strictEqual(inv.total, 13750, 'total in cents');
      const m = inv.metadata || {};
      assert.strictEqual(m.unitId, UNIT); assert.strictEqual(m.buildingId, BLD); assert.strictEqual(m.purpose, 'rent'); assert.strictEqual(m.ym, CUR); assert.strictEqual(m.source, 'suitesforall');
      // Номер программы: [код здания-]R-<офис>-<месяц>-<дата>; R = rent, поставлен человеком/агентом (не RA-авто).
      assert.ok(inv.number && /(^|-)R-/.test(inv.number) && inv.number.includes(UNIT), 'custom rent invoice number: ' + inv.number);
      assert.strictEqual(String(inv.customer_email || '').toLowerCase(), TENANT_EMAIL);
      return `${inv.number} · ${inv.status} · ${(inv.total / 100).toFixed(2)}`;
    });
    await step('the suite carries the same stamps the UI path writes (customerId, lastInvoiceId, lastInvoiceYm)', async () => {
      const st = stateUnit().stripe || {};
      assert.ok(/^cus_/.test(st.customerId || ''), 'customerId'); assert.strictEqual(st.lastInvoiceId, invRent); assert.strictEqual(st.lastInvoiceYm, CUR);
    });
    await step('a second rent invoice for the same month is refused before anything is created', async () => {
      const pr = await call('POST', '/v1/proposals', { action: 'invoice_create', args: { buildingId: BLD, unitId: UNIT, purpose: 'rent', ym: CUR } });
      assert.strictEqual(pr.status, 409, JSON.stringify(pr.body)); assert.ok(/already exists/.test(pr.body.error.message), pr.body.error.message);
    });
    await step('send_reminder re-sends that invoice through Stripe and logs the outreach on the suite', async () => {
      const r = await call('POST', `/v1/units/${BLD}/${UNIT}/reminder`, {}, { 'idempotency-key': 'e2e-reminder-' + (++idemN) + '-' + UNIT });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.structured.invoiceId, invRent);
      const u = stateUnit();
      assert.strictEqual(u.collectionStatus, 'reminded'); assert.strictEqual(u.outreach[u.outreach.length - 1].kind, 'reminder');
    });
    await step('invoice_void: propose → confirm → Stripe invoice is void and the suite stamp no longer points at it', async () => {
      const { proposal, confirm } = await proposeAndConfirm('invoice_void', { buildingId: BLD, unitId: UNIT, invoiceId: invRent, reason: 'e2e run' });
      assert.strictEqual(proposal.requiredConfirmation, 'chat', JSON.stringify(proposal.confirmationReasons));
      assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
      const inv = await stripeClient.invoices.retrieve(invRent);
      assert.strictEqual(inv.status, 'void');
      const st = stateUnit().stripe || {};
      assert.ok(!st.lastInvoiceId && !st.lastInvoiceYm, 'stamps cleared'); assert.ok(/^cus_/.test(st.customerId || ''), 'customer kept');
    });
    await step('after the void the month can be invoiced again (next month here, to keep both invoices apart)', async () => {
      const { proposal, confirm } = await proposeAndConfirm('invoice_create', { buildingId: BLD, unitId: UNIT, purpose: 'rent', ym: NEXT });
      assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
      invNext = confirm.body.structured.result.invoiceId; created.push(invNext);
      assert.ok(/due /.test(proposal.summary));
      return invNext;
    });
    await step('mark-paid-outside-Stripe cannot be confirmed in chat; an admin approves it in the program → Stripe invoice is paid out of band', async () => {
      const { proposal } = await proposeAndConfirm('invoice_mark_paid_oob', { buildingId: BLD, unitId: UNIT, invoiceId: invNext, paymentMethod: 'check', paidAt: new Date().toISOString().slice(0, 10), note: 'e2e' });
      assert.strictEqual(proposal.requiredConfirmation, 'app');
      const list = await fns.agentProposalList({ auth: adminAuth, data: {} });
      assert.ok(list.proposals.some((p) => p.proposalId === proposal.proposalId && p.status === 'pending'));
      const out = await fns.agentProposalDecide({ auth: adminAuth, data: { proposalId: proposal.proposalId, decision: 'approve' } });
      assert.strictEqual(out.status, 'executed');
      const inv = await stripeClient.invoices.retrieve(invNext);
      assert.strictEqual(inv.status, 'paid'); assert.strictEqual(inv.paid_out_of_band, true);
    });
    await step('every action left an audit trail; no dead-letter was written', async () => {
      const audit = [...store.entries()].filter(([k]) => k.startsWith('workspaces/default/audit/')).map(([, v]) => v.action);
      for (const a of ['agent.key.created', 'agent.proposal.created', 'agent.proposal.executed', 'agent.reminder.sent']) assert.ok(audit.includes(a), a + ' missing from audit: ' + audit.join(','));
      assert.strictEqual([...store.keys()].filter((k) => k.startsWith('workspaces/default/agentDeadLetter/')).length, 0);
      return `${audit.length} audit rows`;
    });
  } catch (_) { /* шаг уже напечатан как FAIL */ } finally {
    // Уборка: счёт этого прогона, оставшийся открытым после сбоя, аннулируем.
    if (stripeClient) {
      for (const id of created) {
        try { const inv = await stripeClient.invoices.retrieve(id); if (inv.status === 'open') { await stripeClient.invoices.voidInvoice(id); console.log('cleanup: voided', id); } } catch (e) { console.log('cleanup: could not check', id, '-', e.message); }
      }
    }
  }
  const fails = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - fails.length}/${results.length} passed${REAL ? ' (Stripe TEST mode)' : ' (fake Stripe)'}`);
  if (REAL && created.length) console.log('Stripe test-mode invoices of this run:', created.map((id) => 'https://dashboard.stripe.com/test/invoices/' + id).join('  '));
  process.exit(fails.length || results.length < 12 ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
