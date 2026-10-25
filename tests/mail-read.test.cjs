// Тест functions/mail-read.js (UNIT_EMAIL_PLAN.md § 4.6): двери чтения — список по юниту,
// inbox/all по правам, пагинация, письма треда с санитизацией HTML, подписанные URL.
// Запуск: node tests/mail-read.test.cjs
'use strict';
const assert = require('assert');
const { makeHarness } = require('./_mail-harness.cjs');

const H = makeHarness();
H.install();
const read = H.loadModule('mail-read');

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('  ✓ ' + name); }

const ADDR = 'leasing@al-en.com';
H.store.set('workspaces/default/integrations/mail', { enabled: true, mailboxes: [{ id: 'leasing', address: ADDR, displayName: 'SFA' }], timeZone: 'America/New_York' });
H.store.set('workspaces/default/members/adm', { role: 'admin', email: 'adm@al-en.com' });
H.store.set('workspaces/default/members/mgrA', { role: 'manager', email: 'a@al-en.com', buildings: ['bldg_a'] });
H.store.set('workspaces/default/members/v1', { role: 'viewer', email: 'v1@al-en.com' });
H.store.set('workspaces/default/members/tv', { role: 'teamviewer', email: 'tv@al-en.com' });
H.store.set('workspaces/default/mailAccess/tv', { read: 'all', directions: ['outbound'] });
const ADM = { uid: 'adm', token: { email: 'adm@al-en.com' } };
const MGRA = { uid: 'mgrA', token: { email: 'a@al-en.com' } };
const V1 = { uid: 'v1', token: { email: 'v1@al-en.com' } };
const TV = { uid: 'tv', token: { email: 'tv@al-en.com' } };

function thread(id, over) {
  H.store.set('workspaces/default/mailThreads/leasing__' + id, Object.assign({ mailboxId: 'leasing', gmailThreadId: id, subject: 'S ' + id, snippet: 'sn', participants: ['x@y.test'], participantNames: { 'x@y.test': 'X Y' }, senders: [{ name: 'X Y', email: 'x@y.test' }], firstMessageAt: '2026-10-01T00:00:00.000Z', lastMessageAt: '2026-10-0' + (1 + (id.length % 9)) + 'T00:00:00.000Z', messageCount: 1, hasInbound: true, hasOutbound: false, lastDirection: 'inbound', unitKeys: ['bldg_a__204'], buildingIds: ['bldg_a'], linked: true, links: [{ unitKey: 'bldg_a__204', buildingId: 'bldg_a', unitId: '204', via: 'address', field: 'email', value: 'x@y.test', byUid: 'secret' }], rejected: [] }, over || {}));
}
function message(id, tid, over) {
  H.store.set('workspaces/default/mailMessages/leasing__' + id, Object.assign({ mailboxId: 'leasing', gmailMessageId: id, gmailThreadId: tid, direction: 'inbound', from: { name: 'X Y', email: 'x@y.test' }, to: [{ name: '', email: ADDR }], cc: [], subject: 'S', date: '2026-10-01T00:00:00.000Z', internalDate: 1, snippet: 'sn', bodyText: 'hello', hasHtml: false, attachments: [], unitKeys: ['bldg_a__204'], buildingIds: ['bldg_a'] }, over || {}));
}

