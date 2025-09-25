// services/openaiService.js
const OpenAI = require('openai');
const { handleActionRequest } = require('./actionHandlers/baseActions');
const { formatDataForPrompt } = require('./dataService');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** In-memory per-process store of pending invoice data. */
const invoiceDrafts = new Map(); // userId -> draft
/** Track most recent invoice per user to support quick modify. */
const currentInvoiceByUser = new Map(); // userId -> { id, snapshot }
/** Fast client->invoice index per user. */
const clientIndexByUser = new Map(); // userId -> Map<canonClientName, {id, clientName, updatedAt}>

/* -------------------- utils -------------------- */
function safeStringify(obj) { try { return JSON.stringify(obj); } catch { return '[unserializable]'; } }
function tryParseJSON(input) {
  if (!input) return null;
  if (typeof input === 'object') return input;
  const str = String(input).trim();
  try { return JSON.parse(str); } catch {}
  const m = str.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
function toISODate(x) { try { return new Date(x).toISOString(); } catch { return null; } }
function stripDiacritics(s) { return s ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s; }

/* -------------------- currency -------------------- */
const CURRENCY_WORD_TO_ISO = new Map([
  ['gbp','GBP'],['pound','GBP'],['pounds','GBP'],['sterling','GBP'],
  ['usd','USD'],['dollar','USD'],['dollars','USD'],['us dollars','USD'],
  ['eur','EUR'],['euro','EUR'],['euros','EUR'],
  ['ngn','NGN'],['naira','NGN'],
  ['cad','CAD'],['aud','AUD'],['inr','INR'],['jpy','JPY'],
]);
const CURRENCY_SYMBOL_TO_ISO = new Map([['£','GBP'],['$','USD'],['€','EUR'],['₦','NGN'],['¥','JPY']]);

function normalizeCurrency(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const iso = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(iso)) return iso;
  const sym = CURRENCY_SYMBOL_TO_ISO.get(raw[0]);
  if (sym) return sym;
  const word = raw.toLowerCase().replace(/[^a-z]/g, ' ').trim();
  if (!word) return null;
  if (CURRENCY_WORD_TO_ISO.has(word)) return CURRENCY_WORD_TO_ISO.get(word);
  for (const t of word.split(/\s+/)) if (CURRENCY_WORD_TO_ISO.has(t)) return CURRENCY_WORD_TO_ISO.get(t);
  return null;
}
function detectCurrencyFromText(text) {
  if (!text) return null;
  const sym = text.match(/[£€$₦¥]/);
  if (sym && CURRENCY_SYMBOL_TO_ISO.has(sym[0])) return CURRENCY_SYMBOL_TO_ISO.get(sym[0]);
  const w = text.toLowerCase();
  for (const key of CURRENCY_WORD_TO_ISO.keys()) if (w.includes(key)) return CURRENCY_WORD_TO_ISO.get(key);
  return null;
}
function coerceValidCurrency(draft, userText, fallback = 'GBP') {
  let iso = normalizeCurrency(draft.currency) || detectCurrencyFromText(userText) || fallback;
  if (!iso) iso = fallback;
  draft.currency = iso;
  return draft;
}

/* -------------------- client name -------------------- */
const BAD_CLIENT_TOKENS = new Set([
  'null','undefined','n/a','na','none','-','--','""',"''",
  'unknown','someone','somebody','client','customer','the client','the customer'
]);
function normalizeClientName(v) {
  if (v == null) return 'client name';
  let s = String(v).trim();
  if (!s) return 'client name';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  const low = s.toLowerCase();
  if (BAD_CLIENT_TOKENS.has(low)) return 'client name';
  return s;
}
function isMissingClientName(v) {
  if (!v) return true;
  const low = String(v).trim().toLowerCase();
  return !low || BAD_CLIENT_TOKENS.has(low) || low === 'client name';
}

