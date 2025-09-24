// openaiService.js
const OpenAI = require('openai');
const { handleActionRequest } = require('./actionHandlers/baseActions');
const { formatDataForPrompt } = require('./dataService');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** In-memory per-process store of pending invoice data. */
const invoiceDrafts = new Map(); // key: userId -> draft

// ---------- utils ----------
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
function extractEmailFromContext(conversationHistory = [], userContext = {}) {
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  if (userContext && typeof userContext === 'object') {
    const flat = JSON.stringify(userContext);
    const m = flat.match(emailRegex);
    if (m) return m[0];
  }
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    const text = msg?.text || msg?.content || '';
    const m = String(text).match(emailRegex);
    if (m) return m[0];
  }
  return null;
}

// Treat placeholders as missing.
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

// Prefer the longest numeric chunk, then strip commas/spaces.
const moneyRegex = /(?:(?:£|\$|€|ngn|₦)\s*)?(\d+(?:[,\s]\d{3})*(?:\.\d{1,2})?)/i;
function parseAmountFromText(text) {
  if (!text) return undefined;
  const m = String(text).match(moneyRegex);
  if (!m) return undefined;
  const raw = m[1].replace(/[,\s]/g, '');
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

// Safer client extraction.
const CURRENCY_WORDS = /(pounds?|usd|gbp|eur|ngn|dollars?|naira)/i;
const WORK_NOUNS = /\b(replacement|fixing|fitting|repair|installation|install|service|services|maintenance|supplies|tiles?)\b/i;

function parseClientFromText(text) {
  if (!text) return undefined;
  const s = String(text);

  if (/^\s*(change|set|update)\s+description\b/i.test(s) || /\bdescription\s*[:=]/i.test(s)) {
    return undefined;
  }

  const explicit = s.match(/\b(?:client|customer)\s*[:\-]\s*([A-Z][A-Za-z0-9 .,&'-]{1,60})/i);
  if (explicit?.[1]) {
    const cand = explicit[1].split(/\s+/).slice(0, 4).join(' ').trim();
    if (!CURRENCY_WORDS.test(cand) && !/\d/.test(cand) && /^[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3}$/.test(cand)) {
      return cand;
    }
  }

  const forName = s.match(/\bfor\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})(?=[\s.,]|$)/i);
  if (forName?.[1]) {
    const cand = forName[1].trim();
    if (!CURRENCY_WORDS.test(cand) && !/\d/.test(cand) && !WORK_NOUNS.test(cand)) {
      return cand;
    }
  }
  return undefined;
}

// Ignore boilerplate descriptions like "help me/create/make an invoice", numeric-only, or currency-only lines.
const IGNORE_DESC = [
  /^\s*help\s+me\s+(?:create|make|generate|raise)\s+an?\s+invoice\b/i,
  /^\s*(?:create|make|generate|raise)\s+an?\s+invoice\b/i,
  /^\s*(?:create|make|generate|raise)\s+invoice\b/i,
  /^\s*(?:send|prepare)\s+an?\s+invoice\b/i,
  /^\s*invoice\s+for\b/i,
  /^\s*create\b/i
];

function parseDescriptionFromText(text) {
  if (!text) return undefined;
  const trimmed = text.trim();

  if (/^(yes|no|ok|okay|sure|proceed)\.?$/i.test(trimmed)) return undefined;

  if (/\b(client|customer|amount|total|currency|pounds?|gbp|usd|eur|naira|ngn)\b/i.test(trimmed)) {
    const labeled = trimmed.match(/\b(?:description|work|details)\s*[:\-]\s*([\s\S]{4,})$/i);
    return labeled ? labeled[1].trim() : undefined;
  }

  for (const rx of IGNORE_DESC) {
    if (rx.test(trimmed)) return undefined;
  }

  const hasLetters = /[A-Za-z]/.test(trimmed);
  const hasDigits = /\d/.test(trimmed);
  const hasCurrencyWord = CURRENCY_WORDS.test(trimmed) || /[£$€₦]/.test(trimmed);
  if (!hasLetters) return undefined;
  if (hasDigits && !/\b(replace|repair|install|installation|fix|service|maintain|clean|consult|audit|design|build|fit|paint|deliver|setup|set\s*up|configure)\b/i.test(trimmed)) {
    return undefined;
  }

  const m = trimmed.match(/\b(?:description|work|details)\s*[:\-]\s*([\s\S]{4,})$/i);
  if (m?.[1]) return m[1].trim();

  if (!hasCurrencyWord && trimmed.length >= 6) return trimmed;

  return undefined;
}

// ----- parse modification commands
function parseModificationFromText(text) {
  if (!text) return {};
  const s = String(text).trim();

  const patch = {};

  const amt1 = s.match(/\b(?:set|change|update)\s+(?:the\s+)?amount(?:\s+to|=)?\s*([£$€₦]?\s*\d[\d,\s]*(?:\.\d{1,2})?)/i);
  const amt2 = s.match(/\bamount\s*(?:is|=|:)\s*([£$€₦]?\s*\d[\d,\s]*(?:\.\d{1,2})?)/i);
  if (amt1?.[1] || amt2?.[1]) {
    const raw = (amt1?.[1] || amt2?.[1]).replace(/[,\s]/g, '');
    const n = Number(raw.replace(/[£$€₦]/g, ''));
    if (Number.isFinite(n) && n > 0) patch.amount = n;
  }

  const cl1 = s.match(/\b(?:set|change|update)\s+(?:the\s+)?(?:client|customer)(?:\s+name)?(?:\s+to|=)\s*([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})/i);
  const cl2 = s.match(/\b(?:client|customer)\s*(?:is|=|:)\s*([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})/i);
  if (cl1?.[1] || cl2?.[1]) {
    const cand = (cl1?.[1] || cl2?.[1]).trim();
    if (!CURRENCY_WORDS.test(cand) && !/\d/.test(cand) && !WORK_NOUNS.test(cand)) {
      patch.clientName = cand;
    }
  }

  const d1 = s.match(/\b(?:set|change|update)\s+description(?:\s+to|=)\s*["']?([\s\S]+?)["']?$/i);
  const d2 = s.match(/^description\s*[:=]\s*([\s\S]+)$/i);
  if (d1?.[1] || d2?.[1]) {
    const desc = (d1?.[1] || d2?.[1]).trim();
    if (desc && !/^create\s+an?\s+invoice/i.test(desc)) patch.description = desc;
  }

  return patch;
}

// ---------- AI extraction ----------
async function aiExtractStructure({ model, userMessage, conversationHistory }) {
  const schemaPrompt = `
You are an information extractor. Return ONLY a compact JSON object:

{
  "action": "none" | "create_invoice" | "send_invoice" | "create_event" | "update_event" | "create_task" | "fetch_data",
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
- If the user asks to create or send an invoice, set action accordingly.
- Extract amounts and descriptions into lineItems. Do not sum.
- Convert textual dates to YYYY-MM-DD where possible.
- Use null for unknowns. No code fences.`.trim();

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

// ---------- intent resolution ----------
function resolveIntent(parsed, aiResponseRaw) {
  if (!parsed) return 'chat_fallback';
  if (parsed.needsClarification) return 'clarification';
  if (parsed.action && parsed.action !== 'none') return parsed.action;
  if (parsed.intent && typeof parsed.intent === 'string') return parsed.intent;
  if (parsed.response || parsed.text || parsed.prompt) return 'chat';
  return aiResponseRaw ? 'chat' : 'unknown';
}

// ---------- description suggestion from tasks/events for a specific client ----------
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
      if (picked && picked.length >= 4) {
        candidates.push({ text: picked, source: 'task', title: title || '(untitled)', when: t.createdAt });
      }
    }
  }

  for (const e of events) {
    const title = (e.title || '').trim();
    const desc = (e.description || '').trim();
    const blob = `${title}\n${desc}`.toLowerCase();
    if (blob.includes(needle)) {
      const picked = desc || title;
      if (picked && picked.length >= 4) {
        candidates.push({ text: picked, source: 'event', title: title || '(untitled)', when: e.startTime || e.createdAt });
      }
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
  } catch {
    return null;
  }
}

// ---------- draft helpers ----------
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
    next[k] = v;
  }

  invoiceDrafts.set(id, next);
  return next;
}
function getDraft(userId) { return invoiceDrafts.get(String(userId)) || {}; }
function clearDraft(userId) { invoiceDrafts.delete(String(userId)); }
function draftIsComplete(d) { return Boolean(d && !isMissingClientName(d.clientName) && d.description && d.amount > 0); }

function renderConfirm(draft) {
  return [
    'Review:',
    `- Client: ${draft.clientName || '(missing)'}`,
    `- Amount: ${draft.amount ?? '(missing)'}`,
    `- Description: ${draft.description || '(missing)'}`,
    'Want to change anything? Say: "change client to Sam", "set amount to 650", or start a line with "description: ...".',
    'Reply "yes" to create or "no" to edit.'
  ].join('\n');
}

function renderEditPrompt(draft) {
  return [
    'What should I change?',
    `Current -> Client: ${draft.clientName || '(missing)'} | Amount: ${draft.amount ?? '(missing)'} | Description: ${draft.description || '(missing)'}`,
    'Example commands:',
    '- change client to Sam',
    '- set amount to 650',
    '- description: Replace sink in bathroom'
  ].join('\n');
}

// ---------- main ----------
/** Returns { finalResponse: string, actionResult: object|null } */
exports.generateAIResponse = async (userId, userContext = {}, conversationHistory = [], userMessage = '') => {
  const formattedData = typeof formatDataForPrompt === 'function'
    ? formatDataForPrompt(userContext)
    : {};

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const lowerMsg = String(userMessage || '').trim().toLowerCase();

  // Early "no" -> show edit prompt
  if (/^no\.?$/.test(lowerMsg)) {
    const snap = getDraft(userId);
    return { finalResponse: renderEditPrompt(snap), actionResult: null };
  }

  // Early YES commit: execute immediately if draft complete
  if (/^yes\.?$/.test(lowerMsg)) {
    const draftSnap = getDraft(userId);
    if (draftIsComplete(draftSnap)) {
      let actionResult;
      try {
        actionResult = await handleActionRequest(userId, { action: 'create_invoice' }, draftSnap);
      } catch (err) {
        actionResult = { success: false, error: err?.message || String(err) };
      }
      if (actionResult?.success) {
        const who = draftSnap.clientName;
        clearDraft(userId);
        return { finalResponse: `Invoice created for ${who}.`, actionResult };
      }
      return { finalResponse: `Could not create invoice: ${actionResult?.error || 'unknown error'}`, actionResult };
    }
    // If not complete, fall through.
  }

  // Parse inline modification intents first.
  const modPatch = parseModificationFromText(userMessage);
  const didModify = Object.keys(modPatch).length > 0;
  if (didModify) {
    const updated = setDraft(userId, modPatch);
    return { finalResponse: renderConfirm(updated), actionResult: null };
  }

  // 1) Extract with AI
  let extracted = null;
  try {
    extracted = await aiExtractStructure({ model, userMessage, conversationHistory });
  } catch (err) {
    console.log(`[ai-intent] extraction_error userId=${userId} message=${JSON.stringify(err?.message || 'Extraction failed')}`);
  }

  // 2) Merge incremental info from raw text into draft (guarded)
  const textAmount = parseAmountFromText(userMessage);
  const textClient = parseClientFromText(userMessage);
  const textDesc = parseDescriptionFromText(userMessage);

  if (textAmount || textClient || textDesc) {
    const patch = {};
    const isDescCommand = /^\s*(change|set|update)\s+description\b/i.test(userMessage) || /\bdescription\s*[:=]/i.test(userMessage);

    if (!isDescCommand && textAmount) patch.amount = textAmount;
    if (!isDescCommand && textClient) patch.clientName = textClient;
    if (textDesc) patch.description = textDesc;

    if (Object.keys(patch).length) {
      setDraft(userId, patch);
      console.log(`[draft] merged from free text userId=${userId} patch=${safeStringify(patch)}`);
    }
  }

  // 3) Snapshot
  const intent = resolveIntent(extracted, null);
  console.log(
    `[ai-intent] userId=${userId} intent=${intent}` +
    ` params=${extracted?.params ? safeStringify(extracted.params) : '{}'}` +
    ` needsClarification=${Boolean(extracted?.needsClarification)}` +
    ` action=${extracted?.action || 'none'}`
  );

  // 4) Clarification path — be explicit about what is missing
  if (extracted && extracted.needsClarification && extracted.needsClarification !== false) {
    const action = extracted.action || 'none';
    let draft = getDraft(userId);

    // Merge any AI-parsed params to help compute missing fields
    const incoming = extracted.params || {};
    const lineItems = Array.isArray(incoming.lineItems)
      ? incoming.lineItems.filter(li => li && typeof li.amount === 'number' && li.amount > 0)
      : [];
    const items = lineItems.map(li => ({ description: li.description || 'Item', quantity: 1, unitAmount: Number(li.amount) }));
    const extractedTotal = lineItems.reduce((s, li) => s + (Number(li.amount) || 0), 0);

    const patch = {};
    if (incoming.clientName != null) patch.clientName = incoming.clientName;
    if (incoming.description != null) patch.description = incoming.description;
    if (items.length) patch.items = items;
    if (extractedTotal > 0) patch.amount = extractedTotal;

    if (Object.keys(patch).length) draft = setDraft(userId, patch);

    if (action === 'create_invoice') {
      // Try suggesting a description if client present but description missing
      if (!isMissingClientName(draft.clientName) && !draft.description && !draft.suggestedDescription) {
        const hit = await suggestDescriptionFromUserData(userId, draft.clientName);
        if (hit?.text) {
          draft = setDraft(userId, { suggestedDescription: hit.text, suggestedWhy: `Found in your ${hit.source} titled "${hit.title}".` });
        }
      }

      const missing = [];
      if (isMissingClientName(draft.clientName)) missing.push('client name');
      if (!(draft.amount > 0)) missing.push('amount');
      if (!draft.description) missing.push('description');

      const lines = ['Let’s finish the invoice:'];
      if (isMissingClientName(draft.clientName)) lines.push('- Who is the client?');
      if (!(draft.amount > 0)) lines.push('- What is the total amount? Example: "£650" or "650".');
      if (!draft.description) {
        if (draft.suggestedDescription) {
          lines.push(`- Suggested description: "${draft.suggestedDescription}"`);
          if (draft.suggestedWhy) lines.push(`  Reason: ${draft.suggestedWhy}`);
          lines.push('  Reply "yes" to use it or send your own.');
        } else {
          lines.push('- Add a short description of the work done.');
        }
      }
      lines.push('You can also modify any field: "change client to Sam", "set amount to 650", or start a line with "description: ...".');

      return { finalResponse: lines.join('\n'), actionResult: null };
    }

    // Other actions fall back to the model’s question but never "Need more information."
    const q = extracted.needsClarification.question || 'Specify the missing fields.';
    const opts = Array.isArray(extracted.needsClarification.options) ? extracted.needsClarification.options : [];
    let msg = extracted.response || q;
    if (opts.length) msg += `\n\nOptions:\n${opts.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
    return { finalResponse: msg, actionResult: null };
  }

  // 5) Action path
  if (extracted && extracted.action && extracted.action !== 'none') {
    const incoming = extracted.params || {};

    const lineItems = Array.isArray(incoming.lineItems)
      ? incoming.lineItems.filter(li => li && typeof li.amount === 'number' && li.amount > 0)
      : [];
    const items = lineItems.map(li => ({ description: li.description || 'Item', quantity: 1, unitAmount: Number(li.amount) }));
    const extractedTotal = lineItems.reduce((s, li) => s + (Number(li.amount) || 0), 0);

    const patch = {};
    if (incoming.clientName !== undefined && incoming.clientName !== null) patch.clientName = incoming.clientName;
    if (incoming.description !== undefined && incoming.description !== null) patch.description = incoming.description;
    if (incoming.currency) patch.currency = incoming.currency;
    if (incoming.invoiceDate) patch.date = incoming.invoiceDate;
    if (incoming.dueDate) patch.dueDate = incoming.dueDate;
    if (incoming.email) patch.email = incoming.email;
    if (items.length) patch.items = items;
    if (extractedTotal > 0) patch.amount = extractedTotal;

    let draft = setDraft(userId, patch);

    // Suggest description only if client present but description missing
    if (extracted.action === 'create_invoice' && !isMissingClientName(draft.clientName) && !draft.description) {
      const hit = await suggestDescriptionFromUserData(userId, draft.clientName);
      if (hit?.text) {
        draft = setDraft(userId, { suggestedDescription: hit.text, suggestedWhy: `Found in your ${hit.source} titled "${hit.title}".` });
      }
    }

    if (extracted.action === 'create_invoice') {
      const missing = [];
      if (isMissingClientName(draft.clientName)) missing.push('client name');
      if (!(draft.amount > 0)) missing.push('amount');
      if (!draft.description) missing.push('description');

      if (missing.length) {
        const lines = ['Let’s finish the invoice:'];
        if (isMissingClientName(draft.clientName)) lines.push('- Who is the client?');
        if (!(draft.amount > 0)) lines.push('- What is the total amount? Example: "£650" or "650".');
        if (!draft.description) {
          if (draft.suggestedDescription) {
            lines.push(`- Suggested description: "${draft.suggestedDescription}"`);
            if (draft.suggestedWhy) lines.push(`  Reason: ${draft.suggestedWhy}`);
            lines.push('  Reply "yes" to use it or send your own.');
          } else {
            lines.push('- Add a short description of the work done.');
          }
        }
        lines.push('You can also modify any field: "change client to Sam", "set amount to 650", or start a line with "description: ...".');
        return { finalResponse: lines.join('\n'), actionResult: null };
      }

      return { finalResponse: renderConfirm(draft), actionResult: null };
    }

    // Non-create actions
    console.log(`[ai-intent] executing action=${extracted.action} params=${safeStringify(draft)}`);
    let actionResult;
    try {
      actionResult = await handleActionRequest(userId, { action: extracted.action }, draft);
    } catch (err) {
      actionResult = { success: false, error: err?.message || String(err) };
    }
    const finalResponse = actionResult?.success
      ? (extracted.response || 'Action completed successfully.')
      : `Could not complete action: ${actionResult?.error || 'unknown error'}`;
    return { finalResponse, actionResult };
  }

  // 6) Chat path + incremental guidance
  let draft = getDraft(userId);

  if (!draft.description && draft.suggestedDescription && /^yes\.?$/.test(lowerMsg)) {
    draft = setDraft(userId, { description: draft.suggestedDescription });
    return { finalResponse: renderConfirm(draft), actionResult: null };
  }

  if (/^yes\.?$/.test(lowerMsg) && draftIsComplete(draft)) {
    let actionResult;
    try {
      actionResult = await handleActionRequest(userId, { action: 'create_invoice' }, draft);
    } catch (err) {
      actionResult = { success: false, error: err?.message || String(err) };
    }
    if (actionResult?.success) {
      const who = draft.clientName;
      clearDraft(userId);
      return { finalResponse: `Invoice created for ${who}.`, actionResult };
    }
    return { finalResponse: `Could not create invoice: ${actionResult?.error || 'unknown error'}`, actionResult };
  }

  if (draft.clientName || draft.amount || draft.description || draft.suggestedDescription) {
    const missing = [];
    if (isMissingClientName(draft.clientName)) missing.push('client name');
    if (!(draft.amount > 0)) missing.push('amount');
    if (!draft.description) missing.push('description');

    if (missing.length) {
      const lines = [];
      lines.push(`Still need: ${missing.join(', ')}.`);
      if (isMissingClientName(draft.clientName)) lines.push('Who is the client?');
      if (!(draft.amount > 0)) lines.push('Total amount to bill?');
      if (!draft.description) {
        if (draft.suggestedDescription) {
          lines.push(`Suggested description: "${draft.suggestedDescription}"`);
          if (draft.suggestedWhy) lines.push(`Reason: ${draft.suggestedWhy}`);
          lines.push('Reply "yes" to use it or send your own.');
        } else {
          lines.push('Add a short description.');
        }
      }
      lines.push('You can also modify any field: "change client to Sam", "set amount to 650", or start a line with "description: ...".');
      return { finalResponse: lines.join('\n'), actionResult: null };
    }

    return { finalResponse: renderConfirm(draft), actionResult: null };
  }

  const prompt = extracted?.response || userMessage || 'How can I help?';
  try {
    const actionResult = await handleActionRequest(userId, { type: 'chat' }, { prompt });
    const finalResponse = actionResult?.success ? (actionResult.response || prompt) : prompt;
    return { finalResponse, actionResult };
  } catch {
    return { finalResponse: prompt, actionResult: null };
  }
};
