// =========================================================================
// Bank-feed auto-apply candidate finder (FIXES_LOG Entry 89) — pure Node.
// Запуск: node functions/auto-apply-candidate.test.js
//
// Lifts the REAL _findAutoApplyCandidate and its helpers out of index.js
// (same technique as bank-feed.test.js) and runs them in a vm whose clock is
// pinned, so the current-month gate is deterministic. TZ is pinned to UTC —
// prod Cloud Functions run in UTC and _findOldestUnpaidYm uses local time.
//
// Live cases (2026-10-13):
//   • Suite 101 NUHS pays $13,318.33 by bank deposit every month. The
//     2026-09-08 deposit was offered for OCTOBER (next month checked first)
//     and blocked as «method-mismatch» ('bank' re-mapped to 'other').
//   • Suite 442 (Julie, Stripe payer, one rec at this suite) — a nameless
//     $2,200 «Customer Deposit» from another payer must never auto-apply.
// =========================================================================
process.env.TZ = 'UTC';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', label); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function liftFn(name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
  const m = re.exec(SRC);
  if (!m) throw new Error(`function ${name} not found in index.js`);
  const end = SRC.indexOf('\n}\n', m.index);
  return SRC.slice(m.index, end + 2);
}
function liftConst(name) {
  const m = new RegExp(`^const ${name} = [^;]+;`, 'm').exec(SRC);
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

// vm with the clock pinned to `nowIso` (UTC) — _serverCurrentYm reads new Date().
function makeCtx(nowIso) {
  const NOW = Date.parse(nowIso);
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
    static now() { return NOW; }
  }
  const ctx = vm.createContext({ Date: FakeDate, Set, console });
  vm.runInContext([
    liftConst('_AUTO_APPLY_TOLERANCE_CENTS'),
    liftConst('_AUTO_APPLY_GENERIC_WORDS'),
    liftFn('_normalizeForMatch'),
    liftFn('_descNameTokens'),
    liftFn('_descNamesOther'),
    liftFn('_isAutoApplyContender'),
    liftFn('_amountPaidRecentlyByOther'),
    liftFn('_monthInvoicedViaStripe'),
    liftFn('_unitBilledViaStripe'),
    liftFn('_unitRecentBankAmountsCents'),
    liftFn('_isMonthToMonth'),
    liftFn('_serverCurrentYm'),
    liftFn('_methodFamily'),
    liftFn('_recPaymentMethod'),
    liftFn('_txnYm'),
    liftFn('_ymInLease'),
    liftFn('_unitPrimaryPaymentMethod'),
    liftFn('_findOldestUnpaidYm'),
    liftFn('_guessMethodFromDescServer'),
    liftFn('_findAutoApplyCandidate'),
  ].join('\n'), ctx);
  return ctx;
}
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const txn = (iso, dollars, description, extra) => Object.assign({
  id: 't_' + iso, status: 'posted', amount: Math.round(dollars * 100),
  transactedAt: unix(iso.length === 10 ? iso + 'T00:00:00Z' : iso), description, matchState: 'unmatched',
}, extra || {});
const state = (...units) => ({ buildings: [{ id: 'b1', floors: [{ id: 'f1', units }] }] });
const achRec = (amount, date) => ({ status: 'paid', amount, paidVia: 'ach', date });
const bankFeedRec = (amount, iso, id) => ({ status: 'paid', amount, bankTxnId: id, source: 'bank-feed', paidAt: iso + 'T00:00:00.000Z' });
const webhookRec = (amount, date, inv) => ({ status: 'paid', amount, date, stripe: { invoiceId: inv, paymentMethod: 'unknown', paidAt: Date.parse(date + 'T12:00:00Z') } });
const outcome = (r) => [r.eligible, r.reason || null, (r.candidate && r.candidate.ym) || null];

// NUHS-like unit: pays by bank every month, Jan–Aug recorded.
function nuhs(extra) {
  const payments = {};
  for (const m of ['01', '02', '05', '06', '07', '08']) payments[`2026-${m}`] = achRec(13318.33, `2026-${m}-10`);
  payments['2026-03'] = { status: 'paid', amount: 13318, date: '2026-05-04' };   // hand-recorded, no method
  payments['2026-04'] = { status: 'paid', amount: 13318, date: '2026-05-03' };
  return Object.assign({ id: '101', status: 'occupied', tenant: 'National University Of Health Sciences', contractRent: 13318, rent: 13318,
    leaseStart: '2026-01-01', until: '2026-12-31', payments }, extra || {});
}
const nuhsWithSep = () => { const u = nuhs(); u.payments['2026-09'] = bankFeedRec(13318.33, '2026-09-08', 'fctxn_sep'); return u; };

// Live Suite 442 shape: lease at 442 from 2026-09-01, ONE Stripe-webhook rec.
function julie442(stripeStamps) {
  return { id: '442', status: 'occupied', tenant: 'Julie Sanatine', contractRent: 2200, rent: 2200,
    leaseStart: '2026-09-01', until: '2027-08-31', stripe: Object.assign({ customerId: 'cus_x' }, stripeStamps || {}),
    payments: { '2026-09': webhookRec(2200, '2026-09-01', 'in_sep') } };
}

// ── 1. NUHS October deposit arriving in October → auto-applies to October ──
{
  const ctx = makeCtx('2026-10-15T07:07:00Z');
  const r = ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-14', 13318.33, 'Customer Deposit'));
  eq(outcome(r), [true, null, '2026-10'], 'NUHS Oct deposit in Oct → auto-applies to October');
}

