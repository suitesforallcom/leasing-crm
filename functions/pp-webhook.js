// =========================================================================
// PropertyPulse webhook-нотификатор «building.changed» (notify + pull).
//
// Архитектура: SuitesForAll шлёт ТОЛЬКО сигнал {event, buildingId, excelId,
// changedAt} на PP_WEBHOOK_URL; PropertyPulse в ответ сам тянет данные через
// существующий ppOfficeExport?buildingId=… (authenticated pull). Никакие
// данные арендаторов по вебхуку не передаются — только идентификаторы.
//
// Триггеры:
//  • ppNotifyBuildingChanged — onDocumentWritten('workspaces/{ws}/buildings/{bid}')
//    Коллекция-зеркало (strip-ON): видит клиентский leader-mirror, серверный
//    mirror из mutateWorkspaceState И инцидентные Admin/REST-записи. Монолит
//    под стрипом к зданиям слеп (buildings:[]) — триггерить его бессмысленно.
//  • ppNotifyPaymentChanged — onDocumentWritten('workspaces/{ws}/payments/{pid}')
//    Чистая оплата/void НЕ трогает buildings-док (u.payments вырезан из
//    зеркала, а stripe-штампы lastInvoiceId/autoSentYm не входят в curated-
//    проекцию) — без этого триггера PP вечно показывал бы «paid» после void.
//  • ppWebhookFlushScheduled — minute-кран: trailing edge debounce'а + sweep
//    зависших claim'ов (упавший инстанс).
//
// КЛЮЧЕВЫЕ ИНВАРИАНТЫ (см. docs/pp-webhook-design.md):
//  1. Событие триггера — только СИГНАЛ «что-то изменилось». Хэш считается
//     ВСЕГДА по живому buildings-доку, прочитанному в транзакции, никогда по
//     event-снапшоту: Eventarc не гарантирует порядок доставки, и устаревший
//     снапшот отравил бы contentHash навсегда (silent staleness при реверте).
//  2. contentHash = sha256(stableStringify(curateBuilding(doc))) — PP-видимая
//     проекция: метаданные (_savedRev/_mirroredAt/_mirroredBy) и геометрия
//     (pointsFlat) в хэш не входят → сессионный burst (перезапись всех зданий
//     при загрузке страницы) и drag юнитов не рождают вебхуков.
//  3. Debounce ≥60s на здание: leading edge сразу, накопленное — minute-краном
//     («послать последнее»). At-least-once: claim держит dirty=true+sendingAt,
//     dirty снимается только после успешной доставки; кран пересылает claim'ы
//     старше 5 минут (crash mid-flight). Дубли дедупит PP по deliveryId.
//  4. Fail-safe: модуль пишет ТОЛЬКО в top-level ppWebhookQueue (клиентам
//     закрыта implicit default-deny; Admin SDK rules обходит). НИКОГДА не
//     пишет в buildings/* (не воюет с _savedRev-гардом, FIXES_LOG 65), в
//     монолит, payments, Stripe. Всё тело хендлеров в try/catch, retry:false —
//     никаких event-redelivery штормов. Худший отказ = нет нотификаций + лог.
//  5. Активация — runtime-конфиг ppWebhookQueue/_config {enabled, url,
//     debounceMs?} (kill switch БЕЗ редеплоя; TTL-кэш 60s). В Secret Manager
//     только PP_WEBHOOK_SECRET. Не сконфигурировано → тихий no-op.
//  6. Лог-контракт: НИКОГДА не логируем url / секрет / подпись / тела запросов
//     и ответов. Только {buildingId, attempts, status, reason, durationMs}.
// =========================================================================

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
// Timestamp/FieldValue — через модульный subpath, НЕ через admin.firestore.*:
// functions-эмулятор перехватывает require('firebase-admin') прокси-обёрткой,
// в которой статики namespace (admin.firestore.Timestamp) отсутствуют.
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const crypto = require('node:crypto');
const { curateBuilding, SCHEMA_VERSION } = require('./ppExport');

const PP_WEBHOOK_SECRET = defineSecret('PP_WEBHOOK_SECRET');

