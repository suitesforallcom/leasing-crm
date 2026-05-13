#!/usr/bin/env node
// =====================================================================
// tests/overdue.test.js
//
// Реальный гейт (не доки) для класса багов «overdue/prorate/grace
// разъезжаются между копиями формулы». Тест выдёргивает функции
// _computeProrate и _monthBilling из floor-map-editor.html, eval'ит их
// в Node-песочнице и прогоняет 6 кейсов, покрывающих:
//   1. lease start не-1-е, ym=месяц старта, до конца грейса → not overdue
//   2. lease start не-1-е, ym=месяц старта, после грейса → overdue
//   3. lease start не-1-е, ym=след. месяц, after календарный 1-е+grace → overdue
//   4. lease start не-1-е, ym=прошлый месяц → monthRent = rent
//   5. lease start не-1-е, ym=месяц старта → monthRent = prorated
//   6. lease start 1-го → monthRent = rent для каждого месяца (нет prorate)
//
// Run: node tests/overdue.test.js (или npm test).
// Exit code: 0 — все ассерты прошли, 1 — хотя бы один упал.
// =====================================================================

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, '..', 'floor-map-editor.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// Выдёргиваем тело двух функций по сигнатуре `function <name>(...)`.
// Так как файл — single-page с инлайн-скриптом, проще всего regex по
// заголовку функции и захват тела до соответствующей закрывающей скобки.
function extractFunction(src, name) {
  const reHead = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'g');
  const head = reHead.exec(src);
  if (!head) throw new Error('extractFunction: not found — ' + name);
  let depth = 1;
  let i = head.index + head[0].length;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(head.index, i);
}

const proSrc  = extractFunction(html, '_computeProrate');
const billSrc = extractFunction(html, '_monthBilling');

// Песочница — eval две функции и вытащить их ссылками.
const sandbox = new Function(
  proSrc + '\n' + billSrc + '\nreturn { _computeProrate, _monthBilling };'
);
const { _computeProrate, _monthBilling } = sandbox();

// ---------------------------------------------------------------------
// Test runner — минимальный, без зависимостей. Печатает PASS / FAIL по
// каждому кейсу, в конце суммарный счёт + non-zero exit при провале.
// ---------------------------------------------------------------------
let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (e) {
    fail++;
    console.error('  FAIL  ' + name);
    console.error('        ' + e.message);
  }
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label ? label + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function approxEq(actual, expected, label, eps = 0.01) {
  if (Math.abs(actual - expected) > eps) {
    throw new Error((label ? label + ': ' : '') + 'expected ~' + expected + ', got ' + actual);
  }
}

console.log('\n=== overdue / prorate / grace consolidation tests ===\n');

// Контекст: rent=$700, lease start 2026-05-12 (среда), grace=5 дней.
// _computeProrate('2026-05-12') → 20/31 days → $451.61
const RENT = 700;
const LEASE = '2026-05-12';
const GRACE = 5;

test('proration for May 2026 (lease 2026-05-12) = $451.61 (20/31)', () => {
  const p = _computeProrate(RENT, LEASE);
  if (!p) throw new Error('_computeProrate returned null');
  eq(p.ym, '2026-05', 'ym');
  eq(p.daysRemaining, 20, 'daysRemaining');
  eq(p.daysInMonth, 31, 'daysInMonth');
  approxEq(p.prorated, 451.61, 'prorated');
});

test('1. lease-start month, today = lease start day — NOT overdue (grace ahead)', () => {
  const now = new Date('2026-05-12T12:00:00');
  const mb = _monthBilling(RENT, '2026-05', LEASE, GRACE, now);
  eq(mb.isOverdueByDate, false, 'isOverdueByDate on day of move-in');
  eq(mb.isProratedMonth, true, 'isProratedMonth');
  approxEq(mb.monthRent, 451.61, 'monthRent — should be prorated');
  // dueDate должен быть leaseStart + grace = 17-е мая
  eq(mb.dueDate.getDate(), 17, 'dueDate.getDate()');
  eq(mb.dueDate.getMonth(), 4, 'dueDate.getMonth() (0-indexed May=4)');
});

