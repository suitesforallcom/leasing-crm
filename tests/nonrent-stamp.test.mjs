/**
 * Регрессионный тест FIXES_LOG Entry 107 (2026-11-22) — оплаченный НЕ-rent счёт не
 * закрывает месяц аренды, а слово «deposit» в описании не делает счёт депозитом.
 *
 * Что было: _createStripeInvoiceImpl писал u.stripe.lastInvoiceId для ЛЮБОГО
 * назначения счёта, а lastInvoiceYm — только для rent (клиентский мирор в
 * stripeActionSendInvoiceAdvanced — то же). После разового счёта (ключи, пеня,
 * уборка) пара штампов: lastInvoiceYm = месяц последней ренты, lastInvoiceId = id
 * разового счёта. Канон (_settle / _isMonthSettled) доверял паре, если счёт по
 * штампу не депозит → оплата $25 читалась как оплата месяца.
 *
 * Правило теперь: штамп закрывает месяц, только если счёт по нему — rent-счёт
 * этого месяца. Три копии канона: m/lib/money.js (телефон), functions/lib/money.mjs
 * (сервер, байт-копия) и _isMonthSettled в floor-map-editor.html (десктоп), плюс
 * клиентские сканеры кэша и миррор штампа.
 *
 * Ничего не меняет и никуда не ходит: чистые функции над фикстурой.
 * До исправления 16 утверждений «ОШИБКА 1» были красными.
 *
 * node tests/nonrent-stamp.test.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(here, '..', 'floor-map-editor.html');
const src = fs.readFileSync(HTML_PATH, 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`); }
};
const info = (line) => console.log(`  info ${line}`);
const section = (title) => console.log('\n' + title);

// ── Фикстура: сьют 300, рента $1000, сегодня 10 ноября 2026 ─────────────────
// Сентябрь оплачен. За октябрь выставлен rent-счёт на $1000 — он ОТКРЫТ и
// просрочен. Потом выставлен и оплачен разовый счёт на $25.
const NOV10 = new Date(2026, 10, 10, 12, 0, 0);
const OCT = '2026-10';
const BID = 'b1';

const rentOct = () => ({
  id: 'in_rent_oct', number: 'R-300-OCT26', status: 'open', bucket: 'past_due',
  total: 1000, amountPaid: 0, amountRemaining: 1000,
  customerId: 'cus_300', customerEmail: 'ops@acme.test',
  description: 'Monthly rent — Suite 300 · October 2026',
  metadata: { source: 'suitesforall', unitId: '300', buildingId: BID, purpose: 'rent', ym: OCT },
});
// Форма как у _createStripeInvoiceImpl: description = `${label}: ${customDesc} — Suite N · Month YYYY`.
const paidOneOff = (purpose, label, text, ym = OCT) => ({
  id: 'in_oneoff', number: 'X-300-1', status: 'paid', bucket: 'paid',
  total: 25, amountPaid: 25, amountRemaining: 0,
  customerId: 'cus_300', customerEmail: 'ops@acme.test',
  description: `${label}: ${text} — Suite 300 · October 2026`,
  metadata: { source: 'suitesforall', unitId: '300', buildingId: BID, purpose, ym },
});
const tenant = (stripe) => ({
  id: '300', type: 'office', status: 'occupied', tenant: 'Acme LLC', email: 'ops@acme.test',
  contractRent: 1000, leaseStart: '2025-01-01', until: '2027-12-31', leaseTerm: 36,
  payments: { '2026-09': { status: 'paid', amount: 1000 } },
  stripe,
});
// Штампы ровно такие, какие оставлял сервер после разового счёта до Entry 107.
const stampsAfterOneOff = () => ({ customerId: 'cus_300', lastInvoiceId: 'in_oneoff', lastInvoiceYm: OCT });
// Контроль: штамп смотрит на сам rent-счёт.
const stampsRent = () => ({ customerId: 'cus_300', lastInvoiceId: 'in_rent_oct', lastInvoiceYm: OCT });

const snapOf = (u, invoices, invoiceBuckets = {}) => ({
  buildings: [{ id: BID, name: 'Test', floors: [{ id: 'f1', units: [u] }] }],
  invoices, invoiceBuckets, settings: { lateFee: { graceDays: 5 } }, now: NOV10,
});

// ── 1. Канон телефона и его серверная байт-копия ────────────────────────────
async function canonSuite(label, file) {
  const M = await import(pathToFileURL(file).href);
  section(`${label} — ${path.relative(path.join(here, '..'), file)}`);

  t('контроль: штамп на открытый rent-счёт → октябрь НЕ оплачен, просрочен', () => {
    const u = tenant(stampsRent()); const s = snapOf(u, [rentOct()]);
    assert.equal(M.isMonthSettled(u, OCT, s), null);
    assert.equal(M.monthStatus(u, OCT, s), 'overdue');
  });
  t('контроль: оплаченный rent-счёт по штампу → stripe-paid (правильный путь не сломан)', () => {
    const u = tenant(stampsRent());
    const s = snapOf(u, [{ ...rentOct(), status: 'paid', bucket: 'paid', amountPaid: 1000, amountRemaining: 0 }]);
    assert.equal(M.isMonthSettled(u, OCT, s), 'stripe-paid');
  });

  t('Entry 107: оплачен разовый счёт «Key replacement» $25 (purpose=custom) → октябрь должен остаться НЕоплаченным', () => {
    const u = tenant(stampsAfterOneOff());
    const s = snapOf(u, [rentOct(), paidOneOff('custom', 'Service charge', 'Key replacement')]);
    assert.equal(M.isMonthSettled(u, OCT, s), null, `isMonthSettled = ${M.isMonthSettled(u, OCT, s)}`);
  });
  t('Entry 107: тот же сценарий — статус месяца «overdue», а не «paid»', () => {
    const u = tenant(stampsAfterOneOff());
    const s = snapOf(u, [rentOct(), paidOneOff('custom', 'Service charge', 'Key replacement')]);
    assert.equal(M.monthStatus(u, OCT, s), 'overdue');
  });
  t('Entry 107: тот же сценарий — долг $1000 не исчезает из суммы месяца', () => {
    const u = tenant(stampsAfterOneOff());
    const s = snapOf(u, [rentOct(), paidOneOff('custom', 'Service charge', 'Key replacement')]);
    assert.equal(M.monthAmount(u, OCT, s), 1000);
  });
  t('Entry 107: тот же сценарий — KPI здания: собрано $0, просрочен 1 юнит (а не «собрано $25, должников нет»)', () => {
    const u = tenant(stampsAfterOneOff());
    const s = snapOf(u, [rentOct(), paidOneOff('custom', 'Service charge', 'Key replacement')]);
    const st = M.buildingStats(s.buildings[0], OCT, s);
    assert.deepEqual({ collected: st.collected, paidUnits: st.paidUnits, overdueUnits: st.overdueUnits },
      { collected: 0, paidUnits: 0, overdueUnits: 1 });
  });
  t('Entry 107: оплачена только ПЕНЯ (purpose=late_fee) → аренда за октябрь не оплачена', () => {
    const u = tenant(stampsAfterOneOff());
    const s = snapOf(u, [rentOct(), paidOneOff('late_fee', 'Late fee', 'October rent')]);
    assert.equal(M.isMonthSettled(u, OCT, s), null, `isMonthSettled = ${M.isMonthSettled(u, OCT, s)}`);
  });
  t('Entry 107: разовый счёт выставлен В НОЯБРЕ (metadata.ym=2026-11), штамп месяца остался октябрьским → октябрь не оплачен', () => {
    const u = tenant(stampsAfterOneOff());
    const s = snapOf(u, [rentOct(), paidOneOff('cleaning', 'Cleaning fee', 'Carpet', '2026-11')]);
    assert.equal(M.isMonthSettled(u, OCT, s), null, `isMonthSettled = ${M.isMonthSettled(u, OCT, s)}`);
  });

  // Не ошибка, а объяснение, почему её не видно на счетах со словом «deposit»:
  // Entry 34 (_stampPointsToDeposit) отбрасывает штамп по слову в описании.
  t('контроль: слово «deposit» в описании разового счёта случайно закрывает дыру (guard Entry 34)', () => {
    const u = tenant(stampsAfterOneOff());
    const s = snapOf(u, [rentOct(), paidOneOff('custom', 'Service charge', 'Key card deposit')]);
    assert.equal(M.isMonthSettled(u, OCT, s), null);
  });
}

// ── 2. Десктопный канон: реальные функции из floor-map-editor.html ──────────
function cut(open, close) {
  const from = src.indexOf(open);
  if (from < 0) throw new Error(`floor-map-editor.html: marker not found: ${open.trim().slice(0, 60)}`);
  const to = src.indexOf(close, from + open.length);
  if (to < 0) throw new Error(`floor-map-editor.html: end marker not found: ${close.trim().slice(0, 60)}`);
  return src.slice(from, to);
}
function desktopCtx(units, rows, disk = {}) {
  const code = [
    cut('// ─── Entry 102: invoice ↔ building scope ───', '// ─── /Entry 102 ───'),
    cut('\nvar _invoicesCacheById = null;', "\n// Look up a Stripe invoice's real bucket"),
    cut('\nfunction _lookupInvoiceBucket(', '\n// Full cache row lookup'),
    cut('\nfunction _lookupInvoiceRow(', '\n// Reconcile what the operator'),
    cut('\nfunction _stampPointsToDeposit(', '\n// Cache-scan rent verdict'),
    cut('\nfunction _rentPaidRowFromCache(', '\nfunction _isMonthSettled('),
    cut('\nfunction _isMonthSettled(', '\n// ── Партия 2 аудита'),
    cut('\nfunction _stripePaidRowForYm(', '\n// Реально собранная сумма'),
    cut('\nfunction _stripePaidAmountForYm(', '\n// ── FIX-perf 2'),
    cut('// ─── Entry 95: tenant contact hygiene ───', '// ─── /Entry 95 ───'),
    cut('\nfunction _findDepositInvoiceInCache(', '\n// Earliest moment an invoice'),
    cut('\nfunction _findRentInvoiceInCache(', '\n// Write u.stripe.moveInRent'),
    'this.api = { _isMonthSettled, _stripePaidAmountForYm, _invRowIsDeposit, _stampRowIsRent, _findDepositInvoiceInCache, _findRentInvoiceInCache, _stripeReminderPayload, _stampDiscoveredReminderInvoice };',
  ].join('\n');
  const state = { buildings: [{ id: BID, name: 'Test', floors: [{ id: 'f1', units }] }], ui: {} };
  const ctx = {
    state, _invoicesCache: rows, console,
    currentBuilding: () => state.buildings[0],
    _unitLeaseHead: (u) => u,
    _loadInvoiceBucketDisk: () => disk,
    isValidEmail: (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '')),
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'floor-map-editor.lifted.js' });
  return ctx.api;
}

function desktopSuite() {
  section('Десктоп — _isMonthSettled из floor-map-editor.html');
  t('контроль: штамп на открытый rent-счёт → октябрь не оплачен', () => {
    const u = tenant(stampsRent());
    assert.equal(desktopCtx([u], [rentOct()])._isMonthSettled(u, OCT), null);
  });
  t('контроль: оплаченный rent-счёт по штампу → stripe-paid', () => {
    const u = tenant(stampsRent());
    const api = desktopCtx([u], [{ ...rentOct(), status: 'paid', bucket: 'paid', amountPaid: 1000 }]);
    assert.equal(api._isMonthSettled(u, OCT), 'stripe-paid');
  });
  t('Entry 107: оплачен разовый счёт «Key replacement» $25 → октябрь должен остаться НЕоплаченным', () => {
    const u = tenant(stampsAfterOneOff());
    const got = desktopCtx([u], [rentOct(), paidOneOff('custom', 'Service charge', 'Key replacement')])._isMonthSettled(u, OCT);
    assert.equal(got, null, `_isMonthSettled = ${got}`);
  });
  t('Entry 107: «собрано за октябрь» не должно быть $25 разового счёта', () => {
    const u = tenant(stampsAfterOneOff());
    const got = desktopCtx([u], [rentOct(), paidOneOff('custom', 'Service charge', 'Key replacement')])._stripePaidAmountForYm(u, OCT);
    assert.equal(got, null, `_stripePaidAmountForYm = ${got}`);
  });
  t('Entry 107: оплачена только ПЕНЯ (purpose=late_fee) → аренда за октябрь не оплачена', () => {
    const u = tenant(stampsAfterOneOff());
    const got = desktopCtx([u], [rentOct(), paidOneOff('late_fee', 'Late fee', 'October rent')])._isMonthSettled(u, OCT);
    assert.equal(got, null, `_isMonthSettled = ${got}`);
  });
  t('Entry 107: разовый счёт выставлен в ноябре (metadata.ym=2026-11) → октябрь не оплачен', () => {
    const u = tenant(stampsAfterOneOff());
    const got = desktopCtx([u], [rentOct(), paidOneOff('cleaning', 'Cleaning fee', 'Carpet', '2026-11')])._isMonthSettled(u, OCT);
    assert.equal(got, null, `_isMonthSettled = ${got}`);
  });

  // Характеристика, не утверждение: десктоп верит дисковому штампу 'paid' даже
  // БЕЗ строки счёта в кэше (телефон в этом случае штампу не верит —
  // _lastStampTrustworthy). Что здесь правильно — решается вариантом исправления.
  {
    const u = tenant(stampsAfterOneOff());
    const got = desktopCtx([u], [rentOct()], { in_oneoff: 'paid' })._isMonthSettled(u, OCT);
    info(`десктоп, строки разового счёта нет в кэше, на диске bucket='paid' → _isMonthSettled = ${got} (телефон в этом случае: null)`);
  }
}

// ── 3. moveInRent: то же правило по назначению; ручная привязка сильнее ─────
async function moveInSuite(label, file) {
  const M = await import(pathToFileURL(file).href);
  section(`${label} — штамп moveInRent`);
  const mk = (mi) => tenant({ customerId: 'cus_300', moveInRent: mi });
  t('moveInRent на оплаченный rent-счёт → stripe-paid', () => {
    const u = mk({ ym: OCT, invoiceId: 'in_rent_oct' });
    const s = snapOf(u, [{ ...rentOct(), status: 'paid', bucket: 'paid', amountPaid: 1000 }]);
    assert.equal(M.isMonthSettled(u, OCT, s), 'stripe-paid');
  });
  t('moveInRent на оплаченный разовый счёт (custom) → месяц НЕ оплачен', () => {
    const u = mk({ ym: OCT, invoiceId: 'in_oneoff' });
    const s = snapOf(u, [rentOct(), paidOneOff('custom', 'Service charge', 'Key fob / access card replacement')]);
    assert.equal(M.isMonthSettled(u, OCT, s), null);
  });
  t('moveInRent с manualLink — оператор сам привязал счёт как аренду → stripe-paid при любом назначении', () => {
    const u = mk({ ym: OCT, invoiceId: 'in_oneoff', manualLink: true });
    const s = snapOf(u, [paidOneOff('custom', 'Service charge', 'October rent (hand-made)')]);
    assert.equal(M.isMonthSettled(u, OCT, s), 'stripe-paid');
  });
  t('счёт без назначения (Stripe Dashboard / старый) по штампу — как раньше, stripe-paid', () => {
    const u = tenant(stampsRent());
    const row = { ...rentOct(), status: 'paid', bucket: 'paid', amountPaid: 1000, metadata: { unitId: '300', buildingId: BID } };
    assert.equal(M.isMonthSettled(u, OCT, snapOf(u, [row])), 'stripe-paid');
  });
  t('«Link to month»: rent-счёт ДРУГОГО месяца, привязанный оператором к октябрю, после оплаты закрывает октябрь', () => {
    const u = tenant(stampsRent());
    const row = { ...rentOct(), status: 'paid', bucket: 'paid', amountPaid: 1000, metadata: { unitId: '300', buildingId: BID, purpose: 'rent', ym: '2026-09' } };
    assert.equal(M.isMonthSettled(u, OCT, snapOf(u, [row])), 'stripe-paid');
  });
  t('«Link to month»: счёт с не-rent назначением закрывает месяц только с маркером ручной привязки (lastInvoiceLinkedId)', () => {
    const rows = [paidOneOff('custom', 'Service charge', 'October rent (hand-made)')];
    const linked = tenant({ ...stampsAfterOneOff(), lastInvoiceLinkedId: 'in_oneoff' });
    assert.equal(M.isMonthSettled(linked, OCT, snapOf(linked, rows)), 'stripe-paid');
    const stale = tenant({ ...stampsAfterOneOff(), lastInvoiceLinkedId: 'in_some_older_invoice' });
    assert.equal(M.isMonthSettled(stale, OCT, snapOf(stale, rows)), null);
  });
}

// ── 4. Клиентские двойники: сканеры кэша и штамп при отправке ───────────────
function clientSuite() {
  section('Десктоп — сканеры кэша и штамп при отправке (Entry 107)');
  const AFTER = Date.UTC(2026, 10, 25), BEFORE = Date.UTC(2026, 9, 5);
  const api = () => desktopCtx([tenant(stampsRent())], []);
  t('_invRowIsDeposit: purpose=deposit → да, при любом описании', () => {
    assert.equal(api()._invRowIsDeposit({ created: AFTER, description: 'Move-in', metadata: { purpose: 'deposit' } }), true);
  });
  t('_invRowIsDeposit: custom «Key card deposit» после отсечки → НЕ депозит', () => {
    assert.equal(api()._invRowIsDeposit({ created: AFTER, description: 'Service charge: Key card deposit — Suite 300', metadata: { purpose: 'custom' } }), false);
  });
  t('_invRowIsDeposit: legacy custom «Security deposit» до отсечки → депозит (история не теряется)', () => {
    assert.equal(api()._invRowIsDeposit({ created: BEFORE, description: 'Service charge: Security deposit — Suite 300', metadata: { purpose: 'custom' } }), true);
  });
  t('_invRowIsDeposit: явное другое назначение (damages / late_fee / keys) → никогда не депозит, даже старый', () => {
    for (const p of ['damages', 'late_fee', 'keys', 'cleaning', 'rent']) {
      assert.equal(api()._invRowIsDeposit({ created: BEFORE, description: 'not covered by deposit', metadata: { purpose: p } }), false, p);
    }
  });
  t('_invRowIsDeposit: счёт БЕЗ назначения (выставлен руками в Stripe Dashboard) — по тексту, как раньше, без отсечки', () => {
    assert.equal(api()._invRowIsDeposit({ created: AFTER, description: 'Security deposit', metadata: {} }), true);
    assert.equal(api()._invRowIsDeposit({ created: BEFORE, description: 'Security deposit', metadata: {} }), true);
    assert.equal(api()._invRowIsDeposit({ created: AFTER, description: 'Suite 300 — May', metadata: {} }), false);
  });
  const oneOffRow = (purpose, text, created) => ({ ...paidOneOff(purpose, 'Service charge', text), created });
  t('_findDepositInvoiceInCache: оплаченный «Key card deposit» (custom, после отсечки) не становится депозитом юнита', () => {
    const u = tenant({ customerId: 'cus_300' });
    const c = desktopCtx([u], [oneOffRow('custom', 'Key card deposit', AFTER)]);
    assert.equal(c._findDepositInvoiceInCache(u), null);
  });
  t('_findDepositInvoiceInCache: настоящий депозит (purpose=deposit) находится', () => {
    const u = tenant({ customerId: 'cus_300' });
    const dep = { ...oneOffRow('deposit', 'Security deposit', AFTER), id: 'in_dep', total: 1500 };
    assert.equal(desktopCtx([u], [dep])._findDepositInvoiceInCache(u)?.id, 'in_dep');
  });
  t('_findRentInvoiceInCache: разовый счёт этого месяца (custom / late_fee / keys) НЕ становится «рентой месяца»', () => {
    const u = tenant({ customerId: 'cus_300' });
    for (const p of ['custom', 'late_fee', 'keys', 'damages', 'cleaning']) {
      const c = desktopCtx([u], [oneOffRow(p, 'Key fob / access card replacement', AFTER)]);
      assert.equal(c._findRentInvoiceInCache(u, OCT), null, p);
    }
  });
  t('_findRentInvoiceInCache: rent-счёт месяца находится', () => {
    const u = tenant({ customerId: 'cus_300' });
    assert.equal(desktopCtx([u], [rentOct()])._findRentInvoiceInCache(u, OCT)?.id, 'in_rent_oct');
  });

  t('десктоп «Link to month»: маркер ручной привязки снимает проверку назначения; чужой маркер — нет', () => {
    const rows = [paidOneOff('custom', 'Service charge', 'October rent (hand-made)')];
    const linked = tenant({ ...stampsAfterOneOff(), lastInvoiceLinkedId: 'in_oneoff' });
    assert.equal(desktopCtx([linked], rows)._isMonthSettled(linked, OCT), 'stripe-paid');
    const stale = tenant({ ...stampsAfterOneOff(), lastInvoiceLinkedId: 'in_other' });
    assert.equal(desktopCtx([stale], rows)._isMonthSettled(stale, OCT), null);
  });
  t('напоминание: штамп на ОТКРЫТЫЙ rent-счёт → напоминаем по нему', () => {
    const u = tenant(stampsRent());
    assert.deepEqual({ ...desktopCtx([u], [rentOct()])._stripeReminderPayload(u) }, { invoiceId: 'in_rent_oct' });
  });
  t('напоминание: rent-счёт по штампу уже оплачен → сервер сам ищет открытый счёт клиента (разовый / пеня)', () => {
    const u = tenant(stampsRent());
    const paid = { ...rentOct(), status: 'paid', bucket: 'paid' };
    assert.deepEqual({ ...desktopCtx([u], [paid])._stripeReminderPayload(u) }, { customerId: 'cus_300' });
  });
  t('напоминание: кэш ещё пуст → как раньше, по штампу', () => {
    const u = tenant(stampsRent());
    assert.deepEqual({ ...desktopCtx([u], [])._stripeReminderPayload(u) }, { invoiceId: 'in_rent_oct' });
  });
  t('напоминание: найденный сервером разовый счёт в штамп НЕ пишется; rent-счёт пишется парой; существующий штамп не перетирается', () => {
    const oneOff = paidOneOff('late_fee', 'Late fee', 'October rent');
    const a = tenant({ customerId: 'cus_300' });
    desktopCtx([a], [oneOff])._stampDiscoveredReminderInvoice(a, 'in_oneoff');
    assert.equal(a.stripe.lastInvoiceId, undefined);
    const b = tenant({ customerId: 'cus_300' });
    desktopCtx([b], [rentOct()])._stampDiscoveredReminderInvoice(b, 'in_rent_oct');
    assert.deepEqual({ id: b.stripe.lastInvoiceId, ym: b.stripe.lastInvoiceYm }, { id: 'in_rent_oct', ym: OCT });
    const c = tenant({ customerId: 'cus_300', lastInvoiceId: 'in_keep', lastInvoiceYm: '2026-11' });
    desktopCtx([c], [rentOct()])._stampDiscoveredReminderInvoice(c, 'in_rent_oct');
    assert.equal(c.stripe.lastInvoiceId, 'in_keep');
  });

  // Места, которые не исполнить без DOM и сети — гейты по исходнику.
  const fn = (name) => {
    const i = src.indexOf(`\nasync function ${name}(`); if (i < 0) throw new Error(name + ' not found');
    const ends = [src.indexOf('\nasync function ', i + 1), src.indexOf('\nfunction ', i + 1)].filter((x) => x > 0);
    return src.slice(i, Math.min(...ends));
  };
  t('stripeActionSendInvoiceAdvanced: lastInvoiceId пишется только для rent (вместе с lastInvoiceYm)', () => {
    const body = fn('stripeActionSendInvoiceAdvanced');
    assert.ok(body.includes("if (purpose === 'rent') {\n        u.stripe.lastInvoiceId = res.invoiceId;\n        u.stripe.lastInvoiceYm = ym;"), 'штамп не под гейтом rent');
    assert.equal(body.split('u.stripe.lastInvoiceId = res.invoiceId').length - 1, 1, 'второй безусловный штамп');
  });
  t('Invoice Generator: штамп депозита — только purpose "deposit", без слова в описании', () => {
    assert.ok(src.includes("const isDeposit = purpose === 'deposit';"));
    assert.ok(!src.includes("const isDeposit = purpose === 'custom' && /\\bdeposit\\b/i.test(description || '');"));
  });
  t('self-heal «последний rent-счёт»: custom больше не штампуется как рента', () => {
    assert.ok(!src.includes("if (m.purpose && m.purpose !== 'rent' && m.purpose !== 'custom') return false;"));
  });
  t('быстрая заливка карты и статус-пилл проверяют назначение счёта по штампу', () => {
    assert.equal(src.split('&& _lastStampIsRent(u)').length - 1, 5);
    assert.equal(src.split('&& _moveInStampIsRent(mi)').length - 1, 3);
  });
  t('«Link to month» ставит маркер ручной привязки; _verifyAndStampAfterSend узнаёт депозит по общему правилу', () => {
    assert.ok(src.includes('  u.stripe.lastInvoiceLinkedId = inv.id;'));
    assert.ok(src.includes("return m.purpose === 'deposit' || (m.purpose === 'custom' && /deposit/i.test(r.description || '') && _invRowIsDeposit(r));"));
  });
  t('напоминания: все три отправителя идут через _stripeReminderPayload, безусловной записи штампа нет', () => {
    assert.equal(src.split('= _stripeReminderPayload(').length - 1, 3);
    assert.equal(src.split('_stampDiscoveredReminderInvoice(').length - 1, 4);
    assert.ok(!src.includes('stripe.lastInvoiceId = sentInvoiceId;'));
  });
  t('зеркала правила: сервер и клиент несут одну дату отсечки депозита по тексту', () => {
    const cf = fs.readFileSync(path.join(here, '..', 'functions', 'index.js'), 'utf8');
    assert.ok(cf.includes('const _DEPOSIT_BY_TEXT_CUTOFF_SEC = Date.UTC(2026, 10, 22) / 1000;'));
    assert.ok(src.includes('const _DEPOSIT_BY_TEXT_CUTOFF_MS = Date.UTC(2026, 10, 22);'));
  });
}

await canonSuite('Телефон', path.join(here, '..', 'm', 'lib', 'money.js'));
await canonSuite('Сервер (байт-копия)', path.join(here, '..', 'functions', 'lib', 'money.mjs'));
desktopSuite();
await moveInSuite('Телефон', path.join(here, '..', 'm', 'lib', 'money.js'));
clientSuite();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
