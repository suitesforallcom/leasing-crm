// Тест functions/mail-sync.js (UNIT_EMAIL_PLAN.md § 4.6): нормализация писем,
// push/догон по history.list, протухший historyId → resync, ретраи + dead-letter,
// lock, watch, backfill, admin-status. Фикстурный Gmail, Firestore/Storage в памяти.
// Запуск: node tests/mail-sync.test.cjs
'use strict';
const assert = require('assert');
const path = require('path');
const { makeHarness, gmailMessage } = require('./_mail-harness.cjs');

const H = makeHarness();
H.install();
const sync = H.loadModule('mail-sync');
const shared = require(path.join(H.FN_DIR, 'mail-shared.js'));
const link = require(path.join(H.FN_DIR, 'mail-link.js'));
const I = sync._internals;

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('  ✓ ' + name); }

const ADDR = 'leasing@al-en.com';
const MB = () => H.fixture.mailboxes[ADDR];
const T0 = Date.parse('2026-10-20T15:00:00Z');

function setConfig(over) {
  H.store.set('workspaces/default/integrations/mail', Object.assign({ enabled: true, mailboxes: [{ id: 'leasing', address: ADDR, displayName: 'SuitesForAll Leasing' }], backfillSince: '2026-01-01' }, over || {}));
  shared._resetCachesForTests();
}
function resetMailbox() {
  H.fixture.mailboxes[ADDR] = { historyId: 1000, messages: new Map(), history: [], attachments: {} };
  for (const k of Array.from(H.store.keys())) if (/\/(mailboxes|mailThreads|mailMessages|mailDeadLetter)\//.test(k)) H.store.delete(k);
  H.files.clear();
  link._resetCachesForTests();
}
function addMsg(o, historyId) {
  const m = gmailMessage(o);
  MB().messages.set(m.id, m);
  if (historyId != null) { MB().history.push({ id: historyId, messagesAdded: [m.id] }); MB().historyId = Math.max(MB().historyId, historyId); }
  return m;
}
const B1 = { id: 'bldg_a', name: 'Milam', floors: [{ id: 'f2', units: [{ id: '204', tenant: 'Kastle Systems', email: 'ryan.quinty@kastle.com', emailCc: 'jackie@kastle.com' }] }] };
H.store.set('workspaces/default/data/state', { state: { settings: { syncBuildingsStrip: true }, buildings: [] } });
H.store.set('workspaces/default/buildings/bldg_a', { _schema: 'v2', doc: B1 });
H.store.set('workspaces/default/members/adm', { role: 'admin', email: 'adm@al-en.com' });
H.store.set('workspaces/default/members/v1', { role: 'viewer', email: 'v1@al-en.com' });
const ROOT = { uid: 'root', token: { email: 'tony@al-en.com', email_verified: true } };
const cfgOf = () => shared.getMailConfig({ fresh: true });
const mailboxOf = async () => shared.mailboxById(await cfgOf(), 'leasing');
const mbDoc = () => H.store.get('workspaces/default/mailboxes/leasing') || {};

async function main() {
  setConfig();
  resetMailbox();

  await t('normalizeMessage: заголовки, направление, участники без своих ящиков, тело, вложения, bounce', () => {
    const ctx = { mailboxId: 'leasing', ownAddresses: new Set([ADDR]), ownDomains: new Set(['al-en.com']) };
    const m = gmailMessage({ id: 'm1', threadId: 't1', from: '"Quinty, Ryan" <Ryan.Quinty@kastle.com>', to: `SFA <${ADDR}>, jackie@kastle.com`, cc: 'chandler@kastle.com', subject: 'Re: Fwd: Revised Kastle Service Agreement', text: 'Hi Kristen,\r\n\r\nPlease see attached.\n\nOn Wed, Oct 21 Kristen wrote:\n> old', html: '<p>Hi <b>Kristen</b></p><img src="cid:logo1">', internalDate: T0, references: '<a@x> <b@x>', inReplyTo: '<B@x>', attachments: [{ filename: 'Kastle - Account Transfer.pdf', mime: 'application/pdf', attachmentId: 'att1', size: 100 }, { filename: 'logo.png', mime: 'image/png', attachmentId: 'att2', contentId: 'logo1', inline: true, size: 50 }] });
    const r = I.normalizeMessage(m, ctx);
    assert.strictEqual(r.direction, 'inbound');
    assert.deepStrictEqual(r.from, { name: 'Quinty, Ryan', email: 'ryan.quinty@kastle.com' });
    assert.deepStrictEqual(r.participants, ['ryan.quinty@kastle.com', 'jackie@kastle.com', 'chandler@kastle.com'], 'свой ящик исключён');
    assert.strictEqual(r.participantNames['ryan.quinty@kastle.com'], 'Quinty, Ryan');
    assert.strictEqual(r.subjectNorm, 'revised kastle service agreement');
    assert.strictEqual(r.inReplyTo, 'b@x');
    assert.deepStrictEqual(r.references, ['a@x', 'b@x']);
    assert.ok(r.bodyText.startsWith('Hi Kristen,\n\nPlease see attached.'), JSON.stringify(r.bodyText));
    assert.strictEqual(r.hasHtml, true);
    assert.strictEqual(r.attachments.length, 2);
    assert.strictEqual(r.attachments[1].inline, true);
    assert.strictEqual(r.attachments[1].contentId, 'logo1');
    assert.strictEqual(r.isExternal, true);
    assert.strictEqual(r.isBounce, false);
    assert.strictEqual(r.date, new Date(T0).toISOString());
    const sent = I.normalizeMessage(gmailMessage({ id: 'm2', from: `SFA <${ADDR}>`, to: 'x@y.test', subject: 's', text: 'ok', labelIds: ['SENT'] }), ctx);
    assert.strictEqual(sent.direction, 'outbound');
    assert.deepStrictEqual(sent.participants, ['x@y.test']);
    const bounce = I.normalizeMessage(gmailMessage({ id: 'm3', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', to: ADDR, subject: 'Delivery Status Notification (Failure)', text: 'x' }), ctx);
    assert.strictEqual(bounce.isBounce, true);
    const htmlOnly = I.normalizeMessage(gmailMessage({ id: 'm4', from: 'a@b.test', to: ADDR, subject: 's', html: '<div>Only <i>html</i><br>here</div>' }), ctx);
    assert.strictEqual(htmlOnly.bodyText, 'Only html\nhere');
    assert.strictEqual(I.subjectNorm('RE: re: Fw[2]: Hello   World'), 'hello world');
  });

  await t('bootstrap: без курсора — берём historyId из профиля, ничего не тянем', async () => {
    const cfg = await cfgOf();
    const r = await I.runMailboxJob(cfg, await mailboxOf(), 'schedule', (ctx, ref, d) => I.syncDelta(ctx, ref, d));
    assert.strictEqual(r.bootstrapped, true);
    assert.strictEqual(mbDoc().lastHistoryId, '1000');
    assert.strictEqual(mbDoc().syncLock, undefined, 'lock снят');
    assert.strictEqual(mbDoc().syncVersion, 1);
  });

  await t('push: письмо арендатора → mailMessages + mailThreads с авто-ссылкой, HTML и вложение в Storage, курсор продвинут', async () => {
    MB().attachments.att1 = Buffer.from('%PDF-1.4 fake');
    MB().attachments.att2 = Buffer.from('PNG');
    addMsg({ id: 'm1', threadId: 't1', from: '"Quinty, Ryan" <ryan.quinty@kastle.com>', to: ADDR, subject: 'Revised Kastle Service Agreement', text: 'Hi Kristen', html: '<p>Hi <img src="cid:logo1"></p>', internalDate: T0, attachments: [{ filename: 'Kastle - Account Transfer.pdf', mime: 'application/pdf', attachmentId: 'att1', size: 13 }, { filename: 'logo.png', mime: 'image/png', attachmentId: 'att2', contentId: 'logo1', inline: true, size: 3 }] }, 1001);
    const push = H.pubsub[0].fn;
    await push({ data: { message: { data: Buffer.from(JSON.stringify({ emailAddress: ADDR, historyId: 1001 })).toString('base64') } } });
    const msg = H.store.get('workspaces/default/mailMessages/leasing__m1');
    assert.ok(msg, 'письмо сохранено');
    assert.strictEqual(msg.bodyHtmlPath, 'mail/default/leasing/m1/raw.html');
    assert.ok(H.files.has('mail/default/leasing/m1/raw.html'));
    assert.strictEqual(msg.attachments[0].storagePath, 'mail/default/leasing/m1/att/0_Kastle - Account Transfer.pdf');
    assert.ok(H.files.has(msg.attachments[0].storagePath));
    assert.strictEqual(msg.hasAttachments, true);
    assert.strictEqual(msg.source, 'push');
    assert.strictEqual(msg._html, undefined, 'сырой HTML не в Firestore');
    assert.deepStrictEqual(msg.unitKeys, ['bldg_a__204'], 'денормализация ключей на письмо');
    const th = H.store.get('workspaces/default/mailThreads/leasing__t1');
    assert.ok(th, 'тред создан');
    assert.deepStrictEqual(th.unitKeys, ['bldg_a__204']);
    assert.deepStrictEqual(th.buildingIds, ['bldg_a']);
    assert.strictEqual(th.links[0].via, 'address');
    assert.strictEqual(th.links[0].value, 'ryan.quinty@kastle.com');
    assert.strictEqual(th.messageCount, 1);
    assert.strictEqual(th.linked, true);
    assert.strictEqual(th.hasInbound, true);
    assert.deepStrictEqual(th.attachmentNames, ['Kastle - Account Transfer.pdf']);
    assert.strictEqual(th.senders[0].email, 'ryan.quinty@kastle.com');
    assert.strictEqual(mbDoc().lastHistoryId, '1001');
    assert.strictEqual(mbDoc().syncVersion, 2);
    assert.strictEqual(mbDoc().lastError, null);
  });

  await t('идемпотентность: повторный push тех же записей ничего не дублирует', async () => {
    const cfg = await cfgOf();
    H.store.get('workspaces/default/mailboxes/leasing').lastHistoryId = '1000';
    const r = await I.runMailboxJob(cfg, await mailboxOf(), 'push', (ctx, ref, d) => I.syncDelta(ctx, ref, d));
    assert.strictEqual(r.stats.stored, 0);
    assert.strictEqual(r.stats.skippedExisting, 1);
    assert.strictEqual(H.store.get('workspaces/default/mailThreads/leasing__t1').messageCount, 1);
    assert.strictEqual(mbDoc().lastHistoryId, '1001');
  });

  await t('ответ из ящика (SENT) в тот же тред: агрегат обновлён, DRAFT/TRASH пропущены', async () => {
    addMsg({ id: 'm2', threadId: 't1', from: `SuitesForAll <${ADDR}>`, to: 'ryan.quinty@kastle.com', subject: 'Re: Revised Kastle Service Agreement', text: 'Thanks Ryan', internalDate: T0 + 3600e3, labelIds: ['SENT'] }, 1002);
    addMsg({ id: 'd1', threadId: 't9', from: ADDR, to: 'x@y.test', subject: 'draft', text: 'd', labelIds: ['DRAFT'] }, 1003);
    addMsg({ id: 'tr1', threadId: 't8', from: 'spam@z.test', to: ADDR, subject: 'spam', text: 's', labelIds: ['TRASH'] }, 1004);
    const cfg = await cfgOf();
    const r = await I.runMailboxJob(cfg, await mailboxOf(), 'schedule', (ctx, ref, d) => I.syncDelta(ctx, ref, d));
    assert.strictEqual(r.stats.stored, 1);
    assert.ok(!H.store.has('workspaces/default/mailMessages/leasing__d1'));
    assert.ok(!H.store.has('workspaces/default/mailMessages/leasing__tr1'));
    const th = H.store.get('workspaces/default/mailThreads/leasing__t1');
    assert.strictEqual(th.messageCount, 2);
    assert.strictEqual(th.hasOutbound, true);
    assert.strictEqual(th.lastDirection, 'outbound');
    assert.strictEqual(th.lastMessageAt, new Date(T0 + 3600e3).toISOString());
    assert.deepStrictEqual(H.store.get('workspaces/default/mailMessages/leasing__m2').unitKeys, ['bldg_a__204'], 'via thread');
    assert.strictEqual(mbDoc().lastHistoryId, '1004');
  });

  await t('протухший historyId (404) → resync по messages.list(newer_than:7d) и курсор из профиля', async () => {
    MB().expiredBefore = 5000;
    MB().historyId = 6000;
    addMsg({ id: 'm5', threadId: 't5', from: 'lead@new.test', to: ADDR, subject: 'Tour request', text: 'Hi', internalDate: T0 + 2 * 86400e3 });
    const cfg = await cfgOf();
    const r = await I.runMailboxJob(cfg, await mailboxOf(), 'schedule', (ctx, ref, d) => I.syncDelta(ctx, ref, d));
    assert.strictEqual(r.historyExpired, true);
    assert.ok(H.store.has('workspaces/default/mailMessages/leasing__m5'));
    assert.strictEqual(mbDoc().lastHistoryId, '6000');
    assert.ok(mbDoc().resyncedAt);
    const th5 = H.store.get('workspaces/default/mailThreads/leasing__t5');
    assert.strictEqual(th5.linked, false, 'неизвестный адрес → непривязанный тред');
    delete MB().expiredBefore;
  });

  await t('сбой messages.get → pendingRetry + dead-letter; следующий тик повторяет; после 3 неудач — exhausted', async () => {
    const cfg = await cfgOf();
    addMsg({ id: 'bad1', threadId: 'tb', from: 'a@b.test', to: ADDR, subject: 'x', text: 'x' }, 6001);
    MB().failGet = { bad1: 2 };
    let r = await I.runMailboxJob(cfg, await mailboxOf(), 'push', (ctx, ref, d) => I.syncDelta(ctx, ref, d));
    assert.strictEqual(r.stats.errors, 1);
    assert.deepStrictEqual(mbDoc().pendingRetry.map((p) => [p.id, p.attempts]), [['bad1', 1]]);
    assert.ok(Array.from(H.store.keys()).some((k) => k.includes('/mailDeadLetter/sync_leasing_')), 'dead-letter записан');
    assert.strictEqual(mbDoc().lastError, null, 'частичный сбой — не ошибка ящика');
    r = await I.runMailboxJob(cfg, await mailboxOf(), 'schedule', (ctx, ref, d) => I.syncDelta(ctx, ref, d));
    assert.deepStrictEqual(mbDoc().pendingRetry.map((p) => [p.id, p.attempts]), [['bad1', 2]]);
    r = await I.runMailboxJob(cfg, await mailboxOf(), 'schedule', (ctx, ref, d) => I.syncDelta(ctx, ref, d));
    assert.deepStrictEqual(mbDoc().pendingRetry, [], 'третий тик забрал письмо');
    assert.ok(H.store.has('workspaces/default/mailMessages/leasing__bad1'));
    // exhausted-ветка
    MB().failGet = { bad1: 99 };
    H.store.get('workspaces/default/mailboxes/leasing').pendingRetry = [{ id: 'bad1', attempts: 2 }];
    H.store.delete('workspaces/default/mailMessages/leasing__bad1');
    await I.runMailboxJob(cfg, await mailboxOf(), 'schedule', (ctx, ref, d) => I.syncDelta(ctx, ref, d));
    assert.deepStrictEqual(mbDoc().pendingRetry, []);
    assert.ok(H.store.has('workspaces/default/mailDeadLetter/message_leasing_bad1'), 'exhausted dead-letter');
    MB().failGet = null;
  });

  await t('полный сбой ящика (403) → lastError + dead-letter sync-failed, lock снят, без throw', async () => {
    const cfg = await cfgOf();
    MB().failWith = 403;
    const r = await I.runMailboxJob(cfg, await mailboxOf(), 'schedule', (ctx, ref, d) => I.syncDelta(ctx, ref, d));
    assert.ok(r.error, 'ошибка возвращена, не брошена');
    assert.strictEqual(mbDoc().lastError.code, 403);
    assert.strictEqual(mbDoc().syncLock, undefined);
    assert.ok(Array.from(H.store.entries()).some(([k, v]) => k.includes('/mailDeadLetter/') && v.kind === 'sync-failed'));
    delete MB().failWith;
  });

  await t('lock: свежий syncLock → job пропускается', async () => {
    const cfg = await cfgOf();
    H.store.get('workspaces/default/mailboxes/leasing').syncLock = { at: Date.now(), by: 'other' };
    const r = await I.runMailboxJob(cfg, await mailboxOf(), 'push', async () => { throw new Error('must not run'); });
    assert.strictEqual(r.locked, true);
    H.store.get('workspaces/default/mailboxes/leasing').syncLock = { at: Date.now() - 10 * 60e3, by: 'stale' };
    const r2 = await I.runMailboxJob(cfg, await mailboxOf(), 'push', async () => ({ ran: true }));
    assert.strictEqual(r2.ran, true, 'протухший lock не мешает');
  });

  await t('mailSyncScheduled: enabled=false → ничего; enabled → синк + регистрация watch', async () => {
    const sched = H.scheduled[0].fn;
    setConfig({ enabled: false });
    const before = H.gmailCalls.length;
    await sched();
    assert.strictEqual(H.gmailCalls.length, before, 'выключено — Gmail не трогаем');
    setConfig();
    await sched();
    assert.ok(mbDoc().watchExpiration > Date.now(), 'watch зарегистрирован');
    assert.deepStrictEqual(MB().watched.labelIds, ['INBOX', 'SENT']);
    assert.strictEqual(MB().watched.topicName, 'projects/test-proj/topics/sfa-mail-push');
    const calls = H.gmailCalls.filter((c) => c.name === 'watch').length;
    await sched();
    assert.strictEqual(H.gmailCalls.filter((c) => c.name === 'watch').length, calls, 'свежий watch не продлевается');
  });

  await t('mailOnPush: неизвестный адрес игнорируется без job', async () => {
    const before = H.gmailCalls.length;
    await H.pubsub[0].fn({ data: { message: { data: Buffer.from(JSON.stringify({ emailAddress: 'someone@al-en.com', historyId: 1 })).toString('base64') } } });
    assert.strictEqual(H.gmailCalls.length, before);
    await H.pubsub[0].fn({ data: { message: { data: 'bm90IGpzb24=' } } }); // «not json» — не падаем
  });

  await t('mailBackfill: только root admin (admin-член — отказ)', async () => {
    await assert.rejects(sync.mailBackfill({ auth: { uid: 'adm', token: { email: 'adm@al-en.com' } }, data: {} }), (e) => e.code === 'permission-denied');
    await assert.rejects(sync.mailBackfill({ auth: null, data: {} }), (e) => e.code === 'permission-denied');
  });

  await t('mailBackfill: три письма одной страницей → done:true, lastHistoryId из профиля, треды привязаны', async () => {
    resetMailbox();
    MB().historyId = 7000;
    for (let i = 1; i <= 3; i++) addMsg({ id: 'bf' + i, threadId: 'tbf' + i, from: 'jackie@kastle.com', to: ADDR, subject: 'Backfill ' + i, text: 'b' + i, internalDate: T0 - i * 86400e3 });
    const r = await sync.mailBackfill({ auth: ROOT, data: { pageSize: 10 } });
    const res = r.results[0];
    assert.strictEqual(res.done, true);
    assert.strictEqual(res.imported, 3);
    assert.strictEqual(mbDoc().backfill.done, true);
    assert.strictEqual(mbDoc().lastHistoryId, '7000');
    assert.deepStrictEqual(H.store.get('workspaces/default/mailThreads/leasing__tbf2').unitKeys, ['bldg_a__204']);
    assert.strictEqual(H.store.get('workspaces/default/mailThreads/leasing__tbf2').links[0].field, 'emailCc');
    const again = await sync.mailBackfill({ auth: ROOT, data: {} });
    assert.strictEqual(again.results[0].done, true);
    assert.strictEqual(again.results[0].pageIds, 0, 'повторный вызов после done ничего не тянет');
  });

  await t('mailBackfill: пагинация по pageToken (maxResults=2 у фикстуры через pageSize=10 → кламп) — эмулируем страницами', async () => {
    resetMailbox();
    MB().historyId = 7000;
    for (let i = 1; i <= 5; i++) addMsg({ id: 'pg' + i, threadId: 'tpg' + i, from: 'x@y.test', to: ADDR, subject: 'P' + i, text: 'p', internalDate: T0 - i * 1000 });
    // pageSize < 10 клампится до 10, поэтому страницы режем на стороне фикстуры: подменяем list
    const origList = H.fixture.mailboxes[ADDR].listFilter;
    H.fixture.mailboxes[ADDR].listFilter = null;
    const r1 = await I.runMailboxJob(await cfgOf(), await mailboxOf(), 'backfill', (ctx, ref, d) => I.backfillMailbox(ctx, ref, d, 2));
    assert.strictEqual(r1.done, false);
    assert.strictEqual(r1.pageIds, 2);
    assert.strictEqual(mbDoc().backfill.pageToken, '1');
    const r2 = await I.runMailboxJob(await cfgOf(), await mailboxOf(), 'backfill', (ctx, ref, d) => I.backfillMailbox(ctx, ref, d, 2));
    assert.strictEqual(r2.done, false);
    const r3 = await I.runMailboxJob(await cfgOf(), await mailboxOf(), 'backfill', (ctx, ref, d) => I.backfillMailbox(ctx, ref, d, 2));
    assert.strictEqual(r3.done, true);
    assert.strictEqual(r3.imported, 5);
    H.fixture.mailboxes[ADDR].listFilter = origList;
  });

  await t('mailAdminStatus: admin видит состояние ящика и dead-letters; viewer — отказ; stopWatch только root', async () => {
    const r = await sync.mailAdminStatus({ auth: { uid: 'adm', token: { email: 'adm@al-en.com' } }, data: {} });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mailboxes[0].id, 'leasing');
    assert.strictEqual(r.mailboxes[0].state.backfill.done, true);
    assert.ok(Array.isArray(r.deadLetters));
    await assert.rejects(sync.mailAdminStatus({ auth: { uid: 'v1', token: { email: 'v1@al-en.com' } }, data: {} }), (e) => e.code === 'permission-denied');
    await assert.rejects(sync.mailAdminStatus({ auth: { uid: 'adm', token: { email: 'adm@al-en.com' } }, data: { stopWatch: true } }), (e) => e.code === 'permission-denied');
    MB().watched = { labelIds: ['INBOX'] };
    const s = await sync.mailAdminStatus({ auth: ROOT, data: { stopWatch: true } });
    assert.strictEqual(s.actions[0].stopWatch, true);
    assert.strictEqual(MB().watched, null);
    assert.ok(H.auditLog.some((a) => a.action === 'mail.watch.stop'));
  });

  console.log(`\nmail-sync: ${n} tests passed`);
}

main().catch((e) => { console.error('✗', e); process.exit(1); }).finally(() => H.uninstall());
