/**
 * Gmail ingest — auto-tracking outgoing employee email activity.
 *
 * Архитектура (FIXES_LOG Entry 27 — Phase 8):
 *   Сотрудник отправил письмо из Gmail
 *      ↓
 *   gmail.users.watch() уведомляет Pub/Sub topic `gmail-push`
 *      ↓
 *   onGmailPush (Pub/Sub trigger) — берёт historyId из payload, опрашивает
 *      gmail.users.history.list, фильтрует только messagesAdded в SENT-папке,
 *      достаёт метаданные (subject/from/to/date) через gmail.users.messages.get
 *      с format=metadata + metadataHeaders=[subject,from,to,date,message-id]
 *      ↓
 *   Матчит from → state.employees[].email
 *      Матчит to → state.buildings...units[].tenantEmail (опционально)
 *      ↓
 *   Идёт транзакция на /workspaces/{wid}/data/state:
 *     • если recipient мatched → push в u.outreach[] (type='email', autoLogged=true)
 *     • если recipient unmatched → push в state.gmailActivity[] (FIFO trim до 5000)
 *      ↓
 *   Pulse data-shim читает u.outreach[] + state.gmailActivity[] (Phase 7+8)
 *      → emailsMtd ++ автоматически
 *
 * Идемпотентность: messageId Gmail уникален навсегда. Дублей не пушим
 * (проверяем по messageId в обоих местах перед push).
 *
 * Watch lifecycle: gmail.users.watch() истекает через ~7 дней. Поэтому
 * bootstrapGmailWatch висит на onSchedule(every 24h) и перерегистрирует
 * watch для каждого активного сотрудника. Первый запуск — вручную через
 * adminBootstrapGmailWatch (callable, root-admin only) после того как
 * Tony настроит domain-wide delegation в Workspace Admin Console.
 *
 * Privacy: scope = gmail.metadata (НЕ readonly). Видим только заголовки,
 * НЕ тело письма. Доступ через service-account с domain-wide delegation,
 * каждый employee impersonate-ится отдельно (subject=their_email).
 *
 * Secrets (firebase functions:secrets:set):
 *   GMAIL_SA_KEY — JSON service-account key (целиком; импорт через JSON.parse)
 *
 * Env vars:
 *   GMAIL_PUBSUB_TOPIC — имя Pub/Sub topic (по умолчанию "gmail-push")
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onMessagePublished} = require('firebase-functions/v2/pubsub');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const {google} = require('googleapis');

const GMAIL_SA_KEY = defineSecret('GMAIL_SA_KEY');
const PUBSUB_TOPIC = process.env.GMAIL_PUBSUB_TOPIC || 'gmail-push';

// Workspace model: пока один workspace, хардкод как и везде в index.js.
const WORKSPACE_ID = 'default';

// Лимит размера буфера unattached emails. Старые отрезаются (FIFO).
const GMAIL_ACTIVITY_CAP = 5000;

// Root admin allowlist (синхронно с index.js — single source of truth там,
// дублируем минимально, чтобы избежать циркулярного импорта).
const ROOT_ADMINS = ['tony@al-en.com'];

// Кэш для service-account credentials. Парсится один раз на холодный
// старт. Если ключ ротировали — пересоздаётся при следующем cold-start.
let _saCache = null;
function _getServiceAccount() {
  if (_saCache) return _saCache;
  const raw = GMAIL_SA_KEY.value();
  if (!raw) {
    throw new Error('GMAIL_SA_KEY secret is not configured. Run: ' +
      'firebase functions:secrets:set GMAIL_SA_KEY (paste service-account JSON).');
  }
  try {
    _saCache = JSON.parse(raw);
  } catch (e) {
    throw new Error('GMAIL_SA_KEY is not valid JSON: ' + e.message);
  }
  return _saCache;
}

/**
 * Создаёт Gmail client, имперсонирующий конкретного пользователя через
 * domain-wide delegation. Каждый вызов = свой client, потому что subject
 * (email сотрудника) встраивается в JWT. Кэширование per-user TTL не
 * добавляю — токены auto-refresh через google-auth-library, а cold-start
 * экономия не критична (Pub/Sub trigger редкий).
 */
