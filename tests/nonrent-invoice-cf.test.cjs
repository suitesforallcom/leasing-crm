// Регрессионный тест FIXES_LOG Entry 107 (2026-11-22) — две ошибки серверного пути счетов Stripe.
//
//   Ошибка 1. _createStripeInvoiceImpl пишет u.stripe.lastInvoiceId для ЛЮБОГО
//             назначения счёта, а lastInvoiceYm — только для rent. Оплаченный разовый
//             счёт после этого читается каноном как оплата месяца аренды.
//   Ошибка 2. Слово «deposit» в описании разового счёта: дедуп в
//             _createStripeInvoiceImpl считает его депозитным счётом, а вебхук
//             invoice.paid (isDepositByDesc) перезаписывает u.stripe.depositInvoice.
//
// Тест грузит НАСТОЯЩИЙ functions/index.js с подменёнными firebase-* модулями,
// Firestore в памяти и поддельным Stripe (модуль `stripe` перехвачен). Наружу ничего
// не ходит: ни Stripe, ни Firestore, ни почта. До исправления 7 утверждений были красными.
//
// Запуск: node tests/nonrent-invoice-cf.test.cjs   (нужен functions/node_modules)
'use strict';
const Module = require('module');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const FN_DIR = process.argv[2] || path.join(__dirname, '..', 'functions');
const realLoad = Module._load;

// ---------- generic stub ----------
const anyFn = new Proxy(function () {}, {
  get: (t, p) => (p === 'then' ? undefined : (p === Symbol.toPrimitive ? () => '' : anyFn)),
  apply: () => anyFn,
  construct: () => anyFn,
});
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.httpErrorCode = { status: 400 }; }
}

// ---------- in-memory Firestore ----------
const store = new Map();
const SERVER_TS = { __serverTs: true };
class Timestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  static fromMillis(ms) { return new Timestamp(ms); }
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function resolveSentinels(obj, prev) {
  const out = Object.assign({}, prev || {});
  for (const [k, v] of Object.entries(obj)) out[k] = (v === SERVER_TS) ? { ms: Date.now() } : v;
  return out;
}
function docRef(p) {
  return {
    path: p, id: p.split('/').pop(),
    async get() { const d = store.get(p); return { exists: !!d, id: p.split('/').pop(), data: () => clone(d) }; },
    async set(data, opts) { store.set(p, clone(resolveSentinels(data, opts && opts.merge ? store.get(p) : null))); },
    async update(data) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, clone(resolveSentinels(data, store.get(p)))); },
    async delete() { store.delete(p); },
  };
}
let addSeq = 0;
function collectionRef(p) {
  const self = {
    path: p, doc: (id) => docRef(p + '/' + id),
    where: () => self, orderBy: () => self, limit: () => self, select: () => self,
    async add(d) { const id = 'auto' + (++addSeq); store.set(p + '/' + id, clone(resolveSentinels(d, null))); return { id }; },
    async get() {
      const docs = [];
      for (const [k, v] of store.entries()) {
        if (!k.startsWith(p + '/') || k.slice(p.length + 1).includes('/')) continue;
        docs.push({ id: k.split('/').pop(), exists: true, data: () => clone(v) });
      }
      return { docs, empty: docs.length === 0, size: docs.length, forEach: (cb) => docs.forEach(cb) };
    },
  };
  return self;
}
const db = {
  doc: (p) => docRef(p),
  collection: (p) => collectionRef(p),
  runTransaction: async (fn) => {
    const pending = [];
    const tx = {
      get: (ref) => ref.get(),
      update: (ref, data) => pending.push(() => ref.update(data)),
      set: (ref, data, o) => pending.push(() => ref.set(data, o)),
      delete: (ref) => pending.push(() => ref.delete()),
    };
    const r = await fn(tx);
    for (const p of pending) await p();
    return r;
  },
};
const firestoreFn = Object.assign(() => db, {
  FieldValue: { serverTimestamp: () => SERVER_TS, increment: (n) => n, arrayUnion: anyFn, delete: anyFn },
  Timestamp,
});
const adminStub = { initializeApp: () => {}, firestore: firestoreFn, storage: anyFn, auth: anyFn, app: anyFn };