// ── 2. Payment month = the month the money arrived, not the next one ─────
{
  const ctx = makeCtx('2026-09-09T07:07:00Z');
  const r = ctx._findAutoApplyCandidate(state(nuhs()), txn('2026-09-08', 13318.33, 'Customer Deposit'));
  eq(outcome(r), [true, null, '2026-09'], 'Sep 8 deposit → September (was October)');
}

// ── 3. Family mapping: 'bank' survives _methodFamily; descriptions ────────
{
  const ctx = makeCtx('2026-09-09T07:07:00Z');
  eq(ctx._unitPrimaryPaymentMethod(nuhs()), 'bank', 'NUHS primary family is bank');
  eq(ctx._methodFamily('bank'), 'bank', "_methodFamily('bank') stays bank (was 'other')");
  // Company-name ACH has no keyword — still a bank credit for a bank payer.
  const r = ctx._findAutoApplyCandidate(state(nuhs()), txn('2026-09-08', 13318.33, 'NATIONAL UNIVERS'));
  eq(outcome(r), [true, null, '2026-09'], 'company-name ACH (no keyword) auto-applies for a bank payer');
  // A Stripe payout description is never a bank-family credit.
  const r2 = ctx._findAutoApplyCandidate(state(nuhs()), txn('2026-09-08', 13318.33, 'STRIPE'));
  eq(r2.reason, 'method-mismatch', 'Stripe-payout description → method-mismatch');
}

// ── 4. Suite 442 live shape: one Stripe rec → 'unknown' → manual ──────────
{
  const ctx = makeCtx('2026-10-08T07:07:00Z');
  for (const [label, stamps] of [
    ['Oct invoice stamped', { lastInvoiceYm: '2026-10' }],
    ['stamps moved to Nov (after the Nov send)', { lastInvoiceYm: '2026-11', autoSentYm: '2026-11' }],
    ['stamps cleared (after a void)', {}],
  ]) {
    const r = ctx._findAutoApplyCandidate(state(julie442(stamps)), txn('2026-10-07', 2200, 'Customer Deposit'));
    eq([r.eligible, r.reason, !!r.candidate], [false, 'stripe-billed', false],
      `442: nameless $2,200 is neither applied NOR suggested (Stripe-billed, Entry 90) — ${label}`);
  }
}

// ── 5. Stripe payer with real history → method-mismatch ──────────────────
{
  const ctx = makeCtx('2026-10-08T07:07:00Z');
  const u = julie442();
  u.leaseStart = '2026-07-01';
  u.payments['2026-07'] = webhookRec(2200, '2026-07-01', 'in_a');
  u.payments['2026-08'] = webhookRec(2200, '2026-08-01', 'in_b');
  eq(ctx._unitPrimaryPaymentMethod(u), 'stripe', 'webhook payer primary family is stripe');
  const r = ctx._findAutoApplyCandidate(state(u), txn('2026-10-07', 2200, 'Customer Deposit'));
  eq([r.eligible, r.reason, !!r.candidate], [false, 'stripe-billed', false], 'Stripe payer → stripe-billed, no suggestion');
}

// ── 6. Stray previous-month deposit reaching the current month (the
//       2026-10-01 incident shape) → manual, never auto ───────────────────
{
  const ctx = makeCtx('2026-10-13T07:07:00Z');
  const r = ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-09-17', 13318.33, 'Customer Deposit'));
  eq(outcome(r), [false, 'future-month-needs-manual', '2026-10'], 'Sep 17 deposit seen in Oct, Sep paid → manual advance payment');
}

// ── 7. Current-month gate unchanged: Sep money first seen in Oct ──────────
{
  const ctx = makeCtx('2026-10-01T20:00:00Z');
  const r = ctx._findAutoApplyCandidate(state(nuhs()), txn('2026-09-08', 13318.33, 'Customer Deposit'));
  eq(outcome(r), [false, 'past-month-needs-manual', '2026-09'], 'late-ingested Sep deposit → past-month suggestion for September');
}

// ── 8. 1st-of-month 00:00Z deposit (UTC boundary) ─────────────────────────
{
  const ctx = makeCtx('2026-10-01T15:00:00Z');
  const r = ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-01T00:00:00Z', 13318.33, 'Customer Deposit'));
  eq(outcome(r), [true, null, '2026-10'], 'Oct 1 00:00Z deposit → October');
}

// ── 9. Prepayment: current month paid → next month is manual ─────────────
{
  const ctx = makeCtx('2026-09-28T15:00:00Z');
  const r = ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-09-28', 13318.33, 'Customer Deposit'));
  eq(outcome(r), [false, 'future-month-needs-manual', '2026-10'], 'prepayment → future-month suggestion for October');
}

// ── 10. Arrears: an older month of the lease is open → manual, oldest offered
{
  const ctx = makeCtx('2026-10-08T07:07:00Z');
  const u = nuhs();                        // Sep open, Oct open
  const r = ctx._findAutoApplyCandidate(state(u), txn('2026-10-07', 13318.33, 'Customer Deposit'));
  eq(outcome(r), [false, 'past-month-needs-manual', '2026-09'], 'Sep open + Oct deposit → manual, September offered');
  const u2 = nuhsWithSep(); delete u2.payments['2026-07'];
  const r2 = ctx._findAutoApplyCandidate(state(u2), txn('2026-10-07', 13318.33, 'Customer Deposit'));
  eq(outcome(r2), [false, 'past-month-needs-manual', '2026-07'], 'Jul open (Sep paid) + Oct deposit → oldest open July offered');
}

