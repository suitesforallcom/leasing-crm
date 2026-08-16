// m/lib/money.test.mjs — dependency-free node test for the ported money predicates.
// Run:  node m/lib/money.test.mjs        (exit 0 = pass, 1 = fail)
//
// Каждый кейс — реальный инцидент из FIXES_LOG или пункт MONEY CONTRACT.
// Часы фиксированы через snap.now, диск-тир — через snap.invoiceBuckets, поэтому
// тест детерминирован и не трогает ни localStorage, ни сеть.

import assert from 'node:assert/strict';
import {
  monthStatus, isMonthSettled, verdict, buildingStats, monthAmount,
  leaseEndFromStartTerm, isMonthToMonth, isFinanceShadow, leaseHead,
  UNPAID, STATUS_LABELS, mapStatus, uiStatus,
} from '../m/lib/money.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.error(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
};

// ── fixtures ────────────────────────────────────────────────────────────────
const JUN10 = new Date(2026, 5, 10, 12, 0, 0);   // 2026-06-10 → today ym = 2026-06
const JUN03 = new Date(2026, 5, 3, 12, 0, 0);
const YM = '2026-06';

/** Заворачивает юниты в одно здание/этаж, чтобы построились group/floor индексы. */
function snapOf(units, opts = {}) {
  return {
    buildings: [{ id: 'b1', name: 'Test', floors: [{ id: 'f1', units }] }],
    invoices: opts.invoices || [],
    invoiceBuckets: opts.invoiceBuckets || {},
    settings: opts.settings || {},
    now: opts.now || JUN10,
  };
}
/** Занятый юнит с лизой, начавшейся задолго до тестового месяца. */
function tenant(over = {}) {
  return {
    id: '300', type: 'office', status: 'occupied', tenant: 'Acme LLC',
    email: 'ops@acme.test', contractRent: 1000, leaseStart: '2025-01-01',
    until: '2027-12-31', leaseTerm: 24, ...over,
  };
}
const inv = (id, over = {}) => ({
  id, bucket: 'paid', total: 1000, amountPaid: 1000,
  customerEmail: 'ops@acme.test', description: `Suite 300 rent`,
  metadata: { unitId: '300', purpose: 'rent', ym: YM }, ...over,
});

console.log('\nmoney.js — canonical verdict parity\n');

// ── 1. settled: the three paid paths ────────────────────────────────────────
t('paid via local payments ledger (operator-authoritative)', () => {
  const u = tenant({ payments: { [YM]: { status: 'paid', amount: 1000, paidVia: 'check', date: '2026-06-02' } } });
  const s = snapOf([u]);
  assert.equal(isMonthSettled(u, YM, s), 'paid');
  assert.equal(monthStatus(u, YM, s), 'paid');
  const v = verdict(u, YM, s);
  assert.match(v.source, /marked manually/);
  assert.match(v.source, /check/);
  assert.equal(v.label, 'Paid');
});

t('paid via Stripe move-in stamp', () => {
  const u = tenant({ stripe: { moveInRent: { ym: YM, invoiceId: 'in_movein' } } });
  const s = snapOf([u], { invoices: [inv('in_movein')] });
  assert.equal(isMonthSettled(u, YM, s), 'stripe-paid');
  assert.match(verdict(u, YM, s).source, /Stripe invoice in_movein · paid/);
});

t('paid via lastInvoice stamp (ym-gated)', () => {
  const u = tenant({ stripe: { lastInvoiceYm: YM, lastInvoiceId: 'in_last' } });
  const s = snapOf([u], { invoices: [inv('in_last')] });
  assert.equal(isMonthSettled(u, YM, s), 'stripe-paid');
  // lastInvoiceId — это ПОСЛЕДНИЙ отправленный счёт, не обязательно счёт этого
  // месяца: оплаченная СЕНТЯБРЬСКАЯ рента не смеет закрыть июнь (Suite 224).
  const u2 = tenant({ stripe: { lastInvoiceYm: '2026-09', lastInvoiceId: 'in_sep' } });
  const sepRow = inv('in_sep', { metadata: { unitId: '300', purpose: 'rent', ym: '2026-09' } });
  const s2 = snapOf([u2], { invoices: [sepRow] });
  assert.equal(isMonthSettled(u2, YM, s2), null, 'a paid September invoice must not settle June');
  assert.equal(isMonthSettled(u2, '2026-09', s2), 'stripe-paid', 'but it does settle September');
});