// ── константы ──────────────────────────────────────────────────────────────
const QUEUE_COLLECTION = 'ppWebhookQueue';   // top-level, CF-only (default-deny для клиентов)
const CONFIG_DOC_ID = '_config';             // ppWebhookQueue/_config — runtime kill switch
const DEFAULT_DEBOUNCE_MS = 60_000;          // ≥1 нотификации в 60s на здание
const SWEEP_STALE_MS = 5 * 60_000;           // claim старше 5 мин = упавший инстанс → переслать
const CONFIG_TTL_MS = 60_000;                // кэш runtime-конфига на инстанс
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000]; // паузы между 4 попытками
const ATTEMPT_TIMEOUT_MS = 10_000;           // per-attempt AbortSignal timeout
const FLUSH_BATCH_LIMIT = 50;
const HASH_DELETED = '__DELETED__';
const HASH_MALFORMED = '__MALFORMED__';
const PROD_WS = 'default';                   // staging-workspace не нотифицируем

// ── чистые хелперы (экспортированы для pp-webhook.test.js) ─────────────────

// Детерминированная сериализация (ключи отсортированы) — для сравнения rec
// платёжных доков, у которых порядок ключей зависит от писателя.
function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// Хэш PP-видимого контента здания по сырому buildings/{bid}-доку
// ({_schema,'buildingId', doc, _savedRev?, _mirroredAt?, ...} | null).
// stableStringify (а не JSON.stringify): у curateBuilding порядок ключей
// фиксирован ВЕЗДЕ, кроме payments-карты (curatePayments копирует ym-ключи
// в порядке вставки источника) — на incident-доках с полной формой хэш стал
// бы зависим от писателя. Метаданные и геометрия в hash не входят.
function computeBuildingContentHash(rawDocData) {
  if (!rawDocData) return HASH_DELETED;
  const inner = rawDocData.doc;
  if (!inner || typeof inner !== 'object') return HASH_MALFORMED;
  const curated = curateBuilding(inner);
  if (!curated) return HASH_MALFORMED;
  return crypto.createHash('sha256').update(stableStringify(curated)).digest('hex');
}

// excelId из живого дока: untrusted routing hint для PP — режем до 64 симв.
function extractExcelId(rawDocData) {
  const v = rawDocData && rawDocData.doc && rawDocData.doc.excelId;
  if (v == null || v === '') return null;
  return String(v).slice(0, 64);
}

// Подпись Stripe-style: HMAC-SHA256(secret, `${t}.${rawBody}`), t = unix-секунды.
// Пересчитывается на КАЖДУЮ попытку (свежий t), тело — один и тот же Buffer.
function buildSignatureHeader(secret, tSec, rawBodyBuf) {
  const mac = crypto.createHmac('sha256', secret)
    .update(String(tSec) + '.')
    .update(rawBodyBuf)
    .digest('hex');
  return `t=${tSec},v1=${mac}`;
}