// ── 11. Name matcher points at another unit → no auto-apply ──────────────
{
  const ctx = makeCtx('2026-10-15T07:07:00Z');
  const r = ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-14', 13318.33, 'ACME DENTAL', { matchedUnitId: '305', matchedBuildingId: 'b1' }));
  eq(r.reason, 'name-conflict', 'matcher says another unit → name-conflict');
  const r2 = ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-14', 13318.33, 'Customer Deposit', { matchedUnitId: '101', matchedBuildingId: 'b1' }));
  eq(r2.eligible, true, 'matcher agrees → still eligible');
  const r3 = ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-14', 13318.33, 'Customer Deposit', { matchedUnitId: '442', matchSource: 'auto-apply-future-month-deferred' }));
  eq(r3.eligible, true, 'our own earlier deferral is not a name signal');
}

// ── 12. Previous tenant's leaked recs do not count (Entry 83) ─────────────
{
  const ctx = makeCtx('2026-10-08T07:07:00Z');
  const u = { id: '323', status: 'occupied', contractRent: 898, leaseStart: '2026-08-01', until: '2027-07-31', payments: {} };
  for (const m of ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']) u.payments[m] = achRec(898, m + '-05');
  u.payments['2026-08'] = webhookRec(898, '2026-08-01', 'in_1');
  u.payments['2026-09'] = webhookRec(898, '2026-09-01', 'in_2');
  eq(ctx._unitPrimaryPaymentMethod(u), 'stripe', 'only in-lease recs count → stripe (leak ignored)');
  const r = ctx._findAutoApplyCandidate(state(u), txn('2026-10-07', 898, 'Customer Deposit'));
  eq(r.reason, 'stripe-billed', 'leaked bank history does not open the gate (current tenant pays via Stripe)');
}

// ── 13. New tenant, no history (e.g. deposit = one month's rent) → manual ─
{
  const ctx = makeCtx('2026-10-12T07:07:00Z');
  const u = { id: '210', status: 'occupied', contractRent: 1750, leaseStart: '2026-10-15', until: '2027-10-14', payments: {} };
  const r = ctx._findAutoApplyCandidate(state(u), txn('2026-10-10', 1750, 'Customer Deposit'));
  eq([r.eligible, r.reason], [false, 'ambiguous'], 'not-yet-started tenancy at that rent → manual (ambiguous: rent or deposit)');
  const u2 = Object.assign({}, u, { leaseStart: '2026-09-15' });
  const r2 = ctx._findAutoApplyCandidate(state(u2), txn('2026-10-10', 1750, 'Customer Deposit'));
  eq([r2.eligible, r2.reason, r2.candidate && r2.candidate.primaryMethod], [false, 'method-mismatch', 'unknown'], 'no history → manual with the 🔀 warning');
}

// ── 14. _recPaymentMethod precedence ─────────────────────────────────────
{
  const ctx = makeCtx('2026-10-08T07:07:00Z');
  eq(ctx._recPaymentMethod({ status: 'paid', stripe: { invoiceId: 'in_f' }, bankTxnId: 'fc1', source: 'bank-feed' }), 'ach', 'failed charge then bank confirm → bank');
  eq(ctx._recPaymentMethod({ status: 'paid', paidVia: 'ach', stripe: { invoiceId: 'in_p', paidAt: 1 } }), 'stripe', 'webhook-paid beats a carried-forward paidVia');
  eq(ctx._recPaymentMethod({ status: 'paid', paidVia: 'backfill', bankTxnId: 'x' }), 'backfill', 'backfill stays backfill');
  eq(ctx._recPaymentMethod({ status: 'paid', paidVia: 'check' }), 'check', 'explicit method');
}

// ── 15. Signals that must stay excluded / thresholds ─────────────────────
{
  const ctx = makeCtx('2026-10-14T15:00:00Z');
  const base = { id: '9', status: 'occupied', contractRent: 500, leaseStart: '2026-01-01', until: '2027-01-31' };
  eq(ctx._unitPrimaryPaymentMethod(Object.assign({}, base, { payments: {
    '2026-08': { status: 'paid', amount: 500, paidVia: 'backfill' }, '2026-09': { status: 'paid', amount: 500, paidVia: 'backfill' } } })), 'unknown', 'backfill-only history → unknown');
  eq(ctx._unitPrimaryPaymentMethod(Object.assign({}, base, { payments: {
    '2026-08': { status: 'paid', amount: 500, paidVia: 'ach', bankTxnId: 'a', autoApplied: true },
    '2026-09': { status: 'paid', amount: 500, paidVia: 'ach', bankTxnId: 'b', autoApplied: true } } })), 'unknown', 'auto-applied recs carry no signal (no feedback loop)');
  eq(ctx._unitPrimaryPaymentMethod(Object.assign({}, base, { payments: { '2026-09': achRec(500, '2026-09-05') } })), 'unknown', 'a single rec → unknown');
  eq(ctx._unitPrimaryPaymentMethod(Object.assign({}, base, { payments: {
    '2026-06': achRec(500, '2026-06-05'), '2026-07': achRec(500, '2026-07-05'),
    '2026-08': webhookRec(500, '2026-08-01', 'i1'), '2026-09': webhookRec(500, '2026-09-01', 'i2') } })), 'unknown', '50/50 → unknown');
}

// ── 16. Ambiguous amount and lease window ─────────────────────────────────
{
  const ctx = makeCtx('2026-10-15T07:07:00Z');
  const twin = Object.assign(nuhsWithSep(), { id: '102' });
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep(), twin), txn('2026-10-14', 13318.33, 'Customer Deposit')).reason, 'ambiguous', 'two units at the same rent → ambiguous');
  const ended = Object.assign(nuhsWithSep(), { until: '2026-09-30' });
  eq(ctx._findAutoApplyCandidate(state(ended), txn('2026-10-05', 13318.33, 'Customer Deposit')).reason, 'no-unpaid-month', 'lease ended → no unpaid month');
  const free = nuhsWithSep(); free.payments['2026-10'] = { status: 'free' };
  eq(outcome(ctx._findAutoApplyCandidate(state(free), txn('2026-10-05', 13318.33, 'Customer Deposit'))), [false, 'future-month-needs-manual', '2026-11'], 'waived October → next month is manual');
  const off = Object.assign(nuhsWithSep(), { autoApplyDisabled: true });
  eq(ctx._findAutoApplyCandidate(state(off), txn('2026-10-14', 13318.33, 'Customer Deposit')).reason, 'no-amount-match', 'autoApplyDisabled unit is never a candidate');
}


