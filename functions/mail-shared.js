/**
 * Unit mail — общие хелперы для functions/mail-*.js (UNIT_EMAIL_PLAN.md, Phase 0).
 *
 * Архитектура (кратко):
 *   Общий ящик компании (integrations/mail.mailboxes[]) читается Cloud Functions
 *   через ОТДЕЛЬНЫЙ service-account с domain-wide delegation (секрет MAIL_SA_KEY,
 *   scope gmail.readonly; gmail.send — Phase 1). Письма → workspaces/default/
 *   mailThreads + mailMessages, сырой HTML и вложения → Storage mail/{wid}/...
 *   Клиент читает ТОЛЬКО через callable-двери (mail-read.js); firestore.rules
 *   закрывают mail*-коллекции для прямого доступа.
 *
 * Здесь: конфиг, Gmail-клиент, root-admin, dead-letter, audit, разбор адресов.
 * Константы продублированы минимально (как в gmail-ingest.js), чтобы не
 * тянуть functions/index.js по кругу.
 *
 * Secrets (firebase functions:secrets:set):
 *   MAIL_SA_KEY — JSON ключ service-account `sfa-mail-sa` (целиком).
 * Env:
 *   MAIL_PUBSUB_TOPIC — имя Pub/Sub topic для gmail.users.watch (по умолчанию "sfa-mail-push").
 */
'use strict';

const {HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const {google} = require('googleapis');

const WORKSPACE_ID = 'default';
const MAIL_SA_KEY = defineSecret('MAIL_SA_KEY');
const PUBSUB_TOPIC = process.env.MAIL_PUBSUB_TOPIC || 'sfa-mail-push';
const STORAGE_ROOT = 'mail';

// Root admin allowlist (синхронно с index.js — single source of truth там).
const ROOT_ADMINS = ['tony@al-en.com'];

const SCOPE_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPE_SEND = 'https://www.googleapis.com/auth/gmail.send';

// Лимиты по умолчанию (UNIT_EMAIL_PLAN.md § 6.12); переопределяются в integrations/mail.limits.
const LIMITS_DEFAULT = Object.freeze({
  perUserPerDay: 100,
  perWorkspacePerHour: 120,
  perUnitPerDay: 20,
  maxRecipients: 20,
  maxAttachmentBytes: 25 * 1024 * 1024,
});

const MAX_BODY_TEXT = 100 * 1024;       // bodyText в документе Firestore (≤ 1 МиБ на док)
const MAX_SNIPPET = 200;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function db() { return admin.firestore(); }
function col(name) { return `workspaces/${WORKSPACE_ID}/${name}`; }
function serverTs() { return admin.firestore.FieldValue.serverTimestamp(); }
function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------- config ---

// integrations/mail — НЕсекретный конфиг (Entry 20): адреса ящиков, лимиты,
// TZ, рубильники. Читается всеми членами по rules (:321), пишет admin.
let _cfgCache = { data: null, at: 0 };
const CFG_TTL_MS = 30 * 1000;

function sanitizeId(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

function normalizeConfig(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const mailboxes = (Array.isArray(raw.mailboxes) ? raw.mailboxes : [])
    .filter((m) => m && m.id && m.address)
    .map((m) => ({
      id: sanitizeId(m.id),
      address: normalizeEmail(m.address),
      displayName: String(m.displayName || '').slice(0, 120),
      enabled: m.enabled !== false,
    }))
    .filter((m) => m.id && isValidEmail(m.address));
  const ownDomains = new Set();
  for (const m of mailboxes) ownDomains.add(m.address.split('@')[1]);
  if (Array.isArray(raw.ownDomains)) {
    for (const d of raw.ownDomains) if (d && typeof d === 'string') ownDomains.add(d.trim().toLowerCase());
  }
  const limits = Object.assign({}, LIMITS_DEFAULT);
  if (raw.limits && typeof raw.limits === 'object') {
    for (const k of Object.keys(LIMITS_DEFAULT)) {
      const v = +raw.limits[k];
      if (Number.isFinite(v) && v > 0) limits[k] = v;
    }
  }
  return {
    enabled: raw.enabled === true,
    mailboxes,
    ownDomains: Array.from(ownDomains),
    timeZone: (typeof raw.timeZone === 'string' && raw.timeZone.trim()) ? raw.timeZone.trim() : 'America/New_York',
    sendEnabled: raw.sendEnabled === true,
    gmailLabelsEnabled: raw.gmailLabelsEnabled === true,
    backfillSince: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.backfillSince || '')) ? raw.backfillSince : '2026-01-01',
    limits,
  };
}

