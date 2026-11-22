#!/usr/bin/env node
// Экспорт OpenAPI 3.1 агентского шлюза из РЕЕСТРА инструментов (единый источник
// истины — functions/agent-gateway.js + модули agent-tools-*.js / agent-proposals.js).
//   node scripts/agent-openapi-export.cjs          → печатает спецификацию в stdout
//   node scripts/agent-openapi-export.cjs --write  → пишет functions/agent-openapi.json
// Файл лежит в functions/ намеренно: hosting публикует всё из корня репозитория, что не
// закрыто hosting.ignore (FIXES_LOG Entry 98), а functions/** закрыт — спецификация не
// попадает на сайт без отдельного решения. Наружу её отдаёт сам шлюз: GET /v1/openapi.json.
// Ничего не читает из Firestore/Stripe: шлюз поднимается на заглушках зависимостей.
// tests/agent-openapi.test.cjs проверяет, что закоммиченный файл равен экспорту.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'functions', 'agent-openapi.json');
const BASE_URL = 'https://us-central1-suitesforall.cloudfunctions.net/agentApi';

function build() {
  const gw = require(path.join(ROOT, 'functions', 'agent-gateway.js'));
  const noop = () => {};
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const g = gw.create({
    db: { doc: noop, collection: noop, runTransaction: noop },
    admin: { firestore: { FieldValue: { serverTimestamp: noop } } },
    logger: { info: noop, warn: noop, error: noop, debug: noop, log: noop },
    HttpsError, WORKSPACE_ID: 'default',
    onCall: (o, h) => (typeof o === 'function' ? o : h), onRequest: (o, h) => (typeof o === 'function' ? o : h),
    readWorkspaceState: async () => ({}), mutateWorkspaceState: async () => {}, getStripe: null, secrets: [], impls: {},
  });
  const tools = Array.from(g._internal.TOOLS.values()).filter((t) => !t.hidden);
  const spec = g._internal.buildOpenApi(tools, BASE_URL);
  return { spec, tools, actions: Array.from(g._internal.ACTIONS.values()) };
}

if (require.main === module) {
  const { spec } = build();
  const json = JSON.stringify(spec, null, 2) + '\n';
  if (process.argv.includes('--write')) { fs.writeFileSync(OUT, json); process.stderr.write(`wrote ${path.relative(ROOT, OUT)} (${Object.keys(spec.paths).length} paths)\n`); }
  else process.stdout.write(json);
}

module.exports = { build, OUT, BASE_URL };
