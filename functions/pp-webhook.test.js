// =========================================================================
// Pure-Node тесты pp-webhook.js — БЕЗ Firebase / БЕЗ эмулятора.
// Запуск: node functions/pp-webhook.test.js
// Покрытие: HMAC-подпись, contentHash-стабильность (метаданные/геометрия не
// меняют хэш, контент меняет), таблица решений debounce, классификатор
// ретраев, конфиг-валидатор, эквивалентность платежей, payload-контракт,
// deliverWebhook (мок fetch: ретраи / give-up / redirect / per-attempt t).
// =========================================================================
const crypto = require('node:crypto');
const pw = require('./pp-webhook');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', label); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ── фикстура: сырой buildings/{bid}-док в форме зеркала ─────────────────────
function makeRawDoc(over) {
  const doc = {
    id: 'b100', excelId: '217.1', code: 'TAM', name: 'Tampa Tower',
    address: '100 Main St', icon: 'office',
    floors: [{
      id: 'f1', number: 1, name: '1st Floor', grossSqft: 10000, rentableSqft: 8000,
      units: [{
        id: 'u1', type: 'office', status: 'occupied', rentable: true,
        sqft: 500, rent: 1000, contractRent: 950, deposit: 950,
        tenant: 'Acme LLC', company: 'Acme', email: 'a@b.c', phone: '555',
        leaseStart: '2026-01-01', leaseEnd: '2026-12-31',
        pointsFlat: [0, 0, 10, 0, 10, 10, 0, 10],   // геометрия — НЕ в хэше
        stripe: { customerId: 'cus_1' },
      }],
    }],
    ...(over && over.doc),
  };
  return {
    _schema: 'v2', buildingId: 'b100', doc,
    _savedRev: 5, _mirroredAt: { seconds: 1 }, _mirroredBy: 'client',
    ...(over && over.meta),
  };
}

// ── 1. contentHash ──────────────────────────────────────────────────────────
{
  const h1 = pw.computeBuildingContentHash(makeRawDoc());
  ok(/^[0-9a-f]{64}$/.test(h1), 'hash: hex sha256');

  // метаданные (_savedRev/_mirroredAt/_mirroredBy) не меняют хэш
  const bumped = makeRawDoc(); bumped._savedRev = 999; bumped._mirroredBy = 'cloud-function'; bumped._mirroredAt = { seconds: 777 };
  eq(pw.computeBuildingContentHash(bumped), h1, 'hash: metadata bump = same hash');

  // геометрия (drag юнита) не меняет хэш
  const moved = makeRawDoc(); moved.doc.floors[0].units[0].pointsFlat = [5, 5, 15, 5, 15, 15, 5, 15];
  eq(pw.computeBuildingContentHash(moved), h1, 'hash: geometry-only = same hash');

  // PP-видимый контент меняет хэш
  const tenant = makeRawDoc(); tenant.doc.floors[0].units[0].tenant = 'Other Co';
  ok(pw.computeBuildingContentHash(tenant) !== h1, 'hash: tenant change = different hash');
  const rent = makeRawDoc(); rent.doc.floors[0].units[0].contractRent = 1234;
  ok(pw.computeBuildingContentHash(rent) !== h1, 'hash: contractRent change = different hash');
  const xid = makeRawDoc(); xid.doc.excelId = '999.9';
  ok(pw.computeBuildingContentHash(xid) !== h1, 'hash: excelId change = different hash');

  eq(pw.computeBuildingContentHash(null), pw.HASH_DELETED, 'hash: null = __DELETED__');
  eq(pw.computeBuildingContentHash({ _schema: 'v2' }), pw.HASH_MALFORMED, 'hash: no .doc = __MALFORMED__');
  eq(pw.computeBuildingContentHash({ doc: 'str' }), pw.HASH_MALFORMED, 'hash: non-object .doc = __MALFORMED__');
}

// ── 2. подпись X-Signature ──────────────────────────────────────────────────
{
  const body = Buffer.from('{"a":1}', 'utf8');
  const sig = pw.buildSignatureHeader('topsecret', 1750000000, body);
  const want = crypto.createHmac('sha256', 'topsecret').update('1750000000.').update(body).digest('hex');
  eq(sig, `t=1750000000,v1=${want}`, 'sig: format + HMAC(t.body)');
  ok(pw.buildSignatureHeader('topsecret', 1750000001, body) !== sig, 'sig: fresh t = different signature');
  ok(pw.buildSignatureHeader('other', 1750000000, body) !== sig, 'sig: different secret = different signature');
  // Регрессионный вектор — ЛИТЕРАЛ (не пересчёт тем же кодом): ловит дрейф
  // схемы подписи; PP-сторона сверяет свою реализацию по этому же hex
  // (docs/pp-webhook-contract-for-pp.md §9).
  eq(pw.buildSignatureHeader('test-secret', 1700000000, Buffer.from('{"event":"building.changed"}', 'utf8')),
    't=1700000000,v1=95afc749d304a9b17965aa77435a6c9c402eebc30fa97f9a68394f8b166199b5',
    'sig: regression vector (pinned hex)');
}

