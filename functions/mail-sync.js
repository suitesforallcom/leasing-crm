/**
 * Unit mail — синхронизация общего ящика (UNIT_EMAIL_PLAN.md § 4.6, Phase 0).
 *
 *   Gmail (общий ящик) ── users.watch(INBOX,SENT) ──► Pub/Sub `sfa-mail-push`
 *        ──► mailOnPush ──┐
 *   mailSyncScheduled (каждые 10 мин, догон + продление watch) ──┤
 *   mailBackfill (root admin, первичный импорт с backfillSince)  ──┤
 *                                                                 ▼
 *        history.list(startHistoryId) → messages.get(format=full) → normalizeMessage
 *        → Storage mail/{wid}/{mailboxId}/{gmailMessageId}/raw.html + att/*
 *        → Firestore mailMessages/{mailboxId}__{gmailMessageId}
 *        → updateThread: mailThreads/{mailboxId}__{gmailThreadId} (агрегат +
 *          авто-ссылки по адресам, mail-link.js) → unitKeys/buildingIds на письма.
 *
 * Инварианты:
 *   • идемпотентность — id документов = Gmail id, повторный push безвреден;
 *   • § 0.2.5 — любой сбой оставляет mailboxes.lastError + mailDeadLetter (+ Sentry
 *     через logger.error); письма, которые не удалось забрать, попадают в
 *     pendingRetry и повторяются следующим тиком (≤ 3 попыток, затем dead-letter);
 *   • историю Gmail держит ~неделю: 404/400 на history.list → ограниченный
 *     пересчёт messages.list(newer_than:7d) и новый курсор из getProfile;
 *   • один job на ящик за раз (syncLock с TTL), push и расписание не дерутся;
 *   • в Storage пишет только CF; клиент получает подписанные URL (mail-read.js).
 */
'use strict';

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onMessagePublished} = require('firebase-functions/v2/pubsub');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const shared = require('./mail-shared');
const access = require('./mail-access');
const link = require('./mail-link');
const {htmlToText, decodeEntities} = require('./mail-sanitize');

const MAX_MESSAGES_PER_RUN = 150;
const MAX_RESYNC_MESSAGES = 300;
const BACKFILL_PAGE = 100;
const FETCH_CONCURRENCY = 4;
const LOCK_TTL_MS = 4 * 60 * 1000;
const WATCH_RENEW_BEFORE_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_PENDING_RETRY = 100;
const SKIP_LABELS = ['DRAFT', 'TRASH', 'SPAM'];

// ------------------------------------------------------------- helpers ---

function b64urlDecode(data) {
  if (!data) return Buffer.alloc(0);
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function headersOf(part) {
  const map = {};
  for (const h of ((part && part.headers) || [])) {
    if (!h || !h.name) continue;
    const k = String(h.name).toLowerCase();
    if (map[k] === undefined) map[k] = String(h.value == null ? '' : h.value);
  }
  return map;
}

// «Re: Fwd: FW: тема» → «тема» (lower, схлопнутые пробелы) — ключ беседы.
function subjectNorm(subject) {
  let s = String(subject || '').trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s*(re|fw|fwd|aw|sv|tr|vs|rv|wg)\s*(\[\d+\])?\s*:\s*/i, '');
  } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 300);
}

const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/calendar': '.ics' };

function walkParts(part, acc, depth) {
  if (!part || depth > 20) return;
  const mime = String(part.mimeType || '').toLowerCase();
  const body = part.body || {};
  const filename = String(part.filename || '');
  const ph = headersOf(part);
  const cidRaw = ph['content-id'] || '';
  const contentId = cidRaw ? cidRaw.trim().replace(/^<|>$/g, '').slice(0, 200) : '';
  const disposition = String(ph['content-disposition'] || '').toLowerCase();
  const isAttachment = !!filename || !!body.attachmentId || (!!contentId && !mime.startsWith('text/') && !mime.startsWith('multipart/'));
  if (isAttachment) {
    acc.attachments.push({
      partId: String(part.partId || ''),
      filename: shared.safeFilename(filename || ('part-' + (acc.attachments.length + 1) + (MIME_EXT[mime] || ''))),
      mime: mime || 'application/octet-stream',
      size: +body.size || 0,
      gmailAttachmentId: body.attachmentId || null,
      contentId: contentId || null,
      inline: /inline/.test(disposition) || (!!contentId && !/attachment/.test(disposition)),
      dataInline: body.attachmentId ? null : (body.data || null),
    });
    return;
  }
  if (mime === 'text/plain' && body.data) acc.text.push(b64urlDecode(body.data).toString('utf8'));
  else if (mime === 'text/html' && body.data) acc.html.push(b64urlDecode(body.data).toString('utf8'));
  for (const p of (Array.isArray(part.parts) ? part.parts : [])) walkParts(p, acc, depth + 1);
}