// Сконфигурирован ли вебхук. url: ТОЛЬКО https (без user:pass); http разрешён
// исключительно для 127.0.0.1/localhost (эмуляторные тесты). Никаких
// 'PLACEHOLDER'-строк: пусто = DORMANT, непусто = реальный приёмник.
function isConfigured(cfg, secret) {
  if (!cfg || cfg.enabled !== true) return false;
  if (!secret || typeof secret !== 'string') return false;
  let u;
  try { u = new URL(String(cfg.url || '')); } catch (_) { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return !!u.hostname;
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
  return false;
}

// Таблица решений debounce для building-события. q — нормализованный
// queue-док (ms-числа) или null, newHash — хэш ЖИВОГО дока.
//   'suppress'     — ничего не делаем (no-op запись / уже учтено)
//   'cancel-dirty' — реверт к уже-нотифицированному контенту → снять dirty
//   'send'         — leading edge: клеймить и слать сейчас
//   'mark-dirty'   — внутри 60s-окна: накопить (trailing edge дошлёт кран)
function decideDebounce(q, nowMs, newHash, debounceMs) {
  const win = debounceMs || DEFAULT_DEBOUNCE_MS;
  if (q) {
    const known = (q.dirty && q.pendingHash != null) ? q.pendingHash : q.contentHash;
    if (newHash === known) return 'suppress';
    if (q.dirty && newHash === q.contentHash) {
      // Контент вернулся к последнему нотифицированному состоянию.
      // paymentsDirty при этом не отменяем — платёжное изменение реально.
      return q.paymentsDirty ? 'suppress' : 'cancel-dirty';
    }
    const last = q.lastSentAtMs;
    if (last != null && (nowMs - last) < win) return 'mark-dirty';
  }
  return 'send';
}

// Решение для payment-события (контент уже проверен paymentsEquivalent —
// сюда попадают только реальные изменения платежа).
function decidePaymentNudge(q, nowMs, debounceMs) {
  const win = debounceMs || DEFAULT_DEBOUNCE_MS;
  const last = q && q.lastSentAtMs;
  if (last != null && (nowMs - last) < win) return 'mark-dirty';
  return 'send';
}

// Эквивалентны ли платёжные доки ПО КОНТЕНТУ (rec) — метаданные
// (_mirroredAt/_mirroredBy/_schema) игнорируем, иначе эхо-перезаписи
// зеркал рождали бы ложные нотификации.
function paymentsEquivalent(beforeData, afterData) {
  const b = beforeData ? (beforeData.rec || {}) : null;
  const a = afterData ? (afterData.rec || {}) : null;
  return stableStringify(b) === stableStringify(a);
}

// id платёжного дока = `${buildingId}__${unitId}__${ym}` (functions/index.js
// _writePaymentV2). buildingId не содержит '__' (формат 'b' + timestamp).
function parseBuildingIdFromPaymentId(pid) {
  if (typeof pid !== 'string') return null;
  const parts = pid.split('__');
  if (parts.length < 3 || !parts[0]) return null;
  return parts[0];
}

// Классификация неудачи доставки. Ретраим network/timeout/429/5xx;
// 4xx (кроме 429) и redirect (fetch с redirect:'error' кидает TypeError) —
// не чинятся сами, сразу give-up.
function classifyFailure(status, errMessage) {
  if (status == null) {
    const redirect = /redirect/i.test(String(errMessage || ''));
    return { retryable: !redirect, reason: redirect ? 'redirect' : 'network' };
  }
  if (status === 429) return { retryable: true, reason: 'http_429' };
  if (status >= 500) return { retryable: true, reason: `http_${status}` };
  return { retryable: false, reason: `http_${status}` };
}

// Payload — контракт оператора + аддитивные поля. deleted только при удалении.
function buildPayload(p) {
  const out = {
    event: 'building.changed',
    buildingId: p.buildingId,
    excelId: p.excelId != null ? p.excelId : null,
    changedAt: p.changedAtIso,           // время ПОСЛЕДНЕГО реального изменения
    schemaVersion: SCHEMA_VERSION,       // единая константа с DTO экспорта (ppExport.js)
    source: 'suitesforall',
    workspaceId: p.ws,
    sentAt: p.sentAtIso,
    deliveryId: p.deliveryId,            // константа на доставку (все ретраи)
  };
  if (p.deleted) out.deleted = true;
  return out;
}

// ── runtime-конфиг (kill switch без редеплоя) ──────────────────────────────
let _cfgCache = { value: null, fetchedAtMs: 0 };
function _resetConfigCache() { _cfgCache = { value: null, fetchedAtMs: 0 }; }

async function getRuntimeConfig(db, nowMs) {
  if (_cfgCache.value !== null && (nowMs - _cfgCache.fetchedAtMs) < CONFIG_TTL_MS) {
    return _cfgCache.value;
  }
  let cfg = { enabled: false, url: '', debounceMs: DEFAULT_DEBOUNCE_MS };
  try {
    const snap = await db.collection(QUEUE_COLLECTION).doc(CONFIG_DOC_ID).get();
    if (snap.exists) {
      const d = snap.data() || {};
      cfg = {
        enabled: d.enabled === true,
        url: typeof d.url === 'string' ? d.url : '',
        debounceMs: (typeof d.debounceMs === 'number' && d.debounceMs >= 1000)
          ? d.debounceMs : DEFAULT_DEBOUNCE_MS,
      };
    }
  } catch (e) {
    // Конфиг не читается → считаем выключенным (fail-safe), не кидаем.
    // Ошибку кэшируем КОРОТКО (~5s, не полный TTL) — иначе один транзиентный
    // сбой чтения = 60s блэкаут нотификаций на инстанс.
    logger.warn('[pp-webhook] config read failed', { err: String((e && e.stack) || e).slice(0, 600) });
    cfg = { enabled: false, url: '', debounceMs: DEFAULT_DEBOUNCE_MS };
    _cfgCache = { value: cfg, fetchedAtMs: nowMs - (CONFIG_TTL_MS - 5_000) };
    return cfg;
  }
  _cfgCache = { value: cfg, fetchedAtMs: nowMs };
  return cfg;
}

function _readSecretSafe() {
  try { return PP_WEBHOOK_SECRET.value() || ''; } catch (_) { return ''; }
}

// ── доставка с ретраями ────────────────────────────────────────────────────
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// deps: { fetchImpl?, sleepImpl?, nowMs? } — для тестов. Возвращает
// {ok, attempts, lastStatus, reason, durationMs}. НИКОГДА не кидает.
async function deliverWebhook(url, secret, payload, deps) {
  const d = deps || {};
  const fetchImpl = d.fetchImpl || fetch;
  const sleepImpl = d.sleepImpl || _sleep;
  const nowMs = d.nowMs || Date.now;
  const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8'); // подписываем ровно эти байты
  const started = nowMs();
  let lastStatus = null;
  let lastReason = 'unknown';
  let attemptsMade = 0; // реальное число попыток (401/redirect = 1, не 4)
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    attemptsMade = attempt;
    let status = null;
    let errMessage = '';
    try {
      const tSec = Math.floor(nowMs() / 1000); // свежий t на каждую попытку
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': buildSignatureHeader(secret, tSec, bodyBuf),
        },
        body: bodyBuf,
        redirect: 'error',                       // подписанный POST не следует за 3xx
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      status = res.status;
      // Тело ответа PP не читаем НИКОГДА (лог-гигиена + unbounded size).
      if (res.ok) {
        return { ok: true, attempts: attempt, lastStatus: status, reason: 'ok', durationMs: nowMs() - started };
      }
    } catch (e) {
      // undici кладёт суть («unexpected redirect») в e.cause, а e.message —
      // generic 'fetch failed'; классифицируем по обоим слоям.
      errMessage = [e && e.message, e && e.cause && e.cause.message]
        .filter(Boolean).join(' | ') || String(e);
    }
    lastStatus = status;
    const cls = classifyFailure(status, errMessage);
    lastReason = cls.reason;
    if (!cls.retryable || attempt > RETRY_DELAYS_MS.length) break;
    await sleepImpl(RETRY_DELAYS_MS[attempt - 1]);
  }
  return {
    ok: false,
    attempts: attemptsMade,
    lastStatus,
    reason: lastReason,
    durationMs: nowMs() - started,
  };
}

