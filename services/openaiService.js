// openaiService.js
const OpenAI = require('openai');
const { handleActionRequest } = require('./actionHandlers/baseActions');
const { formatDataForPrompt } = require('./dataService');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** In-memory per-process store of pending invoice data. */
const invoiceDrafts = new Map(); // key: userId -> draft
/** Track the user's most recently created or edited invoice to support "modify the invoice ..." */
const currentInvoiceByUser = new Map(); // key: userId -> { id, snapshot }

/* ---------- utils ---------- */
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

/* ---------- currency normalization ---------- */
const CURRENCY_WORD_TO_ISO = new Map([
  ['gbp', 'GBP'], ['pound', 'GBP'], ['pounds', 'GBP'], ['sterling', 'GBP'],
  ['usd', 'USD'], ['dollar', 'USD'], ['dollars', 'USD'], ['us dollars', 'USD'],
  ['eur', 'EUR'], ['euro', 'EUR'], ['euros', 'EUR'],
  ['ngn', 'NGN'], ['naira', 'NGN'],
  ['cad', 'CAD'], ['aud', 'AUD'], ['inr', 'INR'], ['jpy', 'JPY'],
]);
const CURRENCY_SYMBOL_TO_ISO = new Map([
  ['£', 'GBP'], ['$', 'USD'], ['€', 'EUR'], ['₦', 'NGN'], ['¥', 'JPY'],
]);

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
  for (const t of word.split(/\s+/)) {
    if (CURRENCY_WORD_TO_ISO.has(t)) return CURRENCY_WORD_TO_ISO.get(t);
  }
  return null;
}

function detectCurrencyFromText(text) {
  if (!text) return null;
  const sym = text.match(/[£€$₦¥]/);
  if (sym && CURRENCY_SYMBOL_TO_ISO.has(sym[0])) return CURRENCY_SYMBOL_TO_ISO.get(sym[0]);
  const w = text.toLowerCase();
  for (const key of CURRENCY_WORD_TO_ISO.keys()) {
    if (w.includes(key)) return CURRENCY_WORD_TO_ISO.get(key);
  }
  return null;
}

function coerceValidCurrency(draft, userText, fallback = 'GBP') {
  let iso = normalizeCurrency(draft.currency) || detectCurrencyFromText(userText) || fallback;
  if (!iso) iso = fallback;
  draft.currency = iso;
  return draft;
}

/* ---------- parsing helpers (no regex for amount/description) ---------- */
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

/** Only route-level parsing: detect intent to update and simple client/currency phrases. */
function parseModificationFromText(text) {
  if (!text) return {};
  const s = String(text).trim();
  const patch = {};

  // Currency hints like "in naira" or "currency: GBP"
  const cur1 = s.match(/\bcurrency\s*(?:is|=|:)\s*([A-Za-z£$€₦]+)\b/i);
  const cur2 = s.match(/\b(?:in|to)\s+(naira|pounds?|dollars?|euros?|gbp|usd|eur|ngn)\b/i);
  const cur3 = detectCurrencyFromText(s);
  const curRaw = (cur1?.[1] || cur2?.[1] || cur3 || '').trim();
  if (curRaw) {
    const iso = normalizeCurrency(curRaw);
    if (iso) patch.currency = iso;
  }

  // Client explicit command
  const cl1 = s.match(/\b(?:set|change|update)\s+(?:the\s+)?(?:client|customer)(?:\s+name)?(?:\s+to|=)\s*([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})/i);
  const cl2 = s.match(/\b(?:client|customer)\s*(?:is|=|:)\s*([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})/i);
  if (cl1?.[1] || cl2?.[1]) patch.clientName = (cl1?.[1] || cl2?.[1]).trim();

  // Generic "modify/update/edit invoice"
  if (/\b(modify|update|edit)\b.*\binvoice\b/i.test(s)) patch.__wantsUpdate = true;

  return patch;
}