// ── 17. Second-review cases (Entry 89 rev 3) ─────────────────────────────
{
  const ctx = makeCtx('2026-10-15T07:07:00Z');
  // MS-R1: a reserved unit at the same rent makes the amount ambiguous.
  const reserved = { id: '306', status: 'reserved', contractRent: 13318.33, leaseStart: '2026-11-01', payments: {} };
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep(), reserved), txn('2026-10-14', 13318.33, 'Customer Deposit')).reason, 'ambiguous', 'reserved twin at the same rent → ambiguous');
  // …and an unpaid move-in deposit of that amount does too.
  const newcomer = { id: '412', status: 'occupied', contractRent: 900, deposit: 13318.33, leaseStart: '2026-10-01', until: '2027-09-30', payments: {} };
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep(), newcomer), txn('2026-10-14', 13318.33, 'Customer Deposit')).reason, 'ambiguous', 'unpaid move-in deposit of that amount → ambiguous');
  const paidDep = Object.assign({}, newcomer, { payments: { deposit: { status: 'paid', amount: 13318.33, paidAt: '2026-09-28' } } });
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep(), paidDep), txn('2026-10-14', 13318.33, 'Customer Deposit')).eligible, true, 'paid deposit is not a contender');
  // MS-R2: exact-cents amount, but the descriptor names another company.
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-14', 13318.33, 'ACME DENTAL LLC ACH PMT', { matchedUnitId: '101', matchedBuildingId: 'b1' })).reason, 'name-conflict', 'descriptor names someone else → name-conflict even when the matcher agrees');
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-14', 13318.33, 'NATIONAL UNIVERS')).eligible, true, 'truncated own name passes');
  eq(ctx._descNamesOther('TRANSFER DEPOSIT FROM ...1305', { tenant: 'X' }), false, 'transfer descriptor is generic');
  // Cross-building twin id (Entry 88 shape): matcher points at 101 in ANOTHER building.
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-14', 13318.33, 'Customer Deposit', { matchedUnitId: '101', matchedBuildingId: 'b9' })).reason, 'name-conflict', 'same suite id, other building → name-conflict');
  // MS-R3: Stripe invoice for October exists although stamps moved to November.
  const invoiced = Object.assign(nuhsWithSep(), { stripe: { lastInvoiceYm: '2026-11', autoSentYm: '2026-11' } });
  eq(['stripe-billed', 'stripe-invoiced'].includes(ctx._findAutoApplyCandidate(state(invoiced), txn('2026-10-14', 13318.33, 'Customer Deposit')).reason), true, 'October invoice still open behind November stamps → no auto');
  const mir = Object.assign(nuhsWithSep(), { stripe: { moveInRent: { ym: '2026-10', status: 'paid' } } });
  eq(['stripe-billed', 'stripe-invoiced'].includes(ctx._findAutoApplyCandidate(state(mir), txn('2026-10-14', 13318.33, 'Customer Deposit')).reason), true, 'move-in rent invoice for the month → no auto');
  // Amount fingerprint: rent changed → manual.
  eq(ctx._findAutoApplyCandidate(state(Object.assign(nuhsWithSep(), { contractRent: 13700, rent: 13700 })), txn('2026-10-14', 13700, 'Customer Deposit')).reason, 'amount-changed', 'new amount ≠ own recent bank payments → manual');
  // MS-R5: no ISO lease start → no history signal → manual.
  eq(ctx._unitPrimaryPaymentMethod(Object.assign(nuhsWithSep(), { leaseStart: '', signed: '' })), 'unknown', 'empty leaseStart → unknown');
  eq(ctx._unitPrimaryPaymentMethod(Object.assign(nuhsWithSep(), { leaseStart: '01/01/2026' })), 'unknown', 'non-ISO leaseStart → unknown');
  // R6: oldest open month chosen among several; precedence edges.
  const two = nuhs(); delete two.payments['2026-07'];   // Jul open, Sep open
  eq(outcome(makeCtx('2026-10-08T07:07:00Z')._findAutoApplyCandidate(state(two), txn('2026-10-07', 13318.33, 'Customer Deposit'))), [false, 'past-month-needs-manual', '2026-07'], 'Jul + Sep open → July (oldest) offered');
  eq(ctx._recPaymentMethod({ status: 'paid', bankTxnId: 'fc', stripe: { invoiceId: 'i', paidAt: 1 } }), 'ach', 'linked bank txn wins over a paid invoice id');
  eq(ctx._recPaymentMethod({ status: 'paid', paidVia: 'ach', stripe: { invoiceId: 'i' } }), 'ach', 'unpaid (failed) invoice id does not override an explicit method');
}


