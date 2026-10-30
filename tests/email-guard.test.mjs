/**
 * Гигиена контактов арендатора — Entry 95 (FIXES_LOG).
 *
 * Инцидент 2026-10-29, Suite 107 / Bay Vista Dr: u.email хранился как
 * "ZGLUCK@VIVOHC .COM" (обычный пробел перед .COM). Все клиентские гейты путей
 * отправки и Cloud Function проверяли только /@/, адрес дошёл до Stripe,
 * stripe.customers.create ответил 400 email_invalid, CF отпустила
 * StripeInvalidRequestError наверх, onCall превратил его в голый "INTERNAL" —
 * оператор шесть раз увидел «Failed: INTERNAL — checking Stripe for orphan
 * invoice…» без единого указания на поле.
 *
 * Функции достаём ИЗ ФАЙЛОВ по маркерам Entry 95, а не копируем: копия
 * разошлась бы с задеплоенной, и тест охранял бы несуществующий код.
 *   клиент — floor-map-editor.html, блок «Entry 95: tenant contact hygiene»
 *            (плюс строка isValidEmail, от которой блок зависит);
 *   сервер — functions/index.js, блок «Entry 95: tenant email + Stripe error
 *            mapping» (HttpsError и logger подменяются заглушками).
 * Плюс гейты по исходнику: пути отправки обязаны звать _tenantEmailProblem и
 * _unitStripeBillingEmail, _verifyAndStampAfterSend — матчить новый штамп
 * депозита, а CF — звать _assertTenantEmail и _stripeErrToHttps.
 *
 * Любой сбой извлечения (нет маркера, блок не компилируется, функция не
 * объявлена) печатается одной строкой FAIL с причиной — без стека.
 *
 * Entry 96 (хвосты Entry 95): нормализаторы вынесены в общий UMD-модуль
 * functions/lib/contact.js (канон) ≡ m/lib/contact.js (копия для телефона) —
 * тест грузит модуль через require И import(), сверяет его с десктопным блоком на
 * всех кейсах и проверяет побайтовое совпадение копий; гейты по месту вызова для
 * startAutoPay, _dsSanitizeTenancy, m/app.js, m/ui/lease.js; стенд retry-слоя
 * stripeCallable (коды модульного SDK functions/<code>, allowlist безопасных вызовов).
 *
 * node tests/email-guard.test.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(here, '..', 'floor-map-editor.html');
const CF_PATH = path.join(here, '..', 'functions', 'index.js');
// Entry 96: общий модуль контактов (канон functions/lib/contact.js + байт-идентичная
// копия m/lib/contact.js) и мобильный клиент, который его применяет.
const CONTACT_CF_PATH = path.join(here, '..', 'functions', 'lib', 'contact.js');
const CONTACT_M_PATH = path.join(here, '..', 'm', 'lib', 'contact.js');
const M_APP_PATH = path.join(here, '..', 'm', 'app.js');
const LEASE_JS_PATH = path.join(here, '..', 'm', 'ui', 'lease.js');


const CLIENT_OPEN = '// ─── Entry 95: tenant contact hygiene ───';
const CF_OPEN = '// ─── Entry 95: tenant email + Stripe error mapping ───';
const ENTRY_CLOSE = '// ─── /Entry 95 ───';
// Адреса, на которых клиент, сервер и общий модуль обязаны сходиться (Entry 95 / 96).
const EMAIL_SAMPLES = ['ZGLUCK@VIVOHC .COM', 'zev@example.com', 'Zev@Example.com', '  ok@x.com  ', 'zgluck@vivohc',
  'a@b@c.com', 'zgluck.vivohc.com', '', '   ', 'a\u200Bb@c.com', 'J CASHAW@VIVOHC.COM', 'NOT AN EMAIL',
  'ZGLUCK @VIVOHC.COM', 'zgluck@vivohc. com', 'a b@c.com', 'a@b.c om', 'Zev Gluck <zgluck@vivohc.com>',
  'zgluck@vivohc.com extra', 'jdoe@gmail.com - Jane', 'zgluck@vivohc.com(primary)', '"zgluck"@vivohc.com'];


let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); fail++; } };
const section = (title) => console.log('\n' + title);
// Асинхронный вариант t — для import() модуля и retry-стенда stripeCallable (Entry 96).
const ta = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); fail++; } };


// Заглушки серверного окружения: HttpsError из firebase-functions/v2/https
// несёт code + httpErrorCode; logger — тихий.
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.httpErrorCode = { status: 400 }; }
}
const logger = { info() {}, warn() {}, error() {} };

// Вырезает текст между маркерами; понятная ошибка вместо стека, если маркера нет.
function sliceBetween(src, open, close, file) {
  const from = src.indexOf(open);
  if (from < 0) throw new Error(`${file}: marker "${open}" not found — Entry 95 block missing`);
  const to = src.indexOf(close, from + open.length);
  if (to < 0) throw new Error(`${file}: closing marker "${close}" not found after the opening one`);
  return src.slice(from, to);
}

// Исполняет блок и возвращает объявленные в нём имена. `typeof` вместо голого
// `return { name }`: отсутствующая функция даёт список пропавших имён, а не
// ReferenceError из недр new Function.
function evalBlock(code, names, params = {}) {
  const ret = '\n; return { '
    + names.map(n => `${n}: (typeof ${n} === 'undefined' ? undefined : ${n})`).join(', ')
    + ' };';
  const api = new Function(...Object.keys(params), code + ret)(...Object.values(params));
  const missing = names.filter(n => api[n] === undefined);
  if (missing.length) throw new Error('Entry 95 block does not define: ' + missing.join(', '));
  return api;
}

function loadClient(src) {
  const at = src.indexOf('function isValidEmail(e)');
  if (at < 0) throw new Error('floor-map-editor.html: "function isValidEmail(e)" not found');
  const eol = src.indexOf('\n', at);
  const isValidLine = src.slice(at, eol < 0 ? src.length : eol);
  const block = sliceBetween(src, CLIENT_OPEN, ENTRY_CLOSE, 'floor-map-editor.html');
  return evalBlock(isValidLine + '\n' + block, [
    'isValidEmail', '_normEmail', '_tenantEmailProblem', '_unitStripeBillingEmail',
    '_repairUnitContactEmails', '_normPersonName', '_normCompanyName', '_normPhone',
    '_tenantKey', '_emailLooksValid',
  ]);
}

// Entry 96: блок начинается с require('./lib/contact.js') — подставляем свой require,
// который отдаёт модуль, уже загруженный тестом настоящим CommonJS require.
function loadCF(src, contact) {
  const block = sliceBetween(src, CF_OPEN, ENTRY_CLOSE, 'functions/index.js');
  const require = (p) => {
    if (p === './lib/contact.js') return contact;
    throw new Error('Entry 95 block requires an unexpected module: ' + p);
  };
  return evalBlock(block, [
    '_TENANT_EMAIL_RE', '_normTenantEmailCF', '_isValidTenantEmail', '_assertTenantEmail', '_stripeErrToHttps',
  ], { HttpsError, logger, require });
}


// Исходник функции: от `async function NAME(` (или `function NAME(`) до конца
// тела (`\n}\n` в нулевой колонке), но не дальше len символов — гейт обязан
// стоять в начале функции, а не где-то в её хвосте.
function fnSource(src, name, len = 2500) {
  let at = src.indexOf('async function ' + name + '(');
  if (at < 0) at = src.indexOf('\nfunction ' + name + '(') + 1;
  if (at <= 0) throw new Error(name + ' not found in floor-map-editor.html');
  const end = src.indexOf('\n}\n', at);
  const stop = end > 0 ? Math.min(end + 3, at + len) : at + len;
  return src.slice(at, stop);
}

const count = (s, needle) => s.split(needle).length - 1;

// ─── исходники ───────────────────────────────────────────────────────
section('Исходники');
let htmlSrc = null, cfSrc = null;
t('floor-map-editor.html прочитан', () => { htmlSrc = fs.readFileSync(HTML_PATH, 'utf8'); });
t('functions/index.js прочитан', () => { cfSrc = fs.readFileSync(CF_PATH, 'utf8'); });
let contactCfSrc = null, contactMSrc = null, mAppSrc = null, leaseSrc = null;
t('functions/lib/contact.js прочитан', () => { contactCfSrc = fs.readFileSync(CONTACT_CF_PATH, 'utf8'); });
t('m/lib/contact.js прочитан', () => { contactMSrc = fs.readFileSync(CONTACT_M_PATH, 'utf8'); });
t('m/app.js прочитан', () => { mAppSrc = fs.readFileSync(M_APP_PATH, 'utf8'); });
t('m/ui/lease.js прочитан', () => { leaseSrc = fs.readFileSync(LEASE_JS_PATH, 'utf8'); });

// ─── Entry 96: общий модуль контактов ────────────────────────────────
section('Entry 96 — functions/lib/contact.js ≡ m/lib/contact.js: один UMD-модуль для CF и телефона');
let M = null;
t('две копии совпадают байт-в-байт (канон — functions/lib/contact.js)', () => {
  assert.ok(contactCfSrc !== null && contactMSrc !== null, 'файлы не прочитаны');
  assert.ok(Buffer.from(contactCfSrc).equals(Buffer.from(contactMSrc)), 'копии разошлись — cp functions/lib/contact.js m/lib/contact.js');
});
t('внутри нет import / export / require — файл читается и как CommonJS, и как ES-модуль', () => {
  assert.ok(!/^\s*(import|export)\s/m.test(contactCfSrc || ''), 'есть import / export');
  assert.ok(!/\brequire\(/.test(contactCfSrc || ''), 'есть require(');
});
t('require() отдаёт API: EMAIL_RE (тот же строгий паттерн) + 5 функций', () => {
  M = createRequire(import.meta.url)(CONTACT_CF_PATH);
  for (const n of ['normEmail', 'emailLooksValid', 'normPersonName', 'normCompanyName', 'normPhone']) assert.strictEqual(typeof M[n], 'function', n);
  assert.ok(M.EMAIL_RE instanceof RegExp, 'EMAIL_RE не RegExp');
  assert.strictEqual(M.EMAIL_RE.source, '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$');
});
await ta('import() копии для телефона выставляет globalThis.sfaContact с тем же API', async () => {
  const ns = await import(pathToFileURL(CONTACT_M_PATH).href);
  assert.strictEqual(typeof globalThis.sfaContact, 'object', 'globalThis.sfaContact не выставлен');
  for (const n of ['normEmail', 'emailLooksValid', 'normPersonName', 'normCompanyName', 'normPhone']) assert.strictEqual(typeof globalThis.sfaContact[n], 'function', n);
  if (ns && ns.default) assert.strictEqual(typeof ns.default.normEmail, 'function', 'module.exports не отдан');
});


// ─── клиент ──────────────────────────────────────────────────────────
section('floor-map-editor.html — блок «Entry 95: tenant contact hygiene»');
let C = null;
if (htmlSrc) t('блок найден и исполняется, все 10 функций объявлены', () => { C = loadClient(htmlSrc); });
else console.log('  (клиентские кейсы пропущены — исходник не прочитан)');

if (C) {
  const { _normEmail, _tenantEmailProblem, _unitStripeBillingEmail,
    _repairUnitContactEmails, _normPersonName, _normCompanyName, _normPhone,
    _tenantKey, _emailLooksValid } = C;

  section('_normEmail — только гигиена, никакой валидации');
  t('инцидент: пробел перед .COM вырезан, регистр опущен, repaired:true', () => {
    const r = _normEmail('ZGLUCK@VIVOHC .COM');
    assert.strictEqual(r.email, 'zgluck@vivohc.com');
    assert.strictEqual(r.repaired, true);
  });
  t('чистый адрес — repaired:false', () => {
    const r = _normEmail('zev@example.com');
    assert.strictEqual(r.email, 'zev@example.com');
    assert.strictEqual(r.repaired, false);
  });
  t('смена регистра — не ремонт', () => {
    const r = _normEmail('Zev@Example.com');
    assert.strictEqual(r.email, 'zev@example.com');
    assert.strictEqual(r.repaired, false);
  });
  t('пробелы по краям — trim, не ремонт', () => {
    const r = _normEmail('  ok@x.com  ');
    assert.strictEqual(r.email, 'ok@x.com');
    assert.strictEqual(r.repaired, false);
  });
  t('пробел рядом с точкой или @ — опечатка, чинится (repaired:true)', () => {
    for (const [raw, want] of [
      ['ZGLUCK @VIVOHC.COM', 'zgluck@vivohc.com'],
      ['ZGLUCK@ VIVOHC.COM', 'zgluck@vivohc.com'],
      ['zgluck@vivohc. com', 'zgluck@vivohc.com'],
      ['zgluck@vivohc\t.com', 'zgluck@vivohc.com'],
      ['zgluck@vivohc\u00A0.com', 'zgluck@vivohc.com'],
      ['zgluck @ vivohc . com', 'zgluck@vivohc.com'],
    ]) {
      const r = _normEmail(raw);
      assert.strictEqual(r.email, want, JSON.stringify(raw));
      assert.strictEqual(r.repaired, true, 'repaired for ' + JSON.stringify(raw));
    }
  });
  t('пробел НЕ у точки/@ не склеивается: "a b@c.com" остаётся как есть, repaired:false', () => {
    for (const raw of ['a b@c.com', 'a@b.c om', 'a\tb@c.com', 'a\u00A0b@c.com']) {
      const r = _normEmail(raw);
      assert.strictEqual(r.email, raw.toLowerCase(), JSON.stringify(raw));
      assert.strictEqual(r.repaired, false, JSON.stringify(raw));
    }
  });
  t('display-name вставка "Zev Gluck <zgluck@vivohc.com>" → адрес из угловых скобок, repaired:true', () => {
    for (const raw of ['Zev Gluck <zgluck@vivohc.com>', '"Gluck, Zev" <ZGLUCK@VIVOHC.COM>', '<zgluck@vivohc.com>', 'Zev <ZGLUCK@VIVOHC .COM>']) {
      const r = _normEmail(raw);
      assert.strictEqual(r.email, 'zgluck@vivohc.com', JSON.stringify(raw));
      assert.strictEqual(r.repaired, true, JSON.stringify(raw));
    }
  });
  t('приписка после адреса не склеивается: "zgluck@vivohc.com extra" / "jdoe@gmail.com - Jane" остаются как есть', () => {
    for (const raw of ['zgluck@vivohc.com extra', 'jdoe@gmail.com - Jane', 'zgluck@vivohc.com, jcashaw@vivohc.com', 'zgluck@vivohc.com (primary)']) {
      const r = _normEmail(raw);
      assert.strictEqual(r.email, raw.toLowerCase(), JSON.stringify(raw));
      assert.strictEqual(r.repaired, false, JSON.stringify(raw));
    }
  });
  t('zero-width символы (U+200B..U+200D, U+FEFF) внутри вырезаны — ремонт', () => {
    for (const z of ['\u200B', '\u200C', '\u200D', '\uFEFF']) {
      const tag = 'U+' + z.codePointAt(0).toString(16).toUpperCase();
      const r = _normEmail('zgluck@' + z + 'vivohc.com');
      assert.strictEqual(r.email, 'zgluck@vivohc.com', tag);
      assert.strictEqual(r.repaired, true, 'repaired for ' + tag);
    }
  });
  t('пусто / null / undefined / одни пробелы → email "", repaired:false', () => {
    for (const v of ['', null, undefined, '   ']) {
      const r = _normEmail(v);
      assert.strictEqual(r.email, '', JSON.stringify(v));
      assert.strictEqual(r.repaired, false, JSON.stringify(v));
    }
  });
  t('мусор нормализуется без исключения и без склейки (валидирует не она)', () => {
    assert.strictEqual(_normEmail('NOT AN EMAIL').email, 'not an email');
  });

  section('_tenantEmailProblem — гейт путей отправки');
  const REQUIRED = 'Tenant email required — add it on the Tenant tab';
  t('пусто → "' + REQUIRED + '"', () => {
    for (const v of ['', null, undefined, '  ']) assert.strictEqual(_tenantEmailProblem(v), REQUIRED, JSON.stringify(v));
  });
  t('адрес инцидента "ZGLUCK@VIVOHC .COM" — НЕ проблема: пробел чинится, не отвергается', () => {
    assert.strictEqual(_tenantEmailProblem('ZGLUCK@VIVOHC .COM'), null);
  });
  t('нормальный адрес (любой регистр, краевые пробелы) → null', () => {
    assert.strictEqual(_tenantEmailProblem('zev@example.com'), null);
    assert.strictEqual(_tenantEmailProblem('  Zev@Example.com '), null);
  });
  t('пробел у точки/@ чинится → null; пробел в другом месте → проблема (не склеиваем)', () => {
    assert.strictEqual(_tenantEmailProblem('ZGLUCK @VIVOHC.COM'), null);
    assert.strictEqual(_tenantEmailProblem('zgluck@vivohc. com'), null);
    for (const v of ['a b@c.com', 'a@b.c om']) {
      const p = _tenantEmailProblem(v);
      assert.ok(typeof p === 'string' && p.includes('looks invalid'), JSON.stringify(v) + ' → ' + JSON.stringify(p));
    }
  });
  t('display-name вставка проходит (адрес извлечён); приписка / скобки / кавычки / запятая → проблема', () => {
    assert.strictEqual(_tenantEmailProblem('Zev Gluck <zgluck@vivohc.com>'), null);
    for (const v of ['zgluck@vivohc.com extra', 'jdoe@gmail.com - Jane', 'zgluck@vivohc.com(primary)', '"zgluck"@vivohc.com', 'zgluck@vivohc.com,', 'zgluck@vivohc.com;jcashaw@vivohc.com']) {
      const p = _tenantEmailProblem(v);
      assert.ok(typeof p === 'string' && p.includes('looks invalid'), JSON.stringify(v) + ' → ' + JSON.stringify(p));
    }
  });
  t('невалидно и после нормализации → сообщение с адресом как набран (trim) и ссылкой на Tenant tab', () => {
    assert.strictEqual(_tenantEmailProblem('  ZGLUCK@VIVOHC  '),
      'Tenant email looks invalid: "ZGLUCK@VIVOHC" — fix it on the Tenant tab (check for spaces or typos)');
  });
  t('нет @ / два @ / пустой домен / нет TLD → не null', () => {
    for (const v of ['zgluck.vivohc.com', 'zgluck@@vivohc.com', 'a@b@c.com', '@vivohc.com', 'zgluck@', 'zgluck@.com', 'zgluck@vivohc']) {
      const p = _tenantEmailProblem(v);
      assert.ok(typeof p === 'string' && p.includes('looks invalid'),
        'ожидалась проблема для ' + JSON.stringify(v) + ', получили ' + JSON.stringify(p));
    }
  });

  section('_emailLooksValid — isValidEmail плюс запрет символов прозы');
  t('валидные адреса проходят', () => {
    for (const v of ['zgluck@vivohc.com', 'a.b+tag@x.co', 'zev.gluck@vivo-hc.com']) assert.strictEqual(_emailLooksValid(v), true, v);
  });
  t('скобки, запятые, кавычки, точка с запятой, двоеточие, пробел, пусто → false', () => {
    for (const v of ['zgluck@vivohc.com(primary)', 'zgluck@vivohc.com,', '"zgluck"@vivohc.com', 'a;b@c.com', 'a:b@c.com',
      'zevgluck<zgluck@vivohc.com>', 'a[b]@c.com', '', 'a b@c.com', null, undefined]) assert.strictEqual(_emailLooksValid(v), false, JSON.stringify(v));
  });

  section('_unitStripeBillingEmail — получатель по правилу Invoice Generator');
  const unit107 = () => ({ email: 'ZGLUCK@VIVOHC .COM', emailCc: 'JCASHAW@VIVOHC.COM', stripeBillingContact: 'cc' });
  t('тумблер «$» на CC + валидный CC → CC, нормализованный', () => {
    const r = _unitStripeBillingEmail(unit107());
    assert.strictEqual(r.email, 'jcashaw@vivohc.com');
    assert.strictEqual(r.source, 'cc');
  });
  t('без тумблера → primary, нормализованный (пробел инцидента вырезан)', () => {
    const u = unit107(); delete u.stripeBillingContact;
    const r = _unitStripeBillingEmail(u);
    assert.strictEqual(r.email, 'zgluck@vivohc.com');
    assert.strictEqual(r.source, 'primary');
  });
  t('тумблер на CC, но CC невалиден / пуст → primary', () => {
    for (const cc of ['bad', '', null, undefined, 'jcashaw@vivohc']) {
      const r = _unitStripeBillingEmail({ ...unit107(), emailCc: cc });
      assert.strictEqual(r.source, 'primary', 'cc=' + JSON.stringify(cc));
      assert.strictEqual(r.email, 'zgluck@vivohc.com', 'cc=' + JSON.stringify(cc));
    }
  });
  t('тумблер явно на primary → primary даже при валидном CC', () => {
    const r = _unitStripeBillingEmail({ ...unit107(), stripeBillingContact: 'primary' });
    assert.strictEqual(r.source, 'primary');
    assert.strictEqual(r.email, 'zgluck@vivohc.com');
  });
  t('юнит без почты → email "", source primary (отказ — дело _tenantEmailProblem)', () => {
    const r = _unitStripeBillingEmail({});
    assert.strictEqual(r.email, '');
    assert.strictEqual(r.source, 'primary');
  });
  // Entry 101: raw — исходная строка выбранного поля; её (не email) цитируют тосты гардов отправки.
  t('Entry 101: raw — ввод выбранного поля как есть (CC при тумблере, иначе primary; пусто → "")', () => {
    assert.strictEqual(_unitStripeBillingEmail(unit107()).raw, 'JCASHAW@VIVOHC.COM');
    const u = unit107(); delete u.stripeBillingContact;
    assert.strictEqual(_unitStripeBillingEmail(u).raw, 'ZGLUCK@VIVOHC .COM');
    assert.strictEqual(_unitStripeBillingEmail({ ...unit107(), emailCc: 'bad' }).raw, 'ZGLUCK@VIVOHC .COM', 'CC невалиден → raw primary');
    assert.strictEqual(_unitStripeBillingEmail({}).raw, '');
    assert.strictEqual(_unitStripeBillingEmail({ email: null, emailCc: undefined, stripeBillingContact: 'cc' }).raw, '');
  });
  t('Entry 101: вердикт гарда одинаков на raw и на нормализованном email (нормализация идемпотентна)', () => {
    for (const s of EMAIL_SAMPLES) {
      const b = _unitStripeBillingEmail({ email: s });
      assert.strictEqual(_tenantEmailProblem(b.raw) === null, _tenantEmailProblem(b.email) === null, JSON.stringify(s));
      assert.strictEqual(_normEmail(b.email).email, b.email, 'не идемпотентна на ' + JSON.stringify(s));
    }
  });
  t('Entry 101: тост гарда цитирует ввод как набран, а не нормализованную форму', () => {
    const b = _unitStripeBillingEmail({ email: 'Zev Gluck <zgluck@vivohc>' });
    assert.strictEqual(b.email, 'zgluck@vivohc');
    const p = _tenantEmailProblem(b.raw);
    assert.ok(p && p.includes('"Zev Gluck <zgluck@vivohc>"'), 'ожидалась цитата как набрано, получено: ' + p);
    assert.ok(_tenantEmailProblem(b.email).includes('"zgluck@vivohc"'), 'контроль: нормализованная форма цитирует lower-case адрес');
  });
  t('чистая функция — юнит не мутирует', () => {
    const u = unit107(); const before = JSON.stringify(u);
    _unitStripeBillingEmail(u);
    assert.strictEqual(JSON.stringify(u), before);
  });
  t('CC с display-name извлекается; CC с припиской невалиден → primary', () => {
    const a = _unitStripeBillingEmail({ ...unit107(), emailCc: 'Jane <JCASHAW@VIVOHC.COM>' });
    assert.strictEqual(a.email, 'jcashaw@vivohc.com'); assert.strictEqual(a.source, 'cc');
    const b = _unitStripeBillingEmail({ ...unit107(), emailCc: 'jcashaw@vivohc.com (billing)' });
    assert.strictEqual(b.source, 'primary'); assert.strictEqual(b.email, 'zgluck@vivohc.com');
  });

  section('_repairUnitContactEmails — авторемонт пробелов в сохранённых адресах');
  t('инцидент: email починен и записан обратно; emailCc с краевыми пробелами не тронут', () => {
    const u = { email: 'ZGLUCK@VIVOHC .COM', emailCc: ' ok@x.com ' };
    const reps = _repairUnitContactEmails(u);
    assert.strictEqual(reps.length, 1, 'ожидался ровно один ремонт, получили ' + JSON.stringify(reps));
    assert.strictEqual(reps[0].field, 'email');
    assert.strictEqual(reps[0].from, 'ZGLUCK@VIVOHC .COM');
    assert.strictEqual(reps[0].to, 'zgluck@vivohc.com');
    assert.strictEqual(u.email, 'zgluck@vivohc.com');
    assert.strictEqual(u.emailCc, ' ok@x.com ');   // trim по краям — не «внутренний» ремонт
  });
  t('оба поля с пробелом у @/точки → два ремонта, email первым', () => {
    const u = { email: 'ZGLUCK@VIVOHC .COM', emailCc: 'JCASHAW @VIVOHC.COM' };
    const reps = _repairUnitContactEmails(u);
    assert.deepStrictEqual(reps.map(r => r.field), ['email', 'emailCc']);
    assert.strictEqual(u.email, 'zgluck@vivohc.com');
    assert.strictEqual(u.emailCc, 'jcashaw@vivohc.com');
  });
  t('display-name вставка чинится до адреса; приписка после адреса НЕ трогается и не склеивается', () => {
    const u = { email: 'Zev Gluck <zgluck@vivohc.com>', emailCc: 'jdoe@gmail.com - Jane' };
    const reps = _repairUnitContactEmails(u);
    assert.deepStrictEqual(reps.map(r => r.field), ['email']);
    assert.strictEqual(u.email, 'zgluck@vivohc.com');
    assert.strictEqual(u.emailCc, 'jdoe@gmail.com - Jane');
  });
  t('"a b@c.com" (пробел не у точки/@) — не ремонт, значение не тронуто', () => {
    const u = { email: 'a b@c.com' };
    assert.deepStrictEqual(_repairUnitContactEmails(u), []);
    assert.strictEqual(u.email, 'a b@c.com');
  });
  t('валидный адрес / разница только в регистре — ничего не меняется', () => {
    const u = { email: 'Zev@Example.com', emailCc: 'ok@x.com' };
    assert.deepStrictEqual(_repairUnitContactEmails(u), []);
    assert.strictEqual(u.email, 'Zev@Example.com');
    assert.strictEqual(u.emailCc, 'ok@x.com');
  });
  t('после ремонта всё равно невалидно → не записываем (оператор должен увидеть ошибку, а не тихую правку)', () => {
    const u = { email: 'ZEV GLUCK' };
    assert.deepStrictEqual(_repairUnitContactEmails(u), []);
    assert.strictEqual(u.email, 'ZEV GLUCK');
  });
  t('пустые поля / нет полей → []', () => {
    assert.deepStrictEqual(_repairUnitContactEmails({}), []);
    assert.deepStrictEqual(_repairUnitContactEmails({ email: '', emailCc: null }), []);
  });

  section('_normPersonName / _normCompanyName — Title Case только для «кричащих» значений');
  const NAME_CASES = [
    ['ZEV\u200B GLUCK', 'Zev Gluck'],
    ['zev gluck', 'Zev Gluck'],
    ['McDonald', 'McDonald'],
    ["O'NEIL", "O'Neil"],
    ['MARY-JANE SMITH', 'Mary-Jane Smith'],
    ["MARY-JANE O'NEIL", "Mary-Jane O'Neil"],
    ['  juan   de la cruz ', 'Juan de la Cruz'],
    ['DE LA CRUZ', 'De la Cruz'],
    ['JOHN SMITH III', 'John Smith III'],
    ['ZEV GLUCK, MD', 'Zev Gluck, MD'],
    ['JANE DOE, PHD', 'Jane Doe, PhD'],
    ['VIVO HEALTHCARE CONSULTING, LLC', 'Vivo Healthcare Consulting, LLC'],
    ['acme consulting llc', 'Acme Consulting LLC'],
    ['ACME INC.', 'Acme Inc.'],
    ['SMITH & SONS LLC', 'Smith & Sons LLC'],
    ['iPhone Repair LLC', 'iPhone Repair LLC'],
    ['BANK OF THE WEST', 'Bank of the West'],
    ['ACME LLC D/B/A ACME SALON', 'Acme LLC D/B/A Acme Salon'],
    ['SUITE 107 HOLDINGS, L.L.C.', 'Suite 107 Holdings, L.L.C.'],
    ['JOSÉ GARCÍA', 'José García'],
    ['Zev   Gluck', 'Zev Gluck'],
    ['ZEV GLUCK', 'Zev Gluck'],
    ['JOHN A. SMITH', 'John A. Smith'],
    ['JOHN A SMITH', 'John A Smith'],
    ['MARY E. JONES', 'Mary E. Jones'],
    ['J.R. SMITH', 'J.R. Smith'],
    ['J. R. SMITH', 'J. R. Smith'],
    ['J.P. MORGAN CHASE', 'J.P. Morgan Chase'],
    ['BANK OF AMERICA, N.A.', 'Bank of America, N.A.'],
    ["SMITH'S BARBER SHOP LLC", "Smith's Barber Shop LLC"],
    ["JOE'S PIZZA", "Joe's Pizza"],
    ["MACY'S", "Macy's"],
    ["D'ANGELO", "D'Angelo"],
    ["ANNE-MARIE'S SALON", "Anne-Marie's Salon"],
    ['H&R BLOCK', 'H&R Block'],
    ['AT&T', 'AT&T'],
    ['A&M DENTAL', 'A&M Dental'],
    ['ZEV GLUCK/JANE DOE', 'Zev Gluck/Jane Doe'],
    ['DO IT RIGHT PLUMBING', 'Do It Right Plumbing'],
    ['RENT A CAR', 'Rent A Car'],
    ['', ''],
  ];
  for (const [input, expected] of NAME_CASES) {
    t(`_normPersonName(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
      assert.strictEqual(_normPersonName(input), expected);
    });
  }
  t('_normCompanyName — та же реализация: совпадает с _normPersonName на всех кейсах', () => {
    for (const [input] of NAME_CASES) assert.strictEqual(_normCompanyName(input), _normPersonName(input), JSON.stringify(input));
  });
  t('null / undefined → ""', () => {
    for (const fn of [_normPersonName, _normCompanyName]) {
      assert.strictEqual(fn(null), ''); assert.strictEqual(fn(undefined), '');
    }
  });

  section('_tenantKey — ключ сравнения имени арендатора: регистр и пробелы не считаются сменой арендатора');
  t('"ZEV GLUCK" и "Zev Gluck" — один арендатор', () => {
    assert.strictEqual(_tenantKey('ZEV GLUCK'), _tenantKey('Zev Gluck'));
  });
  t('двойные / неразрывные / zero-width пробелы и края не меняют ключ', () => {
    for (const v of ['Zev   Gluck', ' Zev Gluck ', 'Zev\u00A0Gluck', 'ZEV\u200B GLUCK']) {
      assert.strictEqual(_tenantKey(v), _tenantKey('zev gluck'), JSON.stringify(v));
    }
  });
  t('другое имя — другой ключ; пусто / null / undefined → ""', () => {
    assert.notStrictEqual(_tenantKey('Zev Gluck'), _tenantKey('Zev Glick'));
    for (const v of ['', null, undefined, '  ']) assert.strictEqual(_tenantKey(v), '', JSON.stringify(v));
  });

  section('_normPhone — XXX-XXX-XXXX для 10 цифр (и 1+10), остальное только чистится');
  const PHONE_CASES = [
    ['(347) 563-7418', '347-563-7418'],
    ['3475637418', '347-563-7418'],
    ['+1 347 563 7418', '347-563-7418'],
    ['1-347-563-7418', '347-563-7418'],
    ['  347.563.7418  ', '347-563-7418'],
    ['347  563   7418', '347-563-7418'],
    ['+44 20 7946 0958', '+44 20 7946 0958'],
    ['347-563-7418 x12', '347-563-7418 x12'],
    ['347-563-7418   x12', '347-563-7418 x12'],
    ['12345', '12345'],
    ['', ''],
  ];
  for (const [input, expected] of PHONE_CASES) {
    t(`_normPhone(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
      assert.strictEqual(_normPhone(input), expected);
    });
  }
  t('null / undefined → ""', () => { assert.strictEqual(_normPhone(null), ''); assert.strictEqual(_normPhone(undefined), ''); });

  // ─── Entry 96: модуль ≡ десктоп ───
  section('Entry 96 — functions/lib/contact.js повторяет десктопный блок на всех кейсах (на сервере и в m/ второй копии логики нет)');
  if (!M) console.log('  (пропущено — модуль не загрузился)');
  else {
    t('normPersonName / normCompanyName ≡ _normPersonName / _normCompanyName на NAME_CASES', () => {
      for (const [input, expected] of NAME_CASES) {
        assert.strictEqual(M.normPersonName(input), expected, JSON.stringify(input));
        assert.strictEqual(M.normCompanyName(input), _normCompanyName(input), JSON.stringify(input));
      }
      assert.strictEqual(M.normPersonName(null), ''); assert.strictEqual(M.normCompanyName(undefined), '');
    });
    t('normPhone ≡ _normPhone на PHONE_CASES', () => {
      for (const [input, expected] of PHONE_CASES) assert.strictEqual(M.normPhone(input), expected, JSON.stringify(input));
      assert.strictEqual(M.normPhone(null), ''); assert.strictEqual(M.normPhone(undefined), '');
    });
    t('normEmail ≡ _normEmail ({ email, repaired }) и emailLooksValid ≡ _emailLooksValid на EMAIL_SAMPLES', () => {
      for (const s of EMAIL_SAMPLES) {
        assert.deepStrictEqual(M.normEmail(s), _normEmail(s), JSON.stringify(s));
        assert.strictEqual(M.emailLooksValid(M.normEmail(s).email), _emailLooksValid(_normEmail(s).email), JSON.stringify(s));
      }
      for (const z of ['\u200B', '\u200C', '\u200D', '\uFEFF']) assert.deepStrictEqual(M.normEmail('zgluck@' + z + 'vivohc.com'), _normEmail('zgluck@' + z + 'vivohc.com'));
      for (const v of ['zgluck@vivohc.com(primary)', 'a;b@c.com', 'a b@c.com', 'a[b]@c.com', '', null, undefined]) {
        assert.strictEqual(M.emailLooksValid(v), _emailLooksValid(v), JSON.stringify(v));
      }
    });
  }
}

// ─── клиент: гейты по исходнику ──────────────────────────────────────
if (htmlSrc) {
  section('floor-map-editor.html — все пути отправки зовут гейт и берут получателя по тумблеру');
  for (const name of ['_sendMoveInDirect', '_ntoSendRent', '_ntoSendDeposit', '_sendInvoiceWithLateFees',
    'createMoveInInvoices', 'openSplitMoveInRentModal', '_confirmSplitMoveInRent', '_triggerAutoInvoiceNowIfNeeded']) {
    t(`${name}: _tenantEmailProblem( и _unitStripeBillingEmail( в первых 3000 символах`, () => {
      const body = fnSource(htmlSrc, name, 3000);
      assert.ok(body.includes('_tenantEmailProblem('), name + ' does not call _tenantEmailProblem(');
      assert.ok(body.includes('_unitStripeBillingEmail('), name + ' does not call _unitStripeBillingEmail(');
    });
  }
  t('нигде не осталось emailOverride: u.email — получатель всегда через _unitStripeBillingEmail', () => {
    assert.strictEqual(count(htmlSrc, 'emailOverride: u.email'), 0);
  });
  t('Entry 101: гарды путей отправки получают ввод как есть (_bill.raw); нормализованный _bill.email в гард не уходит', () => {
    assert.strictEqual(count(htmlSrc, '_tenantEmailProblem(_bill.email)'), 0, 'остался гард с нормализованным адресом');
    assert.strictEqual(count(htmlSrc, 'const _emailErr = _tenantEmailProblem(_unitStripeBillingEmail(u).email)'), 0, 'остался inline-гард с нормализованным адресом');
    assert.strictEqual(count(htmlSrc, '_tenantEmailProblem(_bill.raw)'), 7, 'семь гардов через _bill.raw');
    assert.strictEqual(count(htmlSrc, 'const _emailErr = _tenantEmailProblem(_unitStripeBillingEmail(u).raw)'), 2, 'два inline-гарда через .raw');
  });
  t("_verifyAndStampAfterSend: матчит новый штамп депозита (m.purpose === 'deposit')", () => {
    assert.ok(fnSource(htmlSrc, '_verifyAndStampAfterSend', 4000).includes("m.purpose === 'deposit'"));
  });
  t("_verifyAndStampAfterSend: legacy-форма (m.purpose === 'custom' + «deposit» в описании) по-прежнему матчится", () => {
    assert.ok(fnSource(htmlSrc, '_verifyAndStampAfterSend', 4000).includes("m.purpose === 'custom'"));
  });

  section('floor-map-editor.html — Title Case при сохранении не считается сменой арендатора');
  t('saveUnitDetail: детектор смены арендатора сравнивает через _tenantKey(, email через _normEmail(, сырого prevTenant !== curTenant нет', () => {
    const body = fnSource(htmlSrc, 'saveUnitDetail', 6000);
    assert.ok(body.includes('_tenantKey('), 'no _tenantKey( in saveUnitDetail');
    assert.ok(body.includes('_normEmail('), 'no _normEmail( in saveUnitDetail');
    assert.ok(!body.includes('prevTenant !== curTenant'), 'raw prevTenant !== curTenant compare still present');
  });
  t('матчеры имени арендатора идут через _tenantKey: submitBouncedCheck, _convertProspectToTenant, _promoteProspectToTenant, _stampTenantAdded', () => {
    assert.strictEqual(count(htmlSrc, 'c.tenant === lastTenant.name'), 0, 'submitBouncedCheck still compares raw');
    assert.ok(fnSource(htmlSrc, 'submitBouncedCheck', 12000).includes('_tenantKey(c.tenant)'), 'submitBouncedCheck');
    assert.ok(fnSource(htmlSrc, '_convertProspectToTenant').includes('_tenantKey('), '_convertProspectToTenant');
    assert.ok(fnSource(htmlSrc, '_promoteProspectToTenant').includes('_tenantKey('), '_promoteProspectToTenant');
    assert.ok(fnSource(htmlSrc, '_stampTenantAdded').includes('_tenantKey('), '_stampTenantAdded');
  });
  t('saveGroupAssign и _promoteProspectToTenant пишут нормализованные контакты', () => {
    const g = fnSource(htmlSrc, 'saveGroupAssign', 3000);
    for (const fn of ['_normPersonName(', '_normCompanyName(', '_normEmail(', '_normPhone(']) assert.ok(g.includes(fn), 'saveGroupAssign lacks ' + fn);
    const p = fnSource(htmlSrc, '_promoteProspectToTenant');
    for (const fn of ['_normPersonName(', '_normEmail(', '_normPhone(']) assert.ok(p.includes(fn), '_promoteProspectToTenant lacks ' + fn);
  });
}

// ─── сервер ──────────────────────────────────────────────────────────
section('functions/index.js — блок «Entry 95: tenant email + Stripe error mapping»');
let S = null;
if (cfSrc) t('блок найден и исполняется, все 5 имён объявлены', () => { S = loadCF(cfSrc, M); });
else console.log('  (серверные кейсы пропущены — исходник не прочитан)');

if (S) {
  const { _TENANT_EMAIL_RE, _normTenantEmailCF, _isValidTenantEmail, _assertTenantEmail, _stripeErrToHttps } = S;

  section('_normTenantEmailCF / _isValidTenantEmail');
  t('та же нормализация, что у клиента: zero-width и пробел у точки/@ вырезаны, display-name извлечён, lowercase; прочие пробелы не склеиваются', () => {
    assert.strictEqual(_normTenantEmailCF('  ZGLUCK@VIVOHC .COM '), 'zgluck@vivohc.com');
    assert.strictEqual(_normTenantEmailCF('zgluck@\u200Bvivohc.com'), 'zgluck@vivohc.com');
    assert.strictEqual(_normTenantEmailCF('ZGLUCK @VIVOHC.COM'), 'zgluck@vivohc.com');
    assert.strictEqual(_normTenantEmailCF('Zev Gluck <zgluck@vivohc.com>'), 'zgluck@vivohc.com');
    assert.strictEqual(_normTenantEmailCF('a b@c.com'), 'a b@c.com');
    assert.strictEqual(_normTenantEmailCF('jdoe@gmail.com - Jane'), 'jdoe@gmail.com - jane');
    assert.strictEqual(_normTenantEmailCF(null), '');
    assert.strictEqual(_normTenantEmailCF(undefined), '');
  });
  t('_TENANT_EMAIL_RE — тот же строгий паттерн, что isValidEmail на клиенте', () => {
    assert.ok(_TENANT_EMAIL_RE instanceof RegExp, 'не RegExp');
    assert.strictEqual(_TENANT_EMAIL_RE.source, '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$');
  });
  t('_isValidTenantEmail: адрес инцидента и display-name вставка валидны после нормализации', () => {
    assert.strictEqual(_isValidTenantEmail('ZGLUCK@VIVOHC .COM'), true);
    assert.strictEqual(_isValidTenantEmail('zev@example.com'), true);
    assert.strictEqual(_isValidTenantEmail('Zev Gluck <zgluck@vivohc.com>'), true);
  });
  t('_isValidTenantEmail: пусто / null / без TLD / два @ / пробел не у точки / приписка / скобки / кавычки → false', () => {
    for (const v of ['', null, undefined, '   ', 'zgluck@vivohc', 'a@b@c.com', 'zgluck.vivohc.com',
      'a b@c.com', 'jdoe@gmail.com - Jane', 'zgluck@vivohc.com(primary)', '"zgluck"@vivohc.com']) {
      assert.strictEqual(_isValidTenantEmail(v), false, JSON.stringify(v));
    }
  });
  t('_isValidTenantEmail: длина ≤ 254 — 254 проходит, 255 нет', () => {
    assert.strictEqual(_isValidTenantEmail('a'.repeat(249) + '@x.io'), true);
    assert.strictEqual(_isValidTenantEmail('a'.repeat(250) + '@x.io'), false);
  });

  section('_assertTenantEmail — до любого вызова Stripe');
  const throwsHttps = (fn, code) => {
    let thrown = null;
    try { fn(); } catch (e) { thrown = e; }
    assert.ok(thrown, 'должно было упасть, но прошло');
    assert.ok(thrown instanceof HttpsError,
      'ожидался HttpsError, получили ' + (thrown.constructor && thrown.constructor.name) + ': ' + thrown.message);
    assert.strictEqual(thrown.code, code);
    return thrown;
  };
  t('валидный после нормализации → возвращает нормализованный адрес', () => {
    assert.strictEqual(_assertTenantEmail('ZGLUCK@VIVOHC .COM', 'invoicing'), 'zgluck@vivohc.com');
    assert.strictEqual(_assertTenantEmail(' Zev@Example.com '), 'zev@example.com');
  });
  t('пусто → failed-precondition, текст называет Tenant tab и шаг', () => {
    const e = throwsHttps(() => _assertTenantEmail('', 'creating the Stripe customer'), 'failed-precondition');
    assert.strictEqual(e.message, 'Unit has no tenant email — add one on the Tenant tab before creating the Stripe customer');
  });
  t('пусто без where → "… before invoicing"', () => {
    const e = throwsHttps(() => _assertTenantEmail(null), 'failed-precondition');
    assert.strictEqual(e.message, 'Unit has no tenant email — add one on the Tenant tab before invoicing');
  });
  t('невалидно → failed-precondition, в тексте адрес как прислан (trim) + подсказка про пробелы', () => {
    const e = throwsHttps(() => _assertTenantEmail('  ZGLUCK@VIVOHC  ', 'invoicing'), 'failed-precondition');
    assert.strictEqual(e.message,
      'Tenant email "ZGLUCK@VIVOHC" is not a valid address (check for spaces or typos) — fix it on the Tenant tab before invoicing');
  });

  section('_stripeErrToHttps — 4xx Stripe с настоящей причиной, транзиентные как есть');
  // Форма ошибок stripe-node: подкласс Error, .type = имя класса, .code, .statusCode.
  const stripeErr = (type, code, message) => Object.assign(new Error(message), { type, code, statusCode: 400 });
  const incident = () => stripeErr('StripeInvalidRequestError', 'email_invalid', 'Invalid email address: ZGLUCK@VIVOHC .COM');
  t('инцидент: 400 email_invalid → invalid-argument с причиной Stripe и контекстом, не INTERNAL', () => {
    const out = _stripeErrToHttps(incident(), 'stripe.customers.create');
    assert.ok(out instanceof HttpsError, 'ожидался HttpsError, получили ' + (out && out.constructor && out.constructor.name));
    assert.strictEqual(out.code, 'invalid-argument');
    assert.strictEqual(out.message, 'Stripe rejected the request (stripe.customers.create): Invalid email address: ZGLUCK@VIVOHC .COM');
  });
  t('без ctx → "Stripe rejected the request: <message>"', () => {
    assert.strictEqual(_stripeErrToHttps(incident()).message, 'Stripe rejected the request: Invalid email address: ZGLUCK@VIVOHC .COM');
  });
  t('пустой message → подставляется code, затем type', () => {
    assert.ok(_stripeErrToHttps(stripeErr('StripeInvalidRequestError', 'email_invalid', '')).message.endsWith(': email_invalid'));
    assert.ok(_stripeErrToHttps(stripeErr('StripeCardError', undefined, '')).message.endsWith(': StripeCardError'));
  });
  t('resource_missing → not-found', () => {
    assert.strictEqual(_stripeErrToHttps(stripeErr('StripeInvalidRequestError', 'resource_missing', 'No such customer: cus_x')).code, 'not-found');
  });
  t('карта → failed-precondition', () => {
    assert.strictEqual(_stripeErrToHttps(stripeErr('StripeCardError', 'card_declined', 'Your card was declined')).code, 'failed-precondition');
  });
  t('идемпотентность → aborted', () => {
    assert.strictEqual(_stripeErrToHttps(stripeErr('StripeIdempotencyError', undefined, 'Keys for idempotent requests…')).code, 'aborted');
  });
  t('права / аутентификация → permission-denied', () => {
    assert.strictEqual(_stripeErrToHttps(stripeErr('StripePermissionError', undefined, 'no permission')).code, 'permission-denied');
    assert.strictEqual(_stripeErrToHttps(stripeErr('StripeAuthenticationError', undefined, 'bad key')).code, 'permission-denied');
  });
  t('rate limit → resource-exhausted', () => {
    assert.strictEqual(_stripeErrToHttps(stripeErr('StripeRateLimitError', 'rate_limit', 'Too many requests')).code, 'resource-exhausted');
  });
  t('транзиентные StripeAPIError / StripeConnectionError возвращаются КАК ЕСТЬ (тот же объект) — их повторяет retry-слой клиента', () => {
    for (const type of ['StripeAPIError', 'StripeConnectionError']) {
      const e = stripeErr(type, undefined, 'upstream hiccup'); e.statusCode = 503;
      assert.strictEqual(_stripeErrToHttps(e, 'ctx'), e, type);
    }
  });
  t('не-Stripe ошибка, null/undefined, готовый HttpsError и объект с httpErrorCode — без изменений', () => {
    const plain = new Error('boom'); assert.strictEqual(_stripeErrToHttps(plain, 'ctx'), plain);
    const typed = Object.assign(new Error('x'), { type: 'TypeError' }); assert.strictEqual(_stripeErrToHttps(typed), typed);
    assert.strictEqual(_stripeErrToHttps(null), null);
    assert.strictEqual(_stripeErrToHttps(undefined), undefined);
    const h = new HttpsError('already-exists', 'dup'); assert.strictEqual(_stripeErrToHttps(h), h);
    const like = Object.assign(new Error('y'), { httpErrorCode: { status: 409 }, type: 'StripeInvalidRequestError' });
    assert.strictEqual(_stripeErrToHttps(like), like);
  });
  t('идемпотентно: повторный маппинг возвращает тот же HttpsError', () => {
    const once = _stripeErrToHttps(incident(), 'ctx');
    assert.strictEqual(_stripeErrToHttps(once, 'ctx'), once);
  });
}

// ─── сервер: гейты по исходнику (по месту вызова, не по числу вхождений) ─
if (cfSrc) {
  section('functions/index.js — адрес проверяется до Stripe, ошибки Stripe маппятся (гейты по месту вызова)');
  // Регион функции: от якоря до ближайшего следующего top-level объявления.
  const regionFrom = (start, what) => {
    const a = cfSrc.indexOf(start);
    if (a < 0) throw new Error(what + ': anchor "' + start + '" not found in functions/index.js');
    const ends = ['\nexports.', '\nasync function ', '\nfunction ', '\nconst '].map(m => cfSrc.indexOf(m, a + start.length)).filter(i => i >= 0);
    return cfSrc.slice(a, ends.length ? Math.min(...ends) : cfSrc.length);
  };
  // Тело createStripeInvoice лежит либо inline в exports.createStripeInvoice = onCall(,
  // либо вынесено в async function _createStripeInvoiceImpl( (agent-gateway): берём
  // от первого из этих якорей до exports.startAutoPay.
  const invoiceRegion = () => {
    const starts = ['async function _createStripeInvoiceImpl(', 'exports.createStripeInvoice = onCall(']
      .map(m => cfSrc.indexOf(m)).filter(i => i >= 0);
    if (!starts.length) throw new Error('createStripeInvoice not found in functions/index.js');
    const a = Math.min(...starts);
    const b = cfSrc.indexOf('exports.startAutoPay', a);
    if (b < 0) throw new Error('exports.startAutoPay not found after createStripeInvoice');
    return cfSrc.slice(a, b);
  };
  t("createStripeInvoice: _assertTenantEmail(…, 'invoicing') до Stripe и _stripeErrToHttps(e, 'customer' | 'invoice' | 'finalize')", () => {
    const r = invoiceRegion();
    assert.ok(r.includes('_assertTenantEmail('), 'no _assertTenantEmail( in createStripeInvoice');
    assert.ok(r.includes("'invoicing')"), "where-литерал 'invoicing' не найден");
    for (const ctx of ['customer', 'invoice', 'finalize']) {
      assert.ok(r.includes(`_stripeErrToHttps(e, '${ctx}')`), `missing _stripeErrToHttps(e, '${ctx}') in createStripeInvoice`);
    }
  });
  t("ensureStripeCustomer: _assertTenantEmail( до Stripe и _stripeErrToHttps(e, 'customer')", () => {
    const r = regionFrom('exports.ensureStripeCustomer = onCall(', 'ensureStripeCustomer');
    assert.ok(r.includes('_assertTenantEmail('), 'no _assertTenantEmail( in ensureStripeCustomer');
    assert.ok(r.includes("_stripeErrToHttps(e, 'customer')"), "no _stripeErrToHttps(e, 'customer') in ensureStripeCustomer");
  });

  // ─── Entry 96 ───
  t("startAutoPay: _assertTenantEmail(unit.email, 'starting AutoPay') до Stripe, _stripeErrToHttps(e, 'customer' | 'checkout'), ключ stripeCustomers — нормализованный email", () => {
    const r = regionFrom('exports.startAutoPay = onCall(', 'startAutoPay');
    assert.ok(r.includes("_assertTenantEmail(unit.email, 'starting AutoPay')"), "no _assertTenantEmail(unit.email, 'starting AutoPay') in startAutoPay");
    assert.ok(r.includes("_stripeErrToHttps(e, 'customer')"), "no _stripeErrToHttps(e, 'customer') in startAutoPay");
    assert.ok(r.includes("_stripeErrToHttps(e, 'checkout')"), "no _stripeErrToHttps(e, 'checkout') in startAutoPay");
    assert.ok(!r.includes('const email = unit.email;'), 'raw unit.email still assigned in startAutoPay');
    assert.ok(!r.includes('emailLower'), 'emailLower still used in startAutoPay — the key must be the normalized email');
    assert.ok(r.includes('stripeCustomers[email]'), 'stripeCustomers is not keyed by the normalized email in startAutoPay');
  });
  t("Entry 95 block: require('./lib/contact.js') — нормализаторы берутся из общего модуля, не дублируются", () => {
    const block = sliceBetween(cfSrc, CF_OPEN, ENTRY_CLOSE, 'functions/index.js');
    assert.ok(block.includes("require('./lib/contact.js')"), "no require('./lib/contact.js') in the Entry 95 block");
    assert.ok(block.includes('_contact.normEmail('), '_normTenantEmailCF does not delegate to _contact.normEmail');
    assert.ok(block.includes('_contact.emailLooksValid('), '_isValidTenantEmail does not delegate to _contact.emailLooksValid');
  });
  t('_dsSanitizeTenancy: tenant / company / email / tel идут через _contact.* (та же гигиена, что на десктопе при Save)', () => {
    const a = cfSrc.indexOf('function _dsSanitizeTenancy(t) {');
    const b = cfSrc.indexOf('\nexports.dsSendEnvelope', a);
    assert.ok(a >= 0 && b > a, '_dsSanitizeTenancy / dsSendEnvelope not found');
    const r = cfSrc.slice(a, b);
    for (const fn of ['_contact.normPersonName(', '_contact.normCompanyName(', '_contact.normEmail(', '_contact.emailLooksValid(', '_contact.normPhone(']) {
      assert.ok(r.includes(fn), '_dsSanitizeTenancy lacks ' + fn);
    }
    assert.ok(!r.includes('.test(email)'), 'own email regex still in _dsSanitizeTenancy');
  });
}

// ─── Entry 96: мобильный клиент ─────────────────────────────────────
if (mAppSrc && leaseSrc) {
  section('Entry 96 — m/: модуль контактов доезжает до экрана договора и применяется до отправки');
  t("m/app.js: грузит './lib/contact.js' динамически (с ?v=) и отдаёт contact в ctx", () => {
    assert.ok(mAppSrc.includes("'./lib/contact.js'"), "m/app.js does not import './lib/contact.js'");
    assert.ok(/callCF, contact/.test(mAppSrc), 'ctx() in m/app.js does not carry contact');
    assert.ok(mAppSrc.includes('globalThis.sfaContact'), 'm/app.js does not read globalThis.sfaContact');
  });
  const region = (src, start, what) => {
    const a = src.indexOf(start);
    if (a < 0) throw new Error(what + ': anchor "' + start + '" not found in m/ui/lease.js');
    const e = src.indexOf('\n}\n', a);
    return src.slice(a, e > 0 ? e + 3 : src.length);
  };
  t('m/ui/lease.js send(): имя / компания / телефон / email нормализуются ДО сборки документа, подписанта и tenancy', () => {
    const r = region(leaseSrc, 'async function send(ctx, L) {', 'send');
    for (const fn of ['normPersonName(', 'normCompanyName(', 'normPhone(', 'normEmail(', 'emailLooksValid(']) assert.ok(r.includes(fn), 'send() lacks ' + fn);
    const norm = r.indexOf('normPersonName('), doc = r.indexOf('leaseFields(');
    assert.ok(norm >= 0 && doc > norm, 'normalization must come before leaseFields( — the document build');
    assert.ok(r.includes("'That recipient email is not valid.'"), 'invalid-after-repair refusal text changed');
    assert.ok(!r.includes('EMAIL_RE.test(email)'), 'send() still gates by the raw EMAIL_RE');
  });
  t('m/ui/lease.js: Continue, подсказка шага 3 и фильтр людей судят адрес через emailOk( (ремонт пробела у точки/@)', () => {
    assert.ok(region(leaseSrc, 'export function foot(ctx) {', 'foot').includes('emailOk(ctx, L.email)'), 'foot() Continue gate');
    assert.ok(region(leaseSrc, 'function step3(ctx, L, hit) {', 'step3').includes('emailOk(ctx, L.email)'), 'step3 hint');
    assert.ok(region(leaseSrc, 'function step2(ctx, L) {', 'step2').includes('emailOk(ctx, u.email)'), 'people filter');
  });
}

// ─── Entry 96: retry-слой десктопа ───────────────────────────────────
if (htmlSrc) {
  section('Entry 96 — stripeCallable: коды модульного SDK (functions/<code>) ретраятся только для безопасных вызовов');
  const SC_OPEN = 'function stripeCallable(name) {';
  let scBody = null;
  t('function stripeCallable(name) {…} извлекается из исходника; срез префикса и allowlist на месте', () => {
    const a = htmlSrc.indexOf('\n' + SC_OPEN);
    assert.ok(a >= 0, 'stripeCallable not found');
    const e = htmlSrc.indexOf('\n}\n', a);
    assert.ok(e > a, 'end of stripeCallable not found');
    scBody = htmlSrc.slice(a + 1, e + 2);
    assert.ok(scBody.includes("replace(/^functions\\//, '')"), 'isRetriable does not strip the functions/ prefix');
    assert.ok(scBody.includes('_CF_RETRY_SAFE'), 'no _CF_RETRY_SAFE allowlist in stripeCallable');
  });
  if (scBody) {
    // Стенд: fbSync.sdk.httpsCallable отдаёт функцию-счётчик; setTimeout мгновенный; console тихий.
    const run = async (name, impl, data) => {
      const calls = [];
      const fbSync = { enabled: true, functions: {}, sdk: { httpsCallable: (fns, n) => async (d) => { calls.push({ n, d }); return impl(calls.length, d); } } };
      const silent = { info() {}, warn() {}, error() {}, log() {} };
      const stripeCallable = new Function('fbSync', '_fbEnsureFunctionsModule', '_newTraceId', 'setTimeout', 'console',
        scBody + '\n; return stripeCallable;')(fbSync, () => {}, () => 't_test', (fn) => fn(), silent);
      let result, error = null;
      try { result = await stripeCallable(name)(data || { a: 1 }); } catch (e) { error = e; }
      return { attempts: calls.length, result, error, calls };
    };
    const fnErr = (code, message) => Object.assign(new Error(message === undefined ? code : message), { code });
    const always = (code, message) => () => { throw fnErr(code, message); };
    const expectAttempts = (label, name, impl, attempts, extra) => ta(label, async () => {
      const r = await run(name, impl);
      assert.strictEqual(r.attempts, attempts, name + ': ' + r.attempts + ' attempt(s), expected ' + attempts);
      if (extra) extra(r);
    });
    await expectAttempts('functions/internal на createStripeInvoice (ключ идемпотентности в payload) → 3 попытки, ошибка пробрасывается',
      'createStripeInvoice', always('functions/internal', 'internal'), 3, r => assert.strictEqual(r.error && r.error.code, 'functions/internal'));
    await expectAttempts('functions/internal на ensureStripeCustomer (search-then-create) → 3 попытки', 'ensureStripeCustomer', always('functions/internal', 'internal'), 3);
    await expectAttempts('functions/unavailable на listStripeInvoices (чтение) → 3 попытки', 'listStripeInvoices', always('functions/unavailable', 'unavailable'), 3);
    await expectAttempts('functions/deadline-exceeded на listBankTransactions (чтение) → 3 попытки', 'listBankTransactions', always('functions/deadline-exceeded', 'deadline-exceeded'), 3);
    await expectAttempts('functions/resource-exhausted на listAuditEntries → 3 попытки', 'listAuditEntries', always('functions/resource-exhausted', 'rate limited'), 3);
    await expectAttempts('голый internal (compat SDK) на listBackups → тоже ретраится', 'listBackups', always('internal'), 3);
    await expectAttempts('functions/internal на restoreBackup (мутация без идемпотентности) → 1 попытка', 'restoreBackup', always('functions/internal', 'internal'), 1,
      r => assert.strictEqual(r.error && r.error.code, 'functions/internal'));
    await expectAttempts('functions/deadline-exceeded на stripeResendInvoice → 1 попытка (второй resend недопустим)', 'stripeResendInvoice', always('functions/deadline-exceeded', 'deadline-exceeded'), 1);
    await expectAttempts('functions/internal на startAutoPay → 1 попытка', 'startAutoPay', always('functions/internal', 'internal'), 1);
    await expectAttempts('functions/unavailable на voidOrDeleteStripeInvoice → 1 попытка', 'voidOrDeleteStripeInvoice', always('functions/unavailable', 'unavailable'), 1);
    await expectAttempts('functions/aborted на markInvoicePaidOutOfBand → 1 попытка', 'markInvoicePaidOutOfBand', always('functions/aborted', 'aborted'), 1);
    await expectAttempts('functions/failed-precondition на createStripeInvoice → 1 попытка (бизнес-отказ, напр. невалидный email)', 'createStripeInvoice', always('functions/failed-precondition', 'Tenant email "ZGLUCK@VIVOHC" is not a valid address'), 1);
    await expectAttempts('functions/invalid-argument на ensureStripeCustomer → 1 попытка (Stripe 4xx через _stripeErrToHttps)', 'ensureStripeCustomer', always('functions/invalid-argument', 'Stripe rejected the request (customer): Invalid email address'), 1);
    await expectAttempts('functions/permission-denied на listStripeInvoices → 1 попытка', 'listStripeInvoices', always('functions/permission-denied', 'permission-denied'), 1);
    await expectAttempts('functions/not-found на listBankTransactions → 1 попытка', 'listBankTransactions', always('functions/not-found', 'not-found'), 1);
    await expectAttempts("network-level ('Failed to fetch', без httpErrorCode) на restoreBackup → 3 попытки: запрос не дошёл до сервера", 'restoreBackup', () => { throw new Error('Failed to fetch'); }, 3);
    await ta('успех со второй попытки возвращает ответ; _traceId вызывающего сохраняется во всех попытках', async () => {
      const r = await run('listStripeInvoices', (n) => { if (n < 2) throw fnErr('functions/unavailable', 'unavailable'); return { data: { ok: n } }; }, { _traceId: 't_mine', q: 1 });
      assert.strictEqual(r.attempts, 2);
      assert.deepStrictEqual(r.result, { data: { ok: 2 } });
      for (const c of r.calls) { assert.strictEqual(c.d._traceId, 't_mine'); assert.strictEqual(c.d.q, 1); }
    });
    await ta('без _traceId вызывающего каждая попытка несёт один и тот же сгенерированный id', async () => {
      const r = await run('listStripeInvoices', always('functions/unavailable', 'unavailable'));
      assert.strictEqual(r.attempts, 3);
      for (const c of r.calls) assert.strictEqual(c.d._traceId, 't_test');
    });
    t('allowlist _CF_RETRY_SAFE: только чтения + createStripeInvoice / ensureStripeCustomer', () => {
      const m = scBody.match(/_CF_RETRY_SAFE = new Set\(\[([\s\S]*?)\]\)/);
      assert.ok(m, 'allowlist literal not found');
      const names = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map(x => x[1]).sort();
      assert.deepStrictEqual(names, ['createStripeInvoice', 'diagnoseBankAccount', 'ensureStripeCustomer', 'getBankSyncHealthSummary',
        'getScalingReconcileHistory', 'listAuditEntries', 'listAutoAppliedHistory', 'listBackups', 'listBankTransactions',
        'listBankTransactionsForUnit', 'listStripeInvoices'].sort());
    });
  }
  t('_auditOutboxDrain: код ошибки без префикса functions/ — «permanent» записи реально выбрасываются из очереди', () => {
    const body = fnSource(htmlSrc, '_auditOutboxDrain', 6000);
    assert.ok(body.includes("replace(/^functions\\//, '')"), 'isPermanent still compares the prefixed code');
  });
}

// ─── клиент и сервер согласны ────────────────────────────────────────
if (C && S) {
  section('Клиент и сервер согласны — CF никогда не отвергает то, что пропустил клиентский гейт');
  const samples = EMAIL_SAMPLES;
  t('один вердикт на одних адресах', () => {
    for (const s of samples) {
      assert.strictEqual(S._isValidTenantEmail(s), C._tenantEmailProblem(s) === null, 'расходятся на ' + JSON.stringify(s));
    }
  });
  t('одна и та же нормализованная форма', () => {
    for (const s of samples) assert.strictEqual(S._normTenantEmailCF(s), C._normEmail(s).email, JSON.stringify(s));
  });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