// ---------- fake Stripe ----------
const S = { invoices: new Map(), seq: 0, calls: [] };
const nowSec = () => Math.floor(Date.now() / 1000);
function searchInvoices(query) {
  const cust = (/customer:"([^"]*)"/.exec(query) || [])[1];
  const meta = [...query.matchAll(/metadata\["(\w+)"\]:"([^"]*)"/g)].map((m) => [m[1], m[2]]);
  return [...S.invoices.values()].filter((inv) =>
    (!cust || inv.customer === cust) && meta.every(([k, v]) => String((inv.metadata || {})[k] || '') === v));
}
const fakeStripe = {
  customers: {
    search: async () => ({ data: [] }),
    create: async (p) => ({ id: 'cus_created', email: p.email }),
    retrieve: async (id) => ({ id, metadata: { workspaceId: 'default' }, invoice_settings: {} }),
  },
  invoices: {
    search: async ({ query }) => ({ data: searchInvoices(query).map(clone) }),
    list: async (args) => {
      let rows = [...S.invoices.values()];
      if (args && args.customer) rows = rows.filter((i) => i.customer === args.customer);
      if (args && args.status) rows = rows.filter((i) => i.status === args.status);
      rows.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
      return { data: rows.map(clone), has_more: false };
    },
    create: async (p) => {
      const id = 'in_test' + (++S.seq);
      const due = p.due_date != null ? p.due_date
        : (p.days_until_due != null ? (p.days_until_due === 0 ? nowSec() - 60 : nowSec() + p.days_until_due * 86400) : null);
      const inv = {
        id, object: 'invoice', status: 'draft', customer: p.customer, customer_email: 'tenant@example.test',
        collection_method: p.collection_method, description: p.description, footer: p.footer,
        metadata: Object.assign({}, p.metadata), created: nowSec() + S.seq, due_date: due,
        total: 0, amount_due: 0, amount_paid: 0, amount_remaining: 0,
        lines: { total_count: 0, data: [] }, status_transitions: {},
        hosted_invoice_url: 'https://stripe.test/' + id, number: null,
      };
      S.invoices.set(id, inv); S.calls.push(['invoices.create', id, p.metadata.purpose]);
      return clone(inv);
    },
    update: async (id, p) => {
      const inv = S.invoices.get(id);
      if (p.number) inv.number = p.number;
      if (p.metadata) Object.assign(inv.metadata, p.metadata);
      return clone(inv);
    },
    finalizeInvoice: async (id) => { const inv = S.invoices.get(id); inv.status = 'open'; inv.amount_due = inv.amount_remaining = inv.total; return clone(inv); },
    sendInvoice: async (id) => clone(S.invoices.get(id)),
    retrieve: async (id) => { const inv = S.invoices.get(id); if (!inv) { const e = new Error('No such invoice'); e.statusCode = 404; throw e; } return clone(inv); },
    voidInvoice: async (id) => { const inv = S.invoices.get(id); inv.status = 'void'; return clone(inv); },
    del: async (id) => { S.invoices.delete(id); return { id, deleted: true }; },
  },
  invoiceItems: {
    create: async (p) => {
      const inv = S.invoices.get(p.invoice);
      inv.total += p.amount; inv.lines.total_count++; inv.lines.data.push({ amount: p.amount, description: p.description, metadata: p.metadata });
      return { id: 'ii_' + inv.lines.total_count };
    },
  },
  webhooks: { constructEvent: (rawBody) => JSON.parse(rawBody) },
};
// Готовый счёт прямо в «Stripe» (как будто выставлен раньше).
function seedInvoice(over) {
  const id = over.id;
  S.invoices.set(id, Object.assign({
    id, object: 'invoice', status: 'open', customer: 'cus_x', customer_email: 'tenant@example.test',
    description: '', metadata: {}, created: nowSec() - 86400 * 40, due_date: nowSec() - 86400 * 30,
    total: 0, amount_due: 0, amount_paid: 0, amount_remaining: 0, lines: { total_count: 1, data: [] },
    status_transitions: {}, hosted_invoice_url: 'https://stripe.test/' + id, number: id,
  }, over));
}

Module._load = function (request, parent) {
  if (request === 'firebase-admin') return adminStub;
  if (request === 'stripe') return () => fakeStripe;
  if (request === 'firebase-functions/v2/https') {
    return { onCall: (o, h) => (typeof o === 'function' ? o : h), onRequest: (o, h) => (typeof o === 'function' ? o : h), HttpsError };
  }
  if (request === 'firebase-functions/params') {
    return { defineSecret: (n) => ({ name: n, value: () => 'FAKE-' + n }), defineString: (n, o) => ({ value: () => (o && o.default) || '' }) };
  }
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {}, log() {} };
  if (request.startsWith('firebase-functions')) return anyFn;
  if (request === 'jsonwebtoken') return { sign: () => 'fake-assertion' };
  // Локальные модули functions/*.js не нужны этому тесту; общий contact-модуль — настоящий
  // (через него _assertTenantEmail проверяет адрес арендатора).
  if (request.startsWith('./') && !request.startsWith('./lib/')
      && parent && parent.filename && path.dirname(parent.filename) === FN_DIR) return anyFn;
  return realLoad.apply(this, arguments);
};