// ── работа с очередью ──────────────────────────────────────────────────────
function _queueRef(db, ws, bid) {
  return db.collection(QUEUE_COLLECTION).doc(`${ws}__${bid}`);
}
function _buildingRef(db, ws, bid) {
  return db.doc(`workspaces/${ws}/buildings/${bid}`);
}
function _tsToMs(t) {
  if (!t) return null;
  if (typeof t.toMillis === 'function') return t.toMillis();
  return null;
}
function _normalizeQueue(data) {
  if (!data) return null;
  return {
    contentHash: data.contentHash != null ? data.contentHash : null,
    pendingHash: data.pendingHash != null ? data.pendingHash : null,
    dirty: data.dirty === true,
    paymentsDirty: data.paymentsDirty === true,
    excelId: data.excelId != null ? data.excelId : null,
    lastSentAtMs: _tsToMs(data.lastSentAt),
    sendingAtMs: _tsToMs(data.sendingAt),
    lastChangeAtMs: _tsToMs(data.lastChangeAt),
    deliveryId: data.deliveryId || null,
  };
}

// Доставка после claim'а + settle. Конкурентное изменение, прилетевшее во
// время доставки (pendingHash/paymentsDirty), dirty НЕ снимает — дошлёт кран.
async function _sendAndSettle(db, ws, bid, claim, cfg, secret, deps) {
  const payload = buildPayload({
    buildingId: bid,
    excelId: claim.excelId,
    ws,
    changedAtIso: new Date(claim.changedAtMs).toISOString(),
    sentAtIso: new Date((deps && deps.nowMs ? deps.nowMs() : Date.now())).toISOString(),
    deliveryId: claim.deliveryId,
    deleted: claim.deleted,
  });
  const result = await deliverWebhook(cfg.url, secret, payload, deps);
  const qRef = _queueRef(db, ws, bid);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(qRef);
      if (!snap.exists) return;
      const q = snap.data() || {};
      // Гард владения claim'ом: пока шла доставка (retry-хвост до ~90s >
      // 60s-окна), более НОВЫЙ claim (свежий deliveryId) мог занять док —
      // его маркеры (sendingAt/dirty/lastError) трогать нельзя, иначе крах
      // нового инстанса между claim и POST станет невосстановимым (sweep
      // крана ищет только dirty==true).
      if (q.deliveryId !== claim.deliveryId) return;
      const stillPending = q.pendingHash != null || q.paymentsDirty === true;
      if (result.ok && claim.deleted && !stillPending) {
        // Здание удалено, PP нотифицирован, нового pending нет — док больше
        // не нужен. Удаление ВНУТРИ tx: конкурентный mark-dirty (recreate
        // здания в окне) сериализуется транзакцией и не теряется.
        tx.delete(qRef);
        return;
      }
      const upd = {
        sendingAt: null,
        dirty: stillPending, // новое изменение во время доставки → кран дошлёт
      };
      if (result.ok) {
        upd.lastError = null;
        upd.sentCount = FieldValue.increment(1);
      } else {
        // Строгий give-up: dirty по НАШЕЙ доставке снимаем (catch-up =
        // периодический полный pull на стороне PP), pending — оставляем.
        upd.lastError = {
          at: Timestamp.now(),
          attempts: result.attempts,
          status: result.lastStatus,
          reason: result.reason,
        };
        upd.deliveryFailCount = FieldValue.increment(1);
      }
      tx.set(qRef, upd, { merge: true });
    });
  } catch (e) {
    logger.warn('[pp-webhook] settle failed', { buildingId: bid, err: String((e && e.stack) || e).slice(0, 600) });
  }
  if (result.ok) {
    logger.info('[pp-webhook] delivered', { buildingId: bid, attempts: result.attempts, durationMs: result.durationMs, deleted: !!claim.deleted });
  } else {
    logger.error('[pp-webhook] delivery failed', { buildingId: bid, attempts: result.attempts, status: result.lastStatus, reason: result.reason });
  }
  return result;
}