/* ---------- AI extraction ---------- */
async function aiExtractStructure({ model, userMessage, conversationHistory }) {
  const schemaPrompt = `
You are an information extractor. Return ONLY a compact JSON object:

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
- If the user asks to create an invoice, set action=create_invoice.
- If the user asks to modify/update/edit an existing invoice, set action=update_invoice.
- Extract amounts and descriptions into lineItems. Do not sum.
- If user provides "Amount 5000" and "description: ..." in same message, keep them together in lineItems.
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

/* ---------- intent resolution ---------- */
function resolveIntent(parsed, aiResponseRaw) {
  if (!parsed) return 'chat_fallback';
  if (parsed.needsClarification) return 'clarification';
  if (parsed.action && parsed.action !== 'none') return parsed.action;
  if (parsed.intent && typeof parsed.intent === 'string') return parsed.intent;
  if (parsed.response || parsed.text || parsed.prompt) return 'chat';
  return aiResponseRaw ? 'chat' : 'unknown';
}

/* ---------- description suggestion from tasks/events ---------- */
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

/* ---------- draft helpers ---------- */
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
    if (k === '__wantsUpdate') { next.mode = 'update'; continue; }
    if (k === 'invoiceId') { next.invoiceId = String(v); continue; }
    next[k] = v;
  }

  invoiceDrafts.set(id, next);
  return next;
}
function getDraft(userId) { return invoiceDrafts.get(String(userId)) || {}; }
function draftIsComplete(d) {
  return Boolean(d && !isMissingClientName(d.clientName) && d.description && d.amount > 0);
}

// Seed missing fields in the draft from the user's current invoice snapshot.
function seedDraftFromCurrentInvoice(userId) {
  const id = String(userId);
  const cur = invoiceDrafts.get(id) || {};
  const curInv = currentInvoiceByUser.get(id);
  if (!curInv || !curInv.snapshot) return cur;

  const seeded = { ...cur };
  if (!seeded.invoiceId && curInv.id) seeded.invoiceId = curInv.id;
  if (isMissingClientName(seeded.clientName) && curInv.snapshot.clientName) seeded.clientName = curInv.snapshot.clientName;
  if (!(seeded.amount > 0) && curInv.snapshot.amount > 0) seeded.amount = curInv.snapshot.amount;
  if (!seeded.description && curInv.snapshot.description) seeded.description = curInv.snapshot.description;
  if (!seeded.currency && curInv.snapshot.currency) seeded.currency = normalizeCurrency(curInv.snapshot.currency) || 'GBP';
  invoiceDrafts.set(id, seeded);
  return seeded;
}

function renderConfirm(draft) {
  return [
    'Review:',
    `- Client: ${draft.clientName || '(missing)'}`,
    `- Amount: ${draft.amount ?? '(missing)'} ${draft.currency ? `(${draft.currency})` : ''}`.trim(),
    `- Description: ${draft.description || '(missing)'}`,
    'Want to change anything? Say: "change client to Sam", "set amount to 650", or start a line with "description: ...".',
    draft.mode === 'update'
      ? 'Reply "yes" to update or "no" to edit.'
      : 'Reply "yes" to create or "no" to edit.'
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

/* ---------- merge AI extraction into draft on every turn ---------- */
function mergeExtractionIntoDraft(uid, extracted, userMessage) {
  if (!extracted || !extracted.params) return getDraft(uid);
  const p = extracted.params;

  const patch = {};
  if (p.clientName !== undefined && p.clientName !== null) patch.clientName = p.clientName;
  if (p.currency !== undefined && p.currency !== null) patch.currency = normalizeCurrency(p.currency) || p.currency;
  if (p.description !== undefined && p.description !== null) patch.description = p.description;

  // lineItems -> amount and candidate description
  const items = Array.isArray(p.lineItems) ? p.lineItems.filter(li => li && typeof li.amount === 'number' && li.amount > 0) : [];
  if (items.length) {
    const sum = items.reduce((s, li) => s + (Number(li.amount) || 0), 0);
    if (sum > 0) patch.amount = sum;
    // If no top-level description but a single item has one, use it
    if ((patch.description == null || String(patch.description).trim() === '') && items.length === 1) {
      const d = (items[0].description || '').trim();
      if (d.length >= 4) patch.description = d;
    }
  }

  if (p.invoiceId) patch.invoiceId = String(p.invoiceId);
  if (Object.keys(patch).length) setDraft(uid, patch);

  // Ensure a valid currency on draft before using it
  const snap = coerceValidCurrency(getDraft(uid), userMessage);
  return snap;
}

/* ---------- main ---------- */
/** Returns { finalResponse: string, actionResult: object|null } */
exports.generateAIResponse = async (userId, userContext = {}, conversationHistory = [], userMessage = '') => {
  const formattedData = typeof formatDataForPrompt === 'function'
    ? formatDataForPrompt(userContext)
    : {};

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const uid = String(userId);
  const lowerMsg = String(userMessage || '').trim().toLowerCase();

  // Early "no" -> show edit prompt
  if (/^no\.?$/.test(lowerMsg)) {
    seedDraftFromCurrentInvoice(uid);
    const snap = coerceValidCurrency(getDraft(uid), userMessage);
    return { finalResponse: renderEditPrompt(snap), actionResult: null };
  }

  // Route-level parsing for modify/currency/client only
  const modPatch = parseModificationFromText(userMessage);
  if (Object.keys(modPatch).length > 0) {
    seedDraftFromCurrentInvoice(uid);
    const updated = setDraft(uid, modPatch);
    if (updated.mode === 'update' && !updated.invoiceId) {
      const curInv = currentInvoiceByUser.get(uid);
      if (curInv?.id) setDraft(uid, { invoiceId: curInv.id });
    }
  }

  // 1) AI extract every turn and merge into draft (amount + description come from AI only)
  let extracted = null;
  try {
    extracted = await aiExtractStructure({ model, userMessage, conversationHistory });
  } catch (err) {
    console.log(`[ai-intent] extraction_error userId=${uid} message=${JSON.stringify(err?.message || 'Extraction failed')}`);
  }

  // Always seed from current invoice first so updates inherit missing fields
  seedDraftFromCurrentInvoice(uid);
  const draftAfterMerge = mergeExtractionIntoDraft(uid, extracted, userMessage);

  // Early YES commit
  if (/^yes\.?$/.test(lowerMsg)) {
    // Update path
    if (draftAfterMerge.mode === 'update' && draftAfterMerge.invoiceId) {
      let actionResult;
      try {
        actionResult = await handleActionRequest(uid, { action: 'update_invoice' }, draftAfterMerge);
      } catch (err) {
        actionResult = { success: false, error: err?.message || String(err) };
      }
      if (actionResult?.success) {
        currentInvoiceByUser.set(uid, {
          id: draftAfterMerge.invoiceId,
          snapshot: {
            clientName: draftAfterMerge.clientName,
            amount: draftAfterMerge.amount,
            description: draftAfterMerge.description,
            currency: draftAfterMerge.currency
          }
        });
        invoiceDrafts.set(uid, { mode: 'update', invoiceId: draftAfterMerge.invoiceId, ...currentInvoiceByUser.get(uid).snapshot });
        return { finalResponse: `Invoice updated for ${draftAfterMerge.clientName}.`, actionResult };
      }
      return { finalResponse: `Could not update invoice: ${actionResult?.error || 'unknown error'}`, actionResult };
    }

    // Create path
    if (draftIsComplete(draftAfterMerge)) {
      let actionResult;
      try {
        actionResult = await handleActionRequest(uid, { action: 'create_invoice' }, draftAfterMerge);
      } catch (err) {
        actionResult = { success: false, error: err?.message || String(err) };
      }
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
        return { finalResponse: `Invoice created for ${who}.`, actionResult };
      }
      return { finalResponse: `Could not create invoice: ${actionResult?.error || 'unknown error'}`, actionResult };
    }
    // Fall through if not complete.
  }

  // 2) Intent resolution (for messaging only)
  const intent = resolveIntent(extracted, null);
  console.log(
    `[ai-intent] userId=${uid} intent=${intent}` +
    ` params=${extracted?.params ? safeStringify(extracted.params) : '{}'}` +
    ` needsClarification=${Boolean(extracted?.needsClarification)}` +
    ` action=${extracted?.action || 'none'}`
  );

  // 3) Clarify or confirm
  if (extracted && extracted.action && (extracted.action === 'create_invoice' || extracted.action === 'update_invoice')) {
    // Put in update mode if asked to update
    if (extracted.action === 'update_invoice') setDraft(uid, { mode: 'update' });

    // Suggest description if client is present but no desc yet
    let draft = getDraft(uid);
    if (!isMissingClientName(draft.clientName) && !draft.description && !draft.suggestedDescription) {
      const hit = await suggestDescriptionFromUserData(uid, draft.clientName);
      if (hit?.text) {
        draft = setDraft(uid, { suggestedDescription: hit.text, suggestedWhy: `Found in your ${hit.source} titled "${hit.title}".` });
      }
    }

    // Ensure valid currency
    draft = coerceValidCurrency(getDraft(uid), userMessage);

    const missing = [];
    if (isMissingClientName(draft.clientName)) missing.push('client name');
    if (!(draft.amount > 0)) missing.push('amount');
    if (!draft.description) missing.push('description');

    if (missing.length) {
      const lines = ['Let’s finish the invoice:', renderCurrentLine(draft)];
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
      lines.push('- Optionally set currency. Example: "currency: GBP" or "in naira".');
      lines.push('You can also modify any field: "change client to Sam", "set amount to 650", or start a line with "description: ...".');
      return { finalResponse: lines.join('\n'), actionResult: null };
    }

    return { finalResponse: renderConfirm(draft), actionResult: null };
  }

  // 4) If we already have a partially filled draft, guide
  let draft = getDraft(uid);

  if (!draft.description && draft.suggestedDescription && /^yes\.?$/.test(lowerMsg)) {
    draft = setDraft(uid, { description: draft.suggestedDescription });
    draft = coerceValidCurrency(draft, userMessage);
    return { finalResponse: renderConfirm(draft), actionResult: null };
  }

  if (/^yes\.?$/.test(lowerMsg) && draftIsComplete(draft)) {
    draft = coerceValidCurrency(draft, userMessage);
    if (draft.mode === 'update' && draft.invoiceId) {
      let actionResult;
      try {
        actionResult = await handleActionRequest(uid, { action: 'update_invoice' }, draft);
      } catch (err) {
        actionResult = { success: false, error: err?.message || String(err) };
      }
      if (actionResult?.success) {
        currentInvoiceByUser.set(uid, {
          id: draft.invoiceId,
          snapshot: { clientName: draft.clientName, amount: draft.amount, description: draft.description, currency: draft.currency }
        });
        invoiceDrafts.set(uid, { mode: 'update', invoiceId: draft.invoiceId, ...currentInvoiceByUser.get(uid).snapshot });
        return { finalResponse: `Invoice updated for ${draft.clientName}.`, actionResult };
      }
      return { finalResponse: `Could not update invoice: ${actionResult?.error || 'unknown error'}`, actionResult };
    }

    let actionResult;
    try {
      actionResult = await handleActionRequest(uid, { action: 'create_invoice' }, draft);
    } catch (err) {
      actionResult = { success: false, error: err?.message || String(err) };
    }
    if (actionResult?.success) {
      const who = draft.clientName;
      const createdId = actionResult?.data?._id || actionResult?.data?.id || actionResult?.data?.invoiceId || null;
      currentInvoiceByUser.set(uid, {
        id: createdId,
        snapshot: {
          clientName: actionResult?.data?.clientName ?? draft.clientName,
          amount: actionResult?.data?.amount ?? draft.amount,
          description: actionResult?.data?.description ?? draft.description,
          currency: normalizeCurrency(actionResult?.data?.currency) || draft.currency || 'GBP'
        }
      });
      invoiceDrafts.set(uid, { mode: 'update', invoiceId: createdId, ...currentInvoiceByUser.get(uid).snapshot });
      return { finalResponse: `Invoice created for ${who}.`, actionResult };
    }
    return { finalResponse: `Could not create invoice: ${actionResult?.error || 'unknown error'}`, actionResult };
  }

  if (draft.clientName || draft.amount || draft.description || draft.suggestedDescription || draft.currency) {
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
      if (!draft.description) {
        if (draft.suggestedDescription) {
          lines.push(`Suggested description: "${draft.suggestedDescription}"`);
          if (draft.suggestedWhy) lines.push(`Reason: ${draft.suggestedWhy}`);
          lines.push('Reply "yes" to use it or send your own.');
        } else {
          lines.push('Add a short description.');
        }
      }
      lines.push('- Optionally set currency. Example: "currency: GBP" or "in naira".');
      lines.push('You can also modify any field: "change client to Sam", "set amount to 650", or start a line with "description: ...".');
      return { finalResponse: lines.join('\n'), actionResult: null };
    }

    return { finalResponse: renderConfirm(draft), actionResult: null };
  }

  const prompt = (extracted && extracted.response) || userMessage || 'How can I help?';
  try {
    const actionResult = await handleActionRequest(uid, { type: 'chat' }, { prompt });
    const finalResponse = actionResult?.success ? (actionResult.response || prompt) : prompt;
    return { finalResponse, actionResult };
  } catch {
    return { finalResponse: prompt, actionResult: null };
  }
};
