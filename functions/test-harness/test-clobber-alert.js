// =========================================================================
// Эмуляторный тест Ф3-алерта (functions/clobber-alert.js). Проверяет 4
// сигнатуры регрессии (инцидент 2026-06-09) + отсутствие ложных алертов на
// нормальной правке и в staging-workspace.
//
// Зовём интеграционную точку handleBuildingWrite(db, ws, bid, before, after,
// nowMs) НАПРЯМУЮ (functions-эмулятор для логики не нужен — нужен только
// Firestore, чтобы проверить реальную запись алерт-дока). Запуск:
//
//   export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
//   firebase emulators:exec --only firestore,functions \
//     "node functions/test-harness/test-clobber-alert.js"
//
// (--only firestore,functions — по требованию таск-плана; functions-эмулятор
//  при этом просто стоит, тест его не дёргает.)
// =========================================================================
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FATAL: FIRESTORE_EMULATOR_HOST not set — run under `firebase emulators:exec`.');
  process.exit(2);
}

const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'suitesforall' });
const db = admin.firestore();
const ca = require('../clobber-alert');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗ FAIL:', label); }
}

// Mirror-wrapper билдер: {_schema, buildingId, doc, _savedRev, _mirroredBy}.
// units — массив {id?, status?, tenant?, company?}; code — building.code.
function wrap(bid, savedRev, code, units, mirroredBy) {
  return {
    _schema: 'v2', buildingId: bid,
    _savedRev: savedRev,
    _mirroredAt: new Date(),
    _mirroredBy: mirroredBy || 'client',
    doc: {
      id: bid, name: `Bldg ${bid}`, address: '1 Test St',
      ...(code != null ? { code } : {}),
      floors: [{
        id: `${bid}-f1`, number: 1, name: '1st',
        units: (units || []).map((u, i) => ({
          id: u.id || `u${i + 1}`, type: 'office',
          status: u.status || 'vacant',
          tenant: u.tenant || '', company: u.company || '',
          sqft: 100, rent: 500,
          pointsFlat: [0, 0, 10, 0, 10, 10],
        })),
      }],
    },
  };
}

// N occupied+tenant юнитов.
function occUnits(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `o${i}`, status: 'occupied', tenant: `T${i}` }));
}
// N vacant юнитов.
function vacUnits(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `v${i}`, status: 'vacant' }));
}

// Дождаться появления алерт-дока с нужным buildingId; вернуть его data() или null.
async function alertDocFor(bid, nowMs) {
  const id = `default__${bid}__${nowMs}`;
  const snap = await db.collection(ca.ALERTS_COLLECTION).doc(id).get();
  return snap.exists ? snap.data() : null;
}

let _ts = 1_700_000_000_000; // монотонный искусственный nowMs (детерминирует id алерта)
function nextTs() { _ts += 1000; return _ts; }