/**
 * Gmail message (format=full) → нормализованная запись (чистая функция).
 * ctx: { mailboxId, ownAddresses:Set<string>, ownDomains:Set<string> }
 * Поля _html/_rawAttachments НЕ пишутся в Firestore (уходят в Storage).
 */
function normalizeMessage(msg, ctx) {
  const payload = (msg && msg.payload) || {};
  const h = headersOf(payload);
  const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds.map(String) : [];
  const direction = labelIds.includes('SENT') ? 'outbound' : 'inbound';
  const from = shared.parseAddress(h['from']) || { name: '', email: '' };
  const to = shared.parseAddressList(h['to']);
  const cc = shared.parseAddressList(h['cc']);
  const bcc = direction === 'outbound' ? shared.parseAddressList(h['bcc']) : [];
  const replyTo = shared.parseAddress(h['reply-to']);
  const subject = shared.clampText(h['subject'] || '', 998);
  const headerMs = Date.parse(h['date'] || '');
  const internalDate = +msg.internalDate || (Number.isFinite(headerMs) ? headerMs : Date.now());
  const acc = { text: [], html: [], attachments: [] };
  walkParts(payload, acc, 0);
  const html = acc.html.length ? acc.html.join('\n<hr>\n') : '';
  let bodyText = acc.text.length ? acc.text.join('\n\n') : (html ? htmlToText(html) : '');
  bodyText = bodyText.replace(/\r\n?/g, '\n');
  const bodyTextTruncated = bodyText.length > shared.MAX_BODY_TEXT;
  if (bodyTextTruncated) bodyText = bodyText.slice(0, shared.MAX_BODY_TEXT);
  const snippetRaw = decodeEntities(String(msg.snippet || '')).trim() || bodyText.slice(0, 400).replace(/\s+/g, ' ').trim();
  const snippet = shared.clampText(snippetRaw, shared.MAX_SNIPPET);
  const isBounce = /^(mailer-daemon|postmaster)@/i.test(from.email)
    || !!h['x-failed-recipients']
    || (/auto-(replied|generated)/i.test(h['auto-submitted'] || '') && /(undeliver|delivery|failure|returned|bounce)/i.test(subject));
  const participants = [];
  const participantNames = {};
  const own = ctx && ctx.ownAddresses ? ctx.ownAddresses : new Set();
  const consider = (a) => {
    if (!a || !a.email || own.has(a.email)) return;
    if (!participants.includes(a.email)) participants.push(a.email);
    if (a.name && !participantNames[a.email]) participantNames[a.email] = a.name;
  };
  consider(from); to.forEach(consider); cc.forEach(consider); bcc.forEach(consider);
  const ownDomains = ctx && ctx.ownDomains ? ctx.ownDomains : new Set();
  const isExternal = participants.some((e) => !ownDomains.has(e.split('@')[1]));
  const refsRaw = String(h['references'] || '');
  const references = refsRaw ? refsRaw.split(/\s+/).map(shared.normalizeMessageId).filter(Boolean).slice(0, 50) : [];
  return {
    mailboxId: ctx ? ctx.mailboxId : null,
    gmailMessageId: String(msg.id),
    gmailThreadId: String(msg.threadId || msg.id),
    messageIdHeader: shared.normalizeMessageId(h['message-id'] || '') || null,
    inReplyTo: shared.normalizeMessageId(h['in-reply-to'] || '') || null,
    references,
    direction,
    from, to, cc, bcc,
    replyTo: replyTo || null,
    subject,
    subjectNorm: subjectNorm(subject),
    date: new Date(internalDate).toISOString(),
    dateHeader: shared.clampText(h['date'] || '', 80),
    internalDate,
    snippet,
    bodyText,
    bodyTextTruncated,
    hasHtml: !!html,
    attachments: acc.attachments.map((a, i) => ({ index: i, filename: a.filename, mime: a.mime, size: a.size, contentId: a.contentId, inline: !!a.inline, gmailAttachmentId: a.gmailAttachmentId })),
    labelIds,
    isBounce,
    participants: participants.slice(0, 100),
    participantNames,
    isExternal,
    _html: html,
    _rawAttachments: acc.attachments,
  };
}

