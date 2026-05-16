#!/usr/bin/env node
// =============================================================================
// scripts/test-table-sort.mjs
// -----------------------------------------------------------------------------
// Тест-харнесс для универсальной сортировки таблиц.
//
// ЦЕЛЬ: гарантировать что sort, добавленный в floor-map-editor.html по запросу
// CLAUDE.md §14 (sort by header), — это ЧИСТО UI операция: входная коллекция
// строк остаётся той же по count / IDs / суммам после любого sort. Иначе
// оператор увидит "после клика по заголовку у меня одна строка пропала" — это
// и есть тот случай "что-то поехало после сортировки", про который спрашивал
// оператор.
//
// КАК РАБОТАЕТ:
//   1. Читаем floor-map-editor.html как текст.
//   2. Находим определения applyTableSort / readTableSort / writeTableSort
//      по сигнатурам и eval-им в изолированном scope с моком localStorage.
//   3. Прогоняем серию инвариантов на синтетических данных:
//        a. Same row count, same set of IDs, same sum of `total`
//           — для каждой колонки, для asc И desc.
//        b. Stability — записи с одинаковыми sortValue сохраняют исходный порядок.
//        c. Missing values (null / undefined / NaN) уезжают в конец КАК в asc,
//           так и в desc.
//        d. Re-running sort с тем же state даёт идентичный результат
//           (детерминизм).
//
// ЗАПУСК:
//   node scripts/test-table-sort.mjs
//
// EXIT CODES:
//   0 — все инварианты прошли
//   1 — хотя бы один fail (с подробностями в stderr)
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = resolve(__dirname, '..', 'floor-map-editor.html');

// ---- Извлекаем чистые функции из HTML ---------------------------------------
//
// Подход: матчим function-сигнатуру и до последующей function-сигнатуры
// (или закрывающего </script>). Так мы получаем тело функции БЕЗ DOM-зависимостей.
// applyTableSort / readTableSort / writeTableSort — pure-ish (только
// localStorage в read/writeTableSort, который мы мокаем).

const html = readFileSync(HTML_PATH, 'utf8');