// ── 18. Third-review cases (Entry 89 rev 4) ──────────────────────────────
{
  const ctx = makeCtx('2026-10-03T07:07:00Z');
  const bankPayer = (id, amt) => ({ id, status: 'occupied', tenant: 'Tenant ' + id, contractRent: amt, leaseStart: '2026-06-01', until: '2027-12-31',
    payments: Object.fromEntries(['2026-06', '2026-07', '2026-08', '2026-09'].map(m => [m, bankFeedRec(amt, m + '-02', 'fc_' + id + m)])) });
  // F1 L1: 315's rent was raised to $1,545 but the tenant still pays $1,500 = 210's rent.
  const t315 = Object.assign(bankPayer('315', 1500), { contractRent: 1545 });
  eq(ctx._findAutoApplyCandidate(state(bankPayer('210', 1500), t315), txn('2026-10-02', 1500, 'Customer Deposit')).reason, 'ambiguous',
    'the same amount is paid by another unit → ambiguous (rent escalation case)');
  // F1 L1c: a former tenant (vacant unit, tenantHistory) pays arrears equal to another rent.
  const vacant207 = { id: '207', status: 'vacant', contractRent: 0, payments: {}, tenantHistory: [{ tenant: 'Old', payments: { '2026-08': bankFeedRec(1250, '2026-08-03', 'fc_old') } }] };
  eq(ctx._findAutoApplyCandidate(state(bankPayer('412', 1250), vacant207), txn('2026-10-02', 1250, 'Customer Deposit')).reason, 'ambiguous',
    "a former tenant's recent bank amount → ambiguous");
  // F1 L1b: owner / internal transfer never auto.
  eq(ctx._findAutoApplyCandidate(state(bankPayer('118', 2000)), txn('2026-10-02', 2000, 'TRANSFER DEPOSIT FROM ...1305')).reason, 'internal-transfer', 'transfer-from → never auto');
  // Recurring outside series: the same amount already arrived unlinked last month.
  const series = [{ id: 'fc_prev', amount: 200000, transactedAt: unix('2026-09-07T00:00:00Z'), matchState: 'unmatched' }];
  eq(ctx._findAutoApplyCandidate(state(bankPayer('118', 2000)), txn('2026-10-02', 2000, 'Customer Deposit'), { pendingTxns: series }).reason, 'ambiguous',
    'same amount keeps arriving unlinked → ambiguous');
  // Another open suggestion already points at this unit (early payer, operator lag).
  const openSug = [{ id: 'fc_a', amount: 199900, transactedAt: unix('2026-09-28T00:00:00Z'), matchState: 'suggested', matchedUnitId: '118', matchedBuildingId: 'b1' }];
  eq(ctx._findAutoApplyCandidate(state(bankPayer('118', 2000)), txn('2026-10-02', 2000, 'Customer Deposit'), { pendingTxns: openSug }).reason, 'ambiguous',
    'another open suggestion for the unit → ambiguous');
  // Control: the same unit with no such signals auto-applies.
  eq(ctx._findAutoApplyCandidate(state(bankPayer('118', 2000)), txn('2026-10-02', 2000, 'Customer Deposit'), { pendingTxns: [] }).eligible, true, 'control: clean bank payer still auto-applies');
  // R3-2: a previous tenant's leaked PAID deposit does not hide the newcomer's unpaid one.
  const newcomer = { id: '318n', status: 'occupied', contractRent: 900, deposit: 1500, leaseStart: '2026-09-20', until: '2027-09-30',
    payments: { deposit: { status: 'paid', amount: 1500, paidAt: '2026-02-01' } } };
  eq(ctx._findAutoApplyCandidate(state(bankPayer('318', 1500), newcomer), txn('2026-10-02', 1500, 'Customer Deposit')).reason, 'ambiguous',
    "leaked previous tenant's paid deposit → the newcomer's unpaid deposit still counts → ambiguous");
  // R3-5: bank boilerplate is not a name.
  eq(ctx._descNamesOther('REMOTE DEPOSIT CAPTURE', { tenant: 'X Corp' }), false, 'remote deposit capture is generic');
  eq(ctx._descNamesOther('ONLINE TRANSFER FROM CHK 1234', { tenant: 'X Corp' }), false, 'online transfer from chk is generic');
}