// --------------------------------------------------------------- storage ---

function storageBase(mailboxId, gmailMessageId) {
  return `${shared.STORAGE_ROOT}/${shared.WORKSPACE_ID}/${mailboxId}/${gmailMessageId}`;
}

async function storeHtml(bucket, base, norm) {
  if (!norm._html) return { bodyHtmlPath: null, bodyHtmlBytes: 0 };
  const buf = Buffer.from(norm._html, 'utf8');
  const bodyHtmlPath = `${base}/raw.html`;
  await bucket.file(bodyHtmlPath).save(buf, { contentType: 'text/html; charset=utf-8', resumable: false, metadata: { cacheControl: 'private, max-age=0' } });
  return { bodyHtmlPath, bodyHtmlBytes: buf.length };
}

async function storeAttachments(gmail, bucket, base, norm, stats) {
  const out = [];
  for (const a of norm._rawAttachments) {
    const row = { index: out.length, filename: a.filename, mime: a.mime, size: a.size, contentId: a.contentId, inline: !!a.inline, gmailAttachmentId: a.gmailAttachmentId, storagePath: null, tooLarge: false, error: null };
    try {
      let buf = null;
      if (a.dataInline) buf = b64urlDecode(a.dataInline);
      else if (a.gmailAttachmentId) {
        if (a.size > shared.MAX_ATTACHMENT_BYTES) { row.tooLarge = true; out.push(row); continue; }
        const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId: norm.gmailMessageId, id: a.gmailAttachmentId });
        buf = b64urlDecode(res && res.data && res.data.data);
      }
      if (buf && buf.length) {
        if (buf.length > shared.MAX_ATTACHMENT_BYTES) { row.tooLarge = true; out.push(row); continue; }
        row.size = buf.length;
        row.storagePath = `${base}/att/${row.index}_${a.filename}`;
        await bucket.file(row.storagePath).save(buf, { contentType: a.mime || 'application/octet-stream', resumable: false, metadata: { cacheControl: 'private, max-age=0' } });
        stats.attachments++;
      }
    } catch (e) {
      row.error = String((e && e.message) || e).slice(0, 200);
      stats.attachmentErrors++;
    }
    out.push(row);
  }
  return out;
}

// -------------------------------------------------------------- messages ---

function makeCtx(cfg, mailbox, reason) {
  const ownAddresses = new Set((cfg.mailboxes || []).map((m) => m.address));
  return {
    cfg, mailbox, reason,
    gmail: null, index: null,
    bucket: admin.storage().bucket(),
    normCtx: { mailboxId: mailbox.id, ownAddresses, ownDomains: new Set(cfg.ownDomains || []) },
    touched: new Set(),
    errors: [],
    stats: { stored: 0, skippedExisting: 0, skippedLabel: 0, skippedGone: 0, attachments: 0, attachmentErrors: 0, threads: 0, errors: 0 },
  };
}

async function fetchAndStoreMessage(ctx, gmailMessageId, opts) {
  opts = opts || {};
  const db = shared.db();
  const ref = db.doc(shared.col(`mailMessages/${ctx.mailbox.id}__${gmailMessageId}`));
  if (!opts.force) {
    const existing = await ref.get();
    if (existing.exists) {
      const x = existing.data() || {};
      if (x.gmailThreadId) ctx.touched.add(String(x.gmailThreadId));
      ctx.stats.skippedExisting++;
      return 'exists';
    }
  }
  let msg;
  try {
    const res = await ctx.gmail.users.messages.get({ userId: 'me', id: gmailMessageId, format: 'full' });
    msg = res.data;
  } catch (e) {
    const code = e && (e.code || e.status);
    if (code === 404) { ctx.stats.skippedGone++; return 'gone'; }
    throw e;
  }
  const labels = Array.isArray(msg.labelIds) ? msg.labelIds : [];
  if (labels.some((l) => SKIP_LABELS.includes(l))) { ctx.stats.skippedLabel++; return 'skipped'; }
  const norm = normalizeMessage(msg, ctx.normCtx);
  const base = storageBase(ctx.mailbox.id, norm.gmailMessageId);
  const { bodyHtmlPath, bodyHtmlBytes } = await storeHtml(ctx.bucket, base, norm);
  const attachments = await storeAttachments(ctx.gmail, ctx.bucket, base, norm, ctx.stats);
  const doc = Object.assign({}, norm, {
    attachments,
    hasAttachments: attachments.some((a) => !a.inline),
    bodyHtmlPath, bodyHtmlBytes,
    source: opts.source || 'poll',
    storedAt: shared.serverTs(),
  });
  delete doc._html;
  delete doc._rawAttachments;
  // unitKeys/buildingIds ставит updateThread (денормализация из треда).
  await ref.set(doc, { merge: true });
  ctx.touched.add(norm.gmailThreadId);
  ctx.stats.stored++;
  return 'stored';
}