/* -------------------- AI quick edits -------------------- */
async function aiParseQuickEdits(text) {
  if (!text || !String(text).trim()) return {};
  const sys = `
You output a minimal JSON PATCH for an invoice from a short user command.
Return ONLY JSON like:
{
  "clientName": string|null,
  "amount": number|null,
  "currency": string|null,
  "description": string|null
}

Rules:
- Extract a single numeric total if the user sets price/amount. Use a number.
- If currency is indicated (symbol, code, or words), set a 3-letter ISO code (GBP, USD, EUR, NGN, etc).
- If description is provided, return it.
- If client name is set or implied, return it, otherwise null.
- If a field is not clearly present, return null for it.`.trim();

  const usr = String(text);
  let raw = '';
  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      temperature: 0,
      response_format: { type: 'json_object' }
    });
    raw = completion?.choices?.[0]?.message?.content ?? '';
  } catch { return {}; }

  const parsed = tryParseJSON(raw) || {};
  const patch = {};
  if (parsed.clientName != null) {
    const n = normalizeClientName(parsed.clientName);
    if (!isMissingClientName(n)) patch.clientName = n;
  }
  if (typeof parsed.amount === 'number' && isFinite(parsed.amount) && parsed.amount > 0) patch.amount = Number(parsed.amount);
  if (parsed.currency != null) {
    const iso = normalizeCurrency(parsed.currency);
    if (iso) patch.currency = iso;
  }
  if (typeof parsed.description === 'string') {
    const d = parsed.description.trim();
    if (d) patch.description = d;
  }
  return patch;
}

/* -------------------- AI extraction (primary struct) -------------------- */
async function aiExtractStructure({ model, userMessage, conversationHistory }) {
  const schemaPrompt = `
You are an information extractor. Return ONLY JSON:

{
  "action": "none" | "create_invoice" | "update_invoice" | "send_invoice" | "create_event" | "update_event" | "create_task" | "fetch_data",
  "intent": string,
  "needsClarification": false | { "question": string, "options": string[] },
  "params": {
    "clientName": string | null,
    "currency": string | null,
    "invoiceDate": string | null,
    "lineItems": [{"description": string, "amount": number}] | null,
    "invoiceId": string | null,
    "email": string | null,
    "description": string | null
  },
  "response": string | null
}

Rules:
- "modify <name>'s invoice" => action=update_invoice, params.clientName=<name>.
- If invoice number given, set params.invoiceId.
- Put amounts and descriptions into lineItems. Do not sum.
- Use null for unknowns.`.trim();

  const historyMsgs = (conversationHistory || []).map(msg => ({
    role: msg?.sender === 'user' ? 'user' : 'assistant',
    content: msg?.text || msg?.content || ''
  }));

  const messages = [
    { role: 'system', content: schemaPrompt },
    ...historyMsgs,
    { role: 'user', content: userMessage || '' }
  ];

  const completion = await openai.chat.completions.create({
    model,
    messages,
    temperature: 0.1,
    response_format: { type: 'json_object' }
  });

  const raw = completion?.choices?.[0]?.message?.content ?? '';
  return tryParseJSON(raw);
}

/* -------------------- intent resolution -------------------- */
function resolveIntent(parsed, aiResponseRaw) {
  if (!parsed) return 'chat_fallback';
  if (parsed.needsClarification) return 'clarification';
  if (parsed.action && parsed.action !== 'none') return parsed.action;
  if (parsed.intent && typeof parsed.intent === 'string') return parsed.intent;
  if (parsed.response || parsed.text || parsed.prompt) return 'chat';
  return aiResponseRaw ? 'chat' : 'unknown';
}

/* -------------------- description suggestion -------------------- */
function pickDescriptionForClient(events = [], tasks = [], clientName = '') {
  if (!clientName || isMissingClientName(clientName)) return null;
  const needle = clientName.toLowerCase();
  const candidates = [];
  for (const t of tasks) {
    const title = (t.title || '').trim();
    const desc = (t.description || '').trim();
    const blob = `${title}\n${desc}`.toLowerCase();
    if (blob.includes(needle)) {
      const picked = desc || title;
      if (picked && picked.length >= 4) candidates.push({ text: picked, source: 'task', title: title || '(untitled)', when: t.createdAt });
    }
  }
  for (const e of events) {
    const title = (e.title || '').trim();
    const desc = (e.description || '').trim();
    const blob = `${title}\n${desc}`.toLowerCase();
    if (blob.includes(needle)) {
      const picked = desc || title;
      if (picked && picked.length >= 4) candidates.push({ text: picked, source: 'event', title: title || '(untitled)', when: e.startTime || e.createdAt });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0));
  return candidates[0];
}
async function suggestDescriptionFromUserData(userId, clientName) {
  try {
    const res = await handleActionRequest(userId, { type: 'fetch_user_events_and_tasks' }, {});
    if (!res || res.success === false) return null;
    return pickDescriptionForClient(res.events || [], res.tasks || [], clientName);
  } catch { return null; }
}

