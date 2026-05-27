/**
 * lease-extract.js — extractLeaseSignedDate callable Cloud Function.
 *
 * Reads a lease PDF stored in u.leaseDocuments[].pdfStoragePath (Firebase
 * Storage) or .pdfUrl (external/DocuSign URL), runs OCR/text extraction
 * via pdf-parse, then asks the chosen AI provider to return a structured
 * JSON envelope with: signedAt · tenantName · leaseTerm · monthlyRent.
 *
 * Provider choice (state.settings.aiExtraction.active) is visible to all
 * workspace members. API keys (workspaces/{wid}/secrets/aiExtraction) are
 * gated to admins by firestore.rules but the CF reads them via the admin
 * SDK so non-admin members can still USE the «Extract with AI» button.
 *
 * Persists the result into u.leaseDocuments[idx].extracted and, when the
 * unit's u.signed (or doc.signedAt) is empty, backfills it from the
 * extracted signedAt. Never overwrites a value the operator already set.
 *
 * Тони 2026-05-27 — фаза 2b. Полное извлечение (signedAt + всё остальное).
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const WORKSPACE_ID = 'default';
const ROOT_ADMINS = ['tony@al-en.com'];

const PROVIDER_IDS = ['anthropic', 'openai', 'grok', 'google'];

// pdf-parse loaded lazily so cold-start is fast for callables that never
// touch PDFs. Same with the four provider SDKs.
function _pdfParse() {
  return require('pdf-parse');
}

// ------------------------------------------------------------------ auth ---

async function _requireMember(auth, db) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const email = String(auth.token?.email || '').toLowerCase().trim();
  if (ROOT_ADMINS.includes(email)) return {role: 'admin', email};
  const snap = await db.doc(`workspaces/${WORKSPACE_ID}/members/${auth.uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Not a workspace member');
  const data = snap.data() || {};
  if (data.archived === true) {
    throw new HttpsError('permission-denied', 'Archived members cannot use AI extraction');
  }
  const role = data.role || 'viewer';
  return {role, email};
}

// ----------------------------------------------------------- key + active ---

async function _readKeys(db) {
  const snap = await db.doc(`workspaces/${WORKSPACE_ID}/secrets/aiExtraction`).get();
  return (snap.exists ? snap.data() : null) || {};
}

async function _readActiveProvider(db) {
  const snap = await db.doc(`workspaces/${WORKSPACE_ID}/data/state`).get();
  const data = snap.data() || {};
  const state = data.state && typeof data.state === 'object' ? data.state : data;
  const active = state?.settings?.aiExtraction?.active;
  return PROVIDER_IDS.includes(active) ? active : 'anthropic';
}

// --------------------------------------------------------------- pdf load ---

async function _downloadPdfBuffer(doc) {
  // Prefer Storage path — admin SDK has cross-project bucket access.
  if (doc.pdfStoragePath) {
    try {
      const file = admin.storage().bucket().file(doc.pdfStoragePath);
      const [buf] = await file.download();
      return buf;
    } catch (e) {
      logger.warn(`[lease-extract] Storage download failed for ${doc.pdfStoragePath}: ${e.message}`);
      // fall through to pdfUrl
    }
  }
  if (doc.pdfUrl) {
    const res = await fetch(doc.pdfUrl);
    if (!res.ok) {
      throw new HttpsError('failed-precondition',
        `PDF fetch failed for ${doc.pdfUrl} (HTTP ${res.status})`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  throw new HttpsError('failed-precondition',
    'Lease document has neither pdfStoragePath nor pdfUrl');
}

async function _pdfToText(buf) {
  const parse = _pdfParse();
  const out = await parse(buf, {max: 0});
  const text = String(out.text || '').trim();
  if (!text) {
    throw new HttpsError('failed-precondition',
      'PDF contains no extractable text (likely a scanned image — OCR not implemented yet)');
  }
  // Truncate to keep token costs predictable; lease cover pages with
  // the signed date + key fields usually fit comfortably in 10K chars.
  return text.length > 10000 ? text.slice(0, 10000) : text;
}

// ---------------------------------------------------------------- prompt ---

const EXTRACTION_PROMPT = `You are extracting structured lease metadata from a US commercial office lease PDF.

Return ONE JSON object — no prose, no markdown fences. Schema:

{
  "signedAt":     "YYYY-MM-DD"     // the date the parties signed (preferred over effective date when both are present). null if not present.
  "tenantName":   string|null,     // the tenant company or person name. null if unclear.
  "leaseTerm":    number|null,     // total lease length in MONTHS (e.g. 12, 24, 36). null if not stated.
  "monthlyRent":  number|null,     // base monthly rent in USD as a number (no currency symbol, no commas). null if not stated.
  "confidence":   number           // your confidence 0.0 to 1.0 that the signedAt above is correct.
}

Rules:
- If multiple signatures with different dates exist, use the LATEST date as signedAt.
- If only an "Effective Date" is given (no separate signature date), use the effective date and set confidence <= 0.7.
- If the document is clearly NOT a lease, return all fields null with confidence 0.
- Return ONLY the JSON object. No explanation.`;

function _parseJsonStrict(raw) {
  if (!raw) throw new HttpsError('internal', 'AI returned empty response');
  let s = String(raw).trim();
  // Strip ```json ... ``` fences if any provider wrapped it
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // Some providers prefix prose; locate the first {...}
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new HttpsError('internal',
      `AI returned non-JSON: ${String(raw).slice(0, 200)}`);
  }
}

// -------------------------------------------------------------- providers ---

async function _runAnthropic(apiKey, pdfText) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({apiKey});
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `${EXTRACTION_PROMPT}\n\n---LEASE TEXT---\n${pdfText}`,
    }],
  });
  const raw = (msg.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');
  return _parseJsonStrict(raw);
}

async function _runOpenAI(apiKey, pdfText) {
  const OpenAI = require('openai');
  const client = new OpenAI({apiKey});
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: {type: 'json_object'},
    messages: [
      {role: 'system', content: EXTRACTION_PROMPT},
      {role: 'user', content: pdfText},
    ],
  });
  const raw = res.choices?.[0]?.message?.content || '';
  return _parseJsonStrict(raw);
}

async function _runGrok(apiKey, pdfText) {
  // xAI exposes an OpenAI-compatible API — reuse the openai SDK with baseURL.
  const OpenAI = require('openai');
  const client = new OpenAI({apiKey, baseURL: 'https://api.x.ai/v1'});
  const res = await client.chat.completions.create({
    model: 'grok-2-1212',
    messages: [
      {role: 'system', content: EXTRACTION_PROMPT},
      {role: 'user', content: pdfText},
    ],
  });
  const raw = res.choices?.[0]?.message?.content || '';
  return _parseJsonStrict(raw);
}

async function _runGoogle(apiKey, pdfText) {
  // «Google Document AI» in the UI maps to Gemini under the hood —
  // DocAI proper requires trained processors per document type which is
  // out of scope for free-form lease parsing. Gemini Flash hits the
  // same accuracy/cost target with no setup.
  const {GoogleGenerativeAI} = require('@google/generative-ai');
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({
    model: 'gemini-1.5-flash',
    generationConfig: {responseMimeType: 'application/json'},
  });
  const res = await model.generateContent([
    {text: EXTRACTION_PROMPT},
    {text: pdfText},
  ]);
  const raw = res?.response?.text?.() || '';
  return _parseJsonStrict(raw);
}

const PROVIDER_RUNNERS = {
  anthropic: _runAnthropic,
  openai: _runOpenAI,
  grok: _runGrok,
  google: _runGoogle,
};

// ------------------------------------------------------------- normalize ---

function _normalize(raw, provider) {
  const out = {
    signedAt: null,
    tenantName: null,
    leaseTerm: null,
    monthlyRent: null,
    confidence: 0,
    provider,
    extractedAt: new Date().toISOString(),
  };
  if (!raw || typeof raw !== 'object') return out;

  if (typeof raw.signedAt === 'string') {
    // Accept YYYY-MM-DD only; if provider returns something else, drop it.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.signedAt.trim());
    if (m) out.signedAt = `${m[1]}-${m[2]}-${m[3]}`;
  }

  if (typeof raw.tenantName === 'string' && raw.tenantName.trim()) {
    out.tenantName = raw.tenantName.trim().slice(0, 200);
  }

  const lt = Number(raw.leaseTerm);
  if (Number.isFinite(lt) && lt > 0 && lt < 600) out.leaseTerm = Math.round(lt);

  const mr = Number(raw.monthlyRent);
  if (Number.isFinite(mr) && mr > 0 && mr < 1_000_000) {
    out.monthlyRent = Math.round(mr * 100) / 100;
  }

  const c = Number(raw.confidence);
  if (Number.isFinite(c)) out.confidence = Math.max(0, Math.min(1, c));

  return out;
}

// --------------------------------------------------------------- write ---

async function _persist(db, params, extracted) {
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`workspaces/${WORKSPACE_ID}/data/state`);
    const snap = await tx.get(ref);
    const data = snap.data() || {};
    const wrapped = data.state && typeof data.state === 'object';
    const state = wrapped ? data.state : data;

    const building = (state.buildings || []).find(b => b.id === params.buildingId);
    if (!building) throw new HttpsError('not-found', `Building ${params.buildingId} not found`);
    const floor = (building.floors || []).find(f => f.id === params.floorId);
    if (!floor) throw new HttpsError('not-found', `Floor ${params.floorId} not found`);
    const unit = (floor.units || []).find(u => u.id === params.unitId);
    if (!unit) throw new HttpsError('not-found', `Unit ${params.unitId} not found`);
    if (!Array.isArray(unit.leaseDocuments)) {
      throw new HttpsError('failed-precondition', 'Unit has no leaseDocuments[] array');
    }
    const docIdx = unit.leaseDocuments.findIndex(d => d.id === params.leaseDocId);
    if (docIdx < 0) {
      throw new HttpsError('not-found', `Lease document ${params.leaseDocId} not found on unit`);
    }
    const doc = unit.leaseDocuments[docIdx];

    // Stamp the extraction result onto the document. Always overwrite
    // — re-running the extraction should reflect the latest answer.
    doc.extracted = extracted;

    // Backfill the doc-level + unit-level signed date ONLY when empty.
    // We never trample an operator-set value with an AI guess.
    if (extracted.signedAt) {
      if (!doc.signedAt) doc.signedAt = extracted.signedAt;
      if (!unit.signed) unit.signed = extracted.signedAt;
    }

    unit.leaseDocuments[docIdx] = doc;

    const out = wrapped ? {
      ...data,
      state,
      _rev: (data._rev || 0) + 1,
      _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      _updatedBy: 'cloud-function:extractLeaseSignedDate',
    } : {
      ...state,
      _rev: (state._rev || 0) + 1,
      _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      _updatedBy: 'cloud-function:extractLeaseSignedDate',
    };
    tx.set(ref, out);
  });
}

// ------------------------------------------------------------- callable ---

const extractLeaseSignedDate = onCall(async (req) => {
  const db = admin.firestore();

  await _requireMember(req.auth, db);

  const {buildingId, floorId, unitId, leaseDocId} = req.data || {};
  if (!buildingId || !floorId || !unitId || !leaseDocId) {
    throw new HttpsError('invalid-argument',
      'Required: {buildingId, floorId, unitId, leaseDocId}');
  }

  const [keys, activeProvider] = await Promise.all([
    _readKeys(db),
    _readActiveProvider(db),
  ]);
  const apiKey = keys[activeProvider];
  if (!apiKey) {
    throw new HttpsError('failed-precondition',
      `No API key configured for provider '${activeProvider}'. ` +
      `Ask an admin to set it in Settings → AI Document Extraction.`);
  }

  // Locate the document so we can grab the PDF before doing AI work.
  const stateSnap = await db.doc(`workspaces/${WORKSPACE_ID}/data/state`).get();
  const stateData = stateSnap.data() || {};
  const state = stateData.state && typeof stateData.state === 'object'
    ? stateData.state : stateData;
  const b = (state.buildings || []).find(x => x.id === buildingId);
  const f = b && (b.floors || []).find(x => x.id === floorId);
  const u = f && (f.units || []).find(x => x.id === unitId);
  const doc = u && Array.isArray(u.leaseDocuments)
    ? u.leaseDocuments.find(d => d.id === leaseDocId)
    : null;
  if (!doc) {
    throw new HttpsError('not-found',
      `Lease document ${leaseDocId} not found on unit ${buildingId}/${floorId}/${unitId}`);
  }

  const runner = PROVIDER_RUNNERS[activeProvider];
  if (!runner) {
    throw new HttpsError('failed-precondition',
      `Provider '${activeProvider}' is not supported`);
  }

  let pdfBuf;
  try {
    pdfBuf = await _downloadPdfBuffer(doc);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('failed-precondition', `PDF download failed: ${e.message}`);
  }

  let pdfText;
  try {
    pdfText = await _pdfToText(pdfBuf);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('failed-precondition', `PDF parse failed: ${e.message}`);
  }

  let raw;
  try {
    raw = await runner(apiKey, pdfText);
  } catch (e) {
    logger.error(`[lease-extract] provider=${activeProvider} failed`, e);
    throw new HttpsError('internal',
      `AI extraction failed (${activeProvider}): ${e.message || e}`);
  }

  const extracted = _normalize(raw, activeProvider);

  try {
    await _persist(db, {buildingId, floorId, unitId, leaseDocId}, extracted);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', `Persist failed: ${e.message}`);
  }

  return {ok: true, extracted};
});

module.exports = {extractLeaseSignedDate};