function _gmailClientFor(userEmail) {
  const sa = _getServiceAccount();
  const jwt = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.metadata'],
    subject: userEmail,
  });
  return google.gmail({ version: 'v1', auth: jwt });
}

const db = admin.firestore();

// =========================================================================
// onGmailPush — Pub/Sub trigger.
//
// Payload (от gmail.users.watch): { emailAddress, historyId }.
// Из historyId надо взять "новые" события — для этого читаем
// state.gmailWatch[email].lastHistoryId, запрашиваем gmail.users.history.list
// startHistoryId=lastHistoryId, получаем messagesAdded, фильтруем по
// labels=SENT, для каждого — messages.get(format=metadata).
//
// Потом транзакционно пишем в /workspaces/default/data/state.
// =========================================================================
exports.onGmailPush = onMessagePublished(
  {
    topic: PUBSUB_TOPIC,
    secrets: [GMAIL_SA_KEY],
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (event) => {
    let payload;
    try {
      // Pub/Sub payload — base64-encoded JSON.
      const raw = event.data.message.data
        ? Buffer.from(event.data.message.data, 'base64').toString('utf8')
        : '{}';
      payload = JSON.parse(raw);
    } catch (e) {
      logger.error('[gmail-push] failed to decode pub/sub payload', e);
      return;
    }

    const userEmail = (payload.emailAddress || '').toLowerCase();
    const historyId = String(payload.historyId || '');
    if (!userEmail || !historyId) {
      logger.warn('[gmail-push] missing emailAddress or historyId', payload);
      return;
    }

    // Резолвим last-known historyId для этого пользователя.
    // Если первый раз — берём historyId из payload и записываем, новых
    // сообщений в этом тике не считаем (нет startHistoryId — не с чего
    // считать дельту).
    const watchRef = db.doc(`workspaces/${WORKSPACE_ID}/gmailWatch/${encodeURIComponent(userEmail)}`);
    const watchSnap = await watchRef.get();
    // Fallback на `historyId` для записей, созданных bootstrap'ом до того,
    // как мы переименовали поле в `lastHistoryId`. Без fallback'а первый push
    // после bootstrap-а трактовался бы как baseline и письмо терялось.
    const watchData = watchSnap.exists ? (watchSnap.data() || {}) : {};
    const lastHistoryId = watchData.lastHistoryId || watchData.historyId || null;

    if (!lastHistoryId) {
      await watchRef.set({
        email: userEmail,
        lastHistoryId: historyId,
        firstSeen: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      logger.info('[gmail-push] first push for user, recorded baseline', { userEmail, historyId });
      return;
    }

    let gmail;
    try {
      gmail = _gmailClientFor(userEmail);
    } catch (e) {
      logger.error('[gmail-push] service-account init failed', { userEmail, error: e.message });
      return;
    }

    // Тянем delta-историю.
    let messages = [];
    try {
      // Phase 10: watch SENT + INBOX. У history.list нельзя за один вызов
      // вытянуть оба label'а — labelId это фильтр. Делаем два параллельных
      // запроса и объединяем дельту.
      const [sentHist, inboxHist] = await Promise.all([
        gmail.users.history.list({
          userId: 'me',
          startHistoryId: String(lastHistoryId),
          historyTypes: ['messageAdded'],
          labelId: 'SENT',
          maxResults: 100,
        }),
        gmail.users.history.list({
          userId: 'me',
          startHistoryId: String(lastHistoryId),
          historyTypes: ['messageAdded'],
          labelId: 'INBOX',
          maxResults: 100,
        }),
      ]);
      const seen = new Map(); // id → label-hint ('SENT' | 'INBOX')
      for (const h of (sentHist.data.history || [])) {
        for (const m of (h.messagesAdded || [])) {
          if (m.message && m.message.id && !seen.has(m.message.id)) {
            seen.set(m.message.id, 'SENT');
          }
        }
      }
      for (const h of (inboxHist.data.history || [])) {
        for (const m of (h.messagesAdded || [])) {
          if (m.message && m.message.id && !seen.has(m.message.id)) {
            seen.set(m.message.id, 'INBOX');
          }
        }
      }
      messages = Array.from(seen.entries()).map(([id, labelHint]) => ({ id, labelHint }));
    } catch (e) {
      // Если startHistoryId протух (Gmail держит ~7 дней), сбрасываем
      // baseline и ждём следующего тика. Не throw — иначе Pub/Sub retry-loop.
      const status = e && e.code;
      if (status === 404 || status === 400) {
        logger.warn('[gmail-push] historyId expired, resetting baseline', { userEmail, lastHistoryId });
        await watchRef.set({ lastHistoryId: historyId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return;
      }
      logger.error('[gmail-push] history.list failed', { userEmail, error: e.message });
      return;
    }

    if (!messages.length) {
      // Дельта пустая (например, событие про получение, а не отправку).
      // Обновляем cursor и выходим.
      await watchRef.set({ lastHistoryId: historyId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return;
    }

    // Для каждого сообщения достаём только заголовки.
    // In-Reply-To + References парсим чтобы потом склеить replies в цепочки.
    const records = [];
    for (const m of messages) {
      try {
        const mres = await gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date', 'Message-Id', 'In-Reply-To', 'References'],
        });
        const rec = _extractMetadata(mres.data, userEmail, m.labelHint);
        if (rec) records.push(rec);
      } catch (e) {
        logger.warn('[gmail-push] messages.get failed', { userEmail, mid: m.id, error: e.message });
      }
    }

    if (records.length) {
      await _persistEmailRecords(userEmail, records);
    }

    // Двигаем cursor.
    await watchRef.set({
      lastHistoryId: historyId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    logger.info('[gmail-push] processed', { userEmail, count: records.length });
  }
);

/**
 * Извлекает useful fields из Gmail message envelope.
 * Phase 10: дополнительно определяет direction ('sent' / 'received') по
 * labelIds или labelHint, парсит In-Reply-To header для thread-tracking.
 *
 * @param {Object} msg - Gmail message resource
 * @param {string} expectedFrom - email владельца watch'а (для атрибуции)
 * @param {string|null} labelHint - 'SENT' или 'INBOX' из history.list (fallback
 *                                  если labelIds в message пустой)
 */
function _extractMetadata(msg, expectedFrom, labelHint) {
  if (!msg || !msg.payload || !msg.payload.headers) return null;
  const headers = {};
  for (const h of msg.payload.headers) {
    if (h && h.name) headers[h.name.toLowerCase()] = h.value;
  }

  // Direction: ПРИОРИТЕТ — actual labelIds из messages.get (надёжно).
  // labelHint из history.list используется ТОЛЬКО как fallback, если
  // labelIds пуст. Иначе мог быть баг: history.list(labelId='SENT')
  // мог вернуть thread-related INBOX-сообщение → labelHint='SENT' побеждал
  // фактический labelIds=[INBOX]. Fix: labelIds wins.
  const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds : [];
  let direction = null;
  if (labelIds.length > 0) {
    const inSent  = labelIds.includes('SENT');
    const inInbox = labelIds.includes('INBOX');
    if (inSent && inInbox) direction = 'sent';      // sent-to-self → credit sent
    else if (inSent)       direction = 'sent';
    else if (inInbox)      direction = 'received';
    else return null;                               // drafts/trash/spam — skip
  } else if (labelHint === 'SENT')  direction = 'sent';
    else if (labelHint === 'INBOX') direction = 'received';
    else return null;

  const fromRaw = headers['from'] || '';
  const fromEmail = _parseEmailAddress(fromRaw);
  if (!fromEmail) return null;
  const toRaw = headers['to'] || '';
  const toList = _parseEmailList(toRaw);
  const ccList = _parseEmailList(headers['cc'] || '');
  const subject = headers['subject'] || '';
  const dateStr = headers['date'] || '';
  let tsIso;
  const parsed = Date.parse(dateStr);
  if (!isNaN(parsed)) tsIso = new Date(parsed).toISOString();
  else if (msg.internalDate) tsIso = new Date(+msg.internalDate).toISOString();
  else tsIso = new Date().toISOString();
  const messageIdHeader = headers['message-id'] || null;

  // In-Reply-To: RFC822 Message-ID родительского письма. Если есть — это reply.
  // References: список всех Message-ID'ев в треде (для надёжного матчинга
  // когда In-Reply-To отсутствует, например forward).
  const inReplyToRaw = headers['in-reply-to'] || '';
  const inReplyTo = inReplyToRaw ? _normalizeMessageId(inReplyToRaw) : null;
  const referencesRaw = headers['references'] || '';
  const references = referencesRaw
    ? referencesRaw.split(/\s+/).map(_normalizeMessageId).filter(Boolean)
    : [];

  // Diagnostic log: при следующих smoke-тестах позволит точно увидеть какие
  // labelIds Gmail вернул и каким стало direction. Удалить после стабилизации.
  logger.info('[gmail-push] decision', {
    msgId: msg.id,
    owner: expectedFrom,
    labelIds: labelIds.slice(0, 12),
    labelHint: labelHint || null,
    direction,
    fromHeader: fromEmail,
    to: toList[0] || null,
    inReplyTo: inReplyTo || null,
    subject: subject.slice(0, 40),
  });

  return {
    messageId: msg.id,                 // Gmail-side ID, уникален per-mailbox
    messageIdHeader: messageIdHeader ? _normalizeMessageId(messageIdHeader) : null,
    threadId: msg.threadId || null,
    ts: tsIso,
    direction,                         // 'sent' | 'received'
    owner: expectedFrom,               // ящик чьим watch'ем это попало
    from: direction === 'sent' ? expectedFrom : fromEmail,
    fromHeader: fromEmail,
    to: toList[0] || null,
    allRecipients: toList.concat(ccList),
    subject: subject.slice(0, 500),
    inReplyTo,                         // null или Message-ID родителя
    references,                        // массив Message-ID'ев (может пустой)
    snippet: (msg.snippet || '').slice(0, 280),
  };
}

function _normalizeMessageId(s) {
  if (!s) return '';
  // RFC822 Message-ID обычно <abc@host.com>. Нормализуем — убираем уголки.
  return String(s).trim().replace(/^<|>$/g, '').toLowerCase();
}

function _parseEmailAddress(s) {
  if (!s) return '';
  const m = /<([^>]+)>/.exec(s);
  const addr = m ? m[1] : s;
  return String(addr).trim().toLowerCase();
}

function _parseEmailList(s) {
  if (!s) return [];
  // Простой split по запятым. Не RFC-точный, но для basic to/cc adequate.
  return s.split(',').map(_parseEmailAddress).filter(Boolean);
}

/**
 * Транзакционно пишет записи в state. Стратегия:
 *   - если матчим recipient с tenant в state → push в u.outreach[] на этом unit
 *   - если не матчим → push в state.gmailActivity[] (FIFO trim)
 * Идемпотентность через messageId.
 */
async function _persistEmailRecords(userEmail, records) {
  const stateRef = db.doc(`workspaces/${WORKSPACE_ID}/data/state`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    if (!snap.exists) {
      logger.warn('[gmail-push] state doc missing, skip persist', { userEmail });
      return;
    }
    const state = snap.data() || {};
    state.gmailActivity = Array.isArray(state.gmailActivity) ? state.gmailActivity : [];

    // Build tenant → unit index один раз.
    const tenantIndex = _buildRecipientIndex(state);

    let unmatchedAdded = 0;
    let matchedAdded = 0;

    for (const r of records) {
      // Идемпотентность через messageId — Gmail-side ID уникален per-mailbox.
      if (state.gmailActivity.some(g => g && g.messageId === r.messageId)) continue;

      // Для INBOX-писем (direction='received') матчим SENDER против tenant —
      // если tenant нам ответил на цепочку, событие принадлежит unit'у tenant'а.
      // Для SENT — матчим RECIPIENT.
      const matchKey = r.direction === 'received'
        ? [r.fromHeader]
        : r.allRecipients;
      const targetUnit = _findUnitForRecipients(tenantIndex, matchKey);

      if (targetUnit) {
        targetUnit.outreach = Array.isArray(targetUnit.outreach) ? targetUnit.outreach : [];
        if (targetUnit.outreach.some(o => o && o.messageId === r.messageId)) continue;
        targetUnit.outreach.push({
          // Phase 10: direction-aware type для соответствия prototype EmailsTab.
          type: r.direction === 'received' ? 'received' : (r.inReplyTo ? 'reply' : 'email'),
          ts: r.ts,
          text: (r.direction === 'received' ? 'Email received: ' : 'Email sent: ') + (r.subject || '(no subject)'),
          subject: r.subject,
          sentBy: r.from,
          recipientEmail: r.to,
          ownerEmail: r.owner,
          direction: r.direction,
          messageId: r.messageId,
          messageIdHeader: r.messageIdHeader,
          inReplyTo: r.inReplyTo,
          threadId: r.threadId,
          autoLogged: true,
          source: 'gmail-api',
        });
        matchedAdded++;
      } else {
        state.gmailActivity.push({
          messageId: r.messageId,
          messageIdHeader: r.messageIdHeader,
          ts: r.ts,
          direction: r.direction,
          owner: r.owner,
          from: r.from,
          to: r.to,
          subject: r.subject,
          inReplyTo: r.inReplyTo,
          threadId: r.threadId,
          source: 'gmail-api',
        });
        unmatchedAdded++;
      }
    }

    // FIFO trim чтобы не раздуть state.
    if (state.gmailActivity.length > GMAIL_ACTIVITY_CAP) {
      state.gmailActivity = state.gmailActivity.slice(-GMAIL_ACTIVITY_CAP);
    }

    tx.set(stateRef, state);
    logger.info('[gmail-push] persist', { userEmail, matchedAdded, unmatchedAdded });
  });
}

function _buildRecipientIndex(state) {
  const idx = new Map(); // email-lower → { building, floor, unit }
  for (const b of (state.buildings || [])) {
    for (const f of (b.floors || [])) {
      for (const u of (f.units || [])) {
        const emails = [];
        if (u.tenantEmail) emails.push(u.tenantEmail);
        if (u.contactEmail) emails.push(u.contactEmail);
        if (Array.isArray(u.contacts)) {
          for (const c of u.contacts) if (c && c.email) emails.push(c.email);
        }
        for (const e of emails) {
          const lower = String(e).trim().toLowerCase();
          if (lower && !idx.has(lower)) idx.set(lower, u);
        }
      }
    }
  }
  return idx;
}

function _findUnitForRecipients(idx, recipients) {
  for (const r of (recipients || [])) {
    if (idx.has(r)) return idx.get(r);
  }
  return null;
}

// =========================================================================
// bootstrapGmailWatch — scheduled (daily).
//
// Для каждого активного сотрудника workspace'а:
//   1. service-account impersonate его email
//   2. gmail.users.watch({ topicName, labelIds:['SENT'] })
//   3. сохраняет watchExpiration в gmailWatch/{email}
//
// Watch у Gmail живёт ~7 дней. Запускаем раз в сутки, чтобы был запас.
// =========================================================================
exports.bootstrapGmailWatch = onSchedule(
  {
    schedule: '0 4 * * *',  // 04:00 UTC ежедневно
    timeZone: 'UTC',
    secrets: [GMAIL_SA_KEY],
    timeoutSeconds: 540,
    memory: '256MiB',
  },
  async () => {
    return await _bootstrapWatchForAllMembers();
  }
);

async function _bootstrapWatchForAllMembers() {
  const sa = _getServiceAccount();
  const projectId = sa.project_id;
  if (!projectId) {
    logger.error('[gmail-bootstrap] service-account JSON missing project_id');
    return { ok: false, error: 'project_id missing' };
  }
  const topicName = `projects/${projectId}/topics/${PUBSUB_TOPIC}`;

  const membersSnap = await db.collection(`workspaces/${WORKSPACE_ID}/members`).get();
  let registered = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const m of membersSnap.docs) {
    const data = m.data() || {};
    const email = (data.email || '').toLowerCase().trim();
    if (!email) { skipped++; continue; }
    if (data.archived) { skipped++; continue; }
    // Watch регистрируем только для тех, кто реально шлёт письма
    // (admin/manager). Viewers пропускаем.
    if (data.role !== 'admin' && data.role !== 'manager') { skipped++; continue; }

    try {
      const gmail = _gmailClientFor(email);
      const res = await gmail.users.watch({
        userId: 'me',
        requestBody: {
          topicName,
          // Phase 10: оба label'а — SENT для исходящих, INBOX для входящих
          // (без этого нет данных для RECEIVED/REPLIES/AVG REPLY/SLA).
          labelIds: ['SENT', 'INBOX'],
          labelFilterBehavior: 'INCLUDE',
        },
      });
      const watchRef = db.doc(`workspaces/${WORKSPACE_ID}/gmailWatch/${encodeURIComponent(email)}`);
      const watchHistoryId = res.data.historyId ? String(res.data.historyId) : null;
      await watchRef.set({
        email,
        // Сохраняем оба имени поля. `lastHistoryId` — каноническое имя,
        // которое использует onGmailPush для cursor advance. `historyId`
        // оставлен для обратной совместимости со старыми watch-документами.
        lastHistoryId: watchHistoryId,
        historyId: watchHistoryId,
        expiration: res.data.expiration ? Number(res.data.expiration) : null,
        lastWatchAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      registered++;
    } catch (e) {
      failed++;
      errors.push({ email, error: e.message });
      logger.warn('[gmail-bootstrap] watch failed for user', { email, error: e.message });
    }
  }

  logger.info('[gmail-bootstrap] done', { registered, skipped, failed });
  return { ok: true, registered, skipped, failed, errors };
}

// =========================================================================
// adminBootstrapGmailWatch — manual trigger (root admin only).
// Используется при первой настройке после того как Tony настроит
// domain-wide delegation в Workspace Admin Console.
// =========================================================================
exports.adminBootstrapGmailWatch = onCall(
  { secrets: [GMAIL_SA_KEY], timeoutSeconds: 540 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    return await _bootstrapWatchForAllMembers();
  }
);

// =========================================================================
// adminStopGmailWatch — manual trigger (root admin only).
// Останавливает watch для одного пользователя ИЛИ для всех (если userEmail
// не указан). Используется при отключении мониторинга или ротации SA.
// =========================================================================
exports.adminStopGmailWatch = onCall(
  { secrets: [GMAIL_SA_KEY], timeoutSeconds: 120 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const { userEmail } = request.data || {};
    const targets = [];
    if (userEmail) {
      targets.push(String(userEmail).toLowerCase().trim());
    } else {
      const snap = await db.collection(`workspaces/${WORKSPACE_ID}/gmailWatch`).get();
      for (const d of snap.docs) {
        const data = d.data() || {};
        if (data.email) targets.push(data.email);
      }
    }

    let stopped = 0;
    let failed = 0;
    for (const t of targets) {
      try {
        const gmail = _gmailClientFor(t);
        await gmail.users.stop({ userId: 'me' });
        const watchRef = db.doc(`workspaces/${WORKSPACE_ID}/gmailWatch/${encodeURIComponent(t)}`);
        await watchRef.set({
          stoppedAt: admin.firestore.FieldValue.serverTimestamp(),
          active: false,
        }, { merge: true });
        stopped++;
      } catch (e) {
        failed++;
        logger.warn('[gmail-stop] failed', { email: t, error: e.message });
      }
    }
    return { ok: true, stopped, failed };
  }
);