/* -------------------- deterministic name matching -------------------- */
function canonName(s) {
  if (!s) return '';
  const t = stripDiacritics(String(s)).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}
function nameTokens(s) { return canonName(s).split(' ').filter(Boolean); }
function tokenOverlapScore(aName, bName) {
  const a = new Set(nameTokens(aName));
  const b = new Set(nameTokens(bName));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const j = inter / (a.size + b.size - inter);
  return j;
}
function pickMostRecent(arr) {
  const copy = [...arr];
  copy.sort((a, b) => {
    const t = (x) => new Date(x?.updatedAt || x?.date || x?.createdAt || 0).getTime();
    return t(b) - t(a);
  });
  return copy[0] || null;
}
function deterministicPick(target, candidates) {
  const tgt = canonName(target);
  if (!tgt) return null;
  let exact = candidates.filter(c => canonName(c.clientName) === tgt);
  if (exact.length) return pickMostRecent(exact);
  let contains = candidates.filter(c => {
    const cc = canonName(c.clientName);
    return cc.startsWith(tgt) || cc.endsWith(tgt) || cc.includes(` ${tgt} `) || cc === tgt;
  });
  if (contains.length) return pickMostRecent(contains);
  let scored = candidates.map(c => ({ c, s: tokenOverlapScore(target, c.clientName) }));
  scored.sort((x, y) => y.s - x.s);
  if (scored[0] && scored[0].s >= 0.5) {
    const top = scored[0].s;
    const ties = scored.filter(z => z.s === top).map(z => z.c);
    return pickMostRecent(ties);
  }
  return null;
}

/* -------------------- client index helpers -------------------- */
function indexClientInvoice(userId, clientName, invoiceId, updatedAt = new Date()) {
  const uid = String(userId);
  const key = canonName(clientName);
  if (!key || !invoiceId) return;
  const m = clientIndexByUser.get(uid) || new Map();
  m.set(key, { id: String(invoiceId), clientName, updatedAt: new Date(updatedAt) });
  clientIndexByUser.set(uid, m);
}
function lookupClientInvoice(userId, clientName) {
  const m = clientIndexByUser.get(String(userId));
  if (!m) return null;
  return m.get(canonName(clientName)) || null;
}

/* -------------------- AI invoice selection -------------------- */
async function aiPickInvoiceCandidate(uid, targetClientName, candidates) {
  const items = candidates.slice(0, 50).map(c => ({
    id: String(c._id || c.id || c.invoiceId || ''),
    clientName: String(c.clientName || ''),
    amount: Number(c.amount || 0),
    currency: String(normalizeCurrency(c.currency) || 'GBP'),
    date: toISODate(c.updatedAt || c.date || c.createdAt) || null,
    description: String(c.description || '')
  }));

  const sys = `
You select the best invoice to MODIFY given a target client name.
Return ONLY JSON:
{"chosenId": string|null, "reason": string, "confidence": 0..1}
Rules:
- Prefer exact or near-exact client name (case-insensitive, diacritics ignored).
- If multiple matches, pick the most recent by date.
- If no reasonable match, chosenId=null.`.trim();

  const usr = `Target client: ${targetClientName}\nCandidates: ${JSON.stringify(items)}`;

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
    temperature: 0,
    response_format: { type: 'json_object' }
  });

  const raw = completion?.choices?.[0]?.message?.content ?? '';
  const out = tryParseJSON(raw) || {};
  const chosenId = out.chosenId ? String(out.chosenId) : null;
  const confidence = typeof out.confidence === 'number' ? out.confidence : 0;
  return { chosenId, confidence, reason: out.reason || '' };
}