async function main() {
  // ── Сигнатура 1: _savedRev non-monotonic (after < before) ─────────────
  {
    const ts = nextTs();
    const before = wrap('bRev', 30013, 'NTA', occUnits(5));
    const after = wrap('bRev', 2, 'NTA', occUnits(5), 'stale-tab'); // тот же контент, но rev ОБВАЛЕН
    const r = await ca.handleBuildingWrite(db, 'default', 'bRev', before, after, ts);
    ok(r.alerted && r.signals.includes('savedRev_regressed'), '1: savedRev 30013→2 → savedRev_regressed');
    const d = await alertDocFor('bRev', ts);
    ok(d && d.signals.includes('savedRev_regressed'), '1: алерт-док записан в clobberAlerts');
    ok(d && d.beforeSummary.savedRev === 30013 && d.afterSummary.savedRev === 2, '1: summary хранит обе rev');
    ok(d && d._mirroredBy === 'stale-tab', '1: _mirroredBy виновника в алерте');
  }

  // ── Сигнатура 2: occupiedWithTenant упал на >2 ────────────────────────
  {
    const ts = nextTs();
    // 6 occ → 2 occ = падение 4 (> порога 2). rev НЕ падает (изолируем сигнатуру 2).
    const before = wrap('bOcc', 100, 'OCC', occUnits(6));
    const after = wrap('bOcc', 101, 'OCC', [...occUnits(2), ...vacUnits(4)]);
    const r = await ca.handleBuildingWrite(db, 'default', 'bOcc', before, after, ts);
    ok(r.alerted && r.signals.includes('occupied_dropped'), '2: occ 6→2 (−4) → occupied_dropped');
    ok(!r.signals.includes('savedRev_regressed'), '2: rev вырос → НЕ savedRev_regressed');
    const d = await alertDocFor('bOcc', ts);
    ok(d && d.beforeSummary.occupiedWithTenant === 6 && d.afterSummary.occupiedWithTenant === 2, '2: occupancy в summary');
  }
  // Граница: падение ровно на 2 (== порог, не >) → НЕ алерт.
  {
    const ts = nextTs();
    const before = wrap('bOccB', 100, 'OCB', occUnits(5));
    const after = wrap('bOccB', 101, 'OCB', [...occUnits(3), ...vacUnits(2)]); // 5→3 = −2
    const r = await ca.handleBuildingWrite(db, 'default', 'bOccB', before, after, ts);
    ok(!r.alerted, '2b: падение occ ровно на 2 (== порог) → НЕ алерт');
  }

  // ── Сигнатура 3: building.code был и исчез ────────────────────────────
  {
    const ts = nextTs();
    const before = wrap('bCode', 100, 'SOU', occUnits(3));
    const after = wrap('bCode', 101, null, occUnits(3)); // code снесён
    const r = await ca.handleBuildingWrite(db, 'default', 'bCode', before, after, ts);
    ok(r.alerted && r.signals.includes('code_vanished'), '3: code SOU→(нет) → code_vanished');
    const d = await alertDocFor('bCode', ts);
    ok(d && d.beforeSummary.code === 'SOU' && d.afterSummary.code === null, '3: code в summary');
  }
  // Граница: пустая строка code тоже считается «исчез».
  {
    const ts = nextTs();
    const before = wrap('bCodeE', 100, 'BAY', occUnits(3));
    const after = wrap('bCodeE', 101, '   ', occUnits(3)); // whitespace → null
    const r = await ca.handleBuildingWrite(db, 'default', 'bCodeE', before, after, ts);
    ok(r.alerted && r.signals.includes('code_vanished'), '3b: code BAY→"   " → code_vanished');
  }

  // ── Сигнатура 4: total unit count упал на >25% ────────────────────────
  {
    const ts = nextTs();
    // 32 → 0 (whole-floor wipe). rev вырос, occ не считается (units пустые) —
    // но occ 0→0 не падает, изолируем сигнатуру 4.
    const before = wrap('bWipe', 100, 'NTW', vacUnits(32));
    const after = wrap('bWipe', 101, 'NTW', []);
    const r = await ca.handleBuildingWrite(db, 'default', 'bWipe', before, after, ts);
    ok(r.alerted && r.signals.includes('units_wiped'), '4: units 32→0 (−100%) → units_wiped');
    const d = await alertDocFor('bWipe', ts);
    ok(d && d.beforeSummary.totalUnits === 32 && d.afterSummary.totalUnits === 0, '4: totalUnits в summary');
  }
  // Граница: падение ровно на 25% (== порог, не >) → НЕ алерт.
  {
    const ts = nextTs();
    const before = wrap('bWipeB', 100, 'NWB', vacUnits(8));
    const after = wrap('bWipeB', 101, 'NWB', vacUnits(6)); // 8→6 = −25% ровно
    const r = await ca.handleBuildingWrite(db, 'default', 'bWipeB', before, after, ts);
    ok(!r.alerted, '4b: падение units ровно на 25% (== порог) → НЕ алерт');
  }

  // ── НОРМАЛЬНАЯ правка: добавлен арендатор + rev продвинут → НЕТ алерта ──
  {
    const ts = nextTs();
    const before = wrap('bOk', 100, 'OKK', [...occUnits(3), ...vacUnits(2)]);
    const after = wrap('bOk', 101, 'OKK', [...occUnits(4), ...vacUnits(1)]); // +1 арендатор
    const r = await ca.handleBuildingWrite(db, 'default', 'bOk', before, after, ts);
    ok(!r.alerted && r.signals.length === 0, 'N: tenant добавлен, rev↑, code цел → НЕТ алерта');
    const d = await alertDocFor('bOk', ts);
    ok(!d, 'N: алерт-док НЕ создан для нормальной правки');
  }

  // ── create (before нет) и delete (after нет) → НЕ алерт ────────────────
  {
    const ts = nextTs();
    const rc = await ca.handleBuildingWrite(db, 'default', 'bNew', null, wrap('bNew', 1, 'NEW', occUnits(3)), ts);
    ok(!rc.alerted, 'C: create (before=null) → НЕ алерт');
    const rd = await ca.handleBuildingWrite(db, 'default', 'bDel', wrap('bDel', 5, 'DEL', occUnits(3)), null, ts);
    ok(!rd.alerted, 'D: delete (after=null) → НЕ алерт');
  }

  // ── staging-workspace (ws !== 'default') → НЕТ алерта даже при регрессии ─
  {
    const ts = nextTs();
    const before = wrap('bStg', 30000, 'STG', occUnits(6));
    const after = wrap('bStg', 1, null, []); // все 3 сигнатуры разом
    const r = await ca.handleBuildingWrite(db, 'staging', 'bStg', before, after, ts);
    ok(!r.alerted && r.signals.length === 0, 'S: staging ws → handler возвращает без алерта');
    const snap = await db.collection(ca.ALERTS_COLLECTION).doc(`staging__bStg__${ts}`).get();
    ok(!snap.exists, 'S: staging — алерт-док НЕ создан');
  }

  // ── множественные сигнатуры в одной записи → все в signals[] ───────────
  {
    const ts = nextTs();
    const before = wrap('bMulti', 30013, 'PIN', occUnits(8));   // 8 occ, code, rev 30013, 8 units
    const after = wrap('bMulti', 2, null, [], 'stale-tab');     // rev↓, occ→0, code исчез, units wiped
    const r = await ca.handleBuildingWrite(db, 'default', 'bMulti', before, after, ts);
    ok(r.alerted
      && r.signals.includes('savedRev_regressed')
      && r.signals.includes('occupied_dropped')
      && r.signals.includes('code_vanished')
      && r.signals.includes('units_wiped'),
      'M: полный Suite-344-клоббер → все 4 сигнатуры');
    const d = await alertDocFor('bMulti', ts);
    ok(d && Array.isArray(d.signals) && d.signals.length === 4, 'M: алерт-док содержит 4 сигнатуры');
  }

  console.log(`\ntest-clobber-alert: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('test crash:', e); process.exit(1); });