async function fetchMany(ctx, ids, opts) {
  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + FETCH_CONCURRENCY).map((id) =>
      fetchAndStoreMessage(ctx, id, opts).catch((e) => {
        ctx.stats.errors++;
        ctx.errors.push({ id: String(id), message: String((e && e.message) || e).slice(0, 200) });
      })));
  }
}

// ---------------------------------------------------------------- threads ---

async function updateThread(ctx, gmailThreadId) {
  const db = shared.db();
  const snap = await db.collection(shared.col('mailMessages'))
    .where('mailboxId', '==', ctx.mailbox.id)
    .where('gmailThreadId', '==', gmailThreadId)
    .get();
  const msgs = (snap.docs || []).map((d) => Object.assign({ _id: d.id }, d.data() || {}))
    .sort((a, b) => (+a.internalDate || 0) - (+b.internalDate || 0));
  if (!msgs.length) return null;
  const ref = db.doc(shared.col(`mailThreads/${ctx.mailbox.id}__${gmailThreadId}`));
  const prevSnap = await ref.get();
  const prev = prevSnap.exists ? (prevSnap.data() || {}) : {};
  const first = msgs[0];
  const last = msgs[msgs.length - 1];
  const participants = [];
  const participantNames = {};
  const senders = [];
  const seenSenders = new Set();
  const labels = new Set();
  const attachmentNames = [];
  let hasAttachments = false; let hasInbound = false; let hasOutbound = false; let bounceCount = 0; let isExternal = false; let unreadLike = 0;
  for (const m of msgs) {
    for (const p of (m.participants || [])) if (!participants.includes(p)) participants.push(p);
    for (const [k, v] of Object.entries(m.participantNames || {})) if (v && !participantNames[k]) participantNames[k] = v;
    if (m.from && m.from.email && !seenSenders.has(m.from.email)) {
      seenSenders.add(m.from.email);
      senders.push({ name: m.from.name || '', email: m.from.email, own: ctx.normCtx.ownAddresses.has(m.from.email) });
    }
    for (const l of (m.labelIds || [])) labels.add(l);
    for (const a of (m.attachments || [])) if (!a.inline && attachmentNames.length < 10) attachmentNames.push(a.filename);
    if (m.hasAttachments) hasAttachments = true;
    if (m.direction === 'inbound') hasInbound = true; else hasOutbound = true;
    if (m.isBounce) bounceCount++;
    if (m.isExternal) isExternal = true;
    if ((m.labelIds || []).includes('UNREAD')) unreadLike++;
  }
  const auto = link.computeAutoLinks(participants, ctx.index);
  const merged = link.mergeLinks(prev, auto);
  const doc = {
    mailboxId: ctx.mailbox.id,
    gmailThreadId,
    subject: first.subject || '',
    subjectNorm: first.subjectNorm || subjectNorm(first.subject),
    snippet: last.snippet || '',
    participants: participants.slice(0, 100),
    participantNames: Object.fromEntries(Object.entries(participantNames).slice(0, 100)),
    senders: senders.slice(0, 20),
    firstMessageAt: new Date(+first.internalDate || Date.now()).toISOString(),
    lastMessageAt: new Date(+last.internalDate || Date.now()).toISOString(),
    lastInternalDate: +last.internalDate || 0,
    messageCount: msgs.length,
    hasAttachments,
    attachmentNames,
    hasInbound, hasOutbound,
    lastDirection: last.direction || 'inbound',
    lastFrom: last.from || null,
    isExternal,
    bounceCount,
    gmailUnread: unreadLike,
    labelIds: Array.from(labels).slice(0, 30),
    links: merged.links,
    rejected: merged.rejected,
    unitKeys: merged.unitKeys,
    buildingIds: merged.buildingIds,
    linked: merged.linked,
    updatedAt: shared.serverTs(),
    createdAt: prev.createdAt || shared.serverTs(),
  };
  await ref.set(doc, { merge: true });
  await link.syncKeysToMessages(ctx.mailbox.id, gmailThreadId, merged.unitKeys, merged.buildingIds);
  ctx.stats.threads++;
  return doc;
}

// ------------------------------------------------------------ lock/watch ---