// ── 19. Fourth-review cases (Entry 89 rev 5) ─────────────────────────────
{
  const ctx = makeCtx('2026-11-08T07:07:00Z');
  // R4-1: live 442 shape (Sep+Oct paid by Stripe, Nov invoice sent) + the open Oct 7 series instance:
  // the Nov 7 $2,200 must carry the 🔀 method-mismatch warning, not a silent 'ambiguous'.
  const j = julie442({ lastInvoiceYm: '2026-11', autoSentYm: '2026-11' });
  j.payments['2026-10'] = webhookRec(2200, '2026-10-13', 'in_oct');
  const octInst = { id: 'fc_oct7', amount: 220000, transactedAt: unix('2026-10-07T12:00:00Z'), matchState: 'suggested', matchedUnitId: '442', matchedBuildingId: 'b1', status: 'posted' };
  const r = ctx._findAutoApplyCandidate(state(j), txn('2026-11-07', 2200, 'Customer Deposit'), { pendingTxns: [octInst], recentTxns: [octInst] });
  eq([r.reason, !!r.candidate], ['stripe-billed', false], '442 series instance: no suggestion at all (Entry 90)');
}
{
  const ctx = makeCtx('2026-10-03T07:07:00Z');
  const bankPayer = (id, amt) => ({ id, status: 'occupied', tenant: 'Tenant ' + id, email: id + '@x.com', contractRent: amt, leaseStart: '2026-06-01', until: '2027-12-31',
    payments: Object.fromEntries(['2026-06', '2026-07', '2026-08', '2026-09'].map(m => [m, bankFeedRec(amt, m + '-02', 'fc_' + id + m)])) });
  const at = (iso, extra) => Object.assign({ id: 'o_' + iso, amount: 220000, transactedAt: unix(iso + 'T12:00:00Z'), status: 'posted' }, extra);
  // R4-2: a DISMISSED («Not rent») earlier instance still marks the series.
  eq(ctx._findAutoApplyCandidate(state(bankPayer('230', 2200)), txn('2026-10-02', 2200, 'Customer Deposit'),
    { pendingTxns: [], recentTxns: [at('2026-09-07', { matchState: 'dismissed' })] }).reason, 'ambiguous', 'dismissed earlier instance → ambiguous');
  // The tenant's OWN earlier deposits (confirmed to this unit, building missing on old recs) do not count.
  eq(ctx._findAutoApplyCandidate(state(bankPayer('230', 2200)), txn('2026-10-02', 2200, 'Customer Deposit'),
    { pendingTxns: [], recentTxns: [at('2026-09-02', { matchState: 'confirmed', matchedUnitId: '230' }), at('2026-08-02', { matchState: 'confirmed', autoApplyTargetUnitId: '230', matchedBuildingId: 'b1' })] }).eligible, true,
    "own confirmed deposits are not a series");
  // R4-5: void twins, dedupe twins and stale (>45 d) suggestions do not block.
  eq(ctx._findAutoApplyCandidate(state(bankPayer('230', 2200)), txn('2026-10-02', 2200, 'Customer Deposit'),
    { pendingTxns: [at('2026-07-20', { amount: 52000, matchState: 'suggested', matchedUnitId: '230' })],
      recentTxns: [at('2026-09-30', { status: 'void', matchState: 'unmatched' }), at('2026-09-29', { dedupeSuspect: true, matchState: 'unmatched' })] }).eligible, true,
    'void / dedupe twins / stale suggestions do not block');
  const fresh = at('2026-09-28', { amount: 199900, matchState: 'suggested', matchedUnitId: '230', matchedBuildingId: 'b1' });
  eq(ctx._findAutoApplyCandidate(state(bankPayer('230', 2200)), txn('2026-10-02', 2200, 'Customer Deposit'), { pendingTxns: [fresh], recentTxns: [fresh] }).reason, 'ambiguous',
    'a fresh open suggestion for the unit still blocks');
  // R4-3: a recent former tenant at the same rent (any method) is a contender.
  const vac = { id: '207', status: 'vacant', contractRent: 0, payments: {}, tenantHistory: [{ tenant: 'Gone LLC', contractRent: 1250, movedOut: '2026-08-31', payments: { '2026-08': webhookRec(1250, '2026-08-01', 'i8') } }] };
  eq(ctx._findAutoApplyCandidate(state(bankPayer('412', 1250), vac), txn('2026-10-02', 1250, 'Customer Deposit'), { pendingTxns: [], recentTxns: [] }).reason, 'ambiguous',
    'recent former tenant at that rent → ambiguous');
  // R4-7 M9: the candidate unit's OWN former tenant at the same rent counts too.
  const own = Object.assign(bankPayer('412', 1250), { tenantHistory: [{ tenant: 'Previous Co', contractRent: 1250, movedOut: '2026-06-10' }] });
  own.leaseStart = '2026-06-01';
  eq(ctx._findAutoApplyCandidate(state(own), txn('2026-10-02', 1250, 'Customer Deposit'), { pendingTxns: [], recentTxns: [] }).reason, 'ambiguous',
    "the unit's own recent former tenant → ambiguous");
  // …but the SAME tenant relocated from another suite is not «someone else» (R4-6.3).
  const reloc = { id: '358', status: 'vacant', contractRent: 0, payments: {}, tenantHistory: [{ tenant: 'Tenant 412', email: '412@x.com', relocatedTo: '412', contractRent: 1250, movedOut: '2026-08-31',
    payments: { '2026-08': bankFeedRec(1250, '2026-08-02', 'fc_r') } }] };
  eq(ctx._findAutoApplyCandidate(state(bankPayer('412', 1250), reloc), txn('2026-10-02', 1250, 'Customer Deposit'), { pendingTxns: [], recentTxns: [] }).eligible, true,
    'relocated same tenant does not block');
  // R4-6: «ONLINE TRANSFER FROM <own company>» is not internal; «…FROM …1305» is.
  const hd = Object.assign(bankPayer('500', 3000), { tenant: 'Harbor Dental' });
  eq(ctx._findAutoApplyCandidate(state(hd), txn('2026-10-02', 3000, 'ONLINE TRANSFER FROM HARBOR DENTAL'), { pendingTxns: [], recentTxns: [] }).eligible, true, 'own-name online transfer applies');
  eq(ctx._findAutoApplyCandidate(state(hd), txn('2026-10-02', 3000, 'TRANSFER DEPOSIT FROM ...1305'), { pendingTxns: [], recentTxns: [] }).reason, 'internal-transfer', 'account transfer is internal');
  eq(ctx._findAutoApplyCandidate(state(hd), txn('2026-10-02', 3000, 'ONLINE TRANSFER FROM CHK 1234'), { pendingTxns: [], recentTxns: [] }).reason, 'internal-transfer', 'transfer from account digits is internal');
  // Deposit-paid dates in seconds / Timestamp form are read correctly.
  const nc = { id: '600', status: 'occupied', contractRent: 900, deposit: 3000, leaseStart: '2026-09-20', until: '2027-09-30', payments: {},
    stripe: { depositInvoice: { status: 'paid', paidAt: unix('2026-09-18T00:00:00Z') } } };
  eq(ctx._isAutoApplyContender(nc, 300000, Date.now()), false, 'deposit paidAt in SECONDS → paid');
  const nc2 = Object.assign({}, nc, { stripe: {}, payments: { deposit: { status: 'paid', paidAt: { _seconds: unix('2026-09-18T00:00:00Z') } } } });
  eq(ctx._isAutoApplyContender(nc2, 300000, Date.now()), false, 'Timestamp-like paidAt → paid');
}


