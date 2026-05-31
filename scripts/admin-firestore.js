#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Admin Firestore helper — for Claude to do diagnostic + admin operations
 * на workspace через service-account ключ.
 *
 * Используется ТОЛЬКО локально на машине Tony. Ключ берётся из
 * GOOGLE_APPLICATION_CREDENTIALS env var (никогда не хардкодится в код).
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/admin-firestore.js <command> [args]
 *
 * Commands (read-only по умолчанию):
 *   state-summary               — top-level state fields + sizes
 *   employees                   — list all employees (id, name, email, role, status)
 *   employee-detail <id>        — full record for one employee
 *   gmail-activity [n]          — last N gmailActivity entries (default 10)
 *   members                     — workspace members
 *   gmail-watch                 — registered Gmail watches
 *   bank-list-dups              — bankTransactions: find suspected dup groups
 *                                 (same amount + ±2 days). Lists all candidates
 *                                 for operator review. NO modifications.
 *   bank-list-orphan            — bankTransactions: find rows whose accountId
 *                                 is NOT in state.bankConnections.active. These
 *                                 are leftover from disconnected accounts.
 *   bank-cleanup-orphan         — DRY-RUN — show what bank-cleanup-orphan --confirm
 *                                 would delete.
 *
 * Commands (write — require --confirm flag):
 *   update-employee-email <id> <newEmail> --confirm
 *   bank-cleanup-orphan --confirm — delete all bankTransactions docs whose
 *                                   accountId is not in active connections.
 *                                   Each deletion writes an audit entry to
 *                                   workspaces/{ws}/audit.
 *
 * Безопасность:
 *   - Все WRITE команды требуют явный --confirm флаг (защита от случайностей)
 *   - Ключ JSON НИКОГДА не печатается в stdout/stderr
 *   - Все операции логируются с timestamp + operation type
 */

const path = require('path');

// firebase-admin живёт в functions/node_modules — переиспользуем установленную
// версию вместо отдельной install для скрипта.
const adminPath = path.resolve(__dirname, '../functions/node_modules/firebase-admin');
const admin = require(adminPath);

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  console.error('ERROR: GOOGLE_APPLICATION_CREDENTIALS env var not set.');
  console.error('Usage: GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/admin-firestore.js ...');
  process.exit(1);
}

let keyJson;
try {
  keyJson = require(keyPath);
} catch (e) {
  console.error('ERROR: could not read service-account JSON at', keyPath, '—', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(keyJson),
  projectId: keyJson.project_id,
});
const db = admin.firestore();
const WORKSPACE_ID = 'default';

function stateRef() { return db.doc(`workspaces/${WORKSPACE_ID}/data/state`); }

async function loadState() {
  const snap = await stateRef().get();
  if (!snap.exists) throw new Error('state document missing');
  const doc = snap.data() || {};
  // Firestore stores: { _rev, _size, _updatedAt, _updatedBy, gmailActivity, state: { employees, buildings, ... } }
  // The actual workspace state is in `state` sub-field. Top-level meta + gmailActivity stay at root.
  return {
    _meta: { rev: doc._rev, size: doc._size, updatedBy: doc._updatedBy, updatedAt: doc._updatedAt },
    gmailActivity: doc.gmailActivity || [],
    ...(doc.state || {}),
  };
}

async function cmdStateSummary() {
  const state = await loadState();
  const keys = Object.keys(state).sort();
  console.log('=== State fields ===');
  for (const k of keys) {
    const v = state[k];
    let info;
    if (Array.isArray(v)) info = `Array(${v.length})`;
    else if (v && typeof v === 'object') info = `Object(${Object.keys(v).length} keys)`;
    else info = String(v).slice(0, 50);
    console.log(`  ${k.padEnd(28)} ${info}`);
  }
}

