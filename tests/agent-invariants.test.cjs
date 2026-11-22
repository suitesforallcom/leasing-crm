// Grep-гейты для серверного agent gateway (AGENT_API_PLAN § 4.2, § 8).
// scripts/check-invariants.sh проверяет только floor-map-editor.html; этот
// тест — его аналог для functions/agent-*.js. Запуск: node tests/agent-invariants.test.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const results = [];
function check(name, ok, detail) { results.push([ok ? 'PASS' : 'FAIL', name, ok ? '' : (detail || '')]); }
function read(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }
function stripComments(src) {
  // Убираем // и /* */ комментарии и строковые литералы-однострочники с кавычками не трогаем —
  // гейты ниже ищут КОД, а не текст комментариев.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const agentFiles = fs.readdirSync(FN).filter((f) => /^agent-.*\.js$/.test(f)).map((f) => path.join(FN, f));
check('agent modules present (gateway at least)', agentFiles.some((f) => f.endsWith('agent-gateway.js')), 'functions/agent-gateway.js missing');

for (const file of agentFiles) {
  const name = path.basename(file);
  const code = stripComments(read(file) || '');
  // § 0.2.2: «оплачен ли месяц» решает только money.mjs (isMonthSettled) — голое сравнение запрещено.
  const barePaid = /\.status\s*===?\s*['"]paid['"]/.test(code) || /['"]paid['"]\s*===?\s*[a-zA-Z_.]+\.status/.test(code);
  check(`${name}: no bare status==='paid' on money paths (use money.isMonthSettled)`, !barePaid);
  check(`${name}: no localStorage`, !/localStorage/.test(code));
  check(`${name}: no direct firebase-admin require (use core.db)`, name === 'agent-gateway.js' || !/require\(['"]firebase-admin['"]\)/.test(code));
  check(`${name}: no console.log (use logger)`, !/console\.log\(/.test(code));
  check(`${name}: no secrets in logs (token/secret never interpolated into logger calls)`, !/logger\.[a-z]+\([^)]*\b(token|secret|hash)\b[^)]*\$\{/.test(code));
  if (name !== 'agent-gateway.js') {
    check(`${name}: exports register(core)`, /module\.exports\s*=\s*\{[^}]*\bregister\b/.test(code) || /exports\.register\s*=/.test(code));
  }
}

// Ядро: constant-time сравнение + sha256 для ключей, kill switch, dead-letter, лимиты.
const gw = read(path.join(FN, 'agent-gateway.js')) || '';
check('gateway: timingSafeEqual used for key hash compare', /timingSafeEqual/.test(gw));
check('gateway: only sha256 of the secret is stored', /sha256Hex\(parsed\.secret\)/.test(gw) && /hash: k\.hash/.test(gw));
check('gateway: kill switch (agentConfig.enabled) checked in invoke and MCP', (gw.match(/cfg\.enabled/g) || []).length >= 2);
check('gateway: dead-letter helper present and audited', /agentDeadLetter/.test(gw) && /agent\.dead-letter/.test(gw));
check('gateway: body size cap 64 KB', /MAX_BODY_BYTES = 64 \* 1024/.test(gw));
check('gateway: synthetic auth carries real member uid/email and email_verified:false (requireEditor root shortcut closed for agents)', /syntheticAuth: \{ uid: mem\.uid, token: \{ email: mem\.email, email_verified: false, agent: true \} \}/.test(gw) && !/email_verified: true/.test(stripComments(gw)));
check('proposals: no synthetic verified identity either — in-app Approve passes the approver\'s real auth', !/email_verified: true/.test(stripComments(read(path.join(FN, 'agent-proposals.js')) || '')) && /syntheticAuth: decider\.auth/.test(read(path.join(FN, 'agent-proposals.js')) || ''));
check('gateway: role matrix forbids money for mapeditor/viewer/teamviewer', /mapeditor: \['read:units', 'write:specs', 'write:notes'\]/.test(gw) && /teamviewer: \['read:units'\]/.test(gw) && /viewer: \['read:units', 'read:contacts', 'read:finance'\]/.test(gw));
check('gateway: classC default false (money enabled as a second step)', /classC: false/.test(gw));

// Этап 1, деньги: агент не выбирает получателя, не зовёт Stripe сам, исполняет только через proposals.
const moneySrc = stripComments(read(path.join(FN, 'agent-tools-money.js')) || '');
const propSrc = stripComments(read(path.join(FN, 'agent-proposals.js')) || '');
const readSrc = stripComments(read(path.join(FN, 'agent-tools-read.js')) || '');
check('money tools: recipient is the email on file — emailOverride / tenantNameOverride never sent', !!moneySrc && !/emailOverride|tenantNameOverride/.test(moneySrc));
check('money tools: no operator-only invoice options (extraLineItems, rollInLateFeeInvoiceId, allowDuplicate, auto flag)', !/extraLineItems|rollInLateFeeInvoiceId|allowDuplicate|\bauto:\s*true/.test(moneySrc));
check('money tools: never call Stripe directly — only core.impls.* (the same server paths as the UI)', !/getStripe\s*\(|require\(['"]stripe['"]\)|stripe\.invoices/.test(moneySrc) && /core\.impls\[name\]/.test(moneySrc));
check('read tools + proposals: never call Stripe or mutate workspace state', !/getStripe\s*\(|stripe\.invoices|mutateWorkspaceState/.test(readSrc) && !/getStripe\s*\(|stripe\.invoices|mutateWorkspaceState/.test(propSrc));
check('money tools: class C work is registered as actions (prepare + execute), not as directly callable tools', (moneySrc.match(/core\.registerAction\(/g) || []).length === 3 && (moneySrc.match(/core\.register\(/g) || []).length === 1);
check('money tools: state write after a Stripe effect goes through stampAfterEffect (rethrowMirrorFailure + side_effect_unconfirmed)', /rethrowMirrorFailure: true/.test(moneySrc) && /side_effect_unconfirmed/.test(moneySrc));
check('money tools: Entry 71 back-month guard and lease-start gate present', /lastInvoiceYm && ym < st\.lastInvoiceYm/.test(moneySrc) && /leaseStartIso\(u\)/.test(moneySrc));
check('proposals: one-time claim inside a transaction (pending → executing)', /db\.runTransaction\(/.test(propSrc) && /status: 'executing'/.test(propSrc));
check('proposals: "internal" / "unavailable" are never treated as a clean (no-side-effect) failure', /CLEAN_CODES = new Set\(\[[^\]]*\]\)/.test(propSrc) && !/CLEAN_CODES = new Set\(\[[^\]]*'(internal|unavailable|side_effect_unconfirmed)'/.test(propSrc));
check('proposals: dead-letter on an unclean execution failure and on a failed status write', (propSrc.match(/core\.deadLetter\(/g) || []).length >= 2);
check('proposals: effect fingerprint re-checked before execution (stale_proposal)', /fingerprintOf\(prepared\) !== p\.effectHash/.test(propSrc) && /stale_proposal/.test(propSrc));
check('gateway: Idempotency-Key required for write tools', /Idempotency-Key is required/.test(gw));
check('gateway: Stripe invoice snapshot reports truncation', /invoicesTruncated/.test(gw));
{
  const st = stripComments(read(path.join(FN, 'lib', 'agent-stats.js')) || '');
  const n = (st.match(/\.status\s*===?\s*['"]paid['"]/g) || []).length;
  // 4 места, все задокументированы: шелл Entry 70 (isZeroPaidShell), запись и штамп депозита
  // (depositState ×2) и сравнение с ВЕРДИКТОМ канона (c.status из money.monthStatus, не запись платежа).
  check('agent-stats: exactly 4 documented status===\'paid\' comparisons — a month is never judged from a raw payment record', n === 4 && /if \(c\.status === 'paid'\) paid \+= paidAmountFor/.test(st), `found ${n}`);
}
check('money tools: agents invoice RENT only (no late_fee / custom / amount / description arguments)', /enum: \['rent'\]/.test(moneySrc) && !/amountOverride|late_fee|amountUsd:\s*\{|description:\s*x\.description/.test(moneySrc));
check('money tools: proposed amount is checked against the canon month amount (move-in proration) before proposing', /money\.monthAmount\(u, ym, snap\)/.test(moneySrc) && /canonCents - rentCents/.test(moneySrc));
check('money tools: reminder goes only to an invoice issued to the tenant email on file', /normEmail\(r\.customerEmail\) === fileEmail/.test(moneySrc));
check('money tools: any Stripe refusal after invoice creation started is a possible side effect', /Stripe rejected the request \\\(\(\[a-z -\]\+\)\\\)/.test(read(path.join(FN, 'agent-tools-money.js')) || '') && /m\[1\] !== 'customer'/.test(moneySrc));
check('money tools: mark-paid-out-of-band always needs Approve in the program', /name: 'invoice_mark_paid_oob'[\s\S]{0,700}confirm: 'app'/.test(moneySrc));
check('proposals: executed only on a fresh config and a fresh member read', /core\.config\(true\)/.test(propSrc) && /core\.member\(reqBy\.uid, true\)/.test(propSrc));
check('gateway: idempotency key bound to tool + argument hash', /d\.tool !== tool \|\| \(d\.fingerprint && d\.fingerprint !== fingerprint\)/.test(gw));
check('gateway: config read failure fails closed', /failing closed/.test(gw) && /enabled: false, classB: false, classC: false/.test(gw));
check('agent-stats: notes are fail-closed (explicit true only)', /notes: f\.notes === true/.test(read(path.join(FN, 'lib', 'agent-stats.js')) || ''));
check('agent-help.json is valid JSON with flows', (() => { try { const h = JSON.parse(read(path.join(FN, 'agent-help.json')) || ''); return Array.isArray(h.flows) && h.flows.length > 0 && h.flows.every((f) => f.key && f.title && f.steps); } catch (_) { return false; } })());

// index.js: _impl-выделения на месте, onCall-обёртки не изменились, gateway подключён.
const idx = read(path.join(FN, 'index.js')) || '';
for (const [impl, exp] of [
  ['_createStripeInvoiceImpl', 'createStripeInvoice'], ['_listStripeInvoicesImpl', 'listStripeInvoices'],
  ['_stripeResendInvoiceImpl', 'stripeResendInvoice'], ['_voidOrDeleteStripeInvoiceImpl', 'voidOrDeleteStripeInvoice'],
  ['_markInvoicePaidOutOfBandImpl', 'markInvoicePaidOutOfBand'],
]) {
  const re = new RegExp(`exports\\.${exp} = onCall\\(\\{secrets: \\[STRIPE_SECRET_KEY\\]\\}, ${impl}\\);`);
  check(`index.js: exports.${exp} wraps ${impl} with the original options`, re.test(idx));
  check(`index.js: ${impl} declared once`, (idx.match(new RegExp(`async function ${impl}\\(req\\)`, 'g')) || []).length === 1);
}
check('index.js: gateway wired with impls + mutateWorkspaceState', /require\('\.\/agent-gateway'\)\.create\(\{/.test(idx) && /mutateWorkspaceState, getStripe, secrets: \[STRIPE_SECRET_KEY\]/.test(idx));
check('index.js: agent exports present', ['agentApi', 'agentMcp', 'agentKeyCreate', 'agentKeyList', 'agentKeyRevoke', 'agentConfigGet', 'agentConfigSet', 'agentProposalList', 'agentProposalDecide'].every((n) => idx.includes(`exports.${n} = _agentGateway.${n};`)));
check('index.js: requireEditor still the first gate inside the extracted impls', /async function _createStripeInvoiceImpl\(req\) \{[\s\S]{0,600}await requireEditor\(req\.auth\);/.test(idx) && /async function _voidOrDeleteStripeInvoiceImpl\(req\) \{\s*await requireEditor\(req\.auth\);/.test(idx));

// money.mjs — копия канона (байт-в-байт проверяет tests/money-sync.test.cjs; здесь — наличие).
check('functions/lib/money.mjs exists', fs.existsSync(path.join(FN, 'lib', 'money.mjs')));

// firestore.rules не трогаем: никаких правил для agent*-коллекций (default deny = CF-only).
const rules = read(path.join(ROOT, 'firestore.rules')) || '';
check('firestore.rules: no agent* collection rules (CF-only by default deny)', !/agentKeys|agentProposals|agentAudit|agentConfig|agentIdempotency|agentDeadLetter/.test(rules));

const fails = results.filter((r) => r[0] === 'FAIL');
for (const r of results) console.log(r[0], r[1], r[2] ? '— ' + r[2] : '');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