// ---------- даты: от «сегодня», чтобы тест не протухал ----------
function addYm(ym, n) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
const _d = new Date();
const CUR = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}`;
const RENT_YM = addYm(CUR, -2);             // два месяца назад — заведомо просрочен
const START = addYm(CUR, -12) + '-01';
function paidBefore(ym, amount) { const o = {}; for (let i = 11; i >= 3; i--) { const m = addYm(CUR, -i); if (m < ym) o[m] = { status: 'paid', amount }; } return o; }

// ---------- workspace ----------
const tenantUnit = (id, extra) => Object.assign({
  id, type: 'office', rentable: true, status: 'occupied', sqft: 300,
  tenant: 'Tenant ' + id, email: `t${id}@example.test`, contractRent: 1000, deposit: 1500,
  leaseStart: START, until: addYm(CUR, 12) + '-28', leaseTerm: 24, payments: paidBefore(RENT_YM, 1000),
  stripe: { customerId: 'cus_' + id },
}, extra || {});
const REAL_DEP_PAID_AT = Date.now() - 300 * 86400000;
const stateDoc = {
  _rev: 1,
  state: {
    settings: { lateFee: { graceDays: 5 } },
    stripeCustomers: Object.fromEntries(['300', '301', '302', '303', '304', '305'].map((id) => [`t${id}@example.test`, { customerId: 'cus_' + id }])),
    buildings: [{ id: 'b1', name: 'Bay Vista', code: 'BAY', address: '1 Test Way', floors: [{ id: 'f1', name: '3rd', units: [
      // 300 — Ошибка 1: аренда за RENT_YM выставлена и не оплачена, потом разовый счёт.
      tenantUnit('300'),
      // 301 — настоящий депозит $1500 оплачен; потом «Key card deposit» $25.
      tenantUnit('301', { stripe: { customerId: 'cus_301', depositInvoice: { invoiceId: 'in_dep301', amount: 1500, status: 'paid', paidAt: REAL_DEP_PAID_AT } } }),
      // 302 — депозит $1500 ещё не выставлен; «Key card deposit» $25.
      tenantUnit('302'),
      // 303 — депозит $1500 выставлен и НЕ оплачен; счёт за ущерб со словом deposit.
      tenantUnit('303', { stripe: { customerId: 'cus_303', depositInvoice: { invoiceId: 'in_dep303', amount: 1500, status: 'open' } } }),
      // 304 — контроль: настоящий депозит (purpose='deposit') проходит весь путь.
      tenantUnit('304'),
      // 305 — контроль legacy: старый депозит формы custom + «Security deposit», без штампа.
      tenantUnit('305'),
    ] }] }],
  },
};
store.set('workspaces/default/data/state', clone(stateDoc));
store.set('workspaces/default/members/u_mgr', { role: 'manager', email: 'mgr@x.test' });
seedInvoice({ id: 'in_dep301', status: 'paid', customer: 'cus_301', total: 150000, amount_paid: 150000,
  description: 'Security deposit — Suite 301', metadata: { source: 'suitesforall', unitId: '301', buildingId: 'b1', floorId: 'f1', purpose: 'deposit', ym: addYm(CUR, -11) } });
seedInvoice({ id: 'in_dep303', status: 'open', customer: 'cus_303', total: 150000, amount_due: 150000, amount_remaining: 150000,
  description: 'Security deposit — Suite 303', metadata: { source: 'suitesforall', unitId: '303', buildingId: 'b1', floorId: 'f1', purpose: 'deposit', ym: addYm(CUR, -1) } });

// legacy-депозит: выставлен в октябре 2026 (до отсечки Entry 107) как custom + «Security deposit».
seedInvoice({ id: 'in_legacy305', status: 'open', customer: 'cus_305', total: 150000, amount_due: 150000, amount_remaining: 150000,
  created: Date.UTC(2026, 9, 5) / 1000, description: 'Service charge: Security deposit — Suite 305 · October 2026',
  metadata: { source: 'suitesforall', unitId: '305', buildingId: 'b1', floorId: 'f1', purpose: 'custom', ym: '2026-10' } });

const fns = require(path.join(FN_DIR, 'index.js'));
const AUTH = { uid: 'u_mgr', token: { email: 'mgr@x.test' } };
const unitOf = (id) => store.get('workspaces/default/data/state').state.buildings[0].floors[0].units.find((u) => u.id === id);
const createInvoice = (unitId, data) => fns.createStripeInvoice({ auth: AUTH, data: Object.assign({ buildingId: 'b1', floorId: 'f1', unitId }, data) });
let evtSeq = 0;
async function payInvoice(invoiceId) {
  const inv = S.invoices.get(invoiceId);
  inv.status = 'paid'; inv.amount_paid = inv.total; inv.amount_remaining = 0;
  inv.status_transitions = { paid_at: nowSec() };
  const event = { id: 'evt_test' + (++evtSeq), type: 'invoice.paid', data: { object: clone(inv) } };
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  await fns.stripeWebhook({ headers: { 'stripe-signature': 'sig' }, rawBody: JSON.stringify(event) }, res);
  return res;
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['ok  ', name]); }
  catch (e) { results.push(['FAIL', name, String((e && e.message) || e).split('\n')[0]]); }
}

(async () => {
  const money = await import(pathToFileURL(path.join(FN_DIR, 'lib', 'money.mjs')).href);
  const canonSnap = async () => {
    const st = store.get('workspaces/default/data/state').state;
    const listed = await fns.listStripeInvoices({ auth: AUTH, data: { lean: true, limit: 100 } });
    return { buildings: clone(st.buildings), invoices: listed.rows, invoiceBuckets: {}, settings: st.settings, now: new Date() };
  };
  const canonUnit = (snap, id) => snap.buildings[0].floors[0].units.find((u) => u.id === id);

  // ═══ Ошибка 1 ═══════════════════════════════════════════════════════════
  let rentId = null, keysId = null;
  await test('[контроль] rent-счёт за месяц выставлен: штампы lastInvoiceId + lastInvoiceYm указывают на него, месяц не оплачен', async () => {
    const r = await createInvoice('300', { purpose: 'rent', ym: RENT_YM, dueDateUnix: nowSec() - 86400 * 50 });
    rentId = r.invoiceId;
    const st = unitOf('300').stripe;
    assert.strictEqual(st.lastInvoiceId, rentId); assert.strictEqual(st.lastInvoiceYm, RENT_YM);
    const snap = await canonSnap();
    assert.strictEqual(money.isMonthSettled(canonUnit(snap, '300'), RENT_YM, snap), null);
    assert.strictEqual(money.monthStatus(canonUnit(snap, '300'), RENT_YM, snap), 'overdue');
  });
  await test('[контроль] разовый счёт «Replacement key» $25 (purpose=keys) создан и записан в u.stripe.extraInvoices', async () => {
    const r = await createInvoice('300', { purpose: 'keys', amountOverride: 25, description: 'Replacement key' });
    keysId = r.invoiceId;
    assert.ok(keysId && keysId !== rentId);
    assert.strictEqual((unitOf('300').stripe.extraInvoices || [])[0].id, keysId);
  });
  await test('ОШИБКА 1 [источник]: после разового счёта lastInvoiceId обязан по-прежнему указывать на rent-счёт месяца lastInvoiceYm', async () => {
    const st = unitOf('300').stripe;
    assert.strictEqual(st.lastInvoiceYm, RENT_YM);
    assert.strictEqual(st.lastInvoiceId, rentId,
      `lastInvoiceYm=${st.lastInvoiceYm}, но lastInvoiceId=${st.lastInvoiceId} — это счёт purpose=${(S.invoices.get(st.lastInvoiceId).metadata || {}).purpose}`);
  });
  await test('[контроль] арендатор платит ТОЛЬКО разовый счёт $25: вебхук invoice.paid отвечает 200', async () => {
    const res = await payInvoice(keysId);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(S.invoices.get(rentId).status, 'open');
  });
  await test('ОШИБКА 1 [итог]: rent-счёт месяца открыт и просрочен → канон обязан считать месяц НЕоплаченным', async () => {
    const snap = await canonSnap();
    const got = money.isMonthSettled(canonUnit(snap, '300'), RENT_YM, snap);
    assert.strictEqual(got, null, `isMonthSettled(${RENT_YM}) = ${got}; rent-счёт ${rentId} в Stripe: ${S.invoices.get(rentId).status}`);
  });
  await test('ОШИБКА 1 [итог]: тот же юнит обязан остаться должником за этот месяц (overdue, $1000)', async () => {
    const snap = await canonSnap(); const u = canonUnit(snap, '300');
    assert.deepStrictEqual({ status: money.monthStatus(u, RENT_YM, snap), owed: money.monthAmount(u, RENT_YM, snap) }, { status: 'overdue', owed: 1000 });
  });

  // ═══ Ошибка 2 ═══════════════════════════════════════════════════════════
  await test('ОШИБКА 2 [дедуп]: «Key card deposit» $25 (purpose=custom) — разовый счёт; оплаченный настоящий депозит не должен его блокировать', async () => {
    let err = null;
    try { await createInvoice('301', { purpose: 'custom', amountOverride: 25, description: 'Key card deposit' }); } catch (e) { err = e; }
    assert.strictEqual(err, null, err && `${err.code}: ${err.message}`);
  });
  let kc301 = null;
  await test('[контроль] оператор обходит блок через allowDuplicate=true — счёт «Key card deposit» $25 создан', async () => {
    const existing = [...S.invoices.values()].find((i) => i.customer === 'cus_301' && i.metadata.purpose === 'custom');
    kc301 = existing ? existing.id
      : (await createInvoice('301', { purpose: 'custom', amountOverride: 25, description: 'Key card deposit', allowDuplicate: true })).invoiceId;
    assert.ok(kc301);
    assert.match(S.invoices.get(kc301).description, /Service charge: Key card deposit/);
  });
  await test('ОШИБКА 2 [вебхук]: оплачен «Key card deposit» $25 → штамп настоящего депозита (in_dep301, $1500, paid) не тронут', async () => {
    const res = await payInvoice(kc301);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const di = unitOf('301').stripe.depositInvoice;
    assert.deepStrictEqual({ invoiceId: di.invoiceId, amount: di.amount, status: di.status, paidAt: di.paidAt },
      { invoiceId: 'in_dep301', amount: 1500, status: 'paid', paidAt: REAL_DEP_PAID_AT });
  });
  await test('ОШИБКА 2 [вебхук]: депозит $1500 ещё не выставлен; оплачен «Key card deposit» $25 → депозит НЕ должен стать «оплачен»', async () => {
    const r = await createInvoice('302', { purpose: 'custom', amountOverride: 25, description: 'Key card deposit' });
    await payInvoice(r.invoiceId);
    const di = unitOf('302').stripe.depositInvoice;
    assert.ok(!di || di.status !== 'paid', `u.stripe.depositInvoice = ${JSON.stringify(di)}`);
  });
  await test('ОШИБКА 2 [вебхук]: депозит $1500 выставлен и НЕ оплачен; оплачен счёт purpose=damages «…not covered by deposit» $80 → депозит остаётся открытым на $1500', async () => {
    const r = await createInvoice('303', { purpose: 'damages', amountOverride: 80, description: 'Wall repair, not covered by deposit' });
    await payInvoice(r.invoiceId);
    const di = unitOf('303').stripe.depositInvoice;
    assert.deepStrictEqual({ invoiceId: di.invoiceId, amount: di.amount, status: di.status }, { invoiceId: 'in_dep303', amount: 1500, status: 'open' });
  });
  await test('[контроль] настоящий депозит (purpose=deposit, $1500) оплачен → u.stripe.depositInvoice = paid $1500 (этот путь исправление сломать не должно)', async () => {
    const r = await createInvoice('304', { purpose: 'deposit', amountOverride: 1500 });
    await payInvoice(r.invoiceId);
    const di = unitOf('304').stripe.depositInvoice;
    assert.deepStrictEqual({ invoiceId: di && di.invoiceId, amount: di && di.amount, status: di && di.status }, { invoiceId: r.invoiceId, amount: 1500, status: 'paid' });
  });

  await test('[контроль] legacy-депозит (custom + «Security deposit», создан до отсечки) оплачен → по-прежнему отмечает депозит оплаченным', async () => {
    await payInvoice('in_legacy305');
    const di = unitOf('305').stripe.depositInvoice;
    assert.deepStrictEqual({ invoiceId: di && di.invoiceId, amount: di && di.amount, status: di && di.status }, { invoiceId: 'in_legacy305', amount: 1500, status: 'paid' });
  });
  await test('[контроль] новый депозит при существующем legacy-депозите по-прежнему блокируется дедупом (один депозит на юнит)', async () => {
    let err = null;
    try { await createInvoice('305', { purpose: 'deposit', amountOverride: 1500 }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'already-exists', err ? `${err.code}: ${err.message}` : 'создан второй депозит');
  });
  await test('[контроль] второй custom-счёт того же месяца по-прежнему блокируется дедупом (unit, purpose, ym)', async () => {
    let err = null;
    try { await createInvoice('302', { purpose: 'custom', amountOverride: 25, description: 'Key card deposit' }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'already-exists', err ? `${err.code}: ${err.message}` : 'создан дубль');
  });

  let failed = 0;
  for (const [st, name, msg] of results) {
    console.log(`  ${st} ${name}${msg ? '\n       ' + msg : ''}`);
    if (st === 'FAIL') failed++;
  }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