// ── 20. Rev-5 check cases (Entry 89 rev 6) ───────────────────────────────
{
  const ctx = makeCtx('2026-10-03T07:07:00Z');
  const bankPayer = (id, amt) => ({ id, status: 'occupied', tenant: 'Tenant ' + id, email: id + '@x.com', contractRent: amt, leaseStart: '2026-06-01', until: '2027-12-31',
    payments: Object.fromEntries(['2026-06', '2026-07', '2026-08', '2026-09'].map(m => [m, bankFeedRec(amt, m + '-02', 'fc_' + id + m)])) });
  const at = (iso, extra) => Object.assign({ id: 'o_' + iso, amount: 218000, transactedAt: unix(iso + 'T12:00:00Z'), status: 'posted' }, extra);
  // R5-1: a deposit that NAMES another tenant never becomes a 🔀 suggestion for a Stripe / no-history unit.
  const stripeB = julie442(); stripeB.id = '433'; stripeB.tenant = 'Lex Wagner'; stripeB.contractRent = 2180; stripeB.rent = 2180;
  eq(ctx._findAutoApplyCandidate(state(stripeB), txn('2026-10-02', 2180, 'ZELLE PAYMENT FROM HARBOR DENTAL LAB', { matchedUnitId: '230', matchedBuildingId: 'b1' }), { pendingTxns: [], recentTxns: [] }).reason, 'name-conflict',
    'matcher routed the deposit to another unit → name-conflict BEFORE the method gate (no 🔀 suggestion for B)');
  // rev 7 (F3): a descriptor that only NAMES someone else still gives a Stripe/no-history unit the 🔀 warning.
  const r433 = ctx._findAutoApplyCandidate(state(stripeB), txn('2026-10-02', 2180, 'ZELLE PAYMENT FROM JOHN SMITH'), { pendingTxns: [], recentTxns: [] });
  eq([r433.reason, !!r433.candidate], ['stripe-billed', false], 'named descriptor + recently Stripe-paid unit → no suggestion');
  eq(ctx._findAutoApplyCandidate(state(bankPayer('238', 2180)), txn('2026-10-02', 2180, 'ZELLE PAYMENT FROM JOHN SMITH'), { pendingTxns: [], recentTxns: [] }).reason, 'name-conflict',
    'named descriptor + proven bank payer → name-conflict');
  // R5-2: a txn referenced by the unit's own ledger rec (heal whose confirm never landed) is own, not a series.
  const p230 = bankPayer('230', 2180);
  p230.payments['2026-09'] = { status: 'paid', amount: 2180, paidVia: 'ach', date: '2026-09-02', bankTxnId: 'fc_heal' };
  eq(ctx._findAutoApplyCandidate(state(p230), txn('2026-10-02', 2180, 'Customer Deposit'), { pendingTxns: [], recentTxns: [at('2026-09-02', { id: 'fc_heal', matchState: 'suggested' })] }).eligible, true,
    "own ledger-referenced txn is not a series");
  // R5-3: own deposit hidden with «Not rent» after recording the month by hand (no bankTxnId) is own.
  const hand = bankPayer('231', 2180);
  hand.payments['2026-09'] = { status: 'paid', amount: 2180, paidVia: 'ach', date: '2026-09-03' };
  hand.payments['2026-08'] = { status: 'paid', amount: 2180, paidVia: 'ach', date: '2026-08-02' };
  eq(ctx._findAutoApplyCandidate(state(hand), txn('2026-10-02', 2180, 'Customer Deposit'), { pendingTxns: [], recentTxns: [at('2026-09-02', { matchState: 'dismissed' })] }).reason, 'ambiguous',
    'rev 7: a dismissed same-amount row is ALWAYS a series (even next to a hand-recorded month) — fail-safe');
  // rev 7 (F2): a ledger reference only makes a row «own» while it is open or confirmed to this unit / no unit.
  const ref = bankPayer('239', 2180); ref.payments['2026-09'] = { status: 'paid', amount: 2180, paidVia: 'check', date: '2026-09-10', bankTxnId: 'S_sep' };
  eq(ctx._findAutoApplyCandidate(state(ref), txn('2026-10-02', 2180, 'Customer Deposit'), { pendingTxns: [], recentTxns: [at('2026-09-07', { id: 'S_sep', matchState: 'dismissed' })] }).reason, 'ambiguous',
    'stale ledger reference to an Undone (dismissed) row is not own');
  eq(ctx._findAutoApplyCandidate(state(ref), txn('2026-10-02', 2180, 'Customer Deposit'), { pendingTxns: [], recentTxns: [at('2026-09-07', { id: 'S_sep', matchState: 'confirmed', matchedUnitId: '999' })] }).reason, 'ambiguous',
    'ledger reference to a row confirmed to ANOTHER unit is not own');
  const unpaid = bankPayer('240', 2180); unpaid.payments['2026-09'] = { status: 'late', amount: 2180, bankTxnId: 'S_x' };
  unpaid.payments['2026-08'] = bankFeedRec(2180, '2026-08-02', 'fc_a'); unpaid.payments['2026-07'] = bankFeedRec(2180, '2026-07-02', 'fc_b');
  eq(ctx._findAutoApplyCandidate(state(unpaid), txn('2026-10-02', 2180, 'Customer Deposit'), { pendingTxns: [], recentTxns: [at('2026-09-07', { id: 'S_x', matchState: 'unmatched' })] }).reason !== undefined, true,
    'an UNPAID rec referencing a row does not make it own');
  eq(ctx._findAutoApplyCandidate(state(bankPayer('232', 2180)), txn('2026-10-02', 2180, 'Customer Deposit'), { pendingTxns: [], recentTxns: [at('2026-09-12', { matchState: 'dismissed' })] }).reason, 'ambiguous',
    "a dismissed stranger instance (unit's months are bank-linked) is still a series");
  // R5-4: own-link needs the same building, and confirmed state.
  eq(ctx._findAutoApplyCandidate(state(bankPayer('233', 2180)), txn('2026-10-02', 2180, 'Customer Deposit'), { pendingTxns: [], recentTxns: [at('2026-09-02', { matchState: 'confirmed', matchedUnitId: '233', matchedBuildingId: 'b9' })] }).reason, 'ambiguous',
    'confirmed to the same suite id in ANOTHER building → series');
  eq(ctx._findAutoApplyCandidate(state(bankPayer('234', 2180)), txn('2026-10-02', 2180, 'Customer Deposit'), { pendingTxns: [], recentTxns: [at('2026-09-02', { matchState: 'suggested', matchedUnitId: '234' })] }).reason, 'ambiguous',
    'an earlier unconfirmed suggestion of the same amount → series');
  eq(ctx._findAutoApplyCandidate(state(bankPayer('235', 2180)), txn('2026-10-02', 2180, 'Customer Deposit'), { pendingTxns: [at('2026-09-30', { amount: 50000, matchState: 'suggested', matchedUnitId: '235', status: 'pending' })], recentTxns: [] }).eligible, true,
    'a PENDING open suggestion for the unit does not block');
  // 120-day bound on the former-tenant contender.
  const oldVac = { id: '207', status: 'vacant', contractRent: 0, payments: {}, tenantHistory: [{ tenant: 'Long Gone', contractRent: 2180, movedOut: '2026-03-31' }] };
  eq(ctx._findAutoApplyCandidate(state(bankPayer('236', 2180), oldVac), txn('2026-10-02', 2180, 'Customer Deposit'), { pendingTxns: [], recentTxns: [] }).eligible, true,
    'former tenant moved out > 120 days ago is not a contender');
  // R5-5: transfer-from with no identifiable sender is internal.
  for (const desc of ['ONLINE TRANSFER FROM CHK', 'WIRE TRANSFER FROM', 'TRANSFER FROM']) {
    eq(ctx._findAutoApplyCandidate(state(bankPayer('237', 2180)), txn('2026-10-02', 2180, desc), { pendingTxns: [], recentTxns: [] }).reason, 'internal-transfer', `«${desc}» → internal-transfer`);
  }
}