/* -------------------- invoice lookup -------------------- */
async function selectExistingInvoiceByClient(userId, clientName) {
  const uid = String(userId);
  const name = normalizeClientName(clientName);
  if (isMissingClientName(name)) return { ok: false, reason: 'missing_name' };

  // 1) Fast index hit -> hydrate from snapshot or fetch by id
  const ix = lookupClientInvoice(uid, name);
  if (ix) {
    const cur = currentInvoiceByUser.get(uid);
    if (cur && String(cur.id) === String(ix.id) && cur.snapshot) {
      // Use known snapshot
      return commitSelection(uid, { _id: ix.id, ...cur.snapshot, updatedAt: ix.updatedAt }, name, 'index(snapshot)', 1);
    }
    // Try to fetch full invoice
    try {
      const fetched = await handleActionRequest(uid, { action: 'get_invoice' }, { invoiceId: ix.id });
      if (fetched?.success && fetched.data) {
        return commitSelection(uid, fetched.data, name, 'index(fetch)', 1);
      }
    } catch {}
    // Fallback: keep existing values if any, but do NOT zero-out fields
    const fallback = cur && cur.snapshot ? { _id: ix.id, ...cur.snapshot } : { _id: ix.id, clientName: ix.clientName };
    return commitSelection(uid, fallback, name, 'index(fallback)', 0.8);
  }

  // 2) Gather candidates from backend and ALWAYS include a recent list
  let candidates = [];
  for (const call of [
    { action: 'search_invoices', payload: { clientName: name } },
    { action: 'find_invoice_by_client', payload: { clientName: name } }
  ]) {
    try {
      const res = await handleActionRequest(uid, { action: call.action }, call.payload);
      if (res && res.success && res.data) {
        const arr = Array.isArray(res.data) ? res.data : [res.data];
        candidates.push(...arr);
      }
    } catch {}
  }
  try {
    const res = await handleActionRequest(uid, { action: 'list_invoices' }, { limit: 200, sort: 'desc' });
    if (res && res.success && Array.isArray(res.data)) candidates = candidates.concat(res.data);
  } catch {}

  // 3) De-dup by id
  const seen = new Set();
  candidates = candidates.filter(c => {
    const id = String(c._id || c.id || c.invoiceId || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  if (!candidates.length) return { ok: false, reason: 'not_found' };

  // 4) Deterministic, then AI
  const det = deterministicPick(name, candidates);
  if (det) return commitSelection(uid, det, name, 'deterministic', 1);

  const pick = await aiPickInvoiceCandidate(uid, name, candidates);
  if (!pick.chosenId || pick.confidence < 0.30) return { ok: false, reason: 'no_confident_match', meta: pick };

  const chosen = candidates.find(c => String(c._id || c.id || c.invoiceId || '') === pick.chosenId);
  if (!chosen) return { ok: false, reason: 'chosen_missing' };

  return commitSelection(uid, chosen, name, 'ai', pick.confidence);
}

function commitSelection(uid, chosen, fallbackName, via, confidence = 1) {
  const snap = {
    clientName: chosen.clientName || fallbackName,
    amount: chosen.amount != null ? Number(chosen.amount) : undefined,
    description: chosen.description != null ? chosen.description : undefined,
    currency: normalizeCurrency(chosen.currency) || undefined
  };
  // Never default amount to 0 or description to '' here.
  const invId = String(chosen._id || chosen.id || chosen.invoiceId || '');

  // Merge with any existing draft to avoid losing info.
  const prev = invoiceDrafts.get(uid) || {};
  const merged = {
    ...prev,
    ...snap,
    invoiceId: invId,
    mode: 'update'
  };

  // Fill sane defaults without overwriting known data
  if (!merged.currency) merged.currency = 'GBP';

  currentInvoiceByUser.set(uid, { id: invId, snapshot: { clientName: merged.clientName, amount: merged.amount, description: merged.description, currency: merged.currency } });
  invoiceDrafts.set(uid, merged);
  indexClientInvoice(uid, merged.clientName, invId, new Date(chosen.updatedAt || chosen.date || chosen.createdAt || Date.now()));

  console.log(`[invoice-select] via=${via} confidence=${confidence} id=${invId} client="${merged.clientName}"`);
  return { ok: true, invoiceId: invId, snapshot: merged, confidence, via };
}

/* -------------------- draft helpers -------------------- */
function setDraft(userId, patch) {
  const id = String(userId);
  const cur = invoiceDrafts.get(id) || {};
  const next = { ...cur };

  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'amount') { if (Number(v) > 0) next.amount = Number(v); continue; }
    if (k === 'clientName') {
      const norm = normalizeClientName(v);
      if (!isMissingClientName(norm)) next.clientName = norm;
      continue;
    }
    if (k === 'description') {
      const cleaned = String(v).trim();
      if (cleaned && !/^create\s+an?\s+invoice/i.test(cleaned)) next.description = cleaned;
      continue;
    }
    if (k === 'currency') {
      const iso = normalizeCurrency(v);
      if (iso) next.currency = iso;
      continue;
    }
    if (k === 'invoiceId') { next.invoiceId = String(v); continue; }
    if (k === 'mode') { next.mode = v; continue; }
    next[k] = v;
  }

  invoiceDrafts.set(id, next);
  return next;
}
function getDraft(userId) { return invoiceDrafts.get(String(userId)) || {}; }
function draftIsComplete(d) { return Boolean(d && !isMissingClientName(d.clientName) && d.description && d.amount > 0); }

function seedDraftFromCurrentInvoice(userId) {
  const id = String(userId);
  const cur = invoiceDrafts.get(id) || {};
  const curInv = currentInvoiceByUser.get(id);
  if (!curInv || !curInv.snapshot) return cur;

  const seeded = { ...cur };
  const inCreateMode = seeded.mode === 'create';

  if (!inCreateMode) {
    if (!seeded.invoiceId && curInv.id) seeded.invoiceId = curInv.id;
  }
  if (isMissingClientName(seeded.clientName) && curInv.snapshot.clientName) seeded.clientName = curInv.snapshot.clientName;
  if (!(seeded.amount > 0) && typeof curInv.snapshot.amount === 'number' && curInv.snapshot.amount > 0) seeded.amount = curInv.snapshot.amount;
  if (!seeded.description && curInv.snapshot.description) seeded.description = curInv.snapshot.description;
  if (!seeded.currency && curInv.snapshot.currency) seeded.currency = normalizeCurrency(curInv.snapshot.currency) || 'GBP';

  if (!inCreateMode && !seeded.invoiceId && seeded.clientName && curInv.snapshot.clientName && canonName(seeded.clientName) === canonName(curInv.snapshot.clientName)) {
    seeded.invoiceId = curInv.id;
  }

  invoiceDrafts.set(id, seeded);
  return seeded;
}

/* -------------------- rendering -------------------- */
function renderConfirm(draft) {
  return [
    'Review:',
    `- Client: ${draft.clientName || '(missing)'}`,
    `- Amount: ${draft.amount ?? '(missing)'} ${draft.currency ? `(${draft.currency})` : ''}`.trim(),
    `- Description: ${draft.description || '(missing)'}`,
    'Want to change anything? Say: "change client to Sam", "set amount to 650", or start a line with "description: ...".',
    draft.mode === 'update' ? 'Reply "yes" to update or "no" to edit.' : 'Reply "yes" to create or "no" to edit.'
  ].join('\n');
}
function renderEditPrompt(draft) {
  return [
    'What should I change?',
    `Current -> Client: ${draft.clientName || '(missing)'} | Amount: ${draft.amount ?? '(missing)'} ${draft.currency ? `(${draft.currency})` : ''} | Description: ${draft.description || '(missing)'}`,
    'Example commands:',
    '- change client to Sam',
    '- currency: GBP',
    '- description: Replace sink in bathroom'
  ].join('\n');
}
function renderCurrentLine(draft) {
  return `Current -> Client: ${draft.clientName || '(missing)'} | Amount: ${draft.amount ?? '(missing)'} ${draft.currency ? `(${draft.currency})` : ''} | Description: ${draft.description || '(missing)'}`;
}

/* -------------------- merge extraction -------------------- */
function mergeExtractionIntoDraft(uid, extracted, userMessage) {
  if (!extracted || !extracted.params) return getDraft(uid);
  const p = extracted.params;

  const patch = {};
  if (p.clientName !== undefined && p.clientName !== null) patch.clientName = p.clientName;
  if (p.currency !== undefined && p.currency !== null) patch.currency = normalizeCurrency(p.currency) || p.currency;
  if (p.description !== undefined && p.description !== null) patch.description = p.description;

  const items = Array.isArray(p.lineItems) ? p.lineItems.filter(li => li && typeof li.amount === 'number' && li.amount > 0) : [];
  if (items.length) {
    const sum = items.reduce((s, li) => s + (Number(li.amount) || 0), 0);
    if (sum > 0) patch.amount = sum;
    if ((patch.description == null || String(patch.description).trim() === '') && items.length === 1) {
      const d = (items[0].description || '').trim();
      if (d.length >= 4) patch.description = d;
    }
  }

  if (p.invoiceId) patch.invoiceId = String(p.invoiceId);
  if (Object.keys(patch).length) setDraft(uid, patch);

  const snap = coerceValidCurrency(getDraft(uid), userMessage);
  return snap;
}

/* -------------------- main -------------------- */
/** Returns { finalResponse: string, actionResult: object|null } */
exports.generateAIResponse = async (userId, userContext = {}, conversationHistory = [], userMessage = '') => {
  const formattedData = typeof formatDataForPrompt === 'function' ? formatDataForPrompt(userContext) : {};

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const uid = String(userId);
  const lowerMsg = String(userMessage || '').trim().toLowerCase();

  // "no" => edit mode
  if (/^no\.?$/.test(lowerMsg)) {
    const snap = coerceValidCurrency(getDraft(uid), userMessage);
    return { finalResponse: renderEditPrompt(snap), actionResult: null };
  }

  // Full extraction first to know action
  let extracted = null;
  try {
    extracted = await aiExtractStructure({ model, userMessage, conversationHistory });
  } catch (err) {
    console.log(`[ai-intent] extraction_error userId=${uid} message=${JSON.stringify(err?.message || 'Extraction failed')}`);
  }

  // Set mode based on action before any seeding
  if (extracted && extracted.action === 'create_invoice') {
    setDraft(uid, { mode: 'create', invoiceId: null });
  } else if (extracted && extracted.action === 'update_invoice') {
    setDraft(uid, { mode: 'update' });
  }

  // For update with client name but no invoiceId, try to select existing
  if (extracted && extracted.action === 'update_invoice') {
    const p = extracted.params || {};
    if (p && p.clientName && !p.invoiceId) {
      await selectExistingInvoiceByClient(uid, p.clientName); // commitSelection handles draft
    }
  }

  // Seed from current invoice (create mode avoids attaching invoiceId)
  seedDraftFromCurrentInvoice(uid);

  // Now apply quick edits on top so they don't get wiped by selection/seed
  try {
    const quick = await aiParseQuickEdits(userMessage);
    if (Object.keys(quick).length) setDraft(uid, quick);
  } catch {}

  // Merge structured extraction into the draft
  const draftAfterMerge = mergeExtractionIntoDraft(uid, extracted, userMessage);

  // YES => commit
  if (/^yes\.?$/.test(lowerMsg)) {
    if (draftAfterMerge.mode === 'update' && draftAfterMerge.invoiceId) {
      let actionResult;
      try {
        actionResult = await handleActionRequest(uid, { action: 'update_invoice' }, draftAfterMerge);
      } catch (err) { actionResult = { success: false, error: err?.message || String(err) }; }
      if (actionResult?.success) {
        currentInvoiceByUser.set(uid, {
          id: draftAfterMerge.invoiceId,
          snapshot: { clientName: draftAfterMerge.clientName, amount: draftAfterMerge.amount, description: draftAfterMerge.description, currency: draftAfterMerge.currency }
        });
        invoiceDrafts.set(uid, { mode: 'update', invoiceId: draftAfterMerge.invoiceId, ...currentInvoiceByUser.get(uid).snapshot });
        indexClientInvoice(uid, draftAfterMerge.clientName, draftAfterMerge.invoiceId, new Date());
        return { finalResponse: `Invoice updated for ${draftAfterMerge.clientName}.`, actionResult };
      }
      return { finalResponse: `Could not update invoice: ${actionResult?.error || 'unknown error'}`, actionResult };
    }

    if (draftIsComplete(draftAfterMerge)) {
      let actionResult;
      try {
        actionResult = await handleActionRequest(uid, { action: 'create_invoice' }, draftAfterMerge);
      } catch (err) { actionResult = { success: false, error: err?.message || String(err) }; }
      if (actionResult?.success) {
        const who = draftAfterMerge.clientName;
        const createdId = actionResult?.data?._id || actionResult?.data?.id || actionResult?.data?.invoiceId || null;
        currentInvoiceByUser.set(uid, {
          id: createdId,
          snapshot: {
            clientName: actionResult?.data?.clientName ?? draftAfterMerge.clientName,
            amount: actionResult?.data?.amount ?? draftAfterMerge.amount,
            description: actionResult?.data?.description ?? draftAfterMerge.description,
            currency: normalizeCurrency(actionResult?.data?.currency) || draftAfterMerge.currency || 'GBP'
          }
        });
        invoiceDrafts.set(uid, { mode: 'update', invoiceId: createdId, ...currentInvoiceByUser.get(uid).snapshot });
        indexClientInvoice(uid, currentInvoiceByUser.get(uid).snapshot.clientName, createdId, new Date());
        return { finalResponse: `Invoice created for ${who}.`, actionResult };
      }
      return { finalResponse: `Could not create invoice: ${actionResult?.error || 'unknown error'}`, actionResult };
    }
  }

  // log intent
  const intent = resolveIntent(extracted, null);
  console.log(`[ai-intent] userId=${uid} intent=${intent} params=${extracted?.params ? safeStringify(extracted.params) : '{}'} needsClarification=${Boolean(extracted?.needsClarification)} action=${extracted?.action || 'none'}`);

  // clarify or confirm
  if (extracted && extracted.action && (extracted.action === 'create_invoice' || extracted.action === 'update_invoice')) {
    let draft = coerceValidCurrency(getDraft(uid), userMessage);

    if (extracted.action === 'update_invoice') {
      const hadClientName = Boolean(extracted?.params?.clientName);
      const haveInvoice = Boolean(draft.invoiceId);
      if (hadClientName && !haveInvoice) {
        const line = `I couldn't find a confident match for "${extracted.params.clientName}". Say "modify <client>'s invoice", give another client, or specify an invoice number.`;
        const msg = ['Let’s finish the invoice:', renderCurrentLine(draft), line, 'You can also modify any field: "change client to Sam", "set amount to 650", or start a line with "description: ...".'].join('\n');
        return { finalResponse: msg, actionResult: null };
      }
    }

    const missing = [];
    if (isMissingClientName(draft.clientName)) missing.push('client name');
    if (!(draft.amount > 0)) missing.push('amount');
    if (!draft.description) missing.push('description');

    if (missing.length) {
      const lines = ['Let’s finish the invoice:', renderCurrentLine(draft)];
      if (isMissingClientName(draft.clientName)) lines.push('- Who is the client?');
      if (!(draft.amount > 0)) lines.push('- What is the total amount? Example: "£650" or "650".');
      if (!draft.description) {
        const hit = await suggestDescriptionFromUserData(uid, draft.clientName);
        if (hit?.text) {
          lines.push(`- Suggested description: "${hit.text}"`);
          lines.push('  Reply "yes" to use it or send your own.');
          setDraft(uid, { suggestedDescription: hit.text });
        } else {
          lines.push('- Add a short description of the work done.');
        }
      }
      lines.push('- Optionally set currency. Example: "currency: GBP" or "in naira".');
      lines.push('You can also modify any field: "change client to Sam", "set amount to 650", or start a line with "description: ...".');
      return { finalResponse: lines.join('\n'), actionResult: null };
    }

    return { finalResponse: renderConfirm(draft), actionResult: null };
  }

  // partial draft guidance
  let draft = getDraft(uid);
  if (draft.clientName || draft.amount || draft.description || draft.currency) {
    draft = coerceValidCurrency(draft, userMessage);
    const missing = [];
    if (isMissingClientName(draft.clientName)) missing.push('client name');
    if (!(draft.amount > 0)) missing.push('amount');
    if (!draft.description) missing.push('description');

    if (missing.length) {
      const lines = ['Let’s finish the invoice:', renderCurrentLine(draft)];
      lines.push(`Missing: ${missing.join(', ')}.`);
      if (isMissingClientName(draft.clientName)) lines.push('Who is the client?');
      if (!(draft.amount > 0)) lines.push('Total amount to bill?');
      if (!draft.description) lines.push('Add a short description.');
      lines.push('- Optionally set currency. Example: "currency: GBP" or "in naira".');
      lines.push('You can also modify any field: "change client to Sam", "set amount to 650", or start a line with "description: ...".');
      return { finalResponse: lines.join('\n'), actionResult: null };
    }

    return { finalResponse: renderConfirm(draft), actionResult: null };
  }

  // chat fallback
  const prompt = (extracted && extracted.response) || userMessage || 'How can I help?';
  try {
    const actionResult = await handleActionRequest(uid, { type: 'chat' }, { prompt });
    const finalResponse = actionResult?.success ? (actionResult.response || prompt) : prompt;
    return { finalResponse, actionResult };
  } catch {
    return { finalResponse: prompt, actionResult: null };
  }
};
