// =========================================================================
// E2E вебхука на эмуляторе (Firestore + Functions). Запуск:
//
//   export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
//   cd functions
//   echo 'PP_WEBHOOK_SECRET=emulator-test-secret' > .secret.local   # local-only
//   firebase emulators:exec --only firestore,functions \
//     "node test-harness/run-e2e.js"
//
// Сценарии (docs/pp-webhook-design.md § тест-план):
//   0  bootstrap: сид 3 зданий → ровно 3 POST (известный разовый шум), подпись валидна
//   A  одиночное изменение вне окна → 1 немедленный POST
//   B  burst в окне → 0 немедленных, flushOnce → ровно 1 POST (последний контент)
//   C  metadata-only перезапись (_savedRev bump) → 0 POST, очередь не тронута
//   D  geometry-only (pointsFlat) → 0 POST
//   P  payments: create rec → POST; изменение rec в окне → flush дошлёт;
//      metadata-only перезапись payment-дока → 0
//   E1 flaky-приёмник (500×3→200) → доставка с 4-й попытки
//   E2 мёртвый приёмник (всегда 500) → ровно 4 попытки, give-up, lastError,
//      dirty снят, основные записи не задеты
//   G  delete здания → POST deleted:true, queue-док удалён
//   H  staging-workspace → 0 POST
//   F  kill switch: enabled=false (после TTL) → полный no-op, очередь не тронута
// =========================================================================
const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { createMockReceiver } = require('./mock-pp-receiver');
const { seed, mirrorShape, makeBuildingDoc } = require('./seed-strip-on');
const pw = require('../pp-webhook');

const SECRET = 'emulator-test-secret'; // = functions/.secret.local
const PORT = 9099;
const DEBOUNCE_MS = 3000;

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FATAL: FIRESTORE_EMULATOR_HOST not set — run under `firebase emulators:exec`.');
  process.exit(2);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'suitesforall' });
const db = admin.firestore();

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗ FAIL:', label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ждём, пока приёмник насчитает >= n запросов (триггеры асинхронны).
async function waitForCount(rcv, n, timeoutMs) {
  const until = Date.now() + (timeoutMs || 20_000);
  while (Date.now() < until) {
    if (rcv.received.length >= n) return true;
    await sleep(300);
  }
  return rcv.received.length >= n;
}

function verifySignature(rec) {
  if (!rec) return { valid: false, why: 'no request captured' };
  const sig = rec.headers['x-signature'] || '';
  const m = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  if (!m) return { valid: false, why: 'bad header format' };
  const expect = crypto.createHmac('sha256', SECRET)
    .update(`${m[1]}.`).update(rec.rawBody).digest('hex');
  if (m[2] !== expect) return { valid: false, why: 'hmac mismatch' };
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return { valid: false, why: 'stale t' };
  return { valid: true, payload: JSON.parse(rec.rawBody.toString('utf8')) };
}

async function editTenant(bid, tenant, savedRev) {
  const ref = db.doc(`workspaces/default/buildings/${bid}`);
  const cur = (await ref.get()).data();
  const doc = JSON.parse(JSON.stringify(cur.doc));
  doc.floors[0].units[0].tenant = tenant;
  doc.floors[0].units[0].status = 'occupied';
  await ref.set({ ...mirrorShape(doc, savedRev), _mirroredAt: new Date() });
}