async function getMailConfig(opts) {
  const fresh = !!(opts && opts.fresh);
  if (!fresh && _cfgCache.data && Date.now() - _cfgCache.at < CFG_TTL_MS) return _cfgCache.data;
  const snap = await db().doc(col('integrations/mail')).get();
  const cfg = normalizeConfig(snap.exists ? snap.data() : {});
  _cfgCache = { data: cfg, at: Date.now() };
  return cfg;
}

function mailboxById(cfg, id) {
  const want = sanitizeId(id);
  return (cfg.mailboxes || []).find((m) => m.id === want) || null;
}
function mailboxByAddress(cfg, address) {
  const want = normalizeEmail(address);
  return (cfg.mailboxes || []).find((m) => m.address === want) || null;
}

// ------------------------------------------------------- service account ---

let _saCache = null;
function getServiceAccount() {
  if (_saCache) return _saCache;
  const raw = MAIL_SA_KEY.value();
  if (!raw) {
    throw new Error('MAIL_SA_KEY secret is not configured. Run: firebase functions:secrets:set MAIL_SA_KEY (paste service-account JSON).');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error('MAIL_SA_KEY is not valid JSON: ' + e.message); }
  if (!parsed.client_email || !parsed.private_key) throw new Error('MAIL_SA_KEY JSON lacks client_email/private_key');
  _saCache = parsed;
  return _saCache;
}

/**
 * Gmail-клиент, имперсонирующий ТОЛЬКО адрес из allowlist конфига (subject в
 * JWT). Адрес никогда не берётся из клиентского запроса напрямую — только
 * через mailboxById(cfg, id). Токен минтится google-auth-library на лету и
 * не сохраняется.
 */
function gmailClientFor(address, scopes) {
  const sa = getServiceAccount();
  const jwt = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: Array.isArray(scopes) && scopes.length ? scopes : [SCOPE_READONLY],
    subject: address,
  });
  return google.gmail({ version: 'v1', auth: jwt });
}

function pubsubTopicName() {
  const sa = getServiceAccount();
  if (!sa.project_id) throw new Error('MAIL_SA_KEY JSON lacks project_id');
  return `projects/${sa.project_id}/topics/${PUBSUB_TOPIC}`;
}

// ------------------------------------------------------------ root admin ---

let _rootCache = { items: null, at: 0 };
async function isRootAdminEmail(email) {
  const lower = normalizeEmail(email);
  if (!lower) return false;
  if (ROOT_ADMINS.includes(lower)) return true;
  try {
    if (!_rootCache.items || Date.now() - _rootCache.at > 60 * 1000) {
      const snap = await db().collection('workspaces/_config/rootAdminAllowlist').get();
      _rootCache = { items: new Set((snap.docs || []).map((d) => String(d.id).toLowerCase())), at: Date.now() };
    }
    return _rootCache.items.has(lower);
  } catch (e) {
    logger.warn('[mail] root-admin allowlist read failed: ' + (e && e.message));
    return false;
  }
}

async function requireRootAdmin(auth) {
  const email = normalizeEmail(auth && auth.token && auth.token.email);
  if (!auth || !email || auth.token.email_verified === false || !(await isRootAdminEmail(email))) {
    throw new HttpsError('permission-denied', 'Root admin only');
  }
  return { uid: auth.uid, email };
}

// ---------------------------------------------------- dead-letter / audit ---

// § 0.2.5: событие не умирает молча — каждый ранний return оставляет след.
async function deadLetter(key, payload) {
  const safeKey = String(key || 'unknown').replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 200);
  try {
    await db().doc(col(`mailDeadLetter/${safeKey}`)).set({
      ...(payload || {}),
      at: serverTs(),
      _ttl: admin.firestore.Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000),
    }, { merge: true });
  } catch (e) {
    logger.warn(`[mail] dead-letter write failed for ${safeKey}: ${(e && e.message) || e}`);
  }
}

