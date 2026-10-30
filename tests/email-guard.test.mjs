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
 * node tests/email-guard.test.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(here, '..', 'floor-map-editor.html');
const CF_PATH = path.join(here, '..', 'functions', 'index.js');

const CLIENT_OPEN = '// ─── Entry 95: tenant contact hygiene ───';
const CF_OPEN = '// ─── Entry 95: tenant email + Stripe error mapping ───';
const ENTRY_CLOSE = '// ─── /Entry 95 ───';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); fail++; } };
const section = (title) => console.log('\n' + title);

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

function loadCF(src) {
  const block = sliceBetween(src, CF_OPEN, ENTRY_CLOSE, 'functions/index.js');
  return evalBlock(block, [
    '_TENANT_EMAIL_RE', '_normTenantEmailCF', '_isValidTenantEmail', '_assertTenantEmail', '_stripeErrToHttps',
  ], { HttpsError, logger });
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
if (cfSrc) t('блок найден и исполняется, все 5 имён объявлены', () => { S = loadCF(cfSrc); });
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
}

// ─── клиент и сервер согласны ────────────────────────────────────────
if (C && S) {
  section('Клиент и сервер согласны — CF никогда не отвергает то, что пропустил клиентский гейт');
  const samples = ['ZGLUCK@VIVOHC .COM', 'zev@example.com', 'Zev@Example.com', '  ok@x.com  ', 'zgluck@vivohc',
    'a@b@c.com', 'zgluck.vivohc.com', '', '   ', 'a\u200Bb@c.com', 'J CASHAW@VIVOHC.COM', 'NOT AN EMAIL',
    'ZGLUCK @VIVOHC.COM', 'zgluck@vivohc. com', 'a b@c.com', 'a@b.c om', 'Zev Gluck <zgluck@vivohc.com>',
    'zgluck@vivohc.com extra', 'jdoe@gmail.com - Jane', 'zgluck@vivohc.com(primary)', '"zgluck"@vivohc.com'];
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
