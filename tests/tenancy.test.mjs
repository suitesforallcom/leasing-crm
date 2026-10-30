/**
 * Валидатор заявки на аренду из dsSendEnvelope (functions/index.js).
 * Достаём функцию ИЗ ФАЙЛА, а не копируем: копия разошлась бы с задеплоенной,
 * и тест начал бы охранять несуществующий код. Здесь проверяются деньги и срок
 * договора, которые приходят с телефона — то есть с клавиатуры в чужом офисе.
 *
 * node tests/tenancy.test.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'functions', 'index.js'), 'utf8');
const from = src.indexOf('function _dsSanitizeTenancy(t) {');
const to = src.indexOf('\nexports.dsSendEnvelope', from);
if (from < 0 || to < 0) throw new Error('_dsSanitizeTenancy не найдена в functions/index.js');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
// Entry 96: функция зовёт _contact.* — общий модуль контактов грузим настоящим CommonJS require.
const contact = createRequire(import.meta.url)(path.join(here, '..', 'functions', 'lib', 'contact.js'));
const sanitize = new Function('HttpsError', '_contact', src.slice(from, to) + '; return _dsSanitizeTenancy;')(HttpsError, contact);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); fail++; } };
const rejects = (name, arg, fragment) => t(name, () => {
  let thrown = null;
  try { sanitize(arg); } catch (e) { thrown = e; }
  assert.ok(thrown, 'должно было упасть, но прошло');
  if (fragment) assert.ok(String(thrown.message).includes(fragment), 'другое сообщение: ' + thrown.message);
});

t('нет заявки → аренду не заводим', () => assert.strictEqual(sanitize(null), null));
t('нормальная аренда проходит и нормализуется', () => {
  const r = sanitize({ tenant: '  Jasmine Kennedy ', email: 'J@Ex.com', tel: '(727) 555-0134',
    leaseStart: '2026-09-01', leaseEnd: '2027-08-31', contractRent: '1700.005', deposit: 1700 });
  assert.strictEqual(r.tenant, 'Jasmine Kennedy');
  assert.strictEqual(r.email, 'j@ex.com');             // Entry 96: lowercase, как на десктопе
  assert.strictEqual(r.tel, '727-555-0134');           // Entry 96: XXX-XXX-XXXX
  assert.strictEqual(r.contractRent, 1700.01);         // до цента, не до доллара
  assert.strictEqual(r.deposit, 1700);
});
t('арендатор может быть только компанией', () => assert.strictEqual(sanitize({ company: 'Acme LLC' }).company, 'Acme LLC'));
t('високосное 29 февраля — валидная дата', () => assert.strictEqual(sanitize({ tenant: 'A', leaseStart: '2028-02-29' }).leaseStart, '2028-02-29'));
t('пустые деньги дают 0, а не NaN', () => {
  const r = sanitize({ tenant: 'A' });
  assert.strictEqual(r.contractRent, 0); assert.strictEqual(r.deposit, 0);
});

rejects('без имени и без компании', { email: 'a@b.co' }, 'tenant name or company');
rejects('невалидная почта', { tenant: 'A', email: 'not-an-email' }, 'valid address');
rejects('дата не в формате ISO', { tenant: 'A', leaseStart: '09/01/2026' }, 'YYYY-MM-DD');
rejects('31 февраля (движок молча сдвинул бы на март)', { tenant: 'A', leaseStart: '2026-02-31' }, 'real date');
rejects('29 февраля в невисокосный год', { tenant: 'A', leaseStart: '2026-02-29' }, 'real date');
rejects('13-й месяц', { tenant: 'A', leaseStart: '2026-13-01' }, 'real date');
rejects('конец договора раньше начала', { tenant: 'A', leaseStart: '2026-09-01', leaseEnd: '2026-08-01' }, 'before leaseStart');
rejects('отрицательная ставка', { tenant: 'A', contractRent: -5 }, 'out of range');
rejects('нечисловая ставка', { tenant: 'A', contractRent: 'abc' }, 'out of range');
rejects('абсурдная ставка', { tenant: 'A', contractRent: 99999999 }, 'out of range');
rejects('имя длиннее лимита', { tenant: 'x'.repeat(201) }, 'too long');
rejects('заявка не объект', 'строка', 'must be an object');
// Entry 96: контакты с телефона проходят ту же гигиену, что на десктопе при Save —
// общий модуль functions/lib/contact.js (инъекция _contact выше).
t('«кричащее» имя и компания → Title Case; смешанный регистр не трогаем', () => {
  const r = sanitize({ tenant: 'ZEV GLUCK', company: 'VIVO HEALTHCARE CONSULTING, LLC' });
  assert.strictEqual(r.tenant, 'Zev Gluck'); assert.strictEqual(r.company, 'Vivo Healthcare Consulting, LLC');
  assert.strictEqual(sanitize({ tenant: 'McDonald' }).tenant, 'McDonald');
  assert.strictEqual(sanitize({ company: 'iPhone Repair LLC' }).company, 'iPhone Repair LLC');
});
t('email инцидента «ZGLUCK@VIVOHC .COM» чинится и опускается в регистр; display-name вставка → адрес', () => {
  assert.strictEqual(sanitize({ tenant: 'A', email: 'ZGLUCK@VIVOHC .COM' }).email, 'zgluck@vivohc.com');
  assert.strictEqual(sanitize({ tenant: 'A', email: 'Zev Gluck <zgluck@vivohc.com>' }).email, 'zgluck@vivohc.com');
  assert.strictEqual(sanitize({ tenant: 'A', email: '  Zev@Example.com ' }).email, 'zev@example.com');
  assert.strictEqual(sanitize({ tenant: 'A' }).email, '');
});
t('телефон → XXX-XXX-XXXX для 10 цифр и 1+10; международный / добавочный только чистится', () => {
  assert.strictEqual(sanitize({ tenant: 'A', tel: '(347) 563-7418' }).tel, '347-563-7418');
  assert.strictEqual(sanitize({ tenant: 'A', tel: '+1 347 563 7418' }).tel, '347-563-7418');
  assert.strictEqual(sanitize({ tenant: 'A', tel: '+44 20 7946 0958' }).tel, '+44 20 7946 0958');
  assert.strictEqual(sanitize({ tenant: 'A', tel: '347-563-7418   x12' }).tel, '347-563-7418 x12');
});
rejects('email с «прозой» после ремонта (скобки)', { tenant: 'A', email: 'zgluck@vivohc.com(primary)' }, 'valid address');
rejects('пробел не у точки/@ не склеивается → отказ', { tenant: 'A', email: 'a b@c.com' }, 'valid address');
rejects('приписка после адреса не склеивается → отказ', { tenant: 'A', email: 'jdoe@gmail.com - Jane' }, 'valid address');
rejects('«кричащее» имя остаётся именем: email в поле имени — по-прежнему отказ', { tenant: 'ZGLUCK@VIVOHC.COM' }, 'looks like an email');


console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
