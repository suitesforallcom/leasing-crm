// =========================================================================
// Серверный алерт-триггер регрессий зданий (Ф3 stale-tab-protection).
//
// ВТОРОЙ onDocumentWritten на 'workspaces/{ws}/buildings/{bid}' (Firestore
// допускает несколько триггеров на путь — рядом с pp-webhook'ом
// ppNotifyBuildingChanged). Сравнивает event.data.before vs .after и пишет
// АЛЕРТ при сигнатурах инцидента 2026-06-09 (docs/incident-2026-06-09-suite344.md):
//
//   1. _savedRev non-monotonic — after._savedRev (default 0) < before._savedRev.
//      Должно быть невозможно после Entry 67 (CF-зеркало сохраняет+продвигает
//      гард) + Entry 65 Layer-2 (rules '>='); алерт ловит регрессию правил /
//      запись старого кода / Admin-SDK-обход (REST owner-token минует rules).
//   2. occupiedWithTenant упал на >2 — юниты status==='occupied' И (tenant||company).
//      Сигнатура «лиз тихо исчез» (Suite 344: occupied+tenant → vacant).
//   3. building.code был в before.doc, исчез/опустел в after.doc — сигнатура
//      Pasadena (SOU) / Bay Vista (BAY): затирающая волна снесла doc.code.
//   4. total unit count упал на >25% — whole-floor wipe (New Tampa floors
//      25/32/36 → 0). Порог в долях, не абсолют — масштаб-независимо.
//
// При срабатывании: (a) алерт-док в top-level 'clobberAlerts/{ws}__{bid}__{ts}'
// (Admin-SDK-only, implicit default-deny для клиентов — как ppWebhookQueue;
// firestore.rules НЕ меняем); (b) logger.error('[clobber-alert] …', {...}) →
// Cloud Logging; (c) Sentry — в functions/ SDK НЕ подключён (нет @sentry в
// package.json, единственное упоминание — комментарий-breadcrumb в index.js),
// зависимость НЕ добавляем: logger.error + алерт-док достаточны.
//
// FAIL-SAFE ИНВАРИАНТЫ (как pp-webhook, инвариант 4):
//  • Пишет ТОЛЬКО в top-level clobberAlerts. НИКОГДА не трогает buildings/*
//    (не воюет с _savedRev-гардом Entry 65/67), монолит, payments, Stripe.
//  • Всё тело хендлера в try/catch, retry:false — никаких event-redelivery
//    штормов. Худший отказ = нет алерта + warn-лог.
//  • Staging-workspace (ws !== 'default') → return (как pp-webhook PROD_WS).
//  • Timestamp/FieldValue — через модульный subpath 'firebase-admin/firestore',
//    НЕ admin.firestore.* (functions-эмулятор перехватывает require обёрткой
//    без namespace-статиков — известный gotcha).
// =========================================================================

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { Timestamp } = require('firebase-admin/firestore');

// ── константы ──────────────────────────────────────────────────────────────
const ALERTS_COLLECTION = 'clobberAlerts';   // top-level, CF-only (default-deny для клиентов)
const PROD_WS = 'default';                    // staging-workspace не алертим
const OCCUPANCY_DROP_THRESHOLD = 2;           // падение occupiedWithTenant > этого → алерт
const UNIT_COUNT_DROP_FRACTION = 0.25;        // падение total units > 25% → алерт

// ── чистые хелперы (экспортированы для clobber-alert.test.js) ──────────────

// inner building-док из сырого mirror-wrapper ({_schema, buildingId, doc,
// _savedRev, ...} | null). Возвращает {doc, savedRev} — обе ветки defensive.
function unwrap(rawDocData) {
  if (!rawDocData || typeof rawDocData !== 'object') {
    return { doc: null, savedRev: 0, present: false };
  }
  const inner = (rawDocData.doc && typeof rawDocData.doc === 'object') ? rawDocData.doc : null;
  const rev = (typeof rawDocData._savedRev === 'number' && isFinite(rawDocData._savedRev))
    ? rawDocData._savedRev : 0;
  return { doc: inner, savedRev: rev, present: true };
}