// Building-событие: транзакционный debounce по живому доку.
async function markBuildingChange(db, ws, bid, cfg, secret, deps) {
  const nowMs = deps && deps.nowMs ? deps.nowMs() : Date.now();
  const qRef = _queueRef(db, ws, bid);
  const bRef = _buildingRef(db, ws, bid);
  let claim = null;
  await db.runTransaction(async (tx) => {
    claim = null; // tx может ретраиться — каждый заход с чистого листа
    const [qSnap, bSnap] = await tx.getAll(qRef, bRef);
    const q = _normalizeQueue(qSnap.exists ? qSnap.data() : null);
    const live = bSnap.exists ? bSnap.data() : null;
    const newHash = computeBuildingContentHash(live);
    const excelId = extractExcelId(live) != null ? extractExcelId(live) : (q ? q.excelId : null);
    const action = decideDebounce(q, nowMs, newHash, cfg.debounceMs);
    if (action === 'suppress') return;
    const now = Timestamp.fromMillis(nowMs);
    if (action === 'cancel-dirty') {
      // Если по доку прямо сейчас летит доставка (живой sendingAt) — dirty
      // НЕ трогаем: его снимает только settle/кран (инвариант at-least-once;
      // иначе крах доставляющего инстанса делает потерю невидимой для sweep).
      // Снимаем только накопленный pendingHash — реверт отменил это изменение.
      const inFlight = q && q.sendingAtMs != null && (nowMs - q.sendingAtMs) < SWEEP_STALE_MS;
      tx.set(qRef, inFlight ? { pendingHash: null } : { dirty: false, pendingHash: null }, { merge: true });
      return;
    }
    if (action === 'mark-dirty') {
      tx.set(qRef, {
        ws, buildingId: bid, excelId,
        dirty: true, pendingHash: newHash, lastChangeAt: now,
      }, { merge: true });
      return;
    }
    // 'send' — leading edge: клеймим ДО отправки (конкурентная инвокация
    // увидит свежий lastSentAt и уйдёт в mark-dirty).
    const deliveryId = crypto.randomUUID();
    tx.set(qRef, {
      ws, buildingId: bid, excelId,
      contentHash: newHash, pendingHash: null,
      dirty: true,               // at-least-once: снимем только после доставки
      paymentsDirty: false,
      sendingAt: now, lastSentAt: now, lastChangeAt: now,
      deliveryId,
    }, { merge: true });
    claim = { excelId, deliveryId, deleted: newHash === HASH_DELETED, changedAtMs: nowMs };
  }).catch(async (e) => {
    // Tx исчерпала ретраи (горячий buildings-док в session-burst) — страховка:
    // слепо взводим dirty, кран дошлёт по живому доку. Сами никогда не кидаем.
    claim = null;
    logger.warn('[pp-webhook] mark tx failed — fallback to dirty flag', { buildingId: bid, err: String((e && e.stack) || e).slice(0, 400) });
    try { await qRef.set({ ws, buildingId: bid, dirty: true, lastChangeAt: Timestamp.fromMillis(nowMs) }, { merge: true }); } catch (_) {}
  });
  if (claim) await _sendAndSettle(db, ws, bid, claim, cfg, secret, deps);
}

