/**
 * Unit mail — callable-двери чтения (UNIT_EMAIL_PLAN.md § 4.6, Phase 0).
 *
 * Клиент НЕ читает mailThreads/mailMessages напрямую (firestore.rules закрыты);
 * всё идёт через:
 *   mailListThreads({unitKey | view:'inbox'|'all', direction?, cursor?, limit?})
 *   mailGetThread({threadDocId, htmlFor:[messageDocId…]})   — письма + санитизированный HTML
 *   mailGetAttachmentUrl({messageDocId, index})             — подписанный URL на 10 минут
 * Каждая дверь начинается с accessFor (роль + гранты + потолок зданий); любой
 * отказ — один permission-denied без деталей (Entry 92). HTML санитизируется
 * при КАЖДОМ чтении (сырой лежит в Storage). Вложения отдаются только
 * подписанными URL — путь Storage mail/… не открыт ни одним правилом.
 */
'use strict';

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const shared = require('./mail-shared');
const access = require('./mail-access');
const {sanitizeEmailHtml} = require('./mail-sanitize');

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 50;
const HTML_FOR_MAX = 10;
const SIGNED_URL_TTL_MS = 10 * 60 * 1000;
const VIEWS = ['unit', 'inbox', 'all'];

function pickNames(names, emails) {
  const out = {};
  for (const e of (emails || [])) if (names && names[e]) out[e] = names[e];
  return out;
}

// Публичная проекция треда (без служебных полей).
function threadSummary(id, t) {
  t = t || {};
  const participants = Array.isArray(t.participants) ? t.participants.slice(0, 30) : [];
  return {
    id,
    mailboxId: t.mailboxId || null,
    gmailThreadId: t.gmailThreadId || null,
    subject: t.subject || '',
    snippet: t.snippet || '',
    participants,
    participantNames: pickNames(t.participantNames, participants),
    senders: Array.isArray(t.senders) ? t.senders.slice(0, 20) : [],
    firstMessageAt: t.firstMessageAt || null,
    lastMessageAt: t.lastMessageAt || null,
    messageCount: +t.messageCount || 0,
    hasAttachments: !!t.hasAttachments,
    attachmentNames: Array.isArray(t.attachmentNames) ? t.attachmentNames.slice(0, 10) : [],
    hasInbound: !!t.hasInbound,
    hasOutbound: !!t.hasOutbound,
    lastDirection: t.lastDirection || 'inbound',
    lastFrom: t.lastFrom || null,
    isExternal: !!t.isExternal,
    bounceCount: +t.bounceCount || 0,
    labelIds: Array.isArray(t.labelIds) ? t.labelIds.slice(0, 30) : [],
    unitKeys: Array.isArray(t.unitKeys) ? t.unitKeys : [],
    buildingIds: Array.isArray(t.buildingIds) ? t.buildingIds : [],
    linked: !!t.linked,
    links: (Array.isArray(t.links) ? t.links : []).map((l) => ({ unitKey: l.unitKey, buildingId: l.buildingId, unitId: l.unitId, via: l.via, field: l.field, value: l.value || '', label: l.label || '', by: l.by || null, at: l.at || null })),
    rejected: (Array.isArray(t.rejected) ? t.rejected : []).map((r) => ({ unitKey: r.unitKey, by: r.by || null, at: r.at || null, reason: r.reason || '' })),
  };
}