t('paid via cache scan when stamps were wiped by a building swap', () => {
  const u = tenant({ stripe: { customerId: 'cus_1' } });   // штампов нет вообще
  const s = snapOf([u], { invoices: [inv('in_scan', { customerId: 'cus_1' })] });
  assert.equal(isMonthSettled(u, YM, s), 'stripe-paid');
  assert.match(verdict(u, YM, s).source, /matched by tenant \+ month/);
});

t('cache scan is STRICT purpose=rent — a paid LATE FEE never settles rent', () => {
  const u = tenant();
  const s = snapOf([u], { invoices: [inv('in_fee', { metadata: { unitId: '300', purpose: 'late_fee', ym: YM } })] });
  assert.equal(isMonthSettled(u, YM, s), null);
  assert.equal(monthStatus(u, YM, s), 'overdue');
});

t('cache scan is tenant-scoped — a prior tenant\'s paid invoice does not settle', () => {
  const u = tenant({ email: 'new@acme.test' });
  const s = snapOf([u], { invoices: [inv('in_old', { customerEmail: 'gone@old.test' })] });
  assert.equal(isMonthSettled(u, YM, s), null);
});

t('cache scan requires an EXACT ym — no created-date fallback', () => {
  const u = tenant();
  const s = snapOf([u], { invoices: [inv('in_may', { metadata: { unitId: '300', purpose: 'rent', ym: '2026-05' } })] });
  assert.equal(isMonthSettled(u, YM, s), null);
});

// ── 2. deposit cross-stamp guard (FIXES_LOG Entry 34) ───────────────────────
t('deposit-stamp guard: stamp pointing at the deposit invoice never settles rent', () => {
  const u = tenant({ stripe: { depositInvoice: { invoiceId: 'in_dep' }, moveInRent: { ym: YM, invoiceId: 'in_dep' } } });
  const s = snapOf([u], { invoices: [inv('in_dep', { metadata: { unitId: '300', purpose: 'deposit', ym: YM } })] });
  assert.equal(isMonthSettled(u, YM, s), null, 'a paid DEPOSIT must not read as paid rent');
  assert.equal(monthStatus(u, YM, s), 'overdue');
});

t('deposit-stamp guard fires on metadata.purpose and on the description', () => {
  const byMeta = tenant({ stripe: { moveInRent: { ym: YM, invoiceId: 'in_x' } } });
  const s1 = snapOf([byMeta], { invoices: [inv('in_x', { metadata: { unitId: '300', purpose: 'deposit', ym: YM } })] });
  assert.equal(isMonthSettled(byMeta, YM, s1), null);
  const byDesc = tenant({ stripe: { moveInRent: { ym: YM, invoiceId: 'in_y' } } });
  const s2 = snapOf([byDesc], {
    invoices: [inv('in_y', { description: 'Suite 300 — Security Deposit', metadata: { unitId: '300', ym: YM } })],
  });
  assert.equal(isMonthSettled(byDesc, YM, s2), null);
});

// ── 3. waivers + split-brain ────────────────────────────────────────────────
t('waived month is settled as free and is not UNPAID', () => {
  const u = tenant({ payments: { [YM]: { status: 'free', waiverReason: 'referral' } } });
  const s = snapOf([u]);
  assert.equal(isMonthSettled(u, YM, s), 'free');
  assert.equal(monthStatus(u, YM, s), 'free');
  assert.equal(UNPAID.has('free'), false);
  assert.match(verdict(u, YM, s).source, /waived by operator · referral/);
});

