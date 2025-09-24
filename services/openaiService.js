// openaiService.js
const OpenAI = require('openai');
const { handleActionRequest } = require('./actionHandlers/baseActions');
const { formatDataForPrompt } = require('./dataService');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// Treat "null", "undefined", "n/a", quotes-only, or blank as missing.
function normalizeClientName(v) {
  if (v == null) return 'client name';
  let s = String(v).trim();
  if (!s) return 'client name';
  // strip surrounding quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  const low = s.toLowerCase();
  const bad = new Set(['null', 'undefined', 'n/a', 'na', 'none', '-', '--', '""', "''"]);
  if (!s || bad.has(low)) return 'client name';
  return s;
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
    "clientName": string | client name,
    "currency": string | null,
    "invoiceDate": string | null,        // YYYY-MM-DD
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

// ---------- main ----------
/**
 * Returns { finalResponse: string, actionResult: object|null }
 */
exports.generateAIResponse = async (userId, userContext = {}, conversationHistory = [], userMessage = '') => {
  const formattedData = typeof formatDataForPrompt === 'function'
    ? formatDataForPrompt(userContext)
    : {};

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  // 1) Extract with AI
  let extracted = null;
  try {
    extracted = await aiExtractStructure({ model, userMessage, conversationHistory });
  } catch (err) {
    console.log(`[ai-intent] extraction_error userId=${userId} message=${JSON.stringify(err?.message || 'Extraction failed')}`);
  }

  // 2) Log snapshot
  const intent = resolveIntent(extracted, null);
  console.log(
    `[ai-intent] userId=${userId} intent=${intent}` +
    ` params=${extracted?.params ? safeStringify(extracted.params) : '{}'}` +
    ` needsClarification=${Boolean(extracted?.needsClarification)}` +
    ` action=${extracted?.action || 'none'}`
  );

  // 3) No parse → chat
  if (!extracted) {
    const fallback = `What do you need help with regarding the request?`;
    try {
      const actionResult = await handleActionRequest(userId, { type: 'chat' }, { prompt: userMessage || fallback });
      const finalResponse = actionResult?.success ? (actionResult.response || fallback) : fallback;
      return { finalResponse, actionResult };
    } catch {
      return { finalResponse: fallback, actionResult: null };
    }
  }

  // 4) Clarify if needed
  if (extracted.needsClarification && extracted.needsClarification !== false) {
    const q = extracted.needsClarification.question || 'Need more information.';
    const opts = Array.isArray(extracted.needsClarification.options) ? extracted.needsClarification.options : [];
    console.log(`[ai-intent] clarification question=${JSON.stringify(q)} options=${opts.length ? safeStringify(opts) : '[]'}`);
    let msg = extracted.response || q;
    if (opts.length) msg += `\n\nOptions:\n${opts.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
    return { finalResponse: msg, actionResult: null };
  }

  // 5) Action path
  if (extracted.action && extracted.action !== 'none') {
    const pIn = extracted.params || {};

    // Normalize client name here
    const resolvedClientName = normalizeClientName(pIn.clientName);

    // Build items and total
    const lineItems = Array.isArray(pIn.lineItems) ? pIn.lineItems.filter(li => li && typeof li.amount === 'number') : [];
    const items = lineItems.map(li => ({
      description: li.description || 'Item',
      quantity: 1,
      unitAmount: Number(li.amount) || 0
    }));
    const totalAmount = lineItems.reduce((s, li) => s + (Number(li.amount) || 0), 0);

    const mappedParams = {
      clientName: resolvedClientName,                                    // <- enforced
      amount: Number.isFinite(totalAmount) ? totalAmount : undefined,
      description: pIn.description || undefined,
      items: items.length ? items : undefined,
      currency: pIn.currency || undefined,
      date: pIn.invoiceDate || undefined,
      dueDate: pIn.dueDate || undefined,
      email: pIn.email || undefined,
    };

    // Autofill for send_invoice
    if (extracted.action === 'send_invoice') {
      if (!mappedParams.email) {
        const inferred = extractEmailFromContext(conversationHistory, userContext);
        if (inferred) mappedParams.email = inferred;
      }
      if (!pIn.invoiceId && formattedData?.invoices?.all?.length > 0) {
        mappedParams.invoiceId = formattedData.invoices.all[0].id;
      } else if (pIn.invoiceId) {
        mappedParams.invoiceId = pIn.invoiceId;
      }
    }

    console.log(`[ai-intent] executing action=${extracted.action} params=${safeStringify(mappedParams)}`);

    // Execute
    let actionResult;
    try {
      actionResult = await handleActionRequest(userId, { action: extracted.action }, mappedParams);
    } catch (err) {
      actionResult = { success: false, error: err?.message || String(err) };
    }
    console.log(`[ai-intent] action_result success=${Boolean(actionResult && actionResult.success)}`);

    // Response
    let finalResponse;
    if (actionResult?.success) {
      if (extracted.action.includes('invoice')) {
        finalResponse = extracted.response || `Invoice created for ${resolvedClientName}.`; // <- enforced in message too
      } else if (extracted.action.includes('event')) {
        const t = actionResult.data?.title || mappedParams.title || mappedParams.eventId || 'event';
        const when = actionResult.data?.startTime || mappedParams.startTime || '';
        finalResponse = extracted.response || `Event "${t}" scheduled ${when}`.trim();
      } else if (extracted.action.includes('task')) {
        finalResponse = extracted.response || 'Task processed successfully.';
      } else if (extracted.action.includes('fetch')) {
        finalResponse = extracted.response || (actionResult.data ? 'Fetch completed.' : 'No results found.');
      } else {
        finalResponse = extracted.response || 'Action completed successfully.';
      }
    } else {
      const errText = actionResult?.error || 'unknown error';
      finalResponse = `Could not complete action: ${errText}`;
    }
    return { finalResponse, actionResult };
  }

  // 6) Default chat path
  const prompt = extracted.response || userMessage || 'How can I help?';
  console.log(`[ai-intent] chat prompt_len=${prompt ? String(prompt).length : 0}`);
  try {
    const actionResult = await handleActionRequest(userId, { type: 'chat' }, { prompt });
    const finalResponse = actionResult?.success ? (actionResult.response || extracted.response || prompt) : (extracted.response || prompt);
    return { finalResponse, actionResult };
  } catch {
    return { finalResponse: extracted.response || prompt, actionResult: null };
  }
};