// Строка в общий audit (та же форма, что recordAudit в index.js), source='mail'.
async function writeAudit(entry) {
  const e = entry || {};
  const row = {
    ts: serverTs(),
    actor: e.actor || 'cloud-function',
    actorUid: e.actorUid || null,
    action: String(e.action || 'mail.unknown').slice(0, 64),
    source: 'mail',
  };
  if (e.unitId) row.unitId = String(e.unitId).slice(0, 32);
  if (e.buildingId) row.buildingId = String(e.buildingId).slice(0, 32);
  if (e.floorId) row.floorId = String(e.floorId).slice(0, 32);
  if (e.note) row.note = String(e.note).slice(0, 500);
  if (e.traceId && /^t_[A-Za-z0-9_-]{4,40}$/.test(String(e.traceId))) row.traceId = String(e.traceId);
  if (e.mailThreadId) row.mailThreadId = String(e.mailThreadId).slice(0, 120);
  if (e.mailMessageId) row.mailMessageId = String(e.mailMessageId).slice(0, 120);
  if (e.stateWriteOk !== undefined) row.stateWriteOk = !!e.stateWriteOk;
  try {
    const ref = await db().collection(col('audit')).add(row);
    return ref.id;
  } catch (err) {
    logger.warn('[mail] audit write failed: ' + ((err && err.message) || err));
    return null;
  }
}

// --------------------------------------------------------- email strings ---

function normalizeEmail(s) {
  return String(s == null ? '' : s).trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

function isValidEmail(s) {
  const v = String(s || '');
  return /^[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[^\s@<>"',;()]+$/.test(v) && v.length <= 254;
}

// `"Name" <a@b>` | `Name <a@b>` | `<a@b>` | `a@b` → {name, email}
function parseAddress(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const m = /^(.*?)<([^<>]+)>\s*$/.exec(s);
  let name = '';
  let email = '';
  if (m) {
    name = m[1].trim().replace(/^"|"$/g, '').replace(/\\"/g, '"').trim();
    email = normalizeEmail(m[2]);
  } else {
    email = normalizeEmail(s);
  }
  if (!isValidEmail(email)) return null;
  return { name: name.slice(0, 120), email };
}

// Список адресов: запятые вне кавычек и угловых скобок.
function parseAddressList(raw) {
  const s = String(raw == null ? '' : raw);
  const out = [];
  let cur = '';
  let inQ = false;
  let inAngle = false;
  for (const ch of s) {
    if (ch === '"' && !inAngle) inQ = !inQ;
    else if (ch === '<' && !inQ) inAngle = true;
    else if (ch === '>' && !inQ) inAngle = false;
    if (ch === ',' && !inQ && !inAngle) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  const seen = new Set();
  const res = [];
  for (const part of out) {
    const a = parseAddress(part);
    if (a && !seen.has(a.email)) { seen.add(a.email); res.push(a); }
  }
  return res;
}

function normalizeMessageId(s) {
  if (!s) return '';
  return String(s).trim().replace(/^<|>$/g, '').toLowerCase().slice(0, 300);
}

// Логи (Entry 76): адреса арендаторов маскируем.
function maskEmail(v) {
  const s = normalizeEmail(v);
  const at = s.indexOf('@');
  if (at <= 0) return s ? '***' : '';
  return s[0] + '***@' + s.slice(at + 1);
}

function unitKeyOf(buildingId, unitId) {
  return `${String(buildingId)}__${String(unitId)}`;
}
// unitKey = buildingId__unitId (Entry 88: номера сьютов повторяются между зданиями).
function parseUnitKey(key) {
  const s = String(key || '');
  const i = s.indexOf('__');
  if (i <= 0 || i >= s.length - 2) return null;
  return { buildingId: s.slice(0, i), unitId: s.slice(i + 2) };
}

function safeFilename(name) {
  let s = String(name || 'attachment').replace(/[\\/]/g, '_').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!s || s === '.' || s === '..') s = 'attachment';
  return s.slice(0, 120);
}

function clampText(s, max) {
  const v = String(s == null ? '' : s);
  return v.length > max ? v.slice(0, max) : v;
}

module.exports = {
  WORKSPACE_ID, MAIL_SA_KEY, PUBSUB_TOPIC, STORAGE_ROOT, ROOT_ADMINS,
  SCOPE_READONLY, SCOPE_SEND, LIMITS_DEFAULT, MAX_BODY_TEXT, MAX_SNIPPET, MAX_ATTACHMENT_BYTES,
  db, col, serverTs, nowIso,
  normalizeConfig, getMailConfig, mailboxById, mailboxByAddress, sanitizeId,
  getServiceAccount, gmailClientFor, pubsubTopicName,
  isRootAdminEmail, requireRootAdmin,
  deadLetter, writeAudit,
  normalizeEmail, isValidEmail, parseAddress, parseAddressList, normalizeMessageId, maskEmail,
  unitKeyOf, parseUnitKey, safeFilename, clampText,
  _resetCachesForTests() { _cfgCache = { data: null, at: 0 }; _saCache = null; _rootCache = { items: null, at: 0 }; },
};
