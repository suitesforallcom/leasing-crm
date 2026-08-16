/**
 * termsOf — единое правило денег мастера договора (m/ui/lease.js).
 * Его читают ТРИ потребителя: сводка перед отправкой, поля документа и
 * заведение аренды. Разойдутся — в договоре у арендатора будет одна сумма,
 * в базе другая. Функцию достаём ИЗ ФАЙЛА, копию не держим.
 *
 * node tests/leaseterms.test.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'm', 'ui', 'lease.js'), 'utf8');
const from = src.indexOf('function termsOf(L, u) {');
const to = src.indexOf('\nfunction leaseFields', from);
if (from < 0 || to < 0) throw new Error('termsOf не найдена в m/ui/lease.js');
const termsOf = new Function(src.slice(from, to) + '; return termsOf;')();

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); fail++; } };

const unit = { contractRent: 0, rent: 1700, deposit: 1700 };

t('пустые поля → значения юнита', () => {
  const r = termsOf({ rent: '', deposit: '' }, unit);
  assert.strictEqual(r.rent, 1700); assert.strictEqual(r.deposit, 1700);
});
t('вписанные значения выигрывают', () => {
  const r = termsOf({ rent: '1500', deposit: '1800' }, unit);
  assert.strictEqual(r.rent, 1500); assert.strictEqual(r.deposit, 1800);
});
t('ЯВНЫЙ ноль — это ноль, а не значение юнита (прощёный депозит)', () => {
  const r = termsOf({ rent: '', deposit: '0' }, unit);
  assert.strictEqual(r.deposit, 0, 'ноль подменился значением юнита — в договор уйдёт чужая сумма');
});
t('ноль в ренте тоже остаётся нулём', () => {
  assert.strictEqual(termsOf({ rent: '0', deposit: '' }, unit).rent, 0);
});
t('contractRent бьёт проформу rent (MONEY RULE)', () => {
  assert.strictEqual(termsOf({ rent: '', deposit: '' }, { contractRent: 1450, rent: 1700, deposit: 0 }).rent, 1450);
});
t('пробелы вокруг числа не мешают', () => {
  assert.strictEqual(termsOf({ rent: ' 1500 ', deposit: '' }, unit).rent, 1500);
});
t('мусор в поле → значение юнита, а не NaN', () => {
  const r = termsOf({ rent: 'abc', deposit: '' }, unit);
  assert.strictEqual(r.rent, 1700);
});
t('отрицательное → значение юнита, а не минус', () => {
  assert.strictEqual(termsOf({ rent: '-500', deposit: '' }, unit).rent, 1700);
});
t('null/undefined ведут себя как пустое', () => {
  const r = termsOf({ rent: null, deposit: undefined }, unit);
  assert.strictEqual(r.rent, 1700); assert.strictEqual(r.deposit, 1700);
});
t('дробные суммы сохраняются', () => {
  assert.strictEqual(termsOf({ rent: '1450.50', deposit: '' }, unit).rent, 1450.5);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
