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
    liftFn('_monthInvoicedViaStripe'),
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
    eq([r.eligible, r.reason, r.candidate && r.candidate.primaryMethod], [false, 'method-mismatch', 'unknown'],
      `442: nameless $2,200 never auto-applies — ${label}`);
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
  eq([r.eligible, r.reason, r.candidate && r.candidate.primaryMethod], [false, 'method-mismatch', 'stripe'], 'Stripe payer → method-mismatch');
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
  eq(r.reason, 'method-mismatch', 'leaked bank history does not open the gate');
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
  const paidDep = Object.assign({}, newcomer, { payments: { deposit: { status: 'paid', amount: 13318.33 } } });
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep(), paidDep), txn('2026-10-14', 13318.33, 'Customer Deposit')).eligible, true, 'paid deposit is not a contender');
  // MS-R2: exact-cents amount, but the descriptor names another company.
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-14', 13318.33, 'ACME DENTAL LLC ACH PMT', { matchedUnitId: '101', matchedBuildingId: 'b1' })).reason, 'name-conflict', 'descriptor names someone else → name-conflict even when the matcher agrees');
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-14', 13318.33, 'NATIONAL UNIVERS')).eligible, true, 'truncated own name passes');
  eq(ctx._descNamesOther('TRANSFER DEPOSIT FROM ...1305', { tenant: 'X' }), false, 'transfer descriptor is generic');
  // Cross-building twin id (Entry 88 shape): matcher points at 101 in ANOTHER building.
  eq(ctx._findAutoApplyCandidate(state(nuhsWithSep()), txn('2026-10-14', 13318.33, 'Customer Deposit', { matchedUnitId: '101', matchedBuildingId: 'b9' })).reason, 'name-conflict', 'same suite id, other building → name-conflict');
  // MS-R3: Stripe invoice for October exists although stamps moved to November.
  const invoiced = Object.assign(nuhsWithSep(), { stripe: { lastInvoiceYm: '2026-11', autoSentYm: '2026-11' } });
  eq(ctx._findAutoApplyCandidate(state(invoiced), txn('2026-10-14', 13318.33, 'Customer Deposit')).reason, 'stripe-invoiced', 'October invoice still open behind November stamps → no auto');
  const mir = Object.assign(nuhsWithSep(), { stripe: { moveInRent: { ym: '2026-10', status: 'paid' } } });
  eq(ctx._findAutoApplyCandidate(state(mir), txn('2026-10-14', 13318.33, 'Customer Deposit')).reason, 'stripe-invoiced', 'move-in rent invoice for the month → no auto');
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

console.log(`auto-apply-candidate.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