async function acquireLock(mbRef, owner) {
  const db = shared.db();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(mbRef);
    const d = snap.exists ? (snap.data() || {}) : {};
    const lock = d.syncLock;
    const now = Date.now();
    if (lock && lock.at && now - lock.at < LOCK_TTL_MS) return false;
    tx.set(mbRef, { syncLock: { at: now, by: owner } }, { merge: true });
    return true;
  });
}

async function releaseLock(mbRef) {
  await mbRef.set({ syncLock: admin.firestore.FieldValue.delete() }, { merge: true });
}

async function ensureWatch(ctx, mbRef, mbData, opts) {
  const exp = +(mbData && mbData.watchExpiration) || 0;
  if (!(opts && opts.force) && exp && exp - Date.now() > WATCH_RENEW_BEFORE_MS) return { renewed: false, expiration: exp };
  const res = await ctx.gmail.users.watch({
    userId: 'me',
    requestBody: { topicName: shared.pubsubTopicName(), labelIds: ['INBOX', 'SENT'], labelFilterBehavior: 'INCLUDE' },
  });
  const expiration = +(res && res.data && res.data.expiration) || (Date.now() + 7 * 24 * 60 * 60 * 1000);
  const patch = { watchExpiration: expiration, watchRenewedAt: shared.nowIso() };
  if (!(mbData && mbData.lastHistoryId) && res && res.data && res.data.historyId) patch.lastHistoryId = String(res.data.historyId);
  await mbRef.set(patch, { merge: true });
  return { renewed: true, expiration };
}

// ------------------------------------------------------------------ sync ---

// Письма, не забранные прошлыми тиками: повторяем ≤ MAX_RETRY_ATTEMPTS, потом dead-letter.
async function retryPending(ctx, mbData) {
  const pending = Array.isArray(mbData && mbData.pendingRetry) ? mbData.pendingRetry : [];
  if (!pending.length) return [];
  const before = ctx.errors.length;
  await fetchMany(ctx, pending.map((p) => p.id), { source: 'retry' });
  const failedNow = new Set(ctx.errors.slice(before).map((e) => e.id));
  ctx.errors.length = before; // ошибки ретраев учитываем отдельно ниже
  const keep = [];
  for (const p of pending) {
    if (!failedNow.has(p.id)) continue;
    const attempts = (+p.attempts || 1) + 1;
    if (attempts >= MAX_RETRY_ATTEMPTS) {
      await shared.deadLetter(`message_${ctx.mailbox.id}_${p.id}`, { kind: 'message-fetch-exhausted', mailboxId: ctx.mailbox.id, gmailMessageId: p.id, attempts });
    } else {
      keep.push({ id: p.id, attempts, lastError: (p.lastError || '').slice(0, 200) });
    }
  }
  return keep;
}

async function resyncRecent(ctx, mbRef) {
  let pageToken;
  let processed = 0;
  do {
    const res = await ctx.gmail.users.messages.list({ userId: 'me', q: 'newer_than:7d', maxResults: 100, pageToken, includeSpamTrash: false });
    const ids = ((res && res.data && res.data.messages) || []).map((m) => m.id);
    await fetchMany(ctx, ids, { source: 'poll' });
    processed += ids.length;
    pageToken = res && res.data && res.data.nextPageToken;
  } while (pageToken && processed < MAX_RESYNC_MESSAGES);
  const prof = await ctx.gmail.users.getProfile({ userId: 'me' });
  await mbRef.set({ lastHistoryId: String(prof.data.historyId), resyncedAt: shared.nowIso() }, { merge: true });
  return { processed, resynced: true };
}