t('split-brain (Entry 55): a stale local "late" never beats a Stripe-paid month', () => {
  const u = tenant({ stripe: { customerId: 'cus_1' }, payments: { [YM]: { status: 'late' } } });
  const s = snapOf([u], { invoices: [inv('in_ok', { customerId: 'cus_1' })] });
  assert.equal(isMonthSettled(u, YM, s), 'stripe-paid');
  assert.equal(monthStatus(u, YM, s), 'paid');
});

t('localStorage bucket tier settles when the invoice cache is empty', () => {
  const u = tenant({ stripe: { moveInRent: { ym: YM, invoiceId: 'in_disk' } } });
  const s = snapOf([u], { invoices: [], invoiceBuckets: { in_disk: 'paid' } });
  assert.equal(isMonthSettled(u, YM, s), 'stripe-paid');
});

// ── 4. lease-head redirect ──────────────────────────────────────────────────
t('multi-suite lease: a member suite reports the PRIMARY\'s money', () => {
  const primary = tenant({ id: '101', groupId: 'g1', groupRole: 'primary', payments: { [YM]: { status: 'paid', amount: 5000 } } });
  const member = { id: '102', type: 'office', status: 'occupied', tenant: 'Acme LLC', groupId: 'g1', groupRole: 'member' };
  const s = snapOf([primary, member]);
  assert.equal(leaseHead(member, s).id, '101');
  assert.equal(isMonthSettled(member, YM, s), 'paid', 'member must not show a phantom unpaid month');
  assert.equal(isFinanceShadow(member, s), true);
  assert.equal(isFinanceShadow(primary, s), false);
});

// ── 5. due vs overdue by grace days ─────────────────────────────────────────
t('grace boundary: the whole of the 5th is "due", the 6th is "overdue"', () => {
  const u = tenant();
  const late5 = snapOf([u], { now: new Date(2026, 5, 5, 23, 59, 0) });
  const early6 = snapOf([u], { now: new Date(2026, 5, 6, 0, 30, 0) });
  assert.equal(monthStatus(u, YM, late5), 'due');
  assert.equal(monthStatus(u, YM, early6), 'overdue');
});

t('grace is configurable from workspace settings.lateFee.graceDays', () => {
  const u = tenant();
  const g10 = snapOf([u], { now: JUN10, settings: { lateFee: { graceDays: 10 } } });
  assert.equal(monthStatus(u, YM, g10), 'due', 'grace 10 → the 10th is still within grace');
  assert.equal(monthStatus(u, YM, snapOf([u], { now: JUN10 })), 'overdue', 'default grace 5 → overdue');
});

t('a PAST unpaid month is overdue with no grace at all', () => {
  const u = tenant();
  assert.equal(monthStatus(u, '2026-05', snapOf([u], { now: JUN03 })), 'overdue');
});

t('lease-start month anchors grace to the move-in date and prorates the rent', () => {
  const u = tenant({ contractRent: 3000, leaseStart: '2026-06-20' });
  const s = snapOf([u], { now: JUN10 });   // 10 июня — до старта + грейса
  assert.equal(monthStatus(u, YM, s), 'due');
  assert.equal(monthAmount(u, YM, s), 1100, '3000/30 × 11 дней (20–30 включительно)');
});

// ── 6. non-billable states ──────────────────────────────────────────────────
t('lease not started → upcoming, never overdue', () => {
  const u = tenant({ leaseStart: '2026-09-01' });
  const s = snapOf([u]);
  assert.equal(monthStatus(u, YM, s), 'upcoming');
  assert.equal(monthAmount(u, YM, s), 0);
  // Даты вердикта — для глаз оператора, а не ISO: «Sep 1» (год того же года опускаем).
  assert.match(verdict(u, YM, s).detail, /Lease starts Sep 1$/);
});