// ── 3. isConfigured ─────────────────────────────────────────────────────────
{
  const okCfg = { enabled: true, url: 'https://pp.example.com/hook' };
  ok(pw.isConfigured(okCfg, 's3cret'), 'cfg: https + secret = configured');
  ok(!pw.isConfigured(null, 's'), 'cfg: null cfg = no');
  ok(!pw.isConfigured({ enabled: false, url: 'https://x.com/h' }, 's'), 'cfg: enabled=false = no');
  ok(!pw.isConfigured({ enabled: true, url: '' }, 's'), 'cfg: empty url = no');
  ok(!pw.isConfigured(okCfg, ''), 'cfg: empty secret = no');
  ok(!pw.isConfigured({ enabled: true, url: 'http://pp.example.com/h' }, 's'), 'cfg: http non-local = no');
  ok(pw.isConfigured({ enabled: true, url: 'http://127.0.0.1:9999/h' }, 's'), 'cfg: http 127.0.0.1 = yes (emulator)');
  ok(pw.isConfigured({ enabled: true, url: 'http://localhost:9999/h' }, 's'), 'cfg: http localhost = yes (emulator)');
  ok(!pw.isConfigured({ enabled: true, url: 'https://user:pass@pp.com/h' }, 's'), 'cfg: креды в URL = no');
  ok(!pw.isConfigured({ enabled: true, url: 'not a url' }, 's'), 'cfg: мусор = no');
  ok(!pw.isConfigured({ enabled: true, url: 'ftp://pp.com/h' }, 's'), 'cfg: ftp = no');
}

// ── 4. decideDebounce ───────────────────────────────────────────────────────
{
  const W = 60_000;
  const q = (over) => ({
    contentHash: 'A', pendingHash: null, dirty: false, paymentsDirty: false,
    lastSentAtMs: 100_000, sendingAtMs: null, lastChangeAtMs: 100_000, excelId: null,
    deliveryId: null, ...over,
  });
  eq(pw.decideDebounce(null, 0, 'A', W), 'send', 'deb: нет queue-дока = send (bootstrap)');
  eq(pw.decideDebounce(q(), 100_001, 'A', W), 'suppress', 'deb: same hash clean = suppress');
  eq(pw.decideDebounce(q(), 100_001, 'B', W), 'mark-dirty', 'deb: new hash в окне = mark-dirty');
  eq(pw.decideDebounce(q(), 160_000, 'B', W), 'send', 'deb: new hash, окно вышло = send');
  eq(pw.decideDebounce(q({ lastSentAtMs: null }), 5, 'B', W), 'send', 'deb: lastSentAt null = send (не NaN)');
  eq(pw.decideDebounce(q({ dirty: true, pendingHash: 'B' }), 100_001, 'B', W), 'suppress', 'deb: same pendingHash = suppress');
  eq(pw.decideDebounce(q({ dirty: true, pendingHash: 'B' }), 100_001, 'A', W), 'cancel-dirty', 'deb: реверт к contentHash = cancel-dirty');
  eq(pw.decideDebounce(q({ dirty: true, pendingHash: 'B', paymentsDirty: true }), 100_001, 'A', W), 'suppress', 'deb: реверт при paymentsDirty = suppress (платёж не отменяем)');
  eq(pw.decideDebounce(q({ dirty: true, pendingHash: 'B' }), 100_001, 'C', W), 'mark-dirty', 'deb: третий hash в окне = mark-dirty (последний побеждает)');
  eq(pw.decideDebounce(q(), 100_001, pw.HASH_DELETED, W), 'mark-dirty', 'deb: delete в окне = mark-dirty (кран дошлёт deleted)');
  eq(pw.decideDebounce(q(), 160_000, pw.HASH_DELETED, W), 'send', 'deb: delete вне окна = send');
}

// ── 5. decidePaymentNudge ───────────────────────────────────────────────────
{
  const W = 60_000;
  eq(pw.decidePaymentNudge(null, 0, W), 'send', 'pay: нет дока = send');
  eq(pw.decidePaymentNudge({ lastSentAtMs: 100_000 }, 100_001, W), 'mark-dirty', 'pay: в окне = mark-dirty');
  eq(pw.decidePaymentNudge({ lastSentAtMs: 100_000 }, 160_001, W), 'send', 'pay: окно вышло = send');
  eq(pw.decidePaymentNudge({ lastSentAtMs: null }, 5, W), 'send', 'pay: lastSentAt null = send');
}