async function syncDelta(ctx, mbRef, mbData) {
  const keepRetry = await retryPending(ctx, mbData);
  let cursor = mbData && mbData.lastHistoryId ? String(mbData.lastHistoryId) : null;
  if (!cursor) {
    const prof = await ctx.gmail.users.getProfile({ userId: 'me' });
    cursor = String(prof.data.historyId);
    await mbRef.set({ lastHistoryId: cursor, cursorBootstrappedAt: shared.nowIso(), pendingRetry: keepRetry }, { merge: true });
    return { processed: 0, bootstrapped: true };
  }
  let pageToken;
  let processed = 0;
  let more = false;
  const seen = new Set();
  do {
    let res;
    try {
      res = await ctx.gmail.users.history.list({ userId: 'me', startHistoryId: cursor, historyTypes: ['messageAdded'], maxResults: 100, pageToken });
    } catch (e) {
      const code = e && (e.code || e.status);
      if (code === 404 || code === 400) {
        logger.warn('[mail-sync] historyId expired → resync', { mailbox: ctx.mailbox.id, cursor });
        const r = await resyncRecent(ctx, mbRef);
        await mbRef.set({ pendingRetry: keepRetry }, { merge: true });
        return Object.assign({ processed: r.processed, historyExpired: true }, r);
      }
      throw e;
    }
    const records = (res && res.data && res.data.history) || [];
    for (const rec of records) {
      const ids = [];
      for (const m of (rec.messagesAdded || [])) {
        const id = m && m.message && m.message.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const labels = (m.message.labelIds) || [];
        if (labels.some((l) => SKIP_LABELS.includes(l))) continue;
        ids.push(String(id));
      }
      await fetchMany(ctx, ids, { source: 'push' });
      processed += ids.length;
      if (rec.id) cursor = String(rec.id);
      if (processed >= MAX_MESSAGES_PER_RUN) { more = true; break; }
    }
    if (more) break;
    pageToken = res && res.data && res.data.nextPageToken;
    if (!pageToken && res && res.data && res.data.historyId) cursor = String(res.data.historyId);
  } while (pageToken);
  // Непрочитанные ошибки этого тика → pendingRetry (следующий тик повторит).
  const newFailures = ctx.errors.map((e) => ({ id: e.id, attempts: 1, lastError: e.message }));
  const pendingRetry = keepRetry.concat(newFailures).slice(0, MAX_PENDING_RETRY);
  await mbRef.set({ lastHistoryId: cursor, pendingRetry }, { merge: true });
  return { processed, more };
}

async function backfillMailbox(ctx, mbRef, mbData, pageSize) {
  const bf = Object.assign({ pageToken: null, done: false, imported: 0 }, (mbData && mbData.backfill) || {});
  if (bf.done) return { done: true, imported: bf.imported, pageIds: 0 };
  const since = String(ctx.cfg.backfillSince).replace(/-/g, '/');
  const res = await ctx.gmail.users.messages.list({ userId: 'me', q: `after:${since}`, maxResults: pageSize, pageToken: bf.pageToken || undefined, includeSpamTrash: false });
  const ids = ((res && res.data && res.data.messages) || []).map((m) => String(m.id));
  await fetchMany(ctx, ids, { source: 'backfill' });
  const next = (res && res.data && res.data.nextPageToken) || null;
  const patch = { backfill: { pageToken: next, done: !next, imported: (+bf.imported || 0) + ctx.stats.stored, lastRunAt: shared.nowIso(), since: ctx.cfg.backfillSince } };
  if (!next && !(mbData && mbData.lastHistoryId)) {
    const prof = await ctx.gmail.users.getProfile({ userId: 'me' });
    patch.lastHistoryId = String(prof.data.historyId);
  }
  if (ctx.errors.length) {
    const prevPending = Array.isArray(mbData && mbData.pendingRetry) ? mbData.pendingRetry : [];
    patch.pendingRetry = prevPending.concat(ctx.errors.map((e) => ({ id: e.id, attempts: 1, lastError: e.message }))).slice(0, MAX_PENDING_RETRY);
  }
  await mbRef.set(patch, { merge: true });
  return { done: !next, imported: patch.backfill.imported, pageIds: ids.length, nextPageToken: next };
}

/**
 * Обёртка одного job'а на ящик: lock → клиент/индекс → job → агрегаты тредов →
 * счётчики. Любая ошибка → lastError + dead-letter (без rethrow: Pub/Sub не
 * должен уйти в retry-loop; следующий тик повторит).
 */