test('2. lease-start month, today = grace+1 days after lease start — OVERDUE', () => {
  // lease 12-е, grace=5 → дедлайн 17-е → 18-е = overdue.
  const now = new Date('2026-05-18T12:00:00');
  const mb = _monthBilling(RENT, '2026-05', LEASE, GRACE, now);
  eq(mb.isOverdueByDate, true, 'isOverdueByDate after grace');
  approxEq(mb.monthRent, 451.61, 'monthRent still prorated');
});

test('3. next month after lease-start, today = 6-е (past 1-е+grace) — OVERDUE', () => {
  // ym='2026-06', dueDate должен быть 1 июня + 5 = 6 июня.
  // Сегодня 7 июня → past grace.
  const now = new Date('2026-06-07T12:00:00');
  const mb = _monthBilling(RENT, '2026-06', LEASE, GRACE, now);
  eq(mb.isOverdueByDate, true, 'June 7 > June 6 grace cutoff');
  eq(mb.isProratedMonth, false, 'June is NOT prorated month');
  eq(mb.monthRent, RENT, 'monthRent = full rent for non-start month');
  eq(mb.dueDate.getDate(), 6, 'dueDate = 1st + grace = 6th');
  eq(mb.dueDate.getMonth(), 5, 'dueDate.getMonth() (0-indexed June=5)');
});

test('4. month BEFORE lease start (anomaly) — monthRent = rent, not prorated', () => {
  // ym='2026-04' — до lease start 2026-05-12. _monthBilling всё равно
  // вернёт полную rent (он не знает про «до lease»; это ответственность
  // вызывающего цикла — пропускать такие месяцы). Главное — НЕ путать
  // апрель с prorated-месяцем.
  const now = new Date('2026-05-12T12:00:00');
  const mb = _monthBilling(RENT, '2026-04', LEASE, GRACE, now);
  eq(mb.isProratedMonth, false, 'April is NOT proratedMonth');
  eq(mb.monthRent, RENT, 'monthRent = full rent for non-start month');
});

test('5. lease start = 1-го числа — без prorate, monthRent = rent в start month', () => {
  // Лизе с 1 июня — _computeProrate возвращает null (day === 1).
  // _monthBilling должен корректно отработать и вернуть rent.
  const now = new Date('2026-06-03T12:00:00');
  const mb = _monthBilling(RENT, '2026-06', '2026-06-01', GRACE, now);
  eq(mb.isProratedMonth, false, 'June 1 start → no prorate');
  eq(mb.monthRent, RENT, 'monthRent = full rent');
  // Грейс анкорится к 1 июня + 5 = 6 июня. Сегодня 3 — not overdue.
  eq(mb.isOverdueByDate, false, '3 < 6 → not overdue');
  eq(mb.dueDate.getDate(), 6, 'dueDate.getDate()');
});

test('6. leaseStartIso пустой — fallback на (1-е + grace), без prorate', () => {
  const now = new Date('2026-05-10T12:00:00');
  const mb = _monthBilling(RENT, '2026-05', '', GRACE, now);
  eq(mb.isProratedMonth, false);
  eq(mb.monthRent, RENT);
  eq(mb.leaseStartYm, null);
  // dueDate = 1 мая + 5 = 6 мая → 10 > 6 → overdue
  eq(mb.isOverdueByDate, true);
});

test('7. graceDays = 0 — month-start = due date (no buffer)', () => {
  const now = new Date('2026-05-13T12:00:00');
  const mb = _monthBilling(RENT, '2026-05', LEASE, 0, now);
  // Якорь — leaseStart + 0 = 12 мая. Сегодня 13 → overdue.
  eq(mb.dueDate.getDate(), 12);
  eq(mb.isOverdueByDate, true);
});

test('8. February leap year — daysInMonth = 29 (proration math)', () => {
  // 2024-02-15 в високосный год → 15 дней оставшихся из 29.
  const p = _computeProrate(RENT, '2024-02-15');
  eq(p.daysInMonth, 29, 'Feb 2024 = 29 days');
  eq(p.daysRemaining, 15, 'Feb 15..29 = 15 days inclusive');
});

console.log('\n=== Results: ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail > 0 ? 1 : 0);
