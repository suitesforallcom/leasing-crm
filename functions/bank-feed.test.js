// =========================================================================
// Pure-Node simulation of the Stripe FC bank-feed poller (FIXES_LOG Entry 81)
// — БЕЗ Firebase / БЕЗ Stripe. Запуск: node functions/bank-feed.test.js
//
// The bank-feed code lives inside the index.js monolith (which needs the
// whole Firebase runtime to `require`), so the test lifts the relevant
// top-level functions out of the source text and runs them in a vm context
// against a fake Stripe + fake Firestore + fake mutateWorkspaceState.
//
// Covers: inactive account (2026-10-01 incident: Capital One ····5709 went
// inactive 2026-09-19, polls "succeeded" with 0 new, watermark slid past the
// gap), recovery after a Stripe-hosted relink, healthy account watermark,
// transient refresh failure, cron cadence, syncBankConnections duplicate
// guard, finalizeBankConnection ghost replacement.
// =========================================================================
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

// ── lift functions out of index.js ──────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function liftFn(name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
  const m = re.exec(SRC);
  if (!m) throw new Error(`function ${name} not found in index.js`);
  const end = SRC.indexOf('\n}\n', m.index);
  return SRC.slice(m.index, end + 2);
}
function liftExport(name) {
  const start = SRC.indexOf(`exports.${name} = `);
  if (start < 0) throw new Error(`exports.${name} not found in index.js`);
  const end = SRC.indexOf('\n);\n', start);
  return SRC.slice(start, end + 3);
}
function liftConst(name) {
  const m = new RegExp(`^const ${name} = [^;]+;`, 'm').exec(SRC);
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

const DAY = 86400;
const nowUnix = () => Math.floor(Date.now() / 1000);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── fake world ──────────────────────────────────────────────────────────
function makeWorld({ conns, accounts, txns }) {
  const world = {
    state: { bankConnections: clone(conns), operatorStripeCustomerId: 'cus_op' },
    accounts: clone(accounts),          // fcId → Stripe account object
    txns: clone(txns || {}),            // fcId → [{id, transacted_at, amount}]
    docs: new Map(),                    // bankTransactions docs
    audit: [],
    listCalls: [],
    refreshCalls: [],
    refreshCompletes: true,             // refresh() → succeeded immediately
  };
  const stripe = {
    financialConnections: {
      accounts: {
        retrieve: async (id) => {
          if (!world.accounts[id]) throw new Error('No such account');
          return clone(world.accounts[id]);
        },
        refresh: async (id) => {
          world.refreshCalls.push(id);
          const a = world.accounts[id];
          if (a.status !== 'active') {
            const e = new Error(a.status === 'inactive'
              ? 'Data cannot be refreshed on inactive accounts.'
              : 'This account has been disconnected.');
            e.code = a.status === 'inactive' ? 'financial_connections_account_inactive' : 'resource_missing';
            throw e;
          }
          a.transaction_refresh = {
            id: 'fctxnref_' + world.refreshCalls.length,
            last_attempted_at: nowUnix(),
            next_refresh_available_at: null,
            status: world.refreshCompletes ? 'succeeded' : 'pending',
          };
          return clone(a);
        },
        disconnect: async (id) => { world.disconnectCalls = (world.disconnectCalls || 0) + 1; world.accounts[id].status = 'disconnected'; return {}; },
        list: async ({ account_holder }) => ({
          data: Object.values(world.accounts).filter(a => a._customer === account_holder.customer).map(clone),
          has_more: false,
        }),
      },
      transactions: {
        list: async (params) => {
          world.listCalls.push(clone(params));
          const gte = params.transacted_at && params.transacted_at.gte;
          let rows = (world.txns[params.account] || [])
            .filter(t => !gte || t.transacted_at >= gte)
            .map(t => ({ object: 'financial_connections.transaction', account: params.account, currency: 'usd', status: 'posted', description: 'X', ...t }));
          if (params.starting_after) {
            const i = rows.findIndex(r => r.id === params.starting_after);
            rows = rows.slice(i + 1);
          }
          const page = rows.slice(0, params.limit || 100);
          return { data: page, has_more: rows.length > page.length };
        },
      },
    },
  };
  const query = (filters) => ({
    where: (field, op, val) => query([...filters, { field, op, val }]),
    get: async () => {
      const docs = [...world.docs.entries()]
        .filter(([, d]) => filters.every(f => f.op === 'in' ? f.val.includes(d[f.field]) : d[f.field] === f.val))
        .map(([id, d]) => ({ id, ref: { id, path: 'bankTransactions/' + id }, data: () => clone(d) }));
      return { empty: !docs.length, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
    },
  });
  const db = {
    collection: (p) => ({
      doc: (id) => ({ id: id || ('auto' + Math.random()), path: p + '/' + id }),
      add: async (doc) => { if (p.endsWith('/audit')) world.audit.push(doc); return { id: 'a' + world.audit.length }; },
      where: (field, op, val) => query([{ field, op, val }]),
    }),
    doc: (p) => {
      const id = p.split('/').pop();
      return { id, path: p,
        set: async (data) => { world.docs.set(id, { ...(world.docs.get(id) || {}), ...clone(data) }); } };
    },
    runTransaction: async (fn) => {
      if (world.failPaymentWrites) throw new Error('simulated ledger write failure');
      if (world.beforeTx) { const f = world.beforeTx; world.beforeTx = null; await f(); }
      const isLedger = (ref) => String(ref.path).includes('/payments/');
      const isAudit = (ref) => String(ref.path).includes('/audit/');
      const writes = [];
      const tx = {
        get: async (ref) => {
          if (isLedger(ref)) {
            if (world.injectConflictKey && ref.id === world.injectConflictKey) {
              world.paymentsCol.set(ref.id, { ym: ref.id.split('__')[2], rec: { status: 'paid', amount: 2250, source: 'stripe', stripe: { invoiceId: 'in_race' } } });
              world.injectConflictKey = null;
            }
            const d = world.paymentsCol.get(ref.id);
            return { exists: !!d, data: () => clone(d) };
          }
          const d = world.docs.get(ref.id);
          return { exists: !!d, data: () => clone(d) };
        },
        set: (ref, payload, opts) => { writes.push({ ref, payload: clone(payload), opts }); },
      };
      const out = await fn(tx);
      for (const w of writes) {
        if (isLedger(w.ref)) world.paymentsCol.set(w.ref.id, w.payload);
        else if (isAudit(w.ref)) world.audit.push(w.payload);
        else world.docs.set(w.ref.id, { ...(w.opts && w.opts.merge ? (world.docs.get(w.ref.id) || {}) : {}), ...w.payload });
      }
      return out;
    },
    getAll: async (...refs) => refs.map(r => ({ exists: world.docs.has(r.id), data: () => world.docs.get(r.id) })),
    batch: () => {
      const ops = [];
      return {
        set: (ref, data, opts) => ops.push({ ref, data, opts }),
        delete: (ref) => ops.push({ ref, del: true }),
        commit: async () => {
          if (world.failBatches) throw new Error('simulated batch failure');
          for (const o of ops) {
            if (o.del) { if (String(o.ref.path).includes('/payments/')) world.paymentsCol.delete(o.ref.id); else world.docs.delete(o.ref.id); continue; }
            if (String(o.ref.path).includes('/audit/')) { world.audit.push(o.data); continue; }
            world.docs.set(o.ref.id, { ...(world.docs.get(o.ref.id) || {}), ...o.data });
          }
        },
      };
    },
  };
  let mutateCount = 0;
  const ctx = {
    console, Date, Math, JSON, Number, Promise, Error, Map, Set, Array, Object, String, RegExp, Boolean,
    setTimeout,
    exports: {},
    WORKSPACE_ID: 'default',
    STRIPE_SECRET_KEY: 'secret',
    logger: { info() {}, warn() {}, error() {} },
    admin: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TS' } } },
    HttpsError: class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } },
    onCall: (_opts, fn) => fn,
    onSchedule: (_opts, fn) => fn,
    requireEditor: async () => ({ email: 'tony@al-en.com', role: 'admin' }),
    _deletePaymentV2: async (bId, uId, ym) => {
      if (world.failPaymentWrites) throw new Error('simulated ledger delete failure');
      world.paymentsCol.delete(`${bId}__${uId}__${ym}`);
    },
    getStripe: () => stripe,
    db,
    readWorkspaceState: async () => world.hydrate(),
    // Every mutate first runs on a throw-away copy (simulated Firestore txn
    // retry) — closure accumulators that are not reset at the callback top
    // would double-count. Under the simulated buildings strip the persisted
    // copy loses u.payments exactly like _buildingForV2CF; reads re-hydrate
    // payments from world.paymentsCol (the ledger).
    mutateWorkspaceState: async (fn) => {
      mutateCount++;
      const hydrate = world.hydrate;
      fn(hydrate());
      const s = hydrate();
      fn(s);
      if (world.strip) for (const b of s.buildings || []) for (const f of b.floors || []) for (const u of f.units || []) delete u.payments;
      world.state = s;
    },
    _matchTransaction: () => null,
    _isRootAdmin: async (email) => world.rootAdmin !== false && email === 'tony@al-en.com',
    _autoApplyAfterPoll: async () => ({ applied: 0, skipped: 0, candidates: 0 }),
    _findAutoApplyCandidate: (state, txn) => {
      const b = (state.buildings || [])[0], f = b && b.floors[0], u = f && f.units[0];
      if (!u || txn.amount !== 225000) return { eligible: false, reason: 'no-match' };
      return { eligible: true, candidate: { b, f, u, ym: '2026-09', rentCents: 225000, delta: 0 } };
    },
    _guessMethodFromDescServer: () => 'ach',
    _stateIfSyncV2: async () => (world.state.settings && world.state.settings.syncV2 ? world.state : null),
    _writePaymentV2: async (bId, fId, uId, ym, rec) => {
      if (world.failPaymentWrites) throw new Error('simulated ledger write failure');
      world.paymentsCol.set(`${bId}__${uId}__${ym}`, { buildingId: bId, floorId: fId, unitId: uId, ym, rec: clone(rec) });
    },
  };
  world.paymentsCol = new Map();
  // Under the simulated strip, payments live only in paymentsCol and every
  // read hydrates them into u.payments (prod: _mergePaymentsIntoBuildingsCF).
  world.hydrate = () => {
    const s = clone(world.state);
    if (!world.strip) return s;
    for (const b of s.buildings || []) for (const f of b.floors || []) for (const u of f.units || []) {
      for (const [key, doc] of world.paymentsCol) {
        if (key.startsWith(`${b.id}__${u.id}__`)) { u.payments = u.payments || {}; u.payments[doc.ym] = clone(doc.rec); }
      }
    }
    return s;
  };
  world.strip = false;
  world.failPaymentWrites = false;
  vm.createContext(ctx);
  const code = [
    liftConst('BANK_FEED_BACKFILL_DAYS'),
    liftConst('BANK_FEED_WATERMARK_SAFETY_DAYS'),
    liftFn('_bankAcctHealthFromStripe'),
    liftFn('_bankConnPollable'),
    liftFn('_bankSameAccountKind'),
    liftFn('_ledgerIsCollectionCF'),
    liftFn('_recHasStripeInvoice'),
    liftFn('_monthHasStripeInvoice'),
    liftFn('_writeAutoApplyLedgerV2'),
    'const DISCOUNT_REC_FIELDS = ' + /const DISCOUNT_REC_FIELDS = (\[[\s\S]*?\]);/.exec(SRC)[1] + ';',
    liftFn('_discountFieldsOf'),
    liftFn('_applyBankAcctStatus'),
    liftFn('_auditBankRelinkRequired'),
    liftFn('_bankFeedSinceUnix'),
    liftFn('_bankDedupeOf'),
    liftFn('_utcDay'),
    liftFn('_loadPrevAccountTxnIndex'),
    liftFn('_prevIdxTakeSameDay'),
    liftFn('_prevIdxNear'),
    liftFn('_ensureTransactionRefresh'),
    liftFn('_ensureFreshTransactions'),
    liftFn('_pullTransactionsForAccount'),
    liftFn('_markAccountPolled'),
    liftExport('pollBankTransactions'),
    liftExport('bankFeedScheduledPoll'),
    liftExport('syncBankConnections'),
    liftExport('finalizeBankConnection'),
    liftExport('undoAutoAppliedPayment'),
    liftExport('adoptBankFcAccount'),
    liftExport('attachStripeInvoiceToUnit'),
    liftFn('findUnit'),
    liftExport('disconnectBankAccount'),
  ].join('\n');
  vm.runInContext(code, ctx);
  // Real _autoApplyAfterPoll, lifted into its own sandbox entry so the
  // pollBankTransactions scenarios above keep the inert stub.
  vm.runInContext(liftFn('_autoApplyAfterPoll').replace(/^async function _autoApplyAfterPoll\(/, 'async function _realAutoApply('), ctx);
  world.autoApply = (fc) => vm.runInContext(`_realAutoApply(${JSON.stringify(fc)})`, ctx);
  world.fns = ctx.exports;
  world.ctx = ctx;
  world.conn = (id) => world.state.bankConnections.find(c => c.stripeFcAccountId === id);
  return world;
}

// ── fixtures mirroring the 2026-10-01 prod incident ─────────────────────
const FCA = 'fca_1TblcG2nq2bZh3q6pO5NTJaX';
const FCA_OLD = 'fca_1TSrMQ2nq2bZh3q6bnokrr8y';
const T_NOW = nowUnix();
const T_FAIL = T_NOW - 12 * DAY;            // last refresh attempt (failed) ≈ Sep 19
const T_NEWEST = T_NOW - 14 * DAY - 19 * 3600;  // newest cached txn = lastPolledAt − 14d 14h (Sep 17 00:00Z vs Oct 1 14:07Z)
const LAST_POLLED_ISO = new Date((T_NOW - 5 * 3600) * 1000).toISOString();  // today 14:07

function incidentConn(extra) {
  return {
    id: 'bc_' + FCA, stripeFcAccountId: FCA, status: 'active',
    institutionName: 'Capital One', accountLast4: '5709', displayName: 'Business Analyzed Checking',
    backfillCompleted: true, lastPolledAt: LAST_POLLED_ISO, lastPollScanned: 8, lastPollWritten: 0,
    connectedAt: '2026-05-22T00:48:57.744Z', reconnectedAt: '2026-05-27T17:51:47.648Z',
    ...(extra || {}),
  };
}
function inactiveAcct() {
  return {
    id: FCA, status: 'inactive', institution_name: 'Capital One', last4: '5709', _customer: 'cus_op',
    transaction_refresh: { id: 'fctxnref_x', last_attempted_at: T_FAIL, next_refresh_available_at: null, status: 'failed' },
  };
}
const cachedTxns = () => ({
  [FCA]: Array.from({ length: 8 }, (_, i) => ({ id: 'fctxn_old_' + i, transacted_at: T_NEWEST, amount: 1000 + i })),
});

(async () => {
  // ── 1. Inactive account: cron no longer "succeeds" on the stale cache ──
  {
    const w = makeWorld({ conns: [incidentConn()], accounts: { [FCA]: inactiveAcct() }, txns: cachedTxns() });
    // As in prod: the 8 cached txns are already in bankTransactions.
    for (const t of cachedTxns()[FCA]) w.docs.set(t.id, { id: t.id, accountId: FCA, amount: t.amount, transactedAt: t.transacted_at, matchState: 'unmatched' });
    // A deposit Stripe cached at its last succeeded refresh but we never
    // listed (e.g. refresh landed after the cron's list): must still arrive.
    w.txns[FCA].push({ id: 'fctxn_unlisted', transacted_at: T_FAIL - DAY, amount: 4242 });
    // Make it due: interval 1h so the cron picks it up.
    w.state.bankConnections[0].pollIntervalHours = 1;
    await w.fns.bankFeedScheduledPoll();
    const c = w.conn(FCA);
    eq(c.status, 'inactive', 'inactive: local status mirrors Stripe');
    eq(c.needsRelink, true, 'inactive: needsRelink set');
    ok(typeof c.relinkRequiredSince === 'string', 'inactive: relinkRequiredSince stamped');
    eq(c.lastPolledAt, LAST_POLLED_ISO, 'inactive: lastPolledAt NOT advanced');
    eq(c.freshThroughUnix, T_FAIL, 'inactive: freshThroughUnix anchored at min(lastPolledAt, failed refresh)');
    eq(c.lastRefreshStatus, 'failed', 'inactive: lastRefreshStatus recorded');
    ok(typeof c.lastPollAttemptAt === 'string', 'inactive: lastPollAttemptAt stamped');
    eq(w.listCalls.length, 1, 'inactive: Stripe cache still listed (no refresh)');
    eq(w.listCalls[0] && w.listCalls[0].transacted_at.gte, Math.floor(new Date(LAST_POLLED_ISO).getTime() / 1000) - 14 * DAY,
      'inactive: first detection lists with the pre-detection window');
    eq(w.refreshCalls.length, 0, 'inactive: no refresh() call (Stripe refuses it)');
    eq(w.audit.filter(a => a.action === 'bank.sync.relink_required').length, 1, 'inactive: one critical audit alert');
    eq(w.audit[0] && w.audit[0].severity, 'critical', 'inactive: audit severity critical');
    ok(w.docs.has('fctxn_unlisted'), 'inactive: cached-but-unlisted deposit still written (list without refresh)');

    // Second poll a moment later (manual Refresh now) — still inactive.
    const r = await w.fns.pollBankTransactions({ data: { stripeFcAccountId: FCA, manual: true } });
    eq(r.accounts[0].accountStatus, 'inactive', 'manual refresh on inactive: result carries accountStatus');
    eq(r.totalWritten, 0, 'manual refresh on inactive: nothing written');
    eq(w.audit.length, 1, 'inactive: no duplicate audit on repeat polls');
    eq(w.conn(FCA).lastPolledAt, LAST_POLLED_ISO, 'inactive: repeat poll still does not advance lastPolledAt');
    eq(w.conn(FCA).freshThroughUnix, T_FAIL, 'inactive: anchor stable across repeat polls');

    // Cron cadence: just attempted → not due again within the interval…
    w.refreshCalls.length = 0;
    w.state.bankConnections[0].pollIntervalHours = 24;
    const retrieveSpy = w.ctx.getStripe().financialConnections.accounts;
    let retrieves = 0;
    const origRetrieve = retrieveSpy.retrieve;
    retrieveSpy.retrieve = async (id) => { retrieves++; return origRetrieve(id); };
    await w.fns.bankFeedScheduledPoll();
    eq(retrieves, 0, 'cadence: needs-relink account paced by lastPollAttemptAt (not hourly)');
    // …but becomes due once the interval has passed since the last attempt
    // (lastPolledAt stays frozen even further back).
    w.state.bankConnections[0].lastPolledAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    w.state.bankConnections[0].lastPollAttemptAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await w.fns.bankFeedScheduledPoll();
    eq(retrieves, 1, 'cadence: re-checked after the interval');
    retrieveSpy.retrieve = origRetrieve;

    // ── 2. Recovery after a Stripe-hosted relink (same fca id) ──────────
    w.accounts[FCA].status = 'active';
    w.accounts[FCA].transaction_refresh = { id: 'fctxnref_relink', last_attempted_at: nowUnix() - 60, next_refresh_available_at: null, status: 'succeeded' };
    // Gap transactions Stripe now has: Sep 17 → today.
    for (let d = 13; d >= 0; d--) w.txns[FCA].push({ id: 'fctxn_gap_' + d, transacted_at: T_NOW - d * DAY, amount: 5000 + d });
    // A late-published txn dated just after the last fresh refresh — must be inside the window.
    w.txns[FCA].push({ id: 'fctxn_edge', transacted_at: T_FAIL - 13 * DAY, amount: 777 });
    w.listCalls.length = 0;
    const relinkRefreshAt = w.accounts[FCA].transaction_refresh.last_attempted_at;
    const frozenPolled = w.conn(FCA).lastPolledAt;
    const r2 = await w.fns.pollBankTransactions({ data: { stripeFcAccountId: FCA, manual: false } });
    const c2 = w.conn(FCA);
    eq(w.listCalls[0] && w.listCalls[0].transacted_at.gte, T_FAIL - 14 * DAY, 'recovery: window starts 14d before the freshness anchor');
    ok(r2.totalWritten >= 15, `recovery: gap + edge transactions written (got ${r2.totalWritten})`);
    ok(w.docs.has('fctxn_edge'), 'recovery: late-published txn inside the anchored window is captured');
    eq(c2.status, 'active', 'recovery: local status back to active');
    eq(c2.needsRelink, undefined, 'recovery: needsRelink cleared');
    eq(c2.relinkRequiredSince, undefined, 'recovery: relinkRequiredSince cleared');
    ok(c2.lastPolledAt !== frozenPolled, 'recovery: lastPolledAt advances again');
    eq(c2.freshThroughUnix, relinkRefreshAt,
      'recovery: freshThroughUnix = the succeeded refresh current when we listed (not the one just triggered)');

    // OLD behavior check (documents the bug): lastPolledAt − 14d would have
    // started AFTER the newest cached txn, skipping the start of the gap.
    const oldSince = Math.floor(new Date(LAST_POLLED_ISO).getTime() / 1000) - 14 * DAY;
    ok(oldSince > T_NEWEST, 'pre-fix window (lastPolledAt − 14d) had already slid past the newest cached txn');
  }

  // ── 3. Healthy account: freshThroughUnix from the pre-trigger refresh ──
  {
    const tPrev = T_NOW - 1 * DAY;
    const acct = { id: FCA, status: 'active', _customer: 'cus_op', institution_name: 'Capital One', last4: '5709',
      transaction_refresh: { id: 'r', last_attempted_at: tPrev, next_refresh_available_at: tPrev + 3600, status: 'succeeded' } };
    const conn = incidentConn({ lastPolledAt: new Date((T_NOW - 25 * 3600) * 1000).toISOString() });
    const w = makeWorld({ conns: [conn], accounts: { [FCA]: acct }, txns: { [FCA]: [{ id: 'fctxn_new', transacted_at: T_NOW - DAY, amount: 1 }] } });
    await w.fns.bankFeedScheduledPoll();
    const c = w.conn(FCA);
    eq(w.refreshCalls.length, 1, 'healthy: cron triggers a refresh');
    eq(c.freshThroughUnix, tPrev, 'healthy: freshThroughUnix = previous succeeded refresh (cache read before the new one lands)');
    eq(c.status, 'active', 'healthy: stays active');
    eq(c.needsRelink, undefined, 'healthy: no needsRelink');
    ok(w.docs.has('fctxn_new'), 'healthy: new txn written');
    eq(w.audit.length, 0, 'healthy: no audit alert');
    ok(c.lastPolledAt !== conn.lastPolledAt, 'healthy: lastPolledAt advances');
    // Next window = min(lastPolledAt, freshThroughUnix) − 14d.
    const since = w.ctx._bankFeedSinceUnix(c, Date.now(), false);
    eq(since, tPrev - 14 * DAY, 'healthy: next window anchored at freshThroughUnix − 14d');
  }

  // ── 4. Active account, refresh failed (transient) → anchor pinned ────
  {
    const acct = { id: FCA, status: 'active', _customer: 'cus_op', institution_name: 'Capital One', last4: '5709',
      transaction_refresh: { id: 'r', last_attempted_at: T_NOW - 3 * DAY, next_refresh_available_at: null, status: 'failed' } };
    const prevIso = new Date((T_NOW - 2 * DAY) * 1000).toISOString();
    const w = makeWorld({ conns: [incidentConn({ lastPolledAt: prevIso })], accounts: { [FCA]: acct }, txns: cachedTxns() });
    w.refreshCompletes = false;     // re-trigger stays pending; cron does not wait
    await w.fns.bankFeedScheduledPoll();
    const c = w.conn(FCA);
    eq(c.freshThroughUnix, Math.floor(new Date(prevIso).getTime() / 1000), 'transient failure: legacy record pinned at previous lastPolledAt');
    eq(c.needsRelink, undefined, 'transient failure: not flagged as relink (account still active)');
    eq(c.lastRefreshStatus, 'failed', 'transient failure: lastRefreshStatus recorded');
    // A second stale poll must not move the anchor forward.
    w.state.bankConnections[0].lastPolledAt = new Date((T_NOW - 25 * 3600) * 1000).toISOString();
    await w.fns.bankFeedScheduledPoll();
    eq(w.conn(FCA).freshThroughUnix, Math.floor(new Date(prevIso).getTime() / 1000), 'transient failure: anchor does not drift on later stale polls');
  }

  // ── 5. Fresh connection whose first refresh is preparing → still hourly ──
  {
    const acct = { id: FCA, status: 'active', _customer: 'cus_op', institution_name: 'Capital One', last4: '5709', transaction_refresh: null };
    const conn = incidentConn({ lastPolledAt: null, backfillCompleted: undefined, transactionRefreshStatus: 'pending', lastPollAttemptAt: new Date().toISOString() });
    const w = makeWorld({ conns: [conn], accounts: { [FCA]: acct }, txns: {} });
    let retrieves = 0;
    const a = w.ctx.getStripe().financialConnections.accounts;
    const orig = a.retrieve; a.retrieve = async (id) => { retrieves++; return orig(id); };
    await w.fns.bankFeedScheduledPoll();
    eq(retrieves, 1, 'never-polled healthy account is due regardless of lastPollAttemptAt');
  }

  // ── 6. syncBankConnections: no duplicate link of a tracked bank account ──
  {
    const accounts = {
      [FCA]: inactiveAcct(),
      [FCA_OLD]: { id: FCA_OLD, status: 'active', institution_name: 'Capital One', last4: '5709', _customer: 'cus_op',
        transaction_refresh: { status: 'succeeded', last_attempted_at: T_NOW - 150 * DAY } },
      fca_other: { id: 'fca_other', status: 'active', institution_name: 'Chase', last4: '1111', _customer: 'cus_op', transaction_refresh: null },
    };
    const w = makeWorld({ conns: [incidentConn()], accounts, txns: {} });
    const r = await w.fns.syncBankConnections({ auth: { token: { email: 'tony@al-en.com' } } });
    eq(w.state.bankConnections.map(c => c.stripeFcAccountId).sort(), [FCA, 'fca_other'].sort(),
      'sync: second Stripe object for ····5709 is NOT re-added; a genuinely new bank account is');
    eq(r.skippedDuplicates.map(d => d.id), [FCA_OLD], 'sync: skippedDuplicates reports the duplicate');
    eq(r.added, 1, 'sync: added counter survives the txn-retry simulation');
    const c = w.conn(FCA);
    eq(c.status, 'inactive', 'sync: Stripe status mirrored');
    eq(c.needsRelink, true, 'sync: needsRelink set from Stripe status');
    eq(c.freshThroughUnix, T_FAIL, 'sync: catch-up anchor set');
    eq(w.audit.filter(a => a.action === 'bank.sync.relink_required').length, 1, 'sync: one relink audit');
  }
  {
    // Locally disconnected record is terminal: Stripe 'inactive' does not revive it.
    const accounts = { [FCA]: inactiveAcct() };
    const w = makeWorld({ conns: [incidentConn({ status: 'disconnected', disconnectedAt: '2026-10-01T00:00:00Z' })], accounts, txns: {} });
    await w.fns.syncBankConnections({ auth: { token: { email: 'tony@al-en.com' } } });
    eq(w.conn(FCA).status, 'disconnected', 'sync: local disconnected stays disconnected');
    eq(w.conn(FCA).needsRelink, undefined, 'sync: no relink flag on a disconnected record');
    eq(w.audit.length, 0, 'sync: no relink audit for a disconnected record');
  }
  {
    // Same bank + last4 but a different account kind is NOT a duplicate.
    const accounts = {
      [FCA]: { ...inactiveAcct(), category: 'cash', subcategory: 'checking' },
      fca_sav: { id: 'fca_sav', status: 'active', institution_name: 'Capital One', last4: '5709', category: 'cash', subcategory: 'savings', _customer: 'cus_op' },
    };
    const w = makeWorld({ conns: [incidentConn({ accountCategory: 'cash', accountSubcategory: 'checking' })], accounts, txns: {} });
    const r = await w.fns.syncBankConnections({ auth: { token: { email: 'tony@al-en.com' } } });
    ok(!!w.conn('fca_sav'), 'sync: savings account with the same last4 is added (different kind)');
    eq(r.skippedDuplicates.length, 0, 'sync: not reported as duplicate');
  }

  // ── 7. finalizeBankConnection: inactive record is replaced, not duplicated ──
  {
    const NEW = 'fca_NEWLINK';
    const conn = incidentConn({ status: 'inactive', needsRelink: true, relinkRequiredSince: '2026-10-01T00:00:00Z', freshThroughUnix: T_FAIL });
    const w = makeWorld({ conns: [conn], accounts: {}, txns: {} });
    w.accounts[NEW] = { id: NEW, status: 'active', institution_name: 'Capital One', last4: '5709', _customer: 'cus_op' };
    const stripe = w.ctx.getStripe();
    stripe.financialConnections.sessions = {
      retrieve: async () => ({ accounts: { data: [clone(w.accounts[NEW])] } }),
    };
    const r = await w.fns.finalizeBankConnection({ data: { sessionId: 'fcsess_1' }, auth: { token: { email: 'tony@al-en.com' } } });
    eq(w.state.bankConnections.length, 1, 'finalize: no duplicate connection row');
    eq(r.connected, 0, 'finalize: nothing reported as new (client skips the 365-day backfill)');
    eq(r.reactivatedAccounts.map(a => a.stripeFcAccountId), [NEW], 'finalize: reactivated account returned for the catch-up poll');
    const c = w.conn(NEW);
    ok(!!c, 'finalize: record now points at the new fca id');
    eq(c && c.status, 'active', 'finalize: status active');
    eq(c && c.needsRelink, undefined, 'finalize: needsRelink cleared');
    eq(c && c.freshThroughUnix, T_FAIL, 'finalize: catch-up anchor kept');
    eq(c && c.backfillCompleted, true, 'finalize: stays incremental (no 365-day re-import)');
  }

  // ── 8. Auto-apply under buildings strip: the ledger write is durable ──
  {
    const mk = () => {
      const w = makeWorld({ conns: [], accounts: {}, txns: {} });
      w.strip = true;
      w.state.settings = { syncV2: true, syncBuildingsStrip: true };
      w.state.buildings = [{ id: 'b1778422024964', floors: [{ id: 'f1', units: [{ id: '106', tenant: 'Jason Riggs', rent: 2250, outreach: [] }] }] }];
      w.docs.set('fctxn_1U1JWT', { id: 'fctxn_1U1JWT', accountId: FCA, amount: 225000, description: 'Customer Deposit', transactedAt: T_NEWEST, matchState: 'unmatched' });
      return w;
    };
    // 8a. Happy path — the Suite 106 scenario of 2026-09-30.
    const w = mk();
    const r = await w.autoApply(FCA);
    const key = 'b1778422024964__106__2026-09';
    ok(w.paymentsCol.has(key), 'auto-apply: payment written to the payments collection (ledger)');
    eq(w.paymentsCol.get(key) && w.paymentsCol.get(key).rec.bankTxnId, 'fctxn_1U1JWT', 'auto-apply: ledger rec carries the bank txn id');
    eq(w.paymentsCol.get(key) && w.paymentsCol.get(key).rec.status, 'paid', 'auto-apply: ledger rec is paid');
    eq(w.docs.get('fctxn_1U1JWT').matchState, 'confirmed', 'auto-apply: bank txn confirmed after durable write');
    eq(r.applied, 1, 'auto-apply: applied counts durable writes');
    eq(r.ledgerWriteFailed, 0, 'auto-apply: no ledger failures');
    eq(w.audit.filter(a => a.action === 'payment.auto-applied').length, 1, 'auto-apply: one audit row');
    // Without the ledger write (pre-fix) the strip would have left nothing:
    const u106 = w.state.buildings[0].floors[0].units[0];
    eq(u106.payments, undefined, 'strip sim: monolith/building copy holds no u.payments (ledger is the only store)');

    // 8b. Ledger write fails → txn NOT confirmed, no audit, retry next poll succeeds once.
    const w2 = mk();
    w2.failPaymentWrites = true;
    const r2 = await w2.autoApply(FCA);
    eq(w2.docs.get('fctxn_1U1JWT').matchState, 'unmatched', 'ledger failure: bank txn left unconfirmed (retryable)');
    eq(w2.audit.filter(a => a.action === 'payment.auto-applied').length, 0, 'ledger failure: no auto-applied audit');
    eq(r2.applied, 0, 'ledger failure: applied=0');
    eq(r2.ledgerWriteFailed, 1, 'ledger failure: reported');
    w2.failPaymentWrites = false;
    const r3 = await w2.autoApply(FCA);
    ok(w2.paymentsCol.has(key), 'retry: ledger written on the next poll');
    eq(w2.docs.get('fctxn_1U1JWT').matchState, 'confirmed', 'retry: bank txn confirmed');
    eq(r3.applied, 1, 'retry: applied once');
    const outreach = w2.state.buildings[0].floors[0].units[0].outreach || [];
    eq(outreach.filter(e => e.bankTxnId === 'fctxn_1U1JWT').length, 1, 'retry: outreach entry not duplicated');

    // 8c. Heal: ledger already holds this txn's rec (confirm batch never landed).
    const w3 = mk();
    w3.paymentsCol.set(key, { ym: '2026-09', rec: { status: 'paid', amount: 2250, bankTxnId: 'fctxn_1U1JWT', autoApplied: true, autoMatchRentCents: 225000, autoMatchDeltaCents: 0 } });
    const r4 = await w3.autoApply(FCA);
    eq(w3.docs.get('fctxn_1U1JWT').matchState, 'confirmed', 'heal: txn confirmed');
    eq(r4.healed, 1, 'heal: reported');
    eq([...w3.paymentsCol.keys()], [key], 'heal: no second ledger rec (no other month)');
    eq(w3.audit.filter(a => a.action === 'payment.auto-applied').length, 1, 'heal: exactly one audit row');

    // 8d. Undone by the operator (autoApplied:false) → never re-applied.
    const w4 = mk();
    w4.docs.get('fctxn_1U1JWT').autoApplied = false;
    w4.docs.get('fctxn_1U1JWT').matchState = 'suggested';
    await w4.autoApply(FCA);
    eq(w4.paymentsCol.size, 0, 'undo: not re-applied');
    eq(w4.docs.get('fctxn_1U1JWT').matchState, 'suggested', 'undo: stays a manual suggestion');

    // 8e. Ledger gate does not fail open: strip on, syncV2 off → still written.
    const w5 = mk();
    w5.state.settings = { syncBuildingsStrip: true };
    await w5.autoApply(FCA);
    ok(w5.paymentsCol.has(key), 'gate: strip alone requires the ledger write');

    // 8f. Race: another source records the month paid between peek and write → refused.
    const w6 = mk();
    w6.injectConflictKey = key;
    const r6 = await w6.autoApply(FCA);
    eq(w6.paymentsCol.get(key).rec.stripe && w6.paymentsCol.get(key).rec.stripe.invoiceId, 'in_race', 'race: other source rec not overwritten');
    eq(w6.docs.get('fctxn_1U1JWT').matchState, 'unmatched', 'race: txn left for manual review');
    eq(r6.ledgerWriteFailed, 1, 'race: reported');
    const out6 = w6.state.buildings[0].floors[0].units[0].outreach || [];
    eq(out6.filter(e => e.bankTxnId === 'fctxn_1U1JWT').length, 0, 'race: false «auto-applied» outreach removed');

    // 8g. Month tied to a Stripe invoice → skipped (needs a human).
    const w7 = mk();
    w7.paymentsCol.set(key, { ym: '2026-09', rec: { status: 'late', amount: 0, stripe: { invoiceId: 'in_late' } } });
    await w7.autoApply(FCA);
    eq(w7.paymentsCol.get(key).rec.stripe.invoiceId, 'in_late', 'stripe-linked: rec untouched');
    eq(w7.docs.get('fctxn_1U1JWT').matchState, 'unmatched', 'stripe-linked: txn not confirmed');

    // 8g2. Invoice already issued for the month (u.stripe stamp, no ledger rec
    // yet) → skipped. Live case: Suite 442, October, 2026-10-01.
    const w7b = mk();
    w7b.state.buildings[0].floors[0].units[0].stripe = { autoSentYm: '2026-09', lastInvoiceYm: '2026-09' };
    await w7b.autoApply(FCA);
    ok(!w7b.paymentsCol.has(key), 'invoice issued: month not auto-applied');
    eq(w7b.docs.get('fctxn_1U1JWT').matchState, 'unmatched', 'invoice issued: txn left for a human');

    // 8h. Prior non-paid rec: discount fields kept, prior state in history.
    const w8 = mk();
    w8.paymentsCol.set(key, { ym: '2026-09', rec: { status: 'pending', amount: 0, wasDiscounted: true, discountAmount: 50, originalAmount: 2300 } });
    await w8.autoApply(FCA);
    const rec8 = w8.paymentsCol.get(key).rec;
    eq([rec8.status, rec8.wasDiscounted, rec8.discountAmount, rec8.originalAmount], ['paid', true, 50, 2300], 'prior rec: discount fields carried over');
    eq(rec8.history && rec8.history[0] && rec8.history[0].status, 'pending', 'prior rec: previous state in history');
  }

  // ── 9. Undo: ledger delete first, loud on failure ──────────────────
  {
    const mkU = () => {
      const w = makeWorld({ conns: [], accounts: {}, txns: {} });
      w.strip = true;
      w.state.settings = { syncV2: true, syncBuildingsStrip: true };
      w.state.buildings = [{ id: 'b1', floors: [{ id: 'f1', units: [{ id: '106' }] }] }];
      w.paymentsCol.set('b1__106__2026-09', { ym: '2026-09', rec: { status: 'paid', amount: 2250, bankTxnId: 'fctxn_U', autoApplied: true } });
      w.docs.set('fctxn_U', { id: 'fctxn_U', matchState: 'confirmed', autoApplied: true });
      return w;
    };
    const req = { auth: {}, data: { buildingId: 'b1', floorId: 'f1', unitId: '106', ym: '2026-09' } };
    const w = mkU();
    w.failBatches = true;
    let threw = false;
    try { await w.fns.undoAutoAppliedPayment(req); } catch (e) { threw = true; }
    ok(threw, 'undo: ledger delete failure surfaces as an error');
    eq(w.docs.get('fctxn_U').matchState, 'confirmed', 'undo failure: txn NOT released (ledger and txn stay consistent)');
    ok(w.paymentsCol.has('b1__106__2026-09'), 'undo failure: ledger rec still there');
    eq(w.audit.filter(a => a.action === 'payment.auto-applied.undo').length, 0, 'undo failure: no undo audit');
    w.failBatches = false;
    const r = await w.fns.undoAutoAppliedPayment(req);
    eq(r.undone, true, 'undo retry: undone');
    ok(!w.paymentsCol.has('b1__106__2026-09'), 'undo retry: ledger rec removed');
    eq([w.docs.get('fctxn_U').matchState, w.docs.get('fctxn_U').autoApplied], ['suggested', false], 'undo retry: txn back to suggestions, flagged undone');
    eq(w.audit.filter(a => a.action === 'payment.auto-applied.undo').length, 1, 'undo retry: one undo audit');
  }

  // ── 10. Heal races (hardening verify) ──────────────────────────────
  {
    const key = 'b1778422024964__106__2026-09';
    const mkH = (rec) => {
      const w = makeWorld({ conns: [], accounts: {}, txns: {} });
      w.strip = true;
      w.state.settings = { syncV2: true, syncBuildingsStrip: true };
      w.state.buildings = [{ id: 'b1778422024964', floors: [{ id: 'f1', units: [{ id: '106', outreach: [] }] }] }];
      w.docs.set('fctxn_H', { id: 'fctxn_H', accountId: FCA, amount: 1, description: 'X', transactedAt: T_NEWEST, matchState: 'unmatched' });
      w.paymentsCol.set(key, { ym: '2026-09', rec });
      return w;
    };
    // Non-paid rec referencing the txn → no heal.
    const w1 = mkH({ status: 'late', amount: 2250, bankTxnId: 'fctxn_H', autoApplied: true });
    await w1.autoApply(FCA);
    eq(w1.docs.get('fctxn_H').matchState, 'unmatched', 'heal: non-paid rec does not confirm the txn');
    // Ledger doc deleted mid-poll (undo/delete raced) → not re-written, not confirmed.
    const w2 = mkH({ status: 'paid', amount: 2250, bankTxnId: 'fctxn_H', autoApplied: true });
    w2.beforeTx = async () => { w2.paymentsCol.delete(key); };
    await w2.autoApply(FCA);
    ok(!w2.paymentsCol.has(key), 'heal race: deleted rec NOT resurrected from the snapshot');
    eq(w2.docs.get('fctxn_H').matchState, 'unmatched', 'heal race: txn not confirmed');
    // Txn undone mid-poll (autoApplied:false lands before the heal tx) → not confirmed.
    const w3 = mkH({ status: 'paid', amount: 2250, bankTxnId: 'fctxn_H', autoApplied: true });
    w3.beforeTx = async () => { Object.assign(w3.docs.get('fctxn_H'), { matchState: 'suggested', autoApplied: false }); };
    await w3.autoApply(FCA);
    eq([w3.docs.get('fctxn_H').matchState, w3.docs.get('fctxn_H').autoApplied], ['suggested', false], 'heal race: undo wins');
    // Ledger tx: a fresh Stripe-linked rec written between peek and write → conflict.
    const w4 = makeWorld({ conns: [], accounts: {}, txns: {} });
    w4.strip = true;
    w4.state.settings = { syncV2: true, syncBuildingsStrip: true };
    w4.state.buildings = [{ id: 'b1778422024964', floors: [{ id: 'f1', units: [{ id: '106', outreach: [] }] }] }];
    w4.docs.set('fctxn_1U1JWT', { id: 'fctxn_1U1JWT', accountId: FCA, amount: 225000, description: 'Customer Deposit', transactedAt: T_NEWEST, matchState: 'unmatched' });
    w4.beforeTx = async () => { w4.paymentsCol.set(key, { ym: '2026-09', rec: { status: 'late', amount: 0, stripe: { invoiceId: 'in_new' } } }); };
    const r4 = await w4.autoApply(FCA);
    eq(w4.paymentsCol.get(key).rec.stripe.invoiceId, 'in_new', 'ledger tx: fresh Stripe-linked rec not overwritten');
    eq(r4.ledgerWriteFailed, 1, 'ledger tx: refused write reported');
  }

  // ── 11. Adopt the other app's shared FC account (Entry 82) ─────────
  // Real conventions (kiwi's cached Stripe data 2026-09-25): the old FC
  // object dates movements at 00:00Z, the adopted one at 12:00Z.
  {
    const KIWI = 'fca_1UIeYE2nq2bZh3q62ntKHdfX';
    const D0 = Math.floor((T_NOW - 14 * DAY) / DAY) * DAY;     // old newest stored day, 00:00Z
    const mkA = (kiwiOver) => {
      const conn = incidentConn({ status: 'inactive', needsRelink: true, relinkRequiredSince: '2026-10-01T19:56:34Z',
        freshThroughUnix: T_FAIL, accountCategory: 'cash', accountSubcategory: 'checking' });
      const kiwi = { id: KIWI, status: 'active', institution_name: 'Capital One', last4: '5709', category: 'cash', subcategory: 'checking',
        account_holder: { type: 'account' }, permissions: ['payment_method', 'transactions', 'balances'],
        transaction_refresh: { id: 'r', status: 'succeeded', last_attempted_at: T_NOW - 3600, next_refresh_available_at: T_NOW + 3600 },
        ...(kiwiOver || {}) };
      const w = makeWorld({ conns: [conn], accounts: { [FCA]: { ...inactiveAcct(), account_holder: { type: 'customer' } }, [KIWI]: kiwi }, txns: {} });
      // Stored history under the old account (00:00Z).
      for (let i = 0; i < 8; i++) w.docs.set('old_' + i, { id: 'old_' + i, accountId: FCA, amount: 1000 + i, transactedAt: D0, status: 'posted', matchState: 'unmatched' });
      w.docs.set('old_pending', { id: 'old_pending', accountId: FCA, amount: 555, transactedAt: D0 - DAY, status: 'pending', matchState: 'unmatched' });
      w.docs.set('old_confirmed', { id: 'old_confirmed', accountId: FCA, amount: 220000, transactedAt: D0 - 3 * DAY, status: 'posted', matchState: 'confirmed' });
      w.docs.set('old_shift', { id: 'old_shift', accountId: FCA, amount: 99900, transactedAt: D0 - 5 * DAY, status: 'pending', matchState: 'unmatched' });
      w.docs.set('old_lone', { id: 'old_lone', accountId: FCA, amount: 330000, transactedAt: D0 - 2 * DAY, status: 'posted', matchState: 'confirmed' });
      // The same movements under the shared account (12:00Z, new ids) + new ones.
      const kt = [];
      for (let i = 0; i < 8; i++) kt.push({ id: 'k_old_' + i, transacted_at: D0 + 12 * 3600, amount: 1000 + i, status: 'posted' });
      kt.push({ id: 'k_pending_posted', transacted_at: D0 - DAY + 12 * 3600, amount: 555, status: 'posted' });  // same day, now posted
      kt.push({ id: 'k_confirmed_copy', transacted_at: D0 - 3 * DAY + 12 * 3600, amount: 220000, status: 'posted' });
      kt.push({ id: 'k_shift_copy', transacted_at: D0 - 4 * DAY + 12 * 3600, amount: 99900, status: 'posted' });   // dated a day later
      kt.push({ id: 'k_second_1000', transacted_at: D0 + 12 * 3600, amount: 1000, status: 'posted' });           // genuine 2nd deposit
      kt.push({ id: 'k_day_before_220000', transacted_at: D0 - 4 * DAY + 12 * 3600, amount: 220000, status: 'posted' }); // genuine, other day
      kt.push({ id: 'k_lone_near', transacted_at: D0 - DAY + 12 * 3600, amount: 330000, status: 'posted' });  // ambiguous: same amount, 1 day off
      for (let d = 13; d >= 0; d--) kt.push({ id: 'k_gap_' + d, transacted_at: Math.floor((T_NOW - d * DAY) / DAY) * DAY + 12 * 3600, amount: 7000 + d, status: 'posted' });
      w.txns[KIWI] = kt;
      return w;
    };
    const auth = { auth: { token: { email: 'tony@al-en.com' } } };
    for (const [label, over] of [
      ['inactive target', { status: 'inactive' }],
      ['no transactions permission', { permissions: ['payment_method', 'balances'] }],
      ['different last4', { last4: '1305' }],
      ['different account kind', { subcategory: 'savings' }],
    ]) {
      const w = mkA(over);
      let threw = false;
      try { await w.fns.adoptBankFcAccount({ ...auth, data: { fromFcAccountId: FCA, toFcAccountId: KIWI } }); } catch (e) { threw = true; }
      ok(threw && w.conn(FCA), `adopt guard: ${label} → refused, record untouched`);
    }
    {
      const w = mkA();
      w.rootAdmin = false;
      let threw = false;
      try { await w.fns.adoptBankFcAccount({ ...auth, data: { fromFcAccountId: FCA, toFcAccountId: KIWI } }); } catch (e) { threw = true; }
      ok(threw, 'adopt guard: root admin only');
    }
    const w = mkA();
    const r = await w.fns.adoptBankFcAccount({ ...auth, data: { fromFcAccountId: FCA, toFcAccountId: KIWI } });
    eq(r.adopted, true, 'adopt: ok');
    const c = w.conn(KIWI);
    ok(!!c && !w.conn(FCA), 'adopt: record now reads the shared account');
    eq([c.status, c.needsRelink, c.sharedConnection, c.holderType], ['active', undefined, true, 'account'], 'adopt: active, shared, holder=account');
    eq([c.freshThroughUnix, c.dedupeAgainstFcId, c.dedupeUntilUnix, c.adoptedHorizonUnix, c.supersededFcIds],
      [T_FAIL, FCA, D0, D0, [FCA]], 'adopt: anchor kept; dedupe horizon, permanent horizon, superseded id');
    eq(w.audit.filter(a => a.action === 'bank.connection.adopted').length, 1, 'adopt: audited');
    w.listCalls.length = 0;
    const p1 = await w.fns.pollBankTransactions({ data: { stripeFcAccountId: KIWI, manual: false } });
    const a1 = p1.accounts[0];
    eq(w.listCalls[0] && w.listCalls[0].transacted_at.gte, T_FAIL - 14 * DAY, 'adopt poll: window from the anchor');
    eq(a1.dedupSkipped, 10, 'adopt poll: 00:00Z vs 12:00Z copies matched by UTC day (8 + pending→posted + confirmed)');
    eq(a1.dedupHeld, 2, 'adopt poll: near-misses (shifted copy, ambiguous same-amount ±1d) kept but held');
    eq(a1.written, 18, 'adopt poll: gap (14) + 2nd $10.00 + shifted copy + other-day $2,200 + ambiguous $3,300 written');
    eq(w.docs.get('k_lone_near').autoApplied, false, 'adopt poll: ambiguous one held out of auto-apply');
    ok(w.docs.has('k_second_1000') && w.docs.has('k_gap_0') && w.docs.has('k_day_before_220000'), 'adopt poll: genuine txns stored (nothing silently dropped)');
    eq([w.docs.get('k_shift_copy').autoApplied, w.docs.get('k_shift_copy').dedupeSuspect], [false, true], 'adopt poll: shifted copy held out of auto-apply');
    ok(!w.docs.has('k_old_0') && !w.docs.has('k_confirmed_copy'), 'adopt poll: exact copies not stored');
    eq(w.docs.get('old_pending').status, 'posted', 'adopt poll: stale pending doc reconciled to posted');
    eq(w.docs.get('old_confirmed').matchState, 'confirmed', 'adopt poll: old decisions untouched');
    ok(!!w.conn(KIWI).dedupeAgainstFcId, 'adopt poll: dedupe kept for a week past the horizon');
    // Auto-apply guard: a copy that slipped through ingestion is never booked.
    w.docs.set('k_slipped', { id: 'k_slipped', accountId: KIWI, amount: 1003, transactedAt: D0 + 13 * 3600, matchState: 'unmatched' });
    let finderCalls = 0;
    const origFinder = w.ctx._findAutoApplyCandidate;
    w.ctx._findAutoApplyCandidate = (st, txn) => { if (txn.id === 'k_slipped') finderCalls++; return origFinder(st, txn); };
    w.state.buildings = [{ id: 'b1', floors: [{ id: 'f1', units: [{ id: 'u1' }] }] }];
    await w.autoApply(KIWI);
    eq(finderCalls, 0, 'auto-apply guard: look-alike of stored history never reaches the finder');
    // Shared lifecycle.
    await w.fns.disconnectBankAccount({ ...auth, data: { stripeFcAccountId: KIWI } });
    eq(w.disconnectCalls || 0, 0, 'shared disconnect: Stripe detach NOT called (holder = account)');
    eq(w.accounts[KIWI].status, 'active', 'shared disconnect: other app keeps its feed');
    eq(w.conn(KIWI).status, 'disconnected', 'shared disconnect: dropped locally');
    const sy = await w.fns.syncBankConnections(auth);
    ok(!w.conn(FCA), 'sync after shared disconnect: superseded fca_1TblcG NOT re-added');
    ok(sy.skippedDuplicates.some(d => d.id === FCA), 'sync: superseded id reported as skipped');
    const rs = await w.fns.adoptBankFcAccount({ ...auth, data: { fromFcAccountId: KIWI, toFcAccountId: KIWI } });
    eq([rs.resumed, w.conn(KIWI).status], [true, 'active'], 'resume: shared record reactivated without a new link');
  }
  {
    // Own (customer-held) account: Disconnect still detaches at Stripe.
    const w = makeWorld({ conns: [incidentConn({ status: 'active' })], accounts: { [FCA]: { ...inactiveAcct(), status: 'active', account_holder: { type: 'customer' } } }, txns: {} });
    await w.fns.disconnectBankAccount({ auth: { token: { email: 'tony@al-en.com' } }, data: { stripeFcAccountId: FCA } });
    eq(w.disconnectCalls || 0, 1, 'own disconnect: detached at Stripe');
  }

  // ── 12. Attach a hand-made Stripe invoice to a unit (Entry 84) ─────
  {
    const mkI = (invOver, custOver, unitOver) => {
      const w = makeWorld({ conns: [], accounts: {}, txns: {} });
      w.state.buildings = [{ id: 'b1', floors: [{ id: 'f1-3', units: [{ id: '360', tenant: 'Alexander Hardman', email: 'alexanderjhardman@gmail.com', deposit: 500, stripe: { customerId: 'cus_OLD' }, ...(unitOver || {}) }] }] }];
      const inv = { id: 'in_ZAR', number: 'ZAR5KJDC-0001', status: 'open', amount_due: 50000, customer: 'cus_ALEX', metadata: {}, hosted_invoice_url: 'https://invoice.stripe.com/i/x', ...(invOver || {}) };
      const cust = { id: 'cus_ALEX', email: 'alexanderjhardman@gmail.com', metadata: {}, ...(custOver || {}) };
      w.invUpdates = []; w.custUpdates = [];
      const st = w.ctx.getStripe();
      st.invoices = {
        search: async ({ query }) => ({ data: query.includes(inv.number) ? [clone(inv)] : [] }),
        retrieve: async (id) => clone(inv),
        update: async (id, p) => { w.invUpdates.push(p); Object.assign(inv, p); return clone(inv); },
      };
      st.customers = {
        retrieve: async () => clone(cust),
        update: async (id, p) => { w.custUpdates.push(p); Object.assign(cust, p); return clone(cust); },
      };
      return w;
    };
    const req = (over) => ({ auth: { token: { email: 'tony@al-en.com' } }, data: { invoiceNumber: 'ZAR5KJDC-0001', buildingId: 'b1', floorId: 'f1-3', unitId: '360', purpose: 'deposit', ...(over || {}) } });
    for (const [label, invO, custO, unitO] of [
      ['already paid', { status: 'paid' }],
      ['another app (source=kiwi)', { metadata: { source: 'kiwi' } }],
      ['attached elsewhere', { metadata: { unitId: '323', buildingId: 'b1' } }],
      ['customer email ≠ tenant email', null, { email: 'someone@else.com' }],
      ['amount ≠ deposit', { amount_due: 65000 }],
      ['customer of another workspace', null, { metadata: { workspaceId: 'other' } }],
    ]) {
      const w = mkI(invO, custO, unitO);
      let threw = false;
      try { await w.fns.attachStripeInvoiceToUnit(req()); } catch (e) { threw = true; }
      ok(threw && w.invUpdates.length === 0 && w.custUpdates.length === 0, `attach guard: ${label} → refused, nothing written`);
    }
    const w = mkI();
    const r = await w.fns.attachStripeInvoiceToUnit(req());
    eq([r.invoiceId, r.customerTagged], ['in_ZAR', true], 'attach: ok');
    const m = w.invUpdates[0].metadata;
    eq([m.source, m.workspaceId, m.buildingId, m.floorId, m.unitId, m.purpose], ['suitesforall', 'default', 'b1', 'f1-3', '360', 'deposit'], 'attach: invoice carries the routing metadata the webhook needs');
    eq(w.custUpdates[0].metadata.workspaceId, 'default', 'attach: customer becomes trusted for this workspace');
    const di = w.state.buildings[0].floors[0].units[0].stripe.depositInvoice;
    eq([di.invoiceId, di.status, di.amount, di.number], ['in_ZAR', 'open', 500, 'ZAR5KJDC-0001'], 'attach: unit deposit stamp → open (webhook matches it by id)');
    eq(w.audit.filter(a => a.action === 'stripe.invoice.attached').length, 1, 'attach: audited');
  }

  console.log(`bank-feed.test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