// ── 21. Entry 90: Stripe-billed tenants never get bank-deposit suggestions ──
{
  const ctx = makeCtx('2026-11-08T07:07:00Z');
  const base = { id: 'x', status: 'occupied', tenant: 'T', contractRent: 1000, leaseStart: '2026-01-01', until: '2027-12-31', payments: {} };
  eq(ctx._unitBilledViaStripe(Object.assign({}, base, { stripe: { lastInvoiceYm: '2026-11' } })), true, 'recent rent-invoice stamp → Stripe-billed');
  eq(ctx._unitBilledViaStripe(Object.assign({}, base, { stripe: { lastInvoiceYm: '2026-05' } })), false, 'stale (> 3 months) stamp alone → not Stripe-billed');
  eq(ctx._unitBilledViaStripe(Object.assign({}, base, { stripe: { moveInRent: { ym: '2026-10' } } })), true, 'recent move-in rent invoice → Stripe-billed');
  eq(ctx._unitBilledViaStripe(nuhsWithSep()), false, 'NUHS (bank payer, no Stripe) → not Stripe-billed');
  const bankOnceCard = nuhsWithSep(); bankOnceCard.payments['2026-10'] = webhookRec(13318.33, '2026-10-05', 'i_once');
  eq(ctx._unitBilledViaStripe(bankOnceCard), false, 'a proven bank payer who once paid by card stays a bank payer');
  // NUHS still auto-applies its November deposit.
  const n = nuhsWithSep(); n.payments['2026-10'] = bankFeedRec(13318.33, '2026-10-14', 'fc_oct');
  eq(ctx._findAutoApplyCandidate(state(n), txn('2026-11-09', 13318.33, 'Customer Deposit'), { pendingTxns: [], recentTxns: [] }).eligible, true, 'NUHS November still auto-applies');
}

console.log(`auto-apply-candidate.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