async function main() {
  const rcv = createMockReceiver(PORT);
  await rcv.start();
  console.log('\n— Seed (config → монолит → 3 здания) —');
  await seed(db, { url: `http://127.0.0.1:${PORT}/hook`, debounceMs: DEBOUNCE_MS });

  // ── 0. bootstrap burst ────────────────────────────────────────────────
  ok(await waitForCount(rcv, 3, 30_000), '0: bootstrap — 3 POST на 3 новых здания');
  await sleep(2000);
  ok(rcv.received.length === 3, `0: ровно 3 POST (got ${rcv.received.length})`);
  const v0 = verifySignature(rcv.received[0]);
  ok(v0.valid, `0: подпись валидна (${v0.why || 'ok'})`);
  ok(v0.payload && v0.payload.event === 'building.changed' && v0.payload.schemaVersion === 1
    && typeof v0.payload.deliveryId === 'string' && v0.payload.workspaceId === 'default',
    '0: контрактные поля payload');
  ok(['101.1', '102.1', '103.1'].includes(v0.payload.excelId), '0: excelId из дока');

  // ── A. одиночное изменение вне окна ───────────────────────────────────
  await sleep(DEBOUNCE_MS + 1200);
  const beforeA = rcv.received.length;
  await editTenant('b1', 'Alice v2', 2);
  ok(await waitForCount(rcv, beforeA + 1), 'A: 1 немедленный POST');
  await sleep(1500);
  ok(rcv.received.length === beforeA + 1, 'A: без дублей');

  // ── B. burst в окне → flush дошлёт последний ──────────────────────────
  const beforeB = rcv.received.length;
  await editTenant('b1', 'Alice v3', 3);
  await editTenant('b1', 'Alice v4', 4);
  await editTenant('b1', 'Alice v5', 5);
  await sleep(2000);
  ok(rcv.received.length === beforeB, 'B: burst в окне — 0 немедленных POST');
  const qB = (await db.doc('ppWebhookQueue/default__b1').get()).data();
  ok(qB && qB.dirty === true && qB.pendingHash, 'B: очередь dirty + pendingHash накоплен');
  await sleep(DEBOUNCE_MS);
  const fr = await pw.flushOnce(db, { secret: SECRET });
  ok(fr.sent === 1, `B: flushOnce дослал ровно 1 (sent=${fr.sent})`);
  ok(await waitForCount(rcv, beforeB + 1), 'B: trailing POST дошёл');
  const vB = verifySignature(rcv.received[rcv.received.length - 1]);
  ok(vB.valid && vB.payload.buildingId === 'b1', 'B: trailing payload по b1');
  const qB2 = (await db.doc('ppWebhookQueue/default__b1').get()).data();
  ok(qB2 && qB2.dirty === false && qB2.pendingHash === null, 'B: после flush dirty снят');

  // ── C. metadata-only перезапись ───────────────────────────────────────
  await sleep(DEBOUNCE_MS + 500);
  const beforeC = rcv.received.length;
  const b2ref = db.doc('workspaces/default/buildings/b2');
  const b2cur = (await b2ref.get()).data();
  await b2ref.set({ ...b2cur, _savedRev: 99, _mirroredAt: new Date(), _mirroredBy: 'client' });
  await sleep(3000);
  ok(rcv.received.length === beforeC, 'C: metadata-only (_savedRev bump) — 0 POST');

  // ── D. geometry-only ──────────────────────────────────────────────────
  const b2cur2 = (await b2ref.get()).data();
  const geoDoc = JSON.parse(JSON.stringify(b2cur2.doc));
  geoDoc.floors[0].units[0].pointsFlat = [5, 5, 15, 5, 15, 15, 5, 15];
  await b2ref.set({ ...mirrorShape(geoDoc, 100), _mirroredAt: new Date() });
  await sleep(3000);
  ok(rcv.received.length === beforeC, 'D: geometry-only — 0 POST');

  // ── P. payments-триггер ───────────────────────────────────────────────
  const beforeP = rcv.received.length;
  const payRef = db.doc('workspaces/default/payments/b2__u1__2026-06');
  await payRef.set({
    _schema: 'v2', buildingId: 'b2', floorId: 'b2-f1', unitId: 'u1', ym: '2026-06',
    rec: { status: 'paid', amount: 950, date: '2026-06-01' },
    _mirroredAt: new Date(), _mirroredBy: 'client',
  });
  ok(await waitForCount(rcv, beforeP + 1), 'P: оплата (create rec) → немедленный POST');
  const vP = verifySignature(rcv.received[rcv.received.length - 1]);
  ok(vP.valid && vP.payload.buildingId === 'b2', 'P: payload по b2');
  // void в окне → paymentsDirty → flush дошлёт
  await payRef.set({
    _schema: 'v2', buildingId: 'b2', floorId: 'b2-f1', unitId: 'u1', ym: '2026-06',
    rec: { status: 'pending', amount: 950 },
    _mirroredAt: new Date(), _mirroredBy: 'cloud-function',
  });
  await sleep(2000);
  ok(rcv.received.length === beforeP + 1, 'P: void в окне — 0 немедленных');
  const qP = (await db.doc('ppWebhookQueue/default__b2').get()).data();
  ok(qP && qP.dirty === true && qP.paymentsDirty === true, 'P: paymentsDirty взведён');
  // metadata-only перезапись payment-дока (тот же rec) → ничего нового
  const pCur = (await payRef.get()).data();
  await payRef.set({ ...pCur, _mirroredAt: new Date(), _mirroredBy: 'client' });
  await sleep(2000);
  ok(rcv.received.length === beforeP + 1, 'P: metadata-only payment echo — подавлен');
  await sleep(DEBOUNCE_MS);
  const frP = await pw.flushOnce(db, { secret: SECRET });
  ok(frP.sent === 1, `P: flush дослал payments-изменение (sent=${frP.sent})`);

  // ── E1. flaky-приёмник: 500×3 → 200 ──────────────────────────────────
  await sleep(DEBOUNCE_MS + 500);
  rcv.setMode('flaky');
  const beforeE1 = rcv.received.length;
  await editTenant('b3', 'Carol LLC', 2);
  ok(await waitForCount(rcv, beforeE1 + 4, 75_000), 'E1: flaky — 4 попытки дошли до приёмника');
  await sleep(2000);
  const qE1 = (await db.doc('ppWebhookQueue/default__b3').get()).data();
  ok(qE1 && qE1.dirty === false && !qE1.lastError && (qE1.sentCount || 0) >= 1,
    'E1: доставлено на 4-й попытке (sentCount+, lastError null)');

  // ── E2. мёртвый приёмник: give-up ────────────────────────────────────
  rcv.setMode('fail500');
  await sleep(DEBOUNCE_MS + 500);
  const beforeE2 = rcv.received.length;
  await editTenant('b3', 'Carol v2', 3);
  ok(await waitForCount(rcv, beforeE2 + 4, 75_000), 'E2: dead — ровно 4 попытки');
  await sleep(3000);
  ok(rcv.received.length === beforeE2 + 4, 'E2: после give-up попыток больше нет');
  const qE2 = (await db.doc('ppWebhookQueue/default__b3').get()).data();
  ok(qE2 && qE2.lastError && qE2.lastError.attempts === 4 && qE2.lastError.status === 500,
    'E2: lastError {attempts:4, status:500}');
  ok(qE2.dirty === false, 'E2: строгий give-up — dirty снят (catch-up = полный pull PP)');
  const stateDoc = (await db.doc('workspaces/default/data/state').get()).data();
  ok(stateDoc && stateDoc._rev === 1, 'E2: монолит не тронут вебхуком');
  rcv.setMode('ok');

  // ── G. delete здания ──────────────────────────────────────────────────
  await sleep(DEBOUNCE_MS + 500);
  const beforeG = rcv.received.length;
  await db.doc('workspaces/default/buildings/b1').delete();
  ok(await waitForCount(rcv, beforeG + 1), 'G: delete → POST');
  const vG = verifySignature(rcv.received[rcv.received.length - 1]);
  ok(vG.valid && vG.payload.deleted === true && vG.payload.buildingId === 'b1',
    'G: payload deleted:true');
  await sleep(2000);
  ok(!(await db.doc('ppWebhookQueue/default__b1').get()).exists, 'G: queue-док удалён после доставки');

  // ── H. staging-workspace ──────────────────────────────────────────────
  const beforeH = rcv.received.length;
  await db.doc('workspaces/staging/buildings/sx').set(mirrorShape(makeBuildingDoc('sx', '9.9', 'Stage'), 1));
  await sleep(3500);
  ok(rcv.received.length === beforeH, 'H: staging — 0 POST');

  // ── F. kill switch (enabled=false, ждём TTL конфиг-кэша 60s) ─────────
  await db.doc('ppWebhookQueue/_config').set({ enabled: false, url: `http://127.0.0.1:${PORT}/hook`, debounceMs: DEBOUNCE_MS });
  console.log('  … ждём 65s — TTL конфиг-кэша в functions-эмуляторе');
  await sleep(65_000);
  const beforeF = rcv.received.length;
  const qBefore = JSON.stringify((await db.doc('ppWebhookQueue/default__b2').get()).data());
  await editTenant('b2', 'Bob v2', 101);
  await sleep(4000);
  ok(rcv.received.length === beforeF, 'F: kill switch — 0 POST');
  const qAfter = JSON.stringify((await db.doc('ppWebhookQueue/default__b2').get()).data());
  ok(qBefore === qAfter, 'F: kill switch — очередь не тронута (полный no-op)');

  await rcv.stop();
  console.log(`\nE2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('E2E crash:', e); process.exit(1); });