function extractFunction(name) {
  const re = new RegExp(`(function\\s+${name}\\s*\\([^)]*\\)\\s*\\{)`);
  const start = html.search(re);
  if (start < 0) throw new Error(`function ${name} not found in HTML`);
  // Идём от { и считаем баланс { } до выхода на 0.
  let depth = 0;
  let i = start + html.slice(start).match(/\{/).index;
  let end = -1;
  while (i < html.length) {
    const ch = html[i];
    // Грубо пропускаем строки и шаблоны — иначе фигурные скобки внутри
    // строкового литерала ломают баланс.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < html.length && html[i] !== quote) {
        if (html[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    // Однострочный комментарий
    if (ch === '/' && html[i + 1] === '/') {
      i = html.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    // Многострочный
    if (ch === '/' && html[i + 1] === '*') {
      i = html.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
    i++;
  }
  if (end < 0) throw new Error(`unbalanced braces while extracting ${name}`);
  return html.slice(start, end);
}

const fnApply = extractFunction('applyTableSort');
const fnRead  = extractFunction('readTableSort');
const fnWrite = extractFunction('writeTableSort');

// ---- Mock storage + helpers, eval в одном scope -----------------------------
const storage = new Map();
const fakeLocalStorage = {
  getItem: k => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: k => storage.delete(k),
};
// readPref / writePref в HTML обращаются к localStorage с user-namespace.
// Для теста делаем простую обёртку.
const readPref = k => fakeLocalStorage.getItem(k);
const writePref = (k, v) => fakeLocalStorage.setItem(k, v);
const _sfaUid = () => null;

// eslint-disable-next-line no-new-func
const setup = new Function(
  'localStorage', 'readPref', 'writePref', '_sfaUid',
  `${fnApply}\n${fnRead}\n${fnWrite}\nreturn { applyTableSort, readTableSort, writeTableSort };`
);
const { applyTableSort, readTableSort, writeTableSort } =
  setup(fakeLocalStorage, readPref, writePref, _sfaUid);

// =============================================================================
// Инварианты + тестовые данные
// =============================================================================

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; }
  else      { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

function eq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => eq(v, b[i]));
  }
  return false;
}

function setOfIds(rows) {
  return new Set(rows.map(r => r.id));
}

function sumTotal(rows) {
  return rows.reduce((s, r) => s + (Number.isFinite(+r.total) ? +r.total : 0), 0);
}

// Синтетика — близко к тому что buildAgingRows возвращает: tenant/suite/id/total
// + edge-cases: null, undefined, NaN, 0, отрицательное, дубликаты sortValue.
const baseRows = [
  { id: 'A1', tenant: 'Acme Corp',     suite: '101', total: 5000, dso: 45,   lastPaidAtIso: '2026-04-01T10:00:00.000Z' },
  { id: 'A2', tenant: 'Beta LLC',      suite: '102', total: 3000, dso: 12,   lastPaidAtIso: '2026-04-15T14:30:00.000Z' },
  { id: 'A3', tenant: 'Charlie Inc',   suite: '103', total: 0,    dso: 0,    lastPaidAtIso: null },
  { id: 'A4', tenant: 'Delta Ltd',     suite: '104', total: -100, dso: NaN,  lastPaidAtIso: undefined },
  { id: 'A5', tenant: 'Echo Group',    suite: '105', total: 7500, dso: 60,   lastPaidAtIso: '2026-03-01T09:00:00.000Z' },
  { id: 'A6', tenant: 'Foxtrot Co',    suite: '106', total: 5000, dso: 45,   lastPaidAtIso: '2026-04-01T10:00:00.000Z' }, // дубль A1 для stability
  { id: 'A7', tenant: 'acme corp',     suite: '107', total: 200,  dso: null, lastPaidAtIso: '2026-04-20T08:00:00.000Z' }, // case-insensitive
  { id: 'A8', tenant: '',              suite: '108', total: 9999, dso: 999,  lastPaidAtIso: '2026-05-01T00:00:00.000Z' }, // empty tenant
];

const columnsByKey = {
  tenant: { sortValue: r => (r.tenant || '').toLowerCase(), defaultDir: 'asc' },
  suite:  { sortValue: r => r.suite || '',                  defaultDir: 'asc' },
  total:  { sortValue: r => +r.total || 0,                  defaultDir: 'desc' },
  // ВАЖНО: явно проверяем null/undefined ДО `+r.dso` — иначе `+null === 0`
  // и null-строки сольются с настоящими нулями, что искажает тест
  // missing-to-end. Аналог "lastPaid"-column accessor в реальном коде.
  dso:    { sortValue: r => {
    if (r.dso === null || r.dso === undefined) return null;
    const v = +r.dso;
    return Number.isFinite(v) ? v : null;
  }, defaultDir: 'desc' },
  lastPaid: { sortValue: r => {
    if (!r.lastPaidAtIso) return null;
    const t = Date.parse(r.lastPaidAtIso);
    return isNaN(t) ? null : t;
  }, defaultDir: 'desc' },
};

const baselineIds = setOfIds(baseRows);
const baselineTotal = sumTotal(baseRows);
const baselineCount = baseRows.length;

// ---- Test A. Row preservation (count + IDs + total) ------------------------
for (const colKey of Object.keys(columnsByKey)) {
  for (const dir of ['asc', 'desc']) {
    const sorted = applyTableSort(baseRows, { col: colKey, dir }, columnsByKey);
    check(`A.count.${colKey}.${dir}`,
      sorted.length === baselineCount,
      `expected ${baselineCount} rows, got ${sorted.length}`);
    const ids = setOfIds(sorted);
    check(`A.ids.${colKey}.${dir}`,
      ids.size === baselineIds.size && [...baselineIds].every(id => ids.has(id)),
      'set of IDs changed after sort');
    check(`A.total.${colKey}.${dir}`,
      Math.abs(sumTotal(sorted) - baselineTotal) < 0.001,
      `total sum drifted: ${baselineTotal} → ${sumTotal(sorted)}`);
  }
}

// ---- Test B. No mutation -----------------------------------------------------
const before = baseRows.map(r => r.id);
applyTableSort(baseRows, { col: 'total', dir: 'desc' }, columnsByKey);
const after = baseRows.map(r => r.id);
check('B.no-mutation',
  eq(before, after),
  `applyTableSort mutated input: before=[${before}] after=[${after}]`);

// ---- Test C. Missing values уезжают в конец (asc И desc) -------------------
{
  const sortedAsc  = applyTableSort(baseRows, { col: 'dso', dir: 'asc'  }, columnsByKey);
  const sortedDesc = applyTableSort(baseRows, { col: 'dso', dir: 'desc' }, columnsByKey);
  // В обоих направлениях A4 (NaN) и A7 (null) должны быть последними,
  // а реальные значения отсортированы между собой.
  const lastTwoAsc  = sortedAsc.slice(-2).map(r => r.id).sort();
  const lastTwoDesc = sortedDesc.slice(-2).map(r => r.id).sort();
  check('C.missing-asc',  eq(lastTwoAsc,  ['A4', 'A7']),
    `asc: last two should be {A4,A7} (NaN/null), got [${lastTwoAsc}]`);
  check('C.missing-desc', eq(lastTwoDesc, ['A4', 'A7']),
    `desc: last two should be {A4,A7}, got [${lastTwoDesc}]`);
}

// ---- Test D. Stability -----------------------------------------------------
// A1 и A6 имеют одинаковый total=5000 и одинаковый dso=45.
// При сортировке по total/dso их относительный порядок должен сохраниться (A1 раньше A6).
for (const colKey of ['total', 'dso']) {
  for (const dir of ['asc', 'desc']) {
    const sorted = applyTableSort(baseRows, { col: colKey, dir }, columnsByKey);
    const i1 = sorted.findIndex(r => r.id === 'A1');
    const i6 = sorted.findIndex(r => r.id === 'A6');
    check(`D.stable.${colKey}.${dir}`,
      i1 < i6,
      `A1 (idx ${i1}) should come before A6 (idx ${i6}) — same sortValue, original order`);
  }
}

// ---- Test E. Determinism ---------------------------------------------------
{
  const a = applyTableSort(baseRows, { col: 'total', dir: 'desc' }, columnsByKey).map(r => r.id);
  const b = applyTableSort(baseRows, { col: 'total', dir: 'desc' }, columnsByKey).map(r => r.id);
  const c = applyTableSort(baseRows, { col: 'total', dir: 'desc' }, columnsByKey).map(r => r.id);
  check('E.determinism', eq(a, b) && eq(b, c), `runs differ: a=[${a}] b=[${b}] c=[${c}]`);
}

// ---- Test F. Empty / single-row ---------------------------------------------
{
  const empty = applyTableSort([], { col: 'total', dir: 'desc' }, columnsByKey);
  check('F.empty', empty.length === 0, 'empty input should return empty array');

  const single = applyTableSort([baseRows[0]], { col: 'total', dir: 'desc' }, columnsByKey);
  check('F.single', single.length === 1 && single[0].id === 'A1', 'single-row sort failed');
}

// ---- Test G. Unknown column → no-op (returns shallow copy) -----------------
{
  const result = applyTableSort(baseRows, { col: 'nonexistent', dir: 'asc' }, columnsByKey);
  const ids = result.map(r => r.id);
  check('G.unknown-col.count', result.length === baselineCount,
    'unknown column should still return all rows');
  check('G.unknown-col.order', eq(ids, baseRows.map(r => r.id)),
    'unknown column should preserve input order');
  check('G.unknown-col.no-mutation', result !== baseRows,
    'unknown column should still return a NEW array (no mutation)');
}

// ---- Test H. Null sortState → shallow copy ---------------------------------
{
  const result = applyTableSort(baseRows, null, columnsByKey);
  check('H.null-state', result.length === baselineCount && result !== baseRows,
    'null sortState should return shallow copy');
}

// ---- Test I. read/writeTableSort round-trip --------------------------------
{
  storage.clear();
  // null/empty
  check('I.read-empty', readTableSort('sfa_test') === null,
    'unset sort key should return null');
  // write valid
  writeTableSort('sfa_test', { col: 'total', dir: 'desc' });
  const r1 = readTableSort('sfa_test');
  check('I.roundtrip', r1 && r1.col === 'total' && r1.dir === 'desc',
    `roundtrip failed: ${JSON.stringify(r1)}`);
  // clear
  writeTableSort('sfa_test', null);
  check('I.clear', readTableSort('sfa_test') === null, 'null state should clear');
  // invalid dir → reject
  writeTableSort('sfa_test', { col: 'total', dir: 'invalid' });
  check('I.reject-bad-dir', readTableSort('sfa_test') === null,
    'invalid dir should not be persisted');
}

// ---- Test J. Случайная синтетика — большие наборы --------------------------
{
  const N = 1000;
  const big = [];
  for (let i = 0; i < N; i++) {
    big.push({
      id: `R${i}`,
      tenant: `Tenant ${(i * 31) % 100}`,
      total: Math.random() < 0.1 ? null : Math.round(Math.random() * 100000),
      dso: Math.random() < 0.05 ? NaN : Math.round(Math.random() * 365),
    });
  }
  const cols = {
    total: { sortValue: r => +r.total || 0, defaultDir: 'desc' },
    dso:   { sortValue: r => {
      if (r.dso === null || r.dso === undefined) return null;
      const v = +r.dso;
      return Number.isFinite(v) ? v : null;
    }, defaultDir: 'desc' },
  };
  const baseSet = setOfIds(big);
  for (const colKey of Object.keys(cols)) {
    for (const dir of ['asc', 'desc']) {
      const out = applyTableSort(big, { col: colKey, dir }, cols);
      check(`J.${colKey}.${dir}.count`, out.length === N,
        `count drifted: ${N} → ${out.length}`);
      check(`J.${colKey}.${dir}.ids`,
        eq([...setOfIds(out)].sort(), [...baseSet].sort()),
        'IDs differ');
    }
  }
}

// =============================================================================
// Test K. Aging-table specific column accessor — должны соответствовать тому
// что вернёт _agingColumnsByKey() в production. Особое внимание на lastPaid:
// строка БЕЗ ни lastPaidAtIso, ни lastPaidDate должна возвращать null
// (→ уезжает в конец и в asc, и в desc).
// =============================================================================
{
  // Копируем сигнатуру из _agingColumnsByKey() в floor-map-editor.html
  // (строка ~115425). Если оператор изменит accessor, тест должен это
  // отразить — обновляйте копию вместе с продакшн-кодом.
  const agingLastPaid = {
    sortValue: r => {
      if (r.lastPaidAtIso) {
        const t = Date.parse(r.lastPaidAtIso);
        return isNaN(t) ? null : t;
      }
      if (r.lastPaidDate) {
        const t = Date.parse(r.lastPaidDate + 'T00:00:00');
        return isNaN(t) ? null : t;
      }
      return null;
    },
    defaultDir: 'desc',
  };
  const fakeAgingRows = [
    { id: 'X1', lastPaidAtIso: '2026-04-15T14:00:00.000Z', lastPaidDate: '2026-04-15' },
    { id: 'X2', lastPaidAtIso: '2026-04-15T09:00:00.000Z', lastPaidDate: '2026-04-15' }, // тот же день, раннее время
    { id: 'X3', lastPaidAtIso: null,                       lastPaidDate: '2026-03-20' }, // только дата
    { id: 'X4', lastPaidAtIso: null,                       lastPaidDate: null },          // никогда не платил
    { id: 'X5', lastPaidAtIso: 'not-a-date',               lastPaidDate: null },          // битый ISO
    { id: 'X6', lastPaidAtIso: null,                       lastPaidDate: 'also-broken' }, // битая дата
  ];
  const cols = { lastPaid: agingLastPaid };
  const sortedDesc = applyTableSort(fakeAgingRows, { col: 'lastPaid', dir: 'desc' }, cols);
  const sortedAsc  = applyTableSort(fakeAgingRows, { col: 'lastPaid', dir: 'asc'  }, cols);

  // Самый свежий — X1 (14:00) сверху в desc, благодаря timestamp точности.
  check('K.aging.desc-newest-first', sortedDesc[0].id === 'X1',
    `expected X1 first, got ${sortedDesc[0].id}; full order: [${sortedDesc.map(r => r.id)}]`);
  check('K.aging.desc-X2-second',    sortedDesc[1].id === 'X2',
    `X2 (09:00 same day) should be 2nd, got ${sortedDesc[1].id}`);
  check('K.aging.desc-X3-third',     sortedDesc[2].id === 'X3',
    `X3 (older date) should be 3rd, got ${sortedDesc[2].id}`);

  // X4/X5/X6 — все три без валидной даты → null → последние (порядок между
  // ними сохраняется по исходному индексу через стабильность).
  const lastThreeDesc = sortedDesc.slice(-3).map(r => r.id);
  check('K.aging.desc-missing-last',
    lastThreeDesc.includes('X4') && lastThreeDesc.includes('X5') && lastThreeDesc.includes('X6'),
    `last 3 in desc should be missing rows {X4,X5,X6}, got [${lastThreeDesc}]`);

  // В asc — самый старый (X3) сверху, missing всё равно в конец.
  check('K.aging.asc-oldest-first', sortedAsc[0].id === 'X3',
    `expected X3 first in asc, got ${sortedAsc[0].id}`);
  const lastThreeAsc = sortedAsc.slice(-3).map(r => r.id);
  check('K.aging.asc-missing-last',
    lastThreeAsc.includes('X4') && lastThreeAsc.includes('X5') && lastThreeAsc.includes('X6'),
    `last 3 in asc should still be missing rows, got [${lastThreeAsc}]`);
}

// =============================================================================
// Report
// =============================================================================
console.log(`\nApplyTableSort invariants — ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('All invariants hold ✓');