// Плоский список юнитов по всем этажам (defensive — floors/units могут
// отсутствовать или быть не-массивами).
function _allUnits(doc) {
  if (!doc || !Array.isArray(doc.floors)) return [];
  const out = [];
  for (const f of doc.floors) {
    if (f && Array.isArray(f.units)) {
      for (const u of f.units) if (u && typeof u === 'object') out.push(u);
    }
  }
  return out;
}

// Кол-во юнитов status==='occupied' И есть (tenant||company) — LLC-only
// арендатор (company без tenant) считается занятым (конвенция rent-карты).
function occupiedWithTenantCount(doc) {
  let n = 0;
  for (const u of _allUnits(doc)) {
    if (u.status === 'occupied' && (u.tenant || u.company)) n++;
  }
  return n;
}

// Всего юнитов по всем этажам.
function totalUnitCount(doc) {
  return _allUnits(doc).length;
}

// Нормализованный building.code: непустая строка после trim → она же, иначе null.
function buildingCode(doc) {
  if (!doc) return null;
  const c = doc.code;
  if (c == null) return null;
  const s = String(c).trim();
  return s === '' ? null : s;
}

// Компактная сводка дока для алерт-документа и лога (без PII-навала —
// имя арендатора не логируем; только агрегаты + code).
function summarize(unwrapped) {
  if (!unwrapped.present) return { present: false };
  const doc = unwrapped.doc;
  return {
    present: true,
    savedRev: unwrapped.savedRev,
    code: buildingCode(doc),
    occupiedWithTenant: occupiedWithTenantCount(doc),
    totalUnits: totalUnitCount(doc),
  };
}

// ЯДРО: список сработавших сигнатур по before/after сырым mirror-докам.
// Чистая функция — без I/O, тестируется напрямую. Пустой массив = нет регрессии.
function detectSignals(rawBefore, rawAfter) {
  const before = unwrap(rawBefore);
  const after = unwrap(rawAfter);
  const signals = [];

  // Сигнатуры имеют смысл только при переходе СУЩЕСТВУЮЩИЙ → СУЩЕСТВУЮЩИЙ.
  // create (before отсутствует) и delete (after отсутствует) — не клоббер
  // в смысле Ф3 (delete зданий легитимен и редок; create не «понижает»).
  if (!before.present || !after.present) return signals;

  // 1. _savedRev non-monotonic: гард-пол ПОНИЖЕН.
  if (after.savedRev < before.savedRev) {
    signals.push('savedRev_regressed');
  }

  // 2. occupiedWithTenant упал больше порога.
  const occBefore = occupiedWithTenantCount(before.doc);
  const occAfter = occupiedWithTenantCount(after.doc);
  if (occBefore - occAfter > OCCUPANCY_DROP_THRESHOLD) {
    signals.push('occupied_dropped');
  }

  // 3. building.code был и исчез.
  if (buildingCode(before.doc) != null && buildingCode(after.doc) == null) {
    signals.push('code_vanished');
  }

  // 4. total unit count упал больше чем на UNIT_COUNT_DROP_FRACTION.
  const totBefore = totalUnitCount(before.doc);
  const totAfter = totalUnitCount(after.doc);
  if (totBefore > 0 && (totBefore - totAfter) / totBefore > UNIT_COUNT_DROP_FRACTION) {
    signals.push('units_wiped');
  }

  return signals;
}

// ── запись алерта ──────────────────────────────────────────────────────────

// id алерта = `${ws}__${bid}__${ts}`. ts — миллисекунды события (детерминирован
// в пределах одной записи; коллизия двух алертов в одну мс крайне маловероятна
// и лишь перезапишет идентичный по смыслу док).
function _alertId(ws, bid, tsMs) {
  return `${ws}__${bid}__${tsMs}`;
}