// ── 6. paymentsEquivalent ───────────────────────────────────────────────────
{
  const rec = { status: 'paid', amount: 950, date: '2026-06-01' };
  const docA = { _schema: 'v2', buildingId: 'b100', unitId: 'u1', ym: '2026-06', rec, _mirroredBy: 'client' };
  const docB = { _mirroredBy: 'cloud-function', rec: { date: '2026-06-01', amount: 950, status: 'paid' }, ym: '2026-06', unitId: 'u1', buildingId: 'b100', _schema: 'v2' };
  ok(pw.paymentsEquivalent(docA, docB), 'payEq: same rec, другой порядок ключей + метаданные = true');
  ok(!pw.paymentsEquivalent(docA, { ...docA, rec: { ...rec, status: 'pending' } }), 'payEq: status flip = false');
  ok(!pw.paymentsEquivalent(null, docA), 'payEq: create = false');
  ok(!pw.paymentsEquivalent(docA, null), 'payEq: delete = false');
  ok(pw.paymentsEquivalent(null, null), 'payEq: null/null = true (нечего слать)');
}

// ── 7. parseBuildingIdFromPaymentId ────────────────────────────────────────
{
  eq(pw.parseBuildingIdFromPaymentId('b100__u1__2026-06'), 'b100', 'pid: обычный id');
  eq(pw.parseBuildingIdFromPaymentId('b100__u1__deposit'), 'b100', 'pid: deposit-ключ');
  eq(pw.parseBuildingIdFromPaymentId('garbage'), null, 'pid: мусор = null');
  eq(pw.parseBuildingIdFromPaymentId('__u1__2026-06'), null, 'pid: пустой bid = null');
  eq(pw.parseBuildingIdFromPaymentId(null), null, 'pid: null = null');
}

// ── 8. classifyFailure ─────────────────────────────────────────────────────
{
  ok(pw.classifyFailure(500, '').retryable, 'retry: 500 = да');
  ok(pw.classifyFailure(503, '').retryable, 'retry: 503 = да');
  ok(pw.classifyFailure(429, '').retryable, 'retry: 429 = да');
  ok(!pw.classifyFailure(400, '').retryable, 'retry: 400 = нет');
  ok(!pw.classifyFailure(401, '').retryable, 'retry: 401 = нет');
  ok(!pw.classifyFailure(404, '').retryable, 'retry: 404 = нет');
  ok(pw.classifyFailure(null, 'fetch failed: ECONNREFUSED').retryable, 'retry: network = да');
  ok(pw.classifyFailure(null, 'The operation was aborted due to timeout').retryable, 'retry: timeout = да');
  ok(!pw.classifyFailure(null, 'uri requested responds with a redirect, redirect mode is set to error').retryable, 'retry: redirect = нет');
  eq(pw.classifyFailure(null, 'unexpected redirect').reason, 'redirect', 'retry: redirect reason');
}

// ── 9. payload-контракт ────────────────────────────────────────────────────
{
  const p = pw.buildPayload({
    buildingId: 'b100', excelId: '217.1', ws: 'default',
    changedAtIso: '2026-06-09T10:00:00.000Z', sentAtIso: '2026-06-09T10:01:00.000Z',
    deliveryId: 'd-1', deleted: false,
  });
  eq(Object.keys(p).sort(),
    ['buildingId', 'changedAt', 'deliveryId', 'event', 'excelId', 'schemaVersion', 'sentAt', 'source', 'workspaceId'],
    'payload: ровно контрактные поля (без deleted при false)');
  eq(p.event, 'building.changed', 'payload: event');
  eq(p.schemaVersion, 1, 'payload: schemaVersion');
  eq(p.source, 'suitesforall', 'payload: source');
  const pd = pw.buildPayload({ buildingId: 'b1', excelId: null, ws: 'default', changedAtIso: 'x', sentAtIso: 'y', deliveryId: 'd', deleted: true });
  ok(pd.deleted === true, 'payload: deleted=true при удалении');
  ok(pd.excelId === null, 'payload: excelId null когда не заполнен');
  // PII-гард: в payload нет ни одного поля с данными арендатора
  ok(!('tenant' in p) && !('email' in p) && !('company' in p), 'payload: ноль PII');
}

// ── 10. extractExcelId ─────────────────────────────────────────────────────
{
  eq(pw.extractExcelId(makeRawDoc()), '217.1', 'xid: обычный');
  eq(pw.extractExcelId(null), null, 'xid: null doc');
  const longRaw = makeRawDoc(); longRaw.doc.excelId = 'x'.repeat(200);
  eq(pw.extractExcelId(longRaw).length, 64, 'xid: усечение до 64');
  const emptyRaw = makeRawDoc(); emptyRaw.doc.excelId = '';
  eq(pw.extractExcelId(emptyRaw), null, 'xid: пустая строка = null');
}