function messageView(id, m) {
  m = m || {};
  return {
    id,
    gmailMessageId: m.gmailMessageId || null,
    gmailThreadId: m.gmailThreadId || null,
    direction: m.direction || 'inbound',
    from: m.from || null,
    to: Array.isArray(m.to) ? m.to : [],
    cc: Array.isArray(m.cc) ? m.cc : [],
    bcc: Array.isArray(m.bcc) ? m.bcc : [],
    replyTo: m.replyTo || null,
    subject: m.subject || '',
    date: m.date || null,
    dateHeader: m.dateHeader || '',
    internalDate: +m.internalDate || 0,
    snippet: m.snippet || '',
    bodyText: m.bodyText || '',
    bodyTextTruncated: !!m.bodyTextTruncated,
    hasHtml: !!m.hasHtml && !!m.bodyHtmlPath,
    attachments: (Array.isArray(m.attachments) ? m.attachments : []).map((a) => ({
      index: a.index, filename: a.filename, mime: a.mime || 'application/octet-stream', size: +a.size || 0,
      inline: !!a.inline, contentId: a.contentId || null, available: !!a.storagePath, tooLarge: !!a.tooLarge,
    })),
    isBounce: !!m.isBounce,
    deliveryFailed: !!m.deliveryFailed,
    messageIdHeader: m.messageIdHeader || null,
    inReplyTo: m.inReplyTo || null,
    unitKeys: Array.isArray(m.unitKeys) ? m.unitKeys : [],
    buildingIds: Array.isArray(m.buildingIds) ? m.buildingIds : [],
    sentByEmail: m.sentByEmail || null,
    sentVia: m.sentVia || null,
    source: m.source || null,
  };
}