async function runMailboxJob(cfg, mailbox, reason, job) {
  const db = shared.db();
  const mbRef = db.doc(shared.col(`mailboxes/${mailbox.id}`));
  const owner = `${reason}:${Date.now()}`;
  if (!(await acquireLock(mbRef, owner))) {
    logger.info('[mail-sync] mailbox locked — skip', { mailbox: mailbox.id, reason });
    return { mailboxId: mailbox.id, locked: true };
  }
  const ctx = makeCtx(cfg, mailbox, reason);
  let result = null;
  try {
    const mbSnap = await mbRef.get();
    const mbData = mbSnap.exists ? (mbSnap.data() || {}) : {};
    if (!mbSnap.exists) await mbRef.set({ address: mailbox.address, createdAt: shared.serverTs() }, { merge: true });
    ctx.index = await link.loadUnitsIndex();
    ctx.gmail = shared.gmailClientFor(mailbox.address, [shared.SCOPE_READONLY]);
    result = await job(ctx, mbRef, mbData);
    for (const tid of ctx.touched) await updateThread(ctx, tid);
    const inc = admin.firestore.FieldValue.increment;
    await mbRef.set({
      address: mailbox.address,
      lastSyncAt: shared.nowIso(),
      lastSyncReason: reason,
      lastError: null,
      syncVersion: inc(1),
      stats: { messages: inc(ctx.stats.stored), threads: inc(ctx.stats.threads), attachments: inc(ctx.stats.attachments), errors: inc(ctx.stats.errors) },
    }, { merge: true });
    if (ctx.errors.length) {
      await shared.deadLetter(`sync_${mailbox.id}_${Date.now()}`, { kind: 'message-fetch', mailboxId: mailbox.id, reason, errors: ctx.errors.slice(0, 50) });
    }
    logger.info('[mail-sync] done', { mailbox: mailbox.id, reason, stats: ctx.stats, result });
  } catch (e) {
    const message = String((e && e.message) || e).slice(0, 300);
    const code = (e && (e.code || e.status)) || null;
    logger.error('[mail-sync] failed', { mailbox: mailbox.id, reason, code, error: message });
    await mbRef.set({ lastError: { at: shared.nowIso(), reason, code, message } }, { merge: true }).catch(() => {});
    await shared.deadLetter(`sync_${mailbox.id}_${Date.now()}`, { kind: 'sync-failed', mailboxId: mailbox.id, reason, code, error: message, stats: ctx.stats });
    result = { error: message, code };
  } finally {
    await releaseLock(mbRef).catch(() => {});
  }
  return Object.assign({ mailboxId: mailbox.id, stats: ctx.stats }, result || {});
}

// -------------------------------------------------------------- triggers ---

exports.mailOnPush = onMessagePublished(
  { topic: shared.PUBSUB_TOPIC, secrets: [shared.MAIL_SA_KEY], timeoutSeconds: 120, memory: '512MiB' },
  async (event) => {
    let payload;
    try {
      const raw = event && event.data && event.data.message && event.data.message.data
        ? Buffer.from(event.data.message.data, 'base64').toString('utf8') : '{}';
      payload = JSON.parse(raw || '{}');
    } catch (e) {
      logger.warn('[mail-sync] bad pub/sub payload', { error: e && e.message });
      return;
    }
    const address = shared.normalizeEmail(payload && payload.emailAddress);
    const cfg = await shared.getMailConfig();
    const mailbox = address ? shared.mailboxByAddress(cfg, address) : null;
    if (!cfg.enabled || !mailbox || !mailbox.enabled) {
      logger.info('[mail-sync] push ignored (not a configured mailbox or disabled)', { address: shared.maskEmail(address) });
      return;
    }
    await runMailboxJob(cfg, mailbox, 'push', (ctx, mbRef, mbData) => syncDelta(ctx, mbRef, mbData));
  }
);

exports.mailSyncScheduled = onSchedule(
  { schedule: 'every 10 minutes', timeZone: 'UTC', secrets: [shared.MAIL_SA_KEY], timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const cfg = await shared.getMailConfig({ fresh: true });
    if (!cfg.enabled) return;
    for (const mailbox of cfg.mailboxes.filter((m) => m.enabled)) {
      await runMailboxJob(cfg, mailbox, 'schedule', async (ctx, mbRef, mbData) => {
        const r = await syncDelta(ctx, mbRef, mbData);
        try {
          r.watch = await ensureWatch(ctx, mbRef, mbData);
        } catch (e) {
          const message = String((e && e.message) || e).slice(0, 300);
          logger.error('[mail-sync] watch renew failed', { mailbox: mailbox.id, error: message });
          await mbRef.set({ watchError: { at: shared.nowIso(), message } }, { merge: true });
          await shared.deadLetter(`watch_${mailbox.id}_${Date.now()}`, { kind: 'watch-failed', mailboxId: mailbox.id, error: message });
          r.watch = { renewed: false, error: message };
        }
        return r;
      });
    }
  }
);