// Payment-событие: контент-хэш зданий не трогаем (платежи в него не входят),
// клеймим/копим по тем же правилам окна.
async function markPaymentChange(db, ws, bid, cfg, secret, deps) {
  const nowMs = deps && deps.nowMs ? deps.nowMs() : Date.now();
  const qRef = _queueRef(db, ws, bid);
  const bRef = _buildingRef(db, ws, bid);
  let claim = null;
  await db.runTransaction(async (tx) => {
    claim = null;
    const [qSnap, bSnap] = await tx.getAll(qRef, bRef);
    const q = _normalizeQueue(qSnap.exists ? qSnap.data() : null);
    const live = bSnap.exists ? bSnap.data() : null;
    const excelId = extractExcelId(live) != null ? extractExcelId(live) : (q ? q.excelId : null);
    const action = decidePaymentNudge(q, nowMs, cfg.debounceMs);
    const now = Timestamp.fromMillis(nowMs);
    if (action === 'mark-dirty') {
      tx.set(qRef, {
        ws, buildingId: bid, excelId,
        dirty: true, paymentsDirty: true, lastChangeAt: now,
      }, { merge: true });
      return;
    }
    // 'send': contentHash здания фиксируем по живому доку (если очередь
    // пуста), чтобы последующие building-события корректно подавлялись.
    const liveHash = computeBuildingContentHash(live);
    const deliveryId = crypto.randomUUID();
    tx.set(qRef, {
      ws, buildingId: bid, excelId,
      contentHash: (q && q.contentHash != null) ? q.contentHash : liveHash,
      pendingHash: (q && q.pendingHash != null) ? q.pendingHash : null,
      dirty: true,
      paymentsDirty: false,
      sendingAt: now, lastSentAt: now, lastChangeAt: now,
      deliveryId,
    }, { merge: true });
    claim = { excelId, deliveryId, deleted: false, changedAtMs: nowMs };
  }).catch(async (e) => {
    // Та же страховка, что в markBuildingChange: contention → dirty-флаг.
    claim = null;
    logger.warn('[pp-webhook] payment mark tx failed — fallback to dirty flag', { buildingId: bid, err: String((e && e.stack) || e).slice(0, 400) });
    try { await qRef.set({ ws, buildingId: bid, dirty: true, paymentsDirty: true, lastChangeAt: Timestamp.fromMillis(nowMs) }, { merge: true }); } catch (_) {}
  });
  if (claim) await _sendAndSettle(db, ws, bid, claim, cfg, secret, deps);
}