async function signedUrl(bucket, att, forceDownload) {
  const filename = String(att.filename || 'attachment').replace(/["\r\n\\]/g, '_');
  const [url] = await bucket.file(att.storagePath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + SIGNED_URL_TTL_MS,
    responseDisposition: `${forceDownload ? 'attachment' : 'inline'}; filename="${filename}"`,
    responseType: att.mime || 'application/octet-stream',
  });
  return url;
}

async function loadThreadMessages(db, t, a) {
  const snap = await db.collection(shared.col('mailMessages'))
    .where('mailboxId', '==', t.mailboxId)
    .where('gmailThreadId', '==', t.gmailThreadId)
    .get();
  return (snap.docs || [])
    .map((x) => ({ id: x.id, data: x.data() || {} }))
    .filter((x) => a.directionVisible(x.data.direction || 'inbound'))
    .sort((x, y) => (+x.data.internalDate || 0) - (+y.data.internalDate || 0));
}

exports.mailListThreads = onCall({ memory: '512MiB', timeoutSeconds: 30 }, async (req) => {
  const a = access.assertMailReader(await access.accessFor(req.auth));
  const d = req.data || {};
  const cfg = await shared.getMailConfig();
  if (!cfg.enabled) throw new HttpsError('failed-precondition', 'Mail is not enabled for this workspace');
  const view = VIEWS.includes(d.view) ? d.view : 'unit';
  const limit = Math.min(Math.max(+d.limit || LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);
  const direction = access.DIRECTIONS.includes(d.direction) ? d.direction : null;
  const db = shared.db();
  let q = db.collection(shared.col('mailThreads'));
  let unitKey = null;
  if (view === 'unit') {
    const parsed = shared.parseUnitKey(d.unitKey);
    if (!parsed) throw new HttpsError('invalid-argument', 'unitKey is required');
    access.assertCanReadBuilding(a, parsed.buildingId);
    unitKey = shared.unitKeyOf(parsed.buildingId, parsed.unitId);
    q = q.where('unitKeys', 'array-contains', unitKey);
  } else if (view === 'inbox') {
    if (!a.seeUnlinked) throw access.denied();
    q = q.where('linked', '==', false);
  } else if (!(a.isAdmin || a.read === 'all')) {
    throw access.denied();
  }
  q = q.orderBy('lastMessageAt', 'desc');
  if (typeof d.cursor === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(d.cursor)) q = q.startAfter(d.cursor);
  q = q.limit(limit);
  const snap = await q.get();
  const threads = [];
  for (const docSnap of (snap.docs || [])) {
    const t = docSnap.data() || {};
    if (!a.canReadThread(t)) continue;
    const want = direction || (a.directions.length === 1 ? a.directions[0] : null);
    if (want === 'inbound' && !t.hasInbound) continue;
    if (want === 'outbound' && !t.hasOutbound) continue;
    threads.push(threadSummary(docSnap.id, t));
  }
  const docs = snap.docs || [];
  const last = docs.length ? (docs[docs.length - 1].data() || {}) : null;
  return {
    ok: true,
    view,
    unitKey,
    threads,
    nextCursor: docs.length === limit && last && last.lastMessageAt ? last.lastMessageAt : null,
    timeZone: cfg.timeZone,
    mailboxes: cfg.mailboxes.map((m) => ({ id: m.id, address: m.address, displayName: m.displayName })),
    access: { read: a.read, send: !!a.send, seeUnlinked: !!a.seeUnlinked, directions: a.directions, isAdmin: !!a.isAdmin },
  };
});

exports.mailGetThread = onCall({ memory: '512MiB', timeoutSeconds: 60 }, async (req) => {
  const a = access.assertMailReader(await access.accessFor(req.auth));
  const d = req.data || {};
  const threadDocId = String(d.threadDocId || '').slice(0, 200);
  if (!threadDocId) throw new HttpsError('invalid-argument', 'threadDocId is required');
  const htmlFor = (Array.isArray(d.htmlFor) ? d.htmlFor : []).map((x) => String(x)).slice(0, HTML_FOR_MAX);
  const cfg = await shared.getMailConfig();
  const db = shared.db();
  const tSnap = await db.doc(shared.col(`mailThreads/${threadDocId}`)).get();
  if (!tSnap.exists) throw access.denied();
  const t = tSnap.data() || {};
  if (!a.canReadThread(t)) throw access.denied();
  const rows = await loadThreadMessages(db, t, a);
  const bucket = admin.storage().bucket();
  const html = {};
  for (const row of rows) {
    if (!htmlFor.includes(row.id) || !row.data.bodyHtmlPath) continue;
    try {
      const [buf] = await bucket.file(row.data.bodyHtmlPath).download();
      const r = sanitizeEmailHtml(buf.toString('utf8'));
      const inline = {};
      for (const att of (row.data.attachments || [])) {
        if (att && att.inline && att.contentId && att.storagePath) {
          try { inline[att.contentId] = await signedUrl(bucket, att, false); } catch (e) { /* картинка просто не покажется */ }
        }
      }
      html[row.id] = { html: r.html, blockedImages: r.blockedImages, inlineImages: r.inlineImages, truncated: r.truncated, inline };
    } catch (e) {
      logger.warn('[mail-read] html unavailable', { message: row.id, error: String((e && e.message) || e).slice(0, 200) });
      html[row.id] = { error: 'unavailable' };
    }
  }
  return {
    ok: true,
    thread: threadSummary(tSnap.id, t),
    messages: rows.map((row) => messageView(row.id, row.data)),
    html,
    timeZone: cfg.timeZone,
  };
});

exports.mailGetAttachmentUrl = onCall({ memory: '256MiB', timeoutSeconds: 30 }, async (req) => {
  const a = access.assertMailReader(await access.accessFor(req.auth));
  const d = req.data || {};
  const messageDocId = String(d.messageDocId || '').slice(0, 200);
  const index = Number(d.index);
  if (!messageDocId || !Number.isInteger(index) || index < 0) throw new HttpsError('invalid-argument', 'messageDocId and index are required');
  const db = shared.db();
  const mSnap = await db.doc(shared.col(`mailMessages/${messageDocId}`)).get();
  if (!mSnap.exists) throw access.denied();
  const m = mSnap.data() || {};
  const tSnap = await db.doc(shared.col(`mailThreads/${m.mailboxId}__${m.gmailThreadId}`)).get();
  if (!tSnap.exists || !a.canReadThread(tSnap.data() || {}) || !a.directionVisible(m.direction || 'inbound')) throw access.denied();
  const att = (Array.isArray(m.attachments) ? m.attachments : [])[index];
  if (!att || !att.storagePath) throw new HttpsError('not-found', att && att.tooLarge ? 'Attachment is larger than 25 MB and was not copied' : 'Attachment is not available');
  const forceDownload = !/^(image\/|application\/pdf$)/.test(String(att.mime || ''));
  const url = await signedUrl(admin.storage().bucket(), att, forceDownload);
  return { ok: true, url, filename: att.filename, mime: att.mime || 'application/octet-stream', size: +att.size || 0, expiresInSec: Math.floor(SIGNED_URL_TTL_MS / 1000) };
});

module.exports._internals = { threadSummary, messageView, signedUrl, LIST_LIMIT_MAX, HTML_FOR_MAX };