async function main() {
  // 3 треда юнита A (разные даты), 1 тред здания B, 1 непривязанный
  thread('ta1', { lastMessageAt: '2026-10-03T00:00:00.000Z' });
  thread('ta2', { lastMessageAt: '2026-10-02T00:00:00.000Z', hasOutbound: true, hasInbound: false, lastDirection: 'outbound' });
  thread('ta3', { lastMessageAt: '2026-10-01T00:00:00.000Z' });
  thread('tb1', { lastMessageAt: '2026-10-04T00:00:00.000Z', unitKeys: ['bldg_b__204'], buildingIds: ['bldg_b'] });
  thread('tu1', { lastMessageAt: '2026-10-05T00:00:00.000Z', unitKeys: [], buildingIds: [], linked: false, links: [] });

  await t('mailListThreads unit: newest first, только треды юнита, by/byUid не утекают', async () => {
    const r = await read.mailListThreads({ auth: MGRA, data: { unitKey: 'bldg_a__204' } });
    assert.deepStrictEqual(r.threads.map((x) => x.gmailThreadId), ['ta1', 'ta2', 'ta3']);
    assert.strictEqual(r.threads[0].links[0].by, null);
    assert.strictEqual(r.threads[0].links[0].byUid, undefined);
    assert.strictEqual(r.timeZone, 'America/New_York');
    assert.strictEqual(r.access.send, true);
    assert.strictEqual(r.nextCursor, null);
  });

  await t('mailListThreads: пагинация limit+cursor, фильтр направления', async () => {
    const p1 = await read.mailListThreads({ auth: MGRA, data: { unitKey: 'bldg_a__204', limit: 2 } });
    assert.deepStrictEqual(p1.threads.map((x) => x.gmailThreadId), ['ta1', 'ta2']);
    assert.strictEqual(p1.nextCursor, '2026-10-02T00:00:00.000Z');
    const p2 = await read.mailListThreads({ auth: MGRA, data: { unitKey: 'bldg_a__204', limit: 2, cursor: p1.nextCursor } });
    assert.deepStrictEqual(p2.threads.map((x) => x.gmailThreadId), ['ta3']);
    const out = await read.mailListThreads({ auth: MGRA, data: { unitKey: 'bldg_a__204', direction: 'outbound' } });
    assert.deepStrictEqual(out.threads.map((x) => x.gmailThreadId), ['ta2']);
  });

  await t('mailListThreads: чужое здание / viewer / отсутствующий unitKey → отказы', async () => {
    await assert.rejects(read.mailListThreads({ auth: MGRA, data: { unitKey: 'bldg_b__204' } }), (e) => e.code === 'permission-denied');
    await assert.rejects(read.mailListThreads({ auth: V1, data: { unitKey: 'bldg_a__204' } }), (e) => e.code === 'permission-denied');
    await assert.rejects(read.mailListThreads({ auth: ADM, data: {} }), (e) => e.code === 'invalid-argument');
  });

  await t('mailListThreads inbox/all: admin видит непривязанные и всё; manager — нет', async () => {
    const inbox = await read.mailListThreads({ auth: ADM, data: { view: 'inbox' } });
    assert.deepStrictEqual(inbox.threads.map((x) => x.gmailThreadId), ['tu1']);
    const all = await read.mailListThreads({ auth: ADM, data: { view: 'all' } });
    assert.strictEqual(all.threads.length, 5);
    await assert.rejects(read.mailListThreads({ auth: MGRA, data: { view: 'inbox' } }), (e) => e.code === 'permission-denied');
    await assert.rejects(read.mailListThreads({ auth: MGRA, data: { view: 'all' } }), (e) => e.code === 'permission-denied', 'manager с ограничением зданий не получает all');
  });

  await t('грант directions=[outbound]: teamviewer видит только треды с исходящими', async () => {
    const r = await read.mailListThreads({ auth: TV, data: { unitKey: 'bldg_a__204' } });
    assert.deepStrictEqual(r.threads.map((x) => x.gmailThreadId), ['ta2']);
  });

  // ---- mailGetThread ----
  message('m1', 'ta1', { internalDate: 1 });
  message('m2', 'ta1', { internalDate: 2, direction: 'outbound', from: { name: 'SFA', email: ADDR }, hasHtml: true, bodyHtmlPath: 'mail/default/leasing/m2/raw.html', attachments: [{ index: 0, filename: 'logo.png', mime: 'image/png', size: 3, inline: true, contentId: 'logo1', storagePath: 'mail/default/leasing/m2/att/0_logo.png' }, { index: 1, filename: 'doc.pdf', mime: 'application/pdf', size: 5, inline: false, storagePath: 'mail/default/leasing/m2/att/1_doc.pdf' }, { index: 2, filename: 'big.zip', mime: 'application/zip', size: 99, inline: false, storagePath: null, tooLarge: true }] });
  H.files.set('mail/default/leasing/m2/raw.html', { buf: Buffer.from('<p>Hi</p><script>alert(1)</script><img src="cid:logo1"><img src="https://t.test/p.gif">') });

  await t('mailGetThread: письма по времени, HTML санитизирован, cid → подписанный URL, available/tooLarge', async () => {
    const r = await read.mailGetThread({ auth: MGRA, data: { threadDocId: 'leasing__ta1', htmlFor: ['leasing__m2', 'leasing__m1'] } });
    assert.deepStrictEqual(r.messages.map((m) => m.id), ['leasing__m1', 'leasing__m2']);
    assert.strictEqual(r.messages[0].hasHtml, false);
    assert.strictEqual(r.html['leasing__m1'], undefined, 'без HTML — нет записи');
    const h = r.html['leasing__m2'];
    assert.ok(!/script|alert/.test(h.html), h.html);
    assert.ok(/data-mail-cid="logo1"/.test(h.html));
    assert.ok(/data-blocked-src/.test(h.html));
    assert.strictEqual(h.blockedImages, 1);
    assert.ok(/^https:\/\/signed\.example\//.test(h.inline.logo1));
    const atts = r.messages[1].attachments;
    assert.deepStrictEqual(atts.map((a) => [a.available, a.tooLarge]), [[true, false], [true, false], [false, true]]);
    assert.strictEqual(r.thread.gmailThreadId, 'ta1');
  });

  await t('mailGetThread: направление по гранту фильтрует письма; чужой тред → отказ', async () => {
    const r = await read.mailGetThread({ auth: TV, data: { threadDocId: 'leasing__ta1' } });
    assert.deepStrictEqual(r.messages.map((m) => m.id), ['leasing__m2'], 'teamviewer видит только исходящее');
    await assert.rejects(read.mailGetThread({ auth: MGRA, data: { threadDocId: 'leasing__tb1' } }), (e) => e.code === 'permission-denied');
    await assert.rejects(read.mailGetThread({ auth: MGRA, data: { threadDocId: 'leasing__nope' } }), (e) => e.code === 'permission-denied');
    await assert.rejects(read.mailGetThread({ auth: MGRA, data: {} }), (e) => e.code === 'invalid-argument');
  });

  await t('mailGetAttachmentUrl: подписанный URL, disposition по типу, отказы', async () => {
    const pdf = await read.mailGetAttachmentUrl({ auth: MGRA, data: { messageDocId: 'leasing__m2', index: 1 } });
    assert.ok(/^https:\/\/signed\.example\//.test(pdf.url));
    assert.strictEqual(pdf.filename, 'doc.pdf');
    const lastSigned = H.signed[H.signed.length - 1];
    assert.ok(/^inline; filename="doc\.pdf"$/.test(lastSigned.opts.responseDisposition), lastSigned.opts.responseDisposition);
    assert.strictEqual(lastSigned.opts.responseType, 'application/pdf');
    assert.ok(lastSigned.opts.expires - Date.now() <= 10 * 60 * 1000 + 1000);
    await assert.rejects(read.mailGetAttachmentUrl({ auth: MGRA, data: { messageDocId: 'leasing__m2', index: 2 } }), (e) => e.code === 'not-found');
    await assert.rejects(read.mailGetAttachmentUrl({ auth: V1, data: { messageDocId: 'leasing__m2', index: 1 } }), (e) => e.code === 'permission-denied');
    await assert.rejects(read.mailGetAttachmentUrl({ auth: MGRA, data: { messageDocId: 'leasing__zzz', index: 0 } }), (e) => e.code === 'permission-denied');
    await assert.rejects(read.mailGetAttachmentUrl({ auth: MGRA, data: { messageDocId: 'leasing__m2', index: -1 } }), (e) => e.code === 'invalid-argument');
    // teamviewer (только outbound) → m2 исходящее, можно; входящее m1 — нельзя
    message('m3', 'ta1', { internalDate: 3, attachments: [{ index: 0, filename: 'in.pdf', mime: 'application/pdf', size: 1, storagePath: 'mail/default/leasing/m3/att/0_in.pdf' }] });
    await assert.rejects(read.mailGetAttachmentUrl({ auth: TV, data: { messageDocId: 'leasing__m3', index: 0 } }), (e) => e.code === 'permission-denied');
  });

  await t('mailListThreads: mail выключен в конфиге → failed-precondition', async () => {
    H.store.set('workspaces/default/integrations/mail', { enabled: false, mailboxes: [{ id: 'leasing', address: ADDR }] });
    require('path');
    const shared = require(require('path').join(H.FN_DIR, 'mail-shared.js'));
    shared._resetCachesForTests();
    await assert.rejects(read.mailListThreads({ auth: ADM, data: { unitKey: 'bldg_a__204' } }), (e) => e.code === 'failed-precondition');
  });

  console.log(`\nmail-read: ${n} tests passed`);
}

main().catch((e) => { console.error('✗', e); process.exit(1); }).finally(() => H.uninstall());