// Первичный импорт (root admin). Повторный вызов продолжает с backfill.pageToken.
exports.mailBackfill = onCall(
  { secrets: [shared.MAIL_SA_KEY], timeoutSeconds: 540, memory: '1GiB' },
  async (req) => {
    await shared.requireRootAdmin(req.auth);
    const cfg = await shared.getMailConfig({ fresh: true });
    const d = req.data || {};
    const pageSize = Math.min(Math.max(+d.pageSize || BACKFILL_PAGE, 10), 200);
    const targets = d.mailboxId ? [shared.mailboxById(cfg, d.mailboxId)].filter(Boolean) : cfg.mailboxes.filter((m) => m.enabled);
    if (!targets.length) throw new HttpsError('failed-precondition', 'No mailbox configured in integrations/mail');
    const results = [];
    for (const mb of targets) {
      results.push(await runMailboxJob(cfg, mb, 'backfill', (ctx, mbRef, mbData) => backfillMailbox(ctx, mbRef, mbData, pageSize)));
    }
    return { ok: true, results };
  }
);

// Состояние ящиков + dead-letters для Settings → Mail (admin); stopWatch/renewWatch — root admin.
exports.mailAdminStatus = onCall(
  { secrets: [shared.MAIL_SA_KEY], timeoutSeconds: 120 },
  async (req) => {
    const a = access.assertAdmin(await access.accessFor(req.auth));
    const d = req.data || {};
    const cfg = await shared.getMailConfig({ fresh: true });
    const db = shared.db();
    const actions = [];
    if (d.stopWatch || d.renewWatch) {
      await shared.requireRootAdmin(req.auth);
      for (const mb of cfg.mailboxes) {
        const mbRef = db.doc(shared.col(`mailboxes/${mb.id}`));
        try {
          const gmail = shared.gmailClientFor(mb.address, [shared.SCOPE_READONLY]);
          if (d.stopWatch) {
            await gmail.users.stop({ userId: 'me' });
            await mbRef.set({ watchExpiration: null, watchStoppedAt: shared.nowIso() }, { merge: true });
            actions.push({ mailboxId: mb.id, stopWatch: true });
          } else {
            const ctx = makeCtx(cfg, mb, 'admin');
            ctx.gmail = gmail;
            const snap = await mbRef.get();
            const r = await ensureWatch(ctx, mbRef, snap.exists ? snap.data() : {}, { force: true });
            actions.push({ mailboxId: mb.id, renewWatch: r });
          }
        } catch (e) {
          actions.push({ mailboxId: mb.id, error: String((e && e.message) || e).slice(0, 200) });
        }
      }
      await shared.writeAudit({ actor: a.email, actorUid: a.uid, action: d.stopWatch ? 'mail.watch.stop' : 'mail.watch.renew', note: JSON.stringify(actions).slice(0, 400) });
    }
    const mailboxes = [];
    for (const mb of cfg.mailboxes) {
      const snap = await db.doc(shared.col(`mailboxes/${mb.id}`)).get();
      const s = snap.exists ? (snap.data() || {}) : null;
      mailboxes.push({
        id: mb.id, address: mb.address, displayName: mb.displayName, enabled: mb.enabled,
        state: s ? {
          lastSyncAt: s.lastSyncAt || null, lastSyncReason: s.lastSyncReason || null, lastError: s.lastError || null, watchError: s.watchError || null,
          watchExpiration: s.watchExpiration || null, lastHistoryId: s.lastHistoryId || null, syncVersion: s.syncVersion || 0,
          backfill: s.backfill || null, pendingRetry: Array.isArray(s.pendingRetry) ? s.pendingRetry.length : 0, stats: s.stats || null,
          locked: !!(s.syncLock && s.syncLock.at && Date.now() - s.syncLock.at < LOCK_TTL_MS),
        } : null,
      });
    }
    const dlSnap = await db.collection(shared.col('mailDeadLetter')).orderBy('at', 'desc').limit(20).get();
    const deadLetters = (dlSnap.docs || []).map((x) => {
      const v = x.data() || {};
      return { id: x.id, kind: v.kind || null, mailboxId: v.mailboxId || null, error: v.error || null, reason: v.reason || null, at: v.at && v.at.toMillis ? v.at.toMillis() : null };
    });
    return { ok: true, enabled: cfg.enabled, sendEnabled: cfg.sendEnabled, timeZone: cfg.timeZone, backfillSince: cfg.backfillSince, limits: cfg.limits, mailboxes, deadLetters, actions };
  }
);

module.exports._internals = {
  normalizeMessage, subjectNorm, headersOf, walkParts, b64urlDecode,
  makeCtx, fetchAndStoreMessage, fetchMany, updateThread, ensureWatch, acquireLock, releaseLock,
  retryPending, resyncRecent, syncDelta, backfillMailbox, runMailboxJob,
  MAX_MESSAGES_PER_RUN, LOCK_TTL_MS, WATCH_RENEW_BEFORE_MS, SKIP_LABELS,
};
