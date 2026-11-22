// functions/lib/money.mjs ≡ m/lib/money.js — байт-в-байт (AGENT_API_PLAN § 3.5, CLAUDE.md § 0.2.2).
// Сервер (agent gateway) и телефон считают «оплачен ли месяц» ОДНИМ кодом. Две копии,
// а не один файл: Firebase пакует functions/ отдельным архивом, а hosting не отдаёт
// functions/** (та же причина, что у lib/contact.js, FIXES_LOG Entry 96).
// Разошлись → cp m/lib/money.js functions/lib/money.mjs
// Запуск: node tests/money-sync.test.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const canon = path.join(ROOT, 'm', 'lib', 'money.js');
const copy = path.join(ROOT, 'functions', 'lib', 'money.mjs');
const results = [];
function check(name, ok, detail) { results.push([ok ? 'PASS' : 'FAIL', name, ok ? '' : (detail || '')]); }

check('m/lib/money.js exists', fs.existsSync(canon));
check('functions/lib/money.mjs exists', fs.existsSync(copy));
if (fs.existsSync(canon) && fs.existsSync(copy)) {
  const a = fs.readFileSync(canon); const b = fs.readFileSync(copy);
  let at = -1;
  if (!a.equals(b)) { const n = Math.min(a.length, b.length); at = n; for (let i = 0; i < n; i++) if (a[i] !== b[i]) { at = i; break; } }
  const line = at < 0 ? 0 : a.subarray(0, at).toString('utf8').split('\n').length;
  check('functions/lib/money.mjs is byte-identical to m/lib/money.js', a.equals(b), `first difference at line ${line} — run: cp m/lib/money.js functions/lib/money.mjs`);
}
(async () => {
  // Копия действительно грузится сервером как ESM и отдаёт канон-предикаты.
  try {
    const m = await import(copy);
    for (const fn of ['isMonthSettled', 'monthStatus', 'monthAmount', 'verdict', 'leaseHead', 'leaseGroup', 'isFinanceShadow', 'liveInvoiceFor', 'isMonthToMonth', 'isRentableType']) check(`money.mjs exports ${fn}`, typeof m[fn] === 'function');
    check('money.mjs exports UNPAID set', m.UNPAID instanceof Set && m.UNPAID.has('due') && m.UNPAID.has('overdue'));
  } catch (e) { check('money.mjs loads as an ES module from CommonJS (await import)', false, e.message); }
  const fails = results.filter((r) => r[0] === 'FAIL');
  for (const r of results) console.log(r[0], r[1], r[2] ? '— ' + r[2] : '');
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})();