t('anti-phantom gate: no lease start on file → no_lease, $0 owed', () => {
  const u = tenant({ leaseStart: '', signed: '' });
  const s = snapOf([u]);
  assert.equal(monthStatus(u, YM, s), 'no_lease');
  assert.equal(monthAmount(u, YM, s), 0);
});

t('vacant unit owes nothing', () => {
  const u = tenant({ status: 'vacant', tenant: '', company: '' });
  const s = snapOf([u]);
  assert.equal(monthStatus(u, YM, s), 'vacant');
  assert.equal(UNPAID.has(monthStatus(u, YM, s)), false);
});

t('reserved unit reads reserved, not overdue', () => {
  const u = tenant({ status: 'reserved' });
  assert.equal(monthStatus(u, YM, snapOf([u])), 'reserved');
});

t('a paid month stays paid even after the tenant moved out', () => {
  const u = tenant({ status: 'vacant', tenant: '', payments: { [YM]: { status: 'paid', amount: 1000 } } });
  assert.equal(monthStatus(u, YM, snapOf([u])), 'paid');
});

// ── 7. month-to-month ───────────────────────────────────────────────────────
t('month-to-month leases never expire (mtm / m2m / "1" / end-before-start)', () => {
  assert.equal(isMonthToMonth({ leaseTerm: 'mtm' }), true);
  assert.equal(isMonthToMonth({ leaseTerm: 'M2M' }), true);
  assert.equal(isMonthToMonth({ leaseTerm: '1' }), true, 'legacy/import value');
  assert.equal(isMonthToMonth({ leaseStart: '2026-06-01', until: '2026-01-01' }), true, 'end < start = open lease');
  assert.equal(isMonthToMonth({ leaseTerm: 12, leaseStart: '2026-01-01', until: '2026-12-31' }), false);
});

t('a future month on an M2M lease is upcoming, not "lease ended"', () => {
  const mtm = tenant({ leaseTerm: 'mtm', until: '2026-02-28' });
  const fixed = tenant({ leaseTerm: 12, until: '2026-02-28' });
  const s = snapOf([mtm]);
  assert.equal(monthStatus(mtm, '2026-08', s), 'upcoming');
  assert.equal(monthStatus(fixed, '2026-08', snapOf([fixed])), 'ended');
});

t('future month with an advance invoice stays "due", not "upcoming" (Entry 30)', () => {
  const u = tenant();
  const s = snapOf([u], { invoices: [inv('in_adv', { bucket: 'open', metadata: { unitId: '300', purpose: 'rent', ym: '2026-08' } })] });
  assert.equal(monthStatus(u, '2026-08', s), 'due');
  assert.equal(monthStatus(u, '2026-08', snapOf([u])), 'upcoming');
});

// ── 8. verdict shape + labels ───────────────────────────────────────────────
t('verdict returns {status,ui,label,amount,detail,source} and every status has a label', () => {
  const u = tenant();
  const v = verdict(u, YM, snapOf([u]));
  // Контракт расширен 2026-08-15 (ревью интеграции): экранам нужны amount —
  // сколько реально должен за месяц — и ui — статус словами легенды плана этажа.
  assert.deepEqual(Object.keys(v).sort(), ['amount', 'detail', 'label', 'source', 'status', 'ui']);
  assert.equal(v.source, 'no invoice on record');
  assert.ok(v.amount > 0, 'unpaid month must carry the amount owed');
  const paid = tenant({ payments: { [YM]: { status: 'paid', amount: 1000 } } });
  const vp = verdict(paid, YM, snapOf([paid]));
  assert.equal(vp.amount, 0, 'settled month owes nothing');
  assert.equal(vp.ui, 'paid');
  for (const st of ['paid', 'free', 'due', 'overdue', 'upcoming', 'ended', 'vacant', 'reserved', 'no_lease']) {
    assert.ok(STATUS_LABELS[st], `missing label for ${st}`);
  }
  assert.deepEqual([...UNPAID].sort(), ['due', 'overdue']);
});

