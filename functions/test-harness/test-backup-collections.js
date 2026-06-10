// =========================================================================
// Эмуляторный тест фикса бэкапов (FIXES_LOG 68): под strip-ON снапшот обязан
// нести РЕАЛЬНЫЕ здания (регидрация из коллекции + payments в u.payments),
// chunked-путь верифицируется read-back'ом, prune каскадно чистит chunks,
// а regression-кейс инцидента 2026-06-09 (юнит с арендатором) восстановим.
//
//   export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
//   firebase emulators:exec --only firestore \
//     "SFA_TEST_EXPORTS=1 node functions/test-harness/test-backup-collections.js"
// =========================================================================
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FATAL: run under `firebase emulators:exec`.'); process.exit(2);
}
if (process.env.SFA_TEST_EXPORTS !== '1') {
  console.error('FATAL: SFA_TEST_EXPORTS=1 required.'); process.exit(2);
}
const idx = require('../index.js');
const admin = require('firebase-admin');
const db = admin.firestore();

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗ FAIL:', label); }
}

// Большой юнит-пейлоад, чтобы суммарный state гарантированно ушёл в chunked-путь (>800KB).
function fatUnit(id, tenant) {
  return {
    id, type: 'office', status: tenant ? 'occupied' : 'vacant', sqft: 100,
    rent: 500, contractRent: tenant ? 500 : 0, tenant: tenant || '',
    stripe: tenant ? { depositInvoice: { invoiceId: 'in_dep_' + id, status: 'paid', amount: 550 } } : null,
    note: 'x'.repeat(6000), // балласт: 180 юнитов × ~6KB ≈ 1.1MB → chunked-путь гарантирован
    pointsFlat: [0, 0, 10, 0, 10, 10],
  };
}
function building(bid, n, tenantOn) {
  return {
    id: bid, excelId: bid + '.1', code: 'TST', name: 'B' + bid,
    floors: [{ id: bid + '-f1', number: 1, name: '1st',
      units: Array.from({ length: n }, (_, i) => fatUnit(`${bid}-u${i}`, i === 0 && tenantOn ? 'Kaffashin Regression' : null)) }],
  };
}

async function main() {
  // ── Сид: strip-ON монолит (buildings:[]) + коллекции ──────────────────
  await db.doc('workspaces/default/data/state').set({
    state: {
      settings: { syncV2: true, syncBuildingsV2: true, syncBuildingsRead: true, syncBuildingsStrip: true },
      ui: {}, buildings: [], contracts: [{ id: 'c1', unitId: 'bA-u0' }],
    },
    _rev: 7,
  });
  for (const [bid, n, t] of [['bA', 60, true], ['bB', 60, false], ['bC', 60, false]]) {
    await db.doc(`workspaces/default/buildings/${bid}`).set({
      _schema: 'v2', buildingId: bid, doc: building(bid, n, t), _savedRev: 5, _mirroredAt: new Date(), _mirroredBy: 'client',
    });
  }
  await db.doc('workspaces/default/payments/bA__bA-u0__2026-06').set({
    _schema: 'v2', buildingId: 'bA', unitId: 'bA-u0', ym: '2026-06',
    rec: { status: 'paid', amount: 500, date: '2026-06-01' }, _mirroredAt: new Date(),
  });

  // ── 1. Снапшот под strip-ON: регидрация + chunked + verify ────────────
  const res = await idx._test_writeBackupSnapshot({
    workspaceId: 'default', docId: '2026-06-10-manual-test', capturedBy: 'test', reason: 'test',
  });
  ok(res.chunked === true, `1: снапшот chunked (sizeBytes=${res.sizeBytes})`);
  ok(res.sizeBytes > 800 * 1024, '1: размер > 800KB (регидрация сработала)');

  const body = await idx._test_readBackupSnapshotBody('default', '2026-06-10-manual-test');
  const bl = body.state.buildings;
  ok(Array.isArray(bl) && bl.length === 3, `1: пересборка — 3 здания (got ${bl && bl.length})`);
  const u0 = bl.find(b => b.id === 'bA').floors[0].units[0];
  ok(u0.tenant === 'Kaffashin Regression' && u0.status === 'occupied', '1: REGRESSION-кейс инцидента — арендатор в бэкапе');
  ok(u0.stripe && u0.stripe.depositInvoice && u0.stripe.depositInvoice.status === 'paid', '1: депозит-штамп в бэкапе');
  ok(u0.payments && u0.payments['2026-06'] && u0.payments['2026-06'].status === 'paid', '1: payments вмержены из коллекции');
  ok(body.state.contracts && body.state.contracts.length === 1, '1: монолитные секции (contracts) на месте');

  // ── 2. Громкий отказ на пустой регидрации ──────────────────────────────
  // Сносим коллекцию зданий → strip-ON + пусто → снапшот обязан УПАСТЬ.
  for (const bid of ['bA', 'bB', 'bC']) await db.doc(`workspaces/default/buildings/${bid}`).delete();
  let threw = false;
  try {
    await idx._test_writeBackupSnapshot({ workspaceId: 'default', docId: '2026-06-10-manual-fail', capturedBy: 'test', reason: 'test' });
  } catch (e) { threw = /empty-buildings/.test(String(e.message)); }
  ok(threw, '2: пустая регидрация под strip-ON → громкий throw (не бэкап-пустышка)');
  ok(!(await db.doc('workspaces/default/backups/2026-06-10-manual-fail').get()).exists, '2: док-пустышка не записан');

  // ── 3. Prune каскадно удаляет chunks ───────────────────────────────────
  // Старый частый бэкап с чанками (id старше retention).
  await db.doc('workspaces/default/backups/2026-06-01-0100').set({ chunked: true, chunkCount: 2, capturedBy: 'test' });
  await db.doc('workspaces/default/backups/2026-06-01-0100/chunks/0000').set({ buildings: [{ id: 'x' }], idx: 0 });
  await db.doc('workspaces/default/backups/2026-06-01-0100/chunks/0001').set({ buildings: [{ id: 'y' }], idx: 1 });
  const pr = await idx._test_pruneOldFrequentBackups({ workspaceId: 'default', retentionHours: 48 });
  ok(pr.deleted === 1, `3: prune удалил истёкший бэкап (deleted=${pr.deleted})`);
  ok(!(await db.doc('workspaces/default/backups/2026-06-01-0100').get()).exists, '3: родитель удалён');
  const orphans = await db.collection('workspaces/default/backups/2026-06-01-0100/chunks').get();
  ok(orphans.empty, `3: chunks-сироты зачищены (осталось ${orphans.size})`);
  // Свежий chunked-бэкап из шага 1 prune трогать не должен.
  ok((await db.doc('workspaces/default/backups/2026-06-10-manual-test').get()).exists, '3: свежий бэкап не тронут');

  console.log(`\ntest-backup-collections: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('test crash:', e); process.exit(1); });