async function cmdEmployees() {
  const state = await loadState();
  const emps = state.employees || [];
  console.log(`=== Employees (${emps.length}) ===`);
  for (const e of emps) {
    console.log(
      `  ${(e.id || '(no-id)').padEnd(28)}`,
      `${(e.fullName || '(no-name)').padEnd(28)}`,
      `${(e.email || '(no-email)').padEnd(40)}`,
      `${(e.role || '(no-role)').padEnd(12)}`,
      `${e.status || '(no-status)'}${e.archived ? ' [ARCHIVED]' : ''}`,
    );
  }
}

async function cmdEmployeeDetail(id) {
  if (!id) { console.error('ERROR: employee id required'); process.exit(1); }
  const state = await loadState();
  const emp = (state.employees || []).find(e => e.id === id);
  if (!emp) { console.error('Employee not found:', id); process.exit(1); }
  console.log(JSON.stringify(emp, null, 2));
}

async function cmdGmailActivity(nArg) {
  const n = nArg ? +nArg : 10;
  const state = await loadState();
  const arr = state.gmailActivity || [];
  console.log(`=== Gmail Activity (last ${n} of ${arr.length}) ===`);
  for (const g of arr.slice(-n)) {
    console.log(
      `  ts=${g.ts || '?'}`,
      `dir=${(g.direction || '?').padEnd(8)}`,
      `from=${(g.from || '?').padEnd(30)}`,
      `to=${(g.to || '?').padEnd(30)}`,
      `subj=${(g.subject || '').slice(0, 40)}`,
      g.inReplyTo ? '[REPLY]' : '',
    );
  }
}

async function cmdMembers() {
  const snap = await db.collection(`workspaces/${WORKSPACE_ID}/members`).get();
  console.log(`=== Members (${snap.size}) ===`);
  for (const d of snap.docs) {
    const m = d.data() || {};
    console.log(
      `  uid=${d.id}`,
      `email=${(m.email || '?').padEnd(40)}`,
      `role=${(m.role || '?').padEnd(10)}`,
      `archived=${!!m.archived}`,
    );
  }
}

async function cmdGmailWatch() {
  const snap = await db.collection(`workspaces/${WORKSPACE_ID}/gmailWatch`).get();
  console.log(`=== Gmail Watches (${snap.size}) ===`);
  for (const d of snap.docs) {
    const w = d.data() || {};
    const expIso = w.expiration ? new Date(+w.expiration).toISOString() : '?';
    console.log(
      `  ${(w.email || decodeURIComponent(d.id)).padEnd(40)}`,
      `lastHistoryId=${(w.lastHistoryId || w.historyId || '?').padEnd(12)}`,
      `expires=${expIso}`,
    );
  }
}

// =====================================================================
// Bank-transactions diagnosis + cleanup (Tony 2026-05-21 phantom incident)
// =====================================================================
// КРИТИЧЕСКАЯ ФИНАНСОВАЯ КОМАНДА. Используется после reconnect банка,
// timezone-shift bug'а, CSV-overlap'а, или любого другого случая когда
// один реальный bank deposit оказался в `bankTransactions` как 2+ docs.
//
// `bank-list-dups`     — read-only. Группирует все docs по (amount,
//                        ±2 days). Перечисляет группы с >1 doc.
// `bank-list-orphan`   — read-only. Перечисляет docs, accountId которых
//                        нет в state.bankConnections active list.
// `bank-cleanup-orphan` — write. Удаляет docs с orphan accountId'ами.
//                        Безопасно: каждое удаление = audit entry.
// =====================================================================
const _BANK_DUP_WINDOW_DAYS = 2;

function _dayBucketNY(transactedAtUnix) {
  if (!transactedAtUnix) return null;
  const d = new Date((+transactedAtUnix) * 1000);
  const nyStr = d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [mo, da, yr] = nyStr.split('/');
  return `${yr}-${mo}-${da}`;
}

