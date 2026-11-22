/**
 * Entry 82 (повтор 2026-11-22) — общее банковское подключение стало inactive.
 *
 * Инцидент: Capital One ····5709 заново подключили на этом же аккаунте Stripe из другого
 * приложения; общий FC-объект, который читала программа, стал inactive, а баннер и карточка
 * счёта советовали «Request relink» — действие, которое отключило бы второе приложение.
 * Правильное действие — переключить запись на новый активный объект (adoptBankFcAccount).
 *
 * Функции достаём ИЗ ФАЙЛА, копию не держим.
 *   node tests/bank-shared-relink.test.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'floor-map-editor.html'), 'utf8');
function fnSrc(head) {
  const from = src.indexOf(head);
  if (from < 0) throw new Error('не найдено в floor-map-editor.html: ' + head);
  const to = src.indexOf('\n}\n', from);
  return src.slice(from, to + 2);
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const URL_FC = 'https://dashboard.stripe.com/financial-connections/accounts';

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '—', e.message); } }

// ---------- заметка в карточке счёта ----------
function buildNote(email) {
  const f = new Function('esc', 'fbSync', 'isRootAdmin', '_BANK_STRIPE_FC_ACCOUNTS_URL',
    fnSrc('function _bankSharedRelinkNoteHtml(c) {') + '\nreturn _bankSharedRelinkNoteHtml;');
  return f(esc, { user: { email } }, (e) => e === 'tony@al-en.com', URL_FC);
}
const sharedConn = { stripeFcAccountId: 'fca_OLD', institutionName: 'Capital One', accountLast4: '5709', sharedConnection: true, status: 'inactive', needsRelink: true, relinkRequiredSince: '2026-11-22T01:07:07.700Z' };

console.log('Entry 82 — shared bank connection went inactive: switch, never relink');
await test('card note for the owner: says shared connection, forbids Request relink, offers the Switch account field', async () => {
  const html = buildNote('tony@al-en.com')(sharedConn);
  assert.ok(/shared connection/.test(html)); assert.ok(/Do NOT use “Request relink”/.test(html));
  assert.ok(html.includes('data-bank-adopt-input="fca_OLD"')); assert.ok(html.includes(`bankAdoptSharedAccount('fca_OLD', this)`));
  assert.ok(html.includes(URL_FC)); assert.ok(html.includes('Capital One ····5709'));
  assert.ok(!/→ <b>Request relink<\/b>, then sign in/.test(html), 'must not carry the relink steps of a non-shared account');
  assert.ok(!/\sid="/.test(html) && !/\sname="/.test(html), 'input has no id/name (Settings dirty tracker)');
});
await test('card note for a non-owner: no input, tells them to ask the owner', async () => {
  const html = buildNote('manager@x.com')(sharedConn);
  assert.ok(!html.includes('data-bank-adopt-input')); assert.ok(/Only the workspace owner can switch/.test(html));
});
await test('card note escapes whatever is stored on the record', async () => {
  const html = buildNote('tony@al-en.com')({ ...sharedConn, stripeFcAccountId: `fca_"><img src=x onerror=1>`, institutionName: '<b>Bank</b>' });
  assert.ok(!html.includes('<img') && !html.includes('<b>Bank</b>'));
});
await test('_renderBankConnections routes a shared inactive record to the shared note and labels it «Switch required»', async () => {
  const r = fnSrc('function _renderBankConnections() {');
  assert.ok(r.includes('needsRelink && c.sharedConnection === true ? _bankSharedRelinkNoteHtml(c) : needsRelink'));
  assert.ok(r.includes(`c.sharedConnection === true ? 'Switch required' : 'Relink required'`));
  assert.ok(r.includes('Request relink'), 'a non-shared inactive account keeps the relink steps (Entry 81)');
});

// ---------- красный баннер ----------
function runBanner(health) {
  const banner = { innerHTML: '', style: {}, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); } } };
  const f = new Function('document', 'window', 'esc', '_BANK_STRIPE_FC_ACCOUNTS_URL',
    fnSrc('function _refreshBankSyncBanner() {') + '\n_refreshBankSyncBanner();');
  f({ getElementById: () => banner }, { _bankSyncHealth: health, _bankSyncAlerts: [] }, esc, URL_FC);
  return banner;
}
const base = { status: 'relink', newestTxnUnix: 1795176000, daysStale: 2 };
await test('banner for a shared connection: no «Request relink», button leads to Settings → Switch account', async () => {
  const b = runBanner({ ...base, relink: [{ fcId: 'fca_OLD', label: 'Capital One ····5709', shared: true }] });
  assert.ok(b.classList._s.has('is-visible'));
  assert.ok(/shared bank connection was replaced/.test(b.innerHTML)); assert.ok(/Do NOT request a relink/.test(b.innerHTML));
  assert.ok(/Switch account →/.test(b.innerHTML) && b.innerHTML.includes('_openBankSettingsFromBanner()'));
  assert.ok(!/Relink in Stripe/.test(b.innerHTML) && !/must be re-linked/.test(b.innerHTML));
});
await test('banner for an ordinary inactive account is unchanged (Entry 81): «must be re-linked» + «Relink in Stripe»', async () => {
  const b = runBanner({ ...base, relink: [{ fcId: 'fca_X', label: 'Chase ····1111', shared: false }] });
  assert.ok(/Chase ····1111 must be re-linked/.test(b.innerHTML)); assert.ok(/Relink in Stripe ↗/.test(b.innerHTML)); assert.ok(/Request relink/.test(b.innerHTML));
});
await test('_checkBankSyncHealth passes the shared flag of the record to the banner', async () => {
  assert.ok(src.includes('shared: c.sharedConnection === true,'));
});

// ---------- действие «Switch account» ----------
function buildAdopt(env) {
  const f = new Function('state', 'fbSync', 'toast', 'appConfirm', 'refreshBankAccountNow', '_checkBankSyncHealth', 'setIntStatus', 'esc', 'console',
    fnSrc('async function bankAdoptSharedAccount(fromFcId, btn) {') + '\nreturn bankAdoptSharedAccount;');
  return f(env.state, env.fbSync, env.toast, env.appConfirm, env.refresh, async () => {}, () => {}, esc, { warn() {} });
}
function mkEnv(over) {
  const log = { toasts: [], calls: [], refreshed: [], confirms: 0 };
  const env = Object.assign({
    state: { bankConnections: [{ ...sharedConn }] },
    toast: (m, k) => log.toasts.push([k, m]),
    appConfirm: async () => { log.confirms++; return true; },
    refresh: async (id) => { log.refreshed.push(id); },
    fbSync: { functions: {}, sdk: { httpsCallable: (_f, name) => async (args) => { log.calls.push([name, args]); return { data: { adopted: true } }; } } },
  }, over || {});
  return { env, log };
}
const mkBtn = (value) => ({ disabled: false, textContent: '⇄ Switch account', parentElement: { querySelector: () => ({ value }) } });

await test('Switch account: validates the id, asks for confirmation, calls adoptBankFcAccount once, then pulls the gap', async () => {
  const { env, log } = mkEnv();
  await buildAdopt(env)('fca_OLD', mkBtn('  fca_NEW123  '));
  assert.strictEqual(log.confirms, 1);
  assert.deepStrictEqual(log.calls, [['adoptBankFcAccount', { fromFcAccountId: 'fca_OLD', toFcAccountId: 'fca_NEW123' }]]);
  assert.deepStrictEqual(log.refreshed, ['fca_NEW123']);
  assert.ok(log.toasts.some(([k]) => k === 'success'));
});
await test('Switch account: garbage, an empty field or the same id never reach the server', async () => {
  for (const v of ['', 'hello', 'acct_123', 'fca_OLD', 'fca_bad id']) {
    const { env, log } = mkEnv();
    await buildAdopt(env)('fca_OLD', mkBtn(v));
    assert.strictEqual(log.calls.length, 0, v); assert.strictEqual(log.confirms, 0, v); assert.ok(log.toasts.some(([k]) => k === 'error'), v);
  }
});
await test('Switch account: Cancel in the confirmation makes no call', async () => {
  const { env, log } = mkEnv({ appConfirm: async () => false });
  await buildAdopt(env)('fca_OLD', mkBtn('fca_NEW123'));
  assert.strictEqual(log.calls.length, 0); assert.strictEqual(log.refreshed.length, 0);
});
await test('Switch account: a server refusal is shown, nothing is reported as done, the button comes back', async () => {
  const { env, log } = mkEnv({ fbSync: { functions: {}, sdk: { httpsCallable: () => async () => { throw new Error('fca_NEW123 is inactive at Stripe — only an active account can be adopted'); } } } });
  const btn = mkBtn('fca_NEW123');
  await buildAdopt(env)('fca_OLD', btn);
  assert.ok(log.toasts.some(([k, m]) => k === 'error' && /only an active account/.test(m)));
  assert.ok(!log.toasts.some(([k]) => k === 'success')); assert.strictEqual(log.refreshed.length, 0);
  assert.strictEqual(btn.disabled, false);
});
await test('Switch account: a response without adopted/resumed is NOT treated as success (§ 0.2.5)', async () => {
  const { env, log } = mkEnv({ fbSync: { functions: {}, sdk: { httpsCallable: () => async () => ({ data: {} }) } } });
  await buildAdopt(env)('fca_OLD', mkBtn('fca_NEW123'));
  assert.ok(!log.toasts.some(([k]) => k === 'success')); assert.ok(log.toasts.some(([k]) => k === 'error'));
});
await test('the client never writes bank state itself — the switch is a server call only (§ 0.2.3)', async () => {
  const a = fnSrc('async function bankAdoptSharedAccount(fromFcId, btn) {');
  // присваивание (=, но не == / ===) в состояние банка или вызов saveState — запрещены
  assert.ok(!/saveState\s*\(/.test(a) && !/state\.bankConnections\s*=(?!=)/.test(a) && !/\.stripeFcAccountId\s*=(?!=)/.test(a));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