// ── 11. deliverWebhook (мок fetch) ─────────────────────────────────────────
async function testDeliver() {
  const calls = [];
  const mkFetch = (script) => async (url, opts) => {
    const i = calls.length;
    calls.push({ url, sig: opts.headers['X-Signature'], redirect: opts.redirect, body: opts.body.toString('utf8') });
    const beh = script[Math.min(i, script.length - 1)];
    if (beh === 'network') throw new Error('fetch failed: ECONNREFUSED');
    if (beh === 'redirect') {
      // Реальный undici: e.message = generic 'fetch failed', суть — в e.cause.
      const err = new TypeError('fetch failed');
      err.cause = new Error('uri requested responds with a redirect, redirect mode is set to error');
      throw err;
    }
    return { ok: beh < 400, status: beh };
  };
  const noSleep = async () => {};
  let t = 1_000_000_000_000;
  const nowMs = () => (t += 1000); // каждый вызов +1s → у попыток разные t

  // успех с первой
  calls.length = 0;
  let r = await pw.deliverWebhook('https://pp/h', 'sec', { a: 1 }, { fetchImpl: mkFetch([200]), sleepImpl: noSleep, nowMs });
  ok(r.ok && r.attempts === 1, 'deliver: 200 с первой попытки');
  ok(calls[0].redirect === 'error', 'deliver: redirect:error выставлен');

  // 500×3 → 200: доставка на 4-й
  calls.length = 0;
  r = await pw.deliverWebhook('https://pp/h', 'sec', { a: 1 }, { fetchImpl: mkFetch([500, 500, 500, 200]), sleepImpl: noSleep, nowMs });
  ok(r.ok && r.attempts === 4, 'deliver: flaky 500×3→200 = ok на 4-й');
  ok(new Set(calls.map((c) => c.sig)).size === 4, 'deliver: подпись свежая на каждую попытку');
  ok(new Set(calls.map((c) => c.body)).size === 1, 'deliver: тело неизменно между попытками');

  // вечный 500 → give-up после 4
  calls.length = 0;
  r = await pw.deliverWebhook('https://pp/h', 'sec', { a: 1 }, { fetchImpl: mkFetch([500]), sleepImpl: noSleep, nowMs });
  ok(!r.ok && calls.length === 4, 'deliver: вечный 500 = ровно 4 попытки, give-up');

  // 401 → немедленный give-up без ретраев, attempts = реальное число (1, не 4)
  calls.length = 0;
  r = await pw.deliverWebhook('https://pp/h', 'sec', { a: 1 }, { fetchImpl: mkFetch([401]), sleepImpl: noSleep, nowMs });
  ok(!r.ok && calls.length === 1 && r.reason === 'http_401', 'deliver: 401 = 1 попытка, без ретраев');
  ok(r.attempts === 1, `deliver: 401 attempts=1 (реальный счётчик), got ${r.attempts}`);

  // redirect (undici: суть в e.cause) → немедленный give-up
  calls.length = 0;
  r = await pw.deliverWebhook('https://pp/h', 'sec', { a: 1 }, { fetchImpl: mkFetch(['redirect']), sleepImpl: noSleep, nowMs });
  ok(!r.ok && calls.length === 1 && r.reason === 'redirect', 'deliver: redirect (через e.cause) = give-up без ретраев');
  ok(r.attempts === 1, `deliver: redirect attempts=1, got ${r.attempts}`);

  // network → ретраится
  calls.length = 0;
  r = await pw.deliverWebhook('https://pp/h', 'sec', { a: 1 }, { fetchImpl: mkFetch(['network', 'network', 200]), sleepImpl: noSleep, nowMs });
  ok(r.ok && r.attempts === 3, 'deliver: network-fail дважды → ok на 3-й');

  // подпись верифицируема по сырому телу
  calls.length = 0;
  await pw.deliverWebhook('https://pp/h', 'verifyme', { x: 'y' }, { fetchImpl: mkFetch([200]), sleepImpl: noSleep, nowMs });
  const m = calls[0].sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  ok(!!m, 'deliver: формат заголовка t=..,v1=..');
  const expect = crypto.createHmac('sha256', 'verifyme').update(`${m[1]}.${calls[0].body}`).digest('hex');
  eq(m[2], expect, 'deliver: подпись сходится по сырым байтам тела');
}

testDeliver().then(() => {
  console.log(`\npp-webhook.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('test crash:', e);
  process.exit(1);
});