// Trailing-edge кран: дошли накопленное + sweep зависших claim'ов.
// Экспортирован для эмуляторных тестов (вызывается напрямую, без планировщика).
async function flushOnce(db, deps) {
  const d = deps || {};
  const nowMsFn = d.nowMs || Date.now;
  const cfg = d.cfgOverride || await getRuntimeConfig(db, nowMsFn());
  const secret = d.secret != null ? d.secret : _readSecretSafe();
  if (!isConfigured(cfg, secret)) return { sent: 0, skipped: 0, configured: false };
  const snap = await db.collection(QUEUE_COLLECTION)
    .where('dirty', '==', true).limit(FLUSH_BATCH_LIMIT).get();
  let sent = 0, skipped = 0;
  const jobs = [];
  snap.forEach((docSnap) => {
    if (docSnap.id === CONFIG_DOC_ID) return;
    jobs.push((async () => {
      const nowMs = nowMsFn();
      const qRef = docSnap.ref;
      let claim = null;
      let meta = null;
      await db.runTransaction(async (tx) => {
        claim = null;
        const fresh = await tx.get(qRef);
        if (!fresh.exists) return;
        const raw = fresh.data() || {};
        const q = _normalizeQueue(raw);
        if (!q.dirty) return;
        // In-flight claim другого инстанса — не дублируем; sweep только
        // если claim старше SWEEP_STALE_MS (инстанс умер между claim и POST).
        if (q.sendingAtMs != null && (nowMs - q.sendingAtMs) < SWEEP_STALE_MS) return;
        const win = cfg.debounceMs || DEFAULT_DEBOUNCE_MS;
        const stale = q.sendingAtMs != null && (nowMs - q.sendingAtMs) >= SWEEP_STALE_MS;
        if (!stale && q.lastSentAtMs != null && (nowMs - q.lastSentAtMs) < win) return; // ещё в окне
        const ws = raw.ws || PROD_WS;
        const bid = raw.buildingId || qRef.id.replace(`${ws}__`, '');
        // Перечитываем ЖИВОЙ док: лечит out-of-order pendingHash, delete-в-окне
        // и даёт честный deleted:true только при реальном отсутствии дока.
        const bSnap = await tx.get(_buildingRef(db, ws, bid));
        const live = bSnap.exists ? bSnap.data() : null;
        const liveHash = computeBuildingContentHash(live);
        const contentChanged = liveHash !== q.contentHash;
        if (!contentChanged && !q.paymentsDirty && !stale) {
          // Реверт к нотифицированному состоянию — слать нечего.
          tx.set(qRef, { dirty: false, pendingHash: null }, { merge: true });
          return;
        }
        const excelId = extractExcelId(live) != null ? extractExcelId(live) : q.excelId;
        const deliveryId = crypto.randomUUID();
        const now = Timestamp.fromMillis(nowMs);
        tx.set(qRef, {
          ws, buildingId: bid, excelId,
          contentHash: liveHash, pendingHash: null,
          dirty: true, paymentsDirty: false,
          sendingAt: now, lastSentAt: now,
          deliveryId,
        }, { merge: true });
        claim = {
          excelId, deliveryId,
          deleted: liveHash === HASH_DELETED,
          changedAtMs: q.lastChangeAtMs != null ? q.lastChangeAtMs : nowMs,
        };
        meta = { ws, bid };
      });
      if (claim && meta) {
        const r = await _sendAndSettle(db, meta.ws, meta.bid, claim, cfg, secret, d);
        if (r.ok) sent++; else skipped++;
      } else {
        skipped++;
      }
    })());
  });
  const settled = await Promise.allSettled(jobs);
  // Отказы per-doc джобов (contention/transient) не глотаем молча.
  const rejected = settled.filter((r) => r.status === 'rejected');
  if (rejected.length) {
    logger.warn('[pp-webhook] flush jobs failed', {
      count: rejected.length,
      err: String((rejected[0].reason && rejected[0].reason.message) || rejected[0].reason).slice(0, 300),
    });
  }
  return { sent, skipped, configured: true };
}