// Пишет алерт-док. db — admin.firestore(). НИКОГДА не пишет вне clobberAlerts.
async function writeAlert(db, ws, bid, signals, rawBefore, rawAfter, nowMs) {
  const after = unwrap(rawAfter);
  const ref = db.collection(ALERTS_COLLECTION).doc(_alertId(ws, bid, nowMs));
  await ref.set({
    ws,
    buildingId: bid,
    at: Timestamp.fromMillis(nowMs),
    signals,
    beforeSummary: summarize(unwrap(rawBefore)),
    afterSummary: summarize(after),
    // _mirroredBy из after — кто записал клоббер (client / cloud-function /
    // incident-restore-* / Admin REST). Незаслуженно-доверенный hint.
    _mirroredBy: (rawAfter && rawAfter._mirroredBy != null) ? String(rawAfter._mirroredBy).slice(0, 120) : null,
  });
}

// ── интеграционная точка (экспортирована для эмуляторного теста) ────────────
// Обрабатывает один before/after. Возвращает {alerted, signals}.
// НИКОГДА не кидает наружу — внутренний try/catch на запись.
async function handleBuildingWrite(db, ws, bid, rawBefore, rawAfter, nowMs) {
  if (ws !== PROD_WS) return { alerted: false, signals: [] };
  const signals = detectSignals(rawBefore, rawAfter);
  if (signals.length === 0) return { alerted: false, signals: [] };

  const beforeSummary = summarize(unwrap(rawBefore));
  const afterSummary = summarize(unwrap(rawAfter));
  // logger.error → Cloud Logging. НЕ кладём ключ 'message' (firebase-functions
  // logger перезаписывает его) — используем 'err'/именованные поля.
  logger.error('[clobber-alert] building regression detected', {
    err: `signals=${signals.join(',')}`,
    buildingId: bid,
    ws,
    signals,
    beforeSummary,
    afterSummary,
    mirroredBy: afterSummary.present ? ((rawAfter && rawAfter._mirroredBy) || null) : null,
  });

  try {
    await writeAlert(db, ws, bid, signals, rawBefore, rawAfter, nowMs);
    return { alerted: true, signals };
  } catch (e) {
    // Запись алерта упала — НЕ кидаем (retry:false), warn-лог и идём дальше.
    logger.warn('[clobber-alert] alert write failed', {
      buildingId: bid,
      err: String((e && e.stack) || e).slice(0, 600),
    });
    return { alerted: false, signals };
  }
}

// ── Cloud Function ──────────────────────────────────────────────────────────
let _db = null;
function _getDb() {
  if (!_db) _db = admin.firestore(); // initializeApp делает index.js
  return _db;
}

const clobberAlertBuildingWrite = onDocumentWritten(
  { document: 'workspaces/{ws}/buildings/{bid}', retry: false, timeoutSeconds: 60 },
  async (event) => {
    try {
      if (event.params.ws !== PROD_WS) return;             // staging не алертим
      const before = event.data && event.data.before && event.data.before.exists
        ? event.data.before.data() : null;
      const after = event.data && event.data.after && event.data.after.exists
        ? event.data.after.data() : null;
      await handleBuildingWrite(
        _getDb(), event.params.ws, event.params.bid, before, after, Date.now(),
      );
    } catch (e) {
      // Fail-safe: никогда не кидаем (retry:false + лог, основной поток не задет).
      logger.error('[clobber-alert] trigger failed', {
        buildingId: (event && event.params && event.params.bid) || null,
        err: String((e && e.stack) || e).slice(0, 600),
      });
    }
  },
);

module.exports = {
  // Cloud Function (re-export из index.js)
  clobberAlertBuildingWrite,
  // чистые хелперы — для clobber-alert.test.js
  unwrap,
  occupiedWithTenantCount,
  totalUnitCount,
  buildingCode,
  summarize,
  detectSignals,
  // интеграционные точки — для эмуляторного E2E
  handleBuildingWrite,
  writeAlert,
  // константы
  ALERTS_COLLECTION, PROD_WS, OCCUPANCY_DROP_THRESHOLD, UNIT_COUNT_DROP_FRACTION,
};
