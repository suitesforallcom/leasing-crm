// Реестр инструментов ↔ закоммиченная спецификация functions/agent-openapi.json
// (AGENT_API_PLAN § 3.3). Запуск: node tests/agent-openapi.test.cjs
// Источник истины — реестр (functions/agent-gateway.js + модули); файл в functions/ —
// его экспорт (node scripts/agent-openapi-export.cjs --write). Тест падает, если
// файл забыли перегенерировать, и прогоняет redocly lint, когда он установлен.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { build, OUT } = require(path.join(ROOT, 'scripts', 'agent-openapi-export.cjs'));
const results = [];
function check(name, ok, detail) { results.push([ok ? 'PASS' : 'FAIL', name, ok ? '' : (detail || '')]); }

const { spec, tools, actions } = build();
const committed = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
check('functions/agent-openapi.json exists', !!committed);
check('committed spec equals the registry export (run: node scripts/agent-openapi-export.cjs --write)', !!committed && JSON.stringify(committed) === JSON.stringify(spec));
check('OpenAPI version is 3.1.0', spec.openapi === '3.1.0');

// Взаимно-однозначно: каждый инструмент — ровно одна операция с тем же operationId.
const ops = [];
for (const [p, methods] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(methods)) ops.push({ path: p, method: m, op });
const opIds = ops.map((o) => o.op.operationId);
check('operationIds are unique', new Set(opIds).size === opIds.length, opIds.join(','));
for (const t of tools) {
  const hit = ops.find((o) => o.op.operationId === t.name);
  check(`tool ${t.name}: has an operation`, !!hit);
  if (!hit) continue;
  check(`tool ${t.name}: method matches`, hit.method === String(t.rest.method).toLowerCase(), `${hit.method} vs ${t.rest.method}`);
  check(`tool ${t.name}: x-scope / x-risk-class match the registry`, (hit.op['x-scope'] || null) === (t.scope || null) && hit.op['x-risk-class'] === t.risk);
  check(`tool ${t.name}: bearer security + error responses`, Array.isArray(hit.op.security) && hit.op.security.length === 1 && hit.op.responses[401] && hit.op.responses[403] && hit.op.responses[429]);
  if (t.risk === 'A') check(`tool ${t.name}: read tool is GET and marked read-only`, hit.method === 'get' && hit.op['x-mcp-annotations'].readOnlyHint === true);
  else {
    check(`tool ${t.name}: write tool is POST, consequential, with Idempotency-Key header`, hit.method === 'post' && hit.op['x-openai-isConsequential'] === true && (hit.op.parameters || []).some((x) => x.name === 'Idempotency-Key' && x.in === 'header'));
    check(`tool ${t.name}: request body forbids unknown fields`, hit.op.requestBody.content['application/json'].schema.additionalProperties === false);
  }
}
for (const o of ops) check(`operation ${o.op.operationId}: backed by a tool`, o.op.operationId === 'whoami_rest' || tools.some((t) => t.name === o.op.operationId));

// Этап 1 — ровно этот набор (AGENT_API_PLAN § 5).
const want = ['whoami', 'help_howto', 'get_overdue', 'search_units', 'get_unit', 'get_unit_ledger', 'list_invoices', 'send_reminder', 'propose_action', 'confirm_action', 'list_proposals'];
check('Stage 1 tool set is complete and has nothing extra', JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify(want.slice().sort()), tools.map((t) => t.name).join(','));
check('Stage 1 money actions: invoice_create / invoice_void / invoice_mark_paid_oob', JSON.stringify(actions.map((a) => a.name).sort()) === JSON.stringify(['invoice_create', 'invoice_mark_paid_oob', 'invoice_void']));
const proposeOp = ops.find((o) => o.op.operationId === 'propose_action');
const actionEnum = proposeOp && proposeOp.op.requestBody.content['application/json'].schema.properties.action.enum;
check('propose_action enumerates exactly the registered actions', JSON.stringify((actionEnum || []).slice().sort()) === JSON.stringify(actions.map((a) => a.name).sort()));
for (const a of actions) {
  check(`action ${a.name}: money scope, admin/manager only, closed schema with buildingId + unitId`, a.scope === 'money:invoices' && JSON.stringify(a.roles) === JSON.stringify(['admin', 'manager'])
    && a.input.json.additionalProperties === false && a.input.json.required.includes('buildingId') && a.input.json.required.includes('unitId'));
}
// Агент не может выбрать получателя и подменить арендатора: таких аргументов в схемах нет.
const allProps = [].concat(...tools.map((t) => Object.keys(t.input.json.properties || {})), ...actions.map((a) => Object.keys(a.input.json.properties || {})));
check('no tool or action accepts an email / recipient / tenant-name argument', !allProps.some((k) => /email|recipient|tenantName|to$/i.test(k)), allProps.join(','));

// redocly lint — если установлен в tests/node_modules (dev-зависимость).
const redocly = path.join(__dirname, 'node_modules', '.bin', 'redocly');
if (fs.existsSync(redocly) && committed) {
  let out = ''; let ok = true;
  try { out = execFileSync(redocly, ['lint', OUT, '--format', 'stylish'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { ok = false; out = String((e.stdout || '') + (e.stderr || '')); }
  check('redocly lint: no errors', ok, out.slice(-600));
  check('redocly lint: no warnings', ok && !/\bwarnings?\b/i.test(out.replace(/0 warnings/gi, '')), out.slice(-600));
} else {
  results.push(['SKIP', 'redocly lint (tests/node_modules/.bin/redocly not installed)', '']);
}

const fails = results.filter((r) => r[0] === 'FAIL');
for (const r of results) if (r[0] !== 'PASS') console.log(r[0], r[1], r[2] ? '— ' + r[2] : '');
console.log(`\n${results.filter((r) => r[0] === 'PASS').length}/${results.filter((r) => r[0] !== 'SKIP').length} passed`);
process.exit(fails.length ? 1 : 0);