// ── Cloud Functions ────────────────────────────────────────────────────────
let _db = null;
function _getDb() {
  if (!_db) _db = admin.firestore(); // initializeApp делает index.js
  return _db;
}

// Один info-лог «не сконфигурировано» на инстанс — никакого шторма и без URL.
let _unconfiguredLogged = false;
function _logUnconfiguredOnce() {
  if (_unconfiguredLogged) return;
  _unconfiguredLogged = true;
  logger.info('[pp-webhook] not configured (enabled=false / no url / no secret) — webhook is a silent no-op');
}

const ppNotifyBuildingChanged = onDocumentWritten(
  { document: 'workspaces/{ws}/buildings/{bid}', secrets: [PP_WEBHOOK_SECRET], retry: false, timeoutSeconds: 120 },
  async (event) => {
    try {
      if (event.params.ws !== PROD_WS) return;             // staging не нотифицируем
      const db = _getDb();
      const cfg = await getRuntimeConfig(db, Date.now());
      const secret = _readSecretSafe();
      if (!isConfigured(cfg, secret)) { _logUnconfiguredOnce(); return; }
      await markBuildingChange(db, event.params.ws, event.params.bid, cfg, secret, null);
    } catch (e) {
      // Fail-safe: никогда не кидаем (retry:false + лог, основной поток не задет).
      logger.error('[pp-webhook] building trigger failed', {
        buildingId: (event && event.params && event.params.bid) || null,
        err: String((e && e.stack) || e).slice(0, 600),
      });
    }
  }
);

const ppNotifyPaymentChanged = onDocumentWritten(
  { document: 'workspaces/{ws}/payments/{pid}', secrets: [PP_WEBHOOK_SECRET], retry: false, timeoutSeconds: 120 },
  async (event) => {
    try {
      if (event.params.ws !== PROD_WS) return;
      const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
      const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
      if (paymentsEquivalent(before, after)) return;       // эхо-перезапись зеркала
      const bid = parseBuildingIdFromPaymentId(event.params.pid);
      if (!bid) return;
      const db = _getDb();
      const cfg = await getRuntimeConfig(db, Date.now());
      const secret = _readSecretSafe();
      if (!isConfigured(cfg, secret)) { _logUnconfiguredOnce(); return; }
      await markPaymentChange(db, event.params.ws, bid, cfg, secret, null);
    } catch (e) {
      logger.error('[pp-webhook] payment trigger failed', {
        paymentId: (event && event.params && event.params.pid) || null,
        err: String((e && e.stack) || e).slice(0, 600),
      });
    }
  }
);

const ppWebhookFlushScheduled = onSchedule(
  { schedule: '* * * * *', timeZone: 'UTC', secrets: [PP_WEBHOOK_SECRET], timeoutSeconds: 120 },
  async () => {
    try {
      const r = await flushOnce(_getDb(), null);
      if (r.configured && (r.sent || r.skipped)) {
        logger.info('[pp-webhook] flush', { sent: r.sent, skipped: r.skipped });
      }
    } catch (e) {
      logger.error('[pp-webhook] flush failed', { err: String((e && e.stack) || e).slice(0, 600) });
    }
  }
);

module.exports = {
  // Cloud Functions (re-export из index.js)
  ppNotifyBuildingChanged,
  ppNotifyPaymentChanged,
  ppWebhookFlushScheduled,
  // чистые хелперы — для pp-webhook.test.js
  stableStringify,
  computeBuildingContentHash,
  extractExcelId,
  buildSignatureHeader,
  isConfigured,
  decideDebounce,
  decidePaymentNudge,
  paymentsEquivalent,
  parseBuildingIdFromPaymentId,
  classifyFailure,
  buildPayload,
  deliverWebhook,
  // интеграционные точки — для эмуляторного E2E
  markBuildingChange,
  markPaymentChange,
  flushOnce,
  getRuntimeConfig,
  _resetConfigCache,
  // константы
  QUEUE_COLLECTION, CONFIG_DOC_ID, DEFAULT_DEBOUNCE_MS, SWEEP_STALE_MS,
  RETRY_DELAYS_MS, HASH_DELETED, HASH_MALFORMED,
};
