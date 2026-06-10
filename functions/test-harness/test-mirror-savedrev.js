// =========================================================================
// Эмуляторный тест фикса FIXES_LOG 65 / Entry 67: _mirrorBuildingV2CF обязан
// СОХРАНЯТЬ И ПРОДВИГАТЬ _savedRev (старый код делал set() без поля → CF-
// зеркало стирало гард-пол, и stale-tab клиент снова мог затереть здание).
//
// Запуск (нужен только Firestore-эмулятор, functions-эмулятор НЕ нужен —
// функцию зовём напрямую через тест-хук SFA_TEST_EXPORTS):
//
//   export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
//   firebase emulators:exec --only firestore \
//     "SFA_TEST_EXPORTS=1 node functions/test-harness/test-mirror-savedrev.js"
// =========================================================================
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FATAL: FIRESTORE_EMULATOR_HOST not set — run under `firebase emulators:exec`.');
  process.exit(2);
}
if (process.env.SFA_TEST_EXPORTS !== '1') {
  console.error('FATAL: SFA_TEST_EXPORTS=1 required (включает тест-хук в index.js).');
  process.exit(2);
}

// index.js сам делает admin.initializeApp() — свой initializeApp НЕ зовём.
const idx = require('../index.js');
const admin = require('firebase-admin');
const db = admin.firestore();
const mirror = idx._test_mirrorBuildingV2CF;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗ FAIL:', label); }
}

// flat=true → форма ДЛЯ СИДА в Firestore (pointsFlat — вложенные массивы
// Firestore не принимает). flat=false → форма НА ВХОД mirror() (nested
// points, как отдаёт mutateWorkspaceState после регидрации) — проверяем,
// что _buildingForV2CF сплющит перед записью.
function makeBuilding(id, units, flat) {
  return {
    id, excelId: '217.1', name: 'Test Bldg', address: '1 Test St',
    floors: [{
      id: `${id}-f1`, number: 1, name: '1st',
      units: (units || []).map((u, i) => ({
        id: u.id || `u${i + 1}`, type: 'office', status: u.status || 'vacant',
        sqft: 100, rent: 500, tenant: u.tenant || '',
        ...(flat
          ? { pointsFlat: [0, 0, 10, 0, 10, 10] }
          : { points: [[0, 0], [10, 0], [10, 10]] }),
      })),
    }],
  };
}

async function main() {
  if (typeof mirror !== 'function') {
    console.error('FATAL: _test_mirrorBuildingV2CF не экспортирован — тест-хук не сработал.');
    process.exit(2);
  }
  const ref = (bid) => db.doc(`workspaces/default/buildings/${bid}`);

  // ── 1. Существующий док с _savedRev:5 → CF-зеркало → _savedRev:6 ──────
  await ref('bA').set({
    _schema: 'v2', buildingId: 'bA',
    doc: makeBuilding('bA', [{ id: 'u1' }, { id: 'u2' }], /*flat*/ true),
    _savedRev: 5, _mirroredAt: new Date(), _mirroredBy: 'client',
  });
  await mirror(makeBuilding('bA', [{ id: 'u1', tenant: 'Acme', status: 'occupied' }]));
  const a = (await ref('bA').get()).data();
  ok(a._savedRev === 6, `1: _savedRev 5 → 6 (сохранён и продвинут), got ${a._savedRev}`);
  ok(a._mirroredBy === 'cloud-function', '1: _mirroredBy=cloud-function');
  ok(a.doc.floors[0].units.length === 1, '1: doc заменён ЦЕЛИКОМ (удалённый юнит не прилип)');
  ok(a.doc.floors[0].units[0].tenant === 'Acme', '1: контент новый');
  ok(Array.isArray(a.doc.floors[0].units[0].pointsFlat) && !a.doc.floors[0].units[0].points,
    '1: points сплющены в pointsFlat (формат зеркала не сломан)');

  // ── 2. Дока нет → create с _savedRev:1 ────────────────────────────────
  await mirror(makeBuilding('bB', [{ id: 'u1' }]));
  const bDoc = (await ref('bB').get()).data();
  ok(bDoc._savedRev === 1, `2: create → _savedRev 1, got ${bDoc._savedRev}`);

  // ── 3. Наследие бага: док БЕЗ _savedRev (старый CF его стёр) → лечится в 1
  await ref('bC').set({
    _schema: 'v2', buildingId: 'bC',
    doc: makeBuilding('bC', [{ id: 'u1' }], /*flat*/ true),
    _mirroredAt: new Date(), _mirroredBy: 'cloud-function',
    // _savedRev отсутствует — состояние прода после старого CF-зеркала
  });
  await mirror(makeBuilding('bC', [{ id: 'u1', tenant: 'Heal' }]));
  const c = (await ref('bC').get()).data();
  ok(c._savedRev === 1, `3: legacy-док без _savedRev → 1 (гард-пол восстановлен), got ${c._savedRev}`);

  // ── 4. Повторное зеркало того же здания → монотонный рост ─────────────
  await mirror(makeBuilding('bA', [{ id: 'u1', tenant: 'Acme v2', status: 'occupied' }]));
  const a2 = (await ref('bA').get()).data();
  ok(a2._savedRev === 7, `4: повторное зеркало → 7 (монотонно), got ${a2._savedRev}`);

  // ── 5. Симуляция stale-tab гарда: floor никогда не падает ──────────────
  ok(a2._savedRev > 0 && bDoc._savedRev > 0 && c._savedRev > 0,
    '5: ни один путь не оставляет док без _savedRev (resource.get(_savedRev,0) больше не 0)');

  console.log(`\ntest-mirror-savedrev: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('test crash:', e); process.exit(1); });