// ── 9. buildingStats ────────────────────────────────────────────────────────
t('buildingStats sums expected/collected/outstanding and counts each lease once', () => {
  const a = tenant({ id: 'A', contractRent: 1000, deposit: 1000, payments: { [YM]: { status: 'paid', amount: 1000 } } });
  const b = tenant({ id: 'B', contractRent: 2000 });
  const c = tenant({ id: 'C', contractRent: 500, payments: { [YM]: { status: 'free' } } });
  const d = tenant({ id: 'D', contractRent: 800, status: 'vacant', tenant: '' });
  const p = tenant({ id: 'P', contractRent: 1500, groupId: 'g', groupRole: 'primary' });
  const m = tenant({ id: 'M', contractRent: 9999, groupId: 'g', groupRole: 'member' });
  const units = [a, b, c, d, p, m];
  const s = snapOf(units);
  const st = buildingStats(s.buildings[0], YM, s);
  assert.equal(st.expected, 5000, '1000+2000+500+1500, member excluded');
  assert.equal(st.collected, 1000);
  assert.equal(st.waived, 500);
  assert.equal(st.outstanding, 3500, 'B 2000 + P 1500');
  assert.equal(st.collectionRate, 30, '(1000+500)/5000');
  assert.equal(st.units, 5, 'finance shadow M is not counted');
  assert.equal(st.occupied, 4);
  assert.equal(st.vacant, 1);
  assert.equal(st.deposits, 1000);
  assert.equal(st.overdueUnits, 2);
});

t('buildingStats prefers Stripe amountPaid over total (credit-note convention)', () => {
  const u = tenant({ contractRent: 1000, stripe: { customerId: 'cus_1' } });
  const s = snapOf([u], { invoices: [inv('in_cn', { customerId: 'cus_1', total: 1000, amountPaid: 750 })] });
  assert.equal(buildingStats(s.buildings[0], YM, s).collected, 750);
});

// ── 10. leaseEndFromStartTerm — единая конвенция ────────────────────────────
t('leaseEnd: day-1 start = exactly N full months (Jan 1 +12 → Dec 31)', () => {
  assert.equal(leaseEndFromStartTerm('2026-01-01', 12), '2026-12-31');
});
t('leaseEnd: day-1 start, Oct 1 +12 → Sep 30 next year', () => {
  assert.equal(leaseEndFromStartTerm('2026-10-01', 12), '2027-09-30');
});
t('leaseEnd: mid-month start snaps to the end of the anniversary month', () => {
  assert.equal(leaseEndFromStartTerm('2026-08-27', 12), '2027-08-31');
});
t('leaseEnd: 31st start does NOT overflow setMonth (Aug 31 +6 → Feb 28)', () => {
  assert.equal(leaseEndFromStartTerm('2026-08-31', 6), '2027-02-28');
});
t('leaseEnd: 29th/30th starts land on the short-month end', () => {
  assert.equal(leaseEndFromStartTerm('2026-01-29', 1), '2026-02-28');
  assert.equal(leaseEndFromStartTerm('2026-01-30', 13), '2027-02-28');
  assert.equal(leaseEndFromStartTerm('2028-02-29', 12), '2029-02-28', 'leap-day start');
});
t('leaseEnd: leap February is respected, and bad input returns empty string', () => {
  assert.equal(leaseEndFromStartTerm('2027-08-31', 6), '2028-02-29', 'target Feb 2028 is leap');
  assert.equal(leaseEndFromStartTerm('', 12), '');
  assert.equal(leaseEndFromStartTerm('2026-01-01', 0), '');
  assert.equal(leaseEndFromStartTerm('2026-01-01', 'mtm'), '');
  assert.equal(leaseEndFromStartTerm('not-a-date', 12), '');
});