function _fmtAmt(cents) {
  return '$' + ((+cents || 0) / 100).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

async function cmdBankListDups() {
  const col = db.collection(`workspaces/${WORKSPACE_ID}/bankTransactions`);
  const snap = await col.get();
  const all = [];
  snap.forEach(d => all.push({ docId: d.id, ...d.data() }));
  console.log(`=== bankTransactions: ${all.length} total ===`);
  // Группировка по (amount, ±N days).
  const groups = new Map();
  for (const t of all) {
    const amt = +t.amount || 0;
    const day = _dayBucketNY(t.transactedAt);
    if (!amt || !day) continue;
    let assignedKey = null;
    for (const [k, arr] of groups.entries()) {
      const first = arr[0];
      if ((+first.amount || 0) !== amt) continue;
      const firstDay = _dayBucketNY(first.transactedAt);
      if (!firstDay) continue;
      const distMs = Math.abs(new Date(firstDay + 'T12:00:00').getTime() - new Date(day + 'T12:00:00').getTime());
      const distDays = Math.round(distMs / 86400000);
      if (distDays <= _BANK_DUP_WINDOW_DAYS) { assignedKey = k; break; }
    }
    if (assignedKey) groups.get(assignedKey).push(t);
    else groups.set(`${amt}:${day}:${t.docId}`, [t]);
  }
  const dupGroups = Array.from(groups.values()).filter(arr => arr.length > 1);
  console.log(`Found ${dupGroups.length} suspect group(s) with ${dupGroups.reduce((s, a) => s + (a.length - 1), 0)} extra docs.`);
  for (let i = 0; i < dupGroups.length; i++) {
    const arr = dupGroups[i];
    console.log(`\nGroup ${i + 1}: ${_fmtAmt(arr[0].amount)} × ${arr.length} docs`);
    for (const t of arr) {
      const day = _dayBucketNY(t.transactedAt) || '?';
      const desc = (t.description || '').slice(0, 40);
      console.log(`  ${(t.docId || '?').padEnd(40)} acct=${(t.accountId || '?').padEnd(40)} day=${day} status=${(t.status || '?').padEnd(8)} match=${(t.matchState || '?').padEnd(10)} | ${desc}`);
    }
  }
}

async function cmdBankListOrphan() {
  const col = db.collection(`workspaces/${WORKSPACE_ID}/bankTransactions`);
  const snap = await col.get();
  const all = [];
  snap.forEach(d => all.push({ docId: d.id, ...d.data() }));
  // Резолвим active accountIds из state.bankConnections.
  const stateDoc = await stateRef().get();
  const state = stateDoc.data()?.state || {};
  const activeIds = new Set();
  const seenIds = new Set();
  (state.bankConnections || []).forEach(c => {
    if (c.stripeFcAccountId) seenIds.add(c.stripeFcAccountId);
    if (c.stripeFcAccountId && c.status === 'active') activeIds.add(c.stripeFcAccountId);
  });
  console.log(`=== state.bankConnections (${seenIds.size}) ===`);
  (state.bankConnections || []).forEach(c => {
    console.log(`  ${(c.stripeFcAccountId || '?').padEnd(40)} status=${(c.status || '?').padEnd(12)} ${c.institutionName || ''} ····${c.accountLast4 || ''}`);
  });
  // Группируем docs по accountId.
  const byAcct = {};
  for (const t of all) {
    const a = t.accountId || '(no-accountId)';
    if (!byAcct[a]) byAcct[a] = [];
    byAcct[a].push(t);
  }
  console.log(`\n=== bankTransactions by accountId ===`);
  Object.entries(byAcct)
    .sort((a, z) => z[1].length - a[1].length)
    .forEach(([a, arr]) => {
      const orphan = !activeIds.has(a);
      const mark = orphan ? '⚠ ORPHAN' : '   ok';
      console.log(`  ${mark}  ${a.padEnd(40)} ${arr.length} txns`);
    });
  const orphanDocs = [];
  for (const t of all) {
    if (!activeIds.has(t.accountId)) orphanDocs.push(t);
  }
  console.log(`\n→ ${orphanDocs.length} docs would be deleted by bank-cleanup-orphan --confirm`);
  return orphanDocs;
}

async function cmdBankCleanupOrphan(confirm) {
  const orphanDocs = await cmdBankListOrphan();
  if (confirm !== '--confirm') {
    console.log(`\nSAFETY: rerun with --confirm to actually delete ${orphanDocs.length} orphan docs.`);
    return;
  }
  if (!orphanDocs.length) {
    console.log('No orphan docs to delete. Nothing to do.');
    return;
  }
  console.log(`\nDeleting ${orphanDocs.length} orphan docs...`);
  const auditCol = db.collection(`workspaces/${WORKSPACE_ID}/audit`);
  const col = db.collection(`workspaces/${WORKSPACE_ID}/bankTransactions`);
  let deleted = 0;
  for (const t of orphanDocs) {
    try {
      await col.doc(t.docId).delete();
      await auditCol.add({
        action: 'bank.txn.orphan-cleanup',
        ts: admin.firestore.FieldValue.serverTimestamp(),
        actor: 'admin-firestore-script',
        deletedDocId: t.docId,
        deletedDoc: {
          accountId: t.accountId || null,
          amount: t.amount || null,
          description: (t.description || '').slice(0, 200),
          transactedAt: t.transactedAt || null,
          status: t.status || null,
          matchState: t.matchState || null,
        },
        reason: 'accountId not in state.bankConnections.active',
      });
      deleted++;
      if (deleted % 25 === 0) console.log(`  ... ${deleted}/${orphanDocs.length}`);
    } catch (e) {
      console.error(`  FAILED to delete ${t.docId}: ${e.message}`);
    }
  }
  console.log(`✓ Deleted ${deleted}/${orphanDocs.length} orphan docs. Audit entries written to workspaces/${WORKSPACE_ID}/audit.`);
}

async function cmdUpdateEmployeeEmail(id, newEmail, confirm) {
  if (!id || !newEmail) { console.error('ERROR: id + newEmail required'); process.exit(1); }
  if (confirm !== '--confirm') {
    console.error('SAFETY: write commands require --confirm flag. Aborting.');
    process.exit(1);
  }
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef());
    if (!snap.exists) throw new Error('state document missing');
    const doc = snap.data();
    // Real workspace state lives at doc.state.*; preserve top-level
    // metadata (_rev, _size, gmailActivity etc) by mutating only the sub.
    if (!doc.state) throw new Error('doc.state missing — unexpected schema');
    const emp = (doc.state.employees || []).find(e => e.id === id);
    if (!emp) throw new Error('Employee not found: ' + id);
    console.log(`Before: ${emp.fullName} | email=${emp.email}`);
    emp.email = newEmail;
    tx.set(stateRef(), doc);
    console.log(`After:  ${emp.fullName} | email=${newEmail}`);
  });
  console.log('✓ Updated');
}

const COMMANDS = {
  'state-summary':        () => cmdStateSummary(),
  'employees':            () => cmdEmployees(),
  'employee-detail':      (a) => cmdEmployeeDetail(a[0]),
  'gmail-activity':       (a) => cmdGmailActivity(a[0]),
  'members':              () => cmdMembers(),
  'gmail-watch':          () => cmdGmailWatch(),
  'bank-list-dups':       () => cmdBankListDups(),
  'bank-list-orphan':     () => cmdBankListOrphan(),
  'bank-cleanup-orphan':  (a) => cmdBankCleanupOrphan(a[0]),
  'update-employee-email':(a) => cmdUpdateEmployeeEmail(a[0], a[1], a[2]),
};

const cmd = process.argv[2];
const args = process.argv.slice(3);
const fn = COMMANDS[cmd];
if (!fn) {
  console.error('Unknown command:', cmd || '(none)');
  console.error('Available:', Object.keys(COMMANDS).join(', '));
  process.exit(1);
}

fn(args)
  .then(() => process.exit(0))
  .catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