// ── 12. Entry-34 cross-stamp with a COLD invoice cache (регресс ревью 2026-08-15) ──
t('cold cache: a bare lastInvoiceId stamp never settles the month', () => {
  const u = tenant({ stripe: { lastInvoiceYm: YM, lastInvoiceId: 'in_DEPOSIT' } });
  // диск-штамп говорит "paid", но самой строки инвойса в кэше нет —
  // подменой депозита это или нет, проверить нечем → не settled.
  const snap = snapOf([u], { invoices: [], invoiceBuckets: { in_DEPOSIT: 'paid' } });
  assert.equal(isMonthSettled(u, YM, snap), null, 'must not trust an unverifiable stamp');
});
t('cold cache: a moveInRent stamp still settles (rent-only by construction)', () => {
  const u = tenant({ stripe: { moveInRent: { ym: YM, invoiceId: 'in_RENT' } } });
  const snap = snapOf([u], { invoices: [], invoiceBuckets: { in_RENT: 'paid' } });
  assert.equal(isMonthSettled(u, YM, snap), 'stripe-paid');
});

// ── 13. Заливка карты vs денежная правда (решение оператора 2026-08-16) ──
// Десктоп красит «счёт выставлен» синим ПОВЕРХ просрочки (MONO:31960 vs :32024),
// но его же деньги считают такой месяц долгом. Мы повторяем цвет и НЕ теряем долг.
t('карта: просрочка со счётом красится как «счёт выставлен», но помечается', () => {
  const u = tenant();
  const s = snapOf([u], { invoices: [inv('in_open', { status: 'open', bucket: 'open' })] });
  const m = mapStatus(u, YM, s);
  assert.equal(m.status, 'invoiced', 'цвет обязан совпасть с десктопом');
  assert.equal(m.overdue, true, 'долг нельзя терять — иначе синий его маскирует');
});
t('карта: просрочка БЕЗ счёта остаётся просрочкой', () => {
  const u = tenant();
  const m = mapStatus(u, YM, snapOf([u]));
  assert.equal(m.status, 'overdue');
  assert.equal(m.overdue, true);
});
t('ДЕНЬГИ не меняются: uiStatus по-прежнему говорит overdue', () => {
  const u = tenant();
  const s = snapOf([u], { invoices: [inv('in_open', { status: 'open', bucket: 'open' })] });
  assert.equal(uiStatus(u, YM, s), 'overdue',
    'подмена здесь превратила бы «Overdue $13k» на главной в «счёт выставлен»');
});
t('оплаченный месяц пометки не получает', () => {
  const u = tenant({ payments: { [YM]: { status: 'paid' } } });
  const m = mapStatus(u, YM, snapOf([u]));
  assert.equal(m.status, 'paid');
  assert.equal(m.overdue, false);
});

// ── 14. Счёт чужого здания не должен попадать в юнит с тем же номером ──
// В проде 208 номеров сьютов из 815 повторяются между зданиями (MONO:80445).
t('счёт с ЧУЖИМ buildingId игнорируется', () => {
  const u = tenant();                       // сьют 300 в здании b1
  const foreign = inv('in_other', { buildingId: 'b-other', bucket: 'paid', status: 'paid' });
  const s = snapOf([u], { invoices: [foreign] });
  assert.equal(isMonthSettled(u, YM, s), null,
    'оплата чужого здания закрыла месяц — это ложное «оплачено»');
});
t('счёт СВОЕГО здания по-прежнему считается', () => {
  const u = tenant();
  const mine = inv('in_mine', { buildingId: 'b1', bucket: 'paid', status: 'paid' });
  const s = snapOf([u], { invoices: [mine] });
  assert.equal(isMonthSettled(u, YM, s), 'stripe-paid');
});
t('старый счёт БЕЗ buildingId принимается (не теряем историю)', () => {
  const u = tenant();
  const legacy = inv('in_legacy', { bucket: 'paid', status: 'paid' });   // поля здания нет
  const s = snapOf([u], { invoices: [legacy] });
  assert.equal(isMonthSettled(u, YM, s), 'stripe-paid');
});

// ── done ────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
