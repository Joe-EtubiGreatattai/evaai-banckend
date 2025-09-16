// openaiService.js
const OpenAI = require('openai');
const { handleActionRequest } = require('./actionHandlers/baseActions');
const { formatDataForPrompt } = require('./dataService');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Try parse JSON defensively.
 * If model wrapped JSON in text we attempt to extract the first {...} or [...]
 */
function tryParseJSON(input) {
  if (!input) return null;
  if (typeof input === 'object') return input;
  const str = String(input).trim();
  try {
    return JSON.parse(str);
  } catch (e) {
    // attempt to extract first JSON block
    const m = str.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) { return null; }
    }
    return null;
  }
}

/**
 * Heuristic: scan conversation history and userContext for an email address
 */
function extractEmailFromContext(conversationHistory = [], userContext = {}) {
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  if (userContext && typeof userContext === 'object') {
    const flat = JSON.stringify(userContext);
    const m = flat.match(emailRegex);
    if (m) return m[0];
  }
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (!msg) continue;
    const text = msg.text || msg.content || '';
    const m = String(text).match(emailRegex);
    if (m) return m[0];
  }
  return null;
}

/**
 * Main exported function.
 * Returns { finalResponse: string, actionResult: object|null }
 */
exports.generateAIResponse = async (userId, userContext = {}, conversationHistory = [], userMessage = '') => {
  // Format data for prompt (preserve existing behavior)
  const formattedData = typeof formatDataForPrompt === 'function'
    ? formatDataForPrompt(userContext)
    : {};

  // Build system prompt. Keep concise but allow project to supply full prompt in their file.
  const systemPrompt = `You are an assistant that returns structured JSON when asked to perform actions.
Follow the expected response format strictly unless the user requests plain chat.
When unable to follow the format, return a short plain-text answer.`;

  // Build messages: preserve conversation history mapping
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text || msg.content || ''
    })),
    { role: "user", content: userMessage || '' }
  ];

  // Request model completion. Use environment override for model.
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  let completion;
  try {
    completion = await openai.chat.completions.create({
      model,
      messages,
      temperature: 0.2,
      // This is advisory. Model may still return text.
      response_format: { type: "json_object" }
    });
  } catch (err) {
    // Model call failed. Bubble up the raw error text as finalResponse.
    const errMsg = (err && err.message) ? `OpenAI error: ${err.message}` : 'OpenAI request failed';
    return { finalResponse: errMsg, actionResult: null };
  }

  const aiResponseRaw = completion?.choices?.[0]?.message?.content ?? '';
  const parsed = tryParseJSON(aiResponseRaw);
  let finalResponse = null;
  let actionResult = null;

  // If parsing failed, route raw text to chat handler instead of erroring out.
  if (!parsed) {
    try {
      actionResult = await handleActionRequest(userId, { type: 'chat' }, { prompt: aiResponseRaw || userMessage });
      if (actionResult && actionResult.success) {
        finalResponse = actionResult.response || String(aiResponseRaw).trim();
      } else {
        finalResponse = String(aiResponseRaw).trim();
      }
    } catch (err) {
      // Fallback to raw text
      finalResponse = String(aiResponseRaw).trim() || (err && err.message) || 'Sorry. Could not process response.';
    }
    return { finalResponse, actionResult };
  }

  // Ensure parsed is an object and has params
  parsed.params = parsed.params || {};

  try {
    // Clarification path
    if (parsed.needsClarification) {
      finalResponse = parsed.response ||
        `I need more information: ${parsed.needsClarification.question || ''}`;
      if (parsed.needsClarification.options) {
        finalResponse += `\n\nOptions:\n${parsed.needsClarification.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
      }
      return { finalResponse, actionResult: null };
    }

    // If an explicit action is requested
    if (parsed.action && parsed.action !== 'none') {
      // Special handling for send_invoice to auto-fill common missing params
      if (parsed.action === 'send_invoice') {
        if (!parsed.params.email) {
          const extractedEmail = extractEmailFromContext(conversationHistory, userContext);
          if (extractedEmail) parsed.params.email = extractedEmail;
        }
        if (!parsed.params.invoiceId && formattedData && formattedData.invoices && formattedData.invoices.all && formattedData.invoices.all.length > 0) {
          parsed.params.invoiceId = parsed.params.invoiceId || formattedData.invoices.all[0].id;
        }
      }

      // Basic validation heuristics for common actions to avoid silent failures
      if (parsed.action.includes('event') && !parsed.params.title && !parsed.params.eventId) {
        throw new Error('Event actions require either title or eventId');
      }
      if (parsed.action.includes('invoice') && !parsed.params.clientName && !parsed.params.invoiceId) {
        // allow send_invoice to recover via email/invoiceId heuristics
        if (parsed.action !== 'send_invoice') {
          throw new Error('Invoice actions require either clientName or invoiceId');
        }
      }
      if (parsed.action.includes('task') && !parsed.params.title && !parsed.params.taskId) {
        throw new Error('Task actions require either title or taskId');
      }

      // Call your action handler with the parsed action and params
      try {
        actionResult = await handleActionRequest(userId, parsed, parsed.params);
      } catch (err) {
        actionResult = { success: false, error: err && err.message ? err.message : String(err) };
      }

      // Compose finalResponse based on actionResult and parsed.response
      if (actionResult && actionResult.success) {
        if (parsed.action.includes('event')) {
          const t = actionResult.data?.title || parsed.params.title || parsed.params.eventId || 'event';
          const when = actionResult.data?.startTime || parsed.params.startTime || '';
          finalResponse = parsed.response || `Event "${t}" scheduled ${when}`.trim();
        } else if (parsed.action === 'send_invoice') {
          finalResponse = parsed.response || `Invoice sent to ${parsed.params.email || 'recipient'}.`;
        } else if (parsed.action.includes('invoice')) {
          finalResponse = parsed.response || `Invoice action completed.`;
        } else if (parsed.action.includes('task')) {
          finalResponse = parsed.response || `Task processed successfully.`;
        } else if (parsed.action.includes('fetch')) {
          finalResponse = parsed.response || (actionResult.data ? 'Fetch completed.' : 'No results found.');
        } else {
          finalResponse = parsed.response || 'Action completed successfully.';
        }
      } else {
        finalResponse = parsed.response || `Could not complete action: ${actionResult?.error || 'unknown error'}`;
      }

      return { finalResponse, actionResult };
    }

    // No action requested. Treat as chat reply.
    const prompt = (parsed.response || parsed.text || parsed.prompt) || aiResponseRaw || userMessage || 'How can I help?';
    try {
      actionResult = await handleActionRequest(userId, { type: 'chat' }, { prompt });
      finalResponse = (actionResult && actionResult.success) ? (actionResult.response || parsed.response || aiResponseRaw) : (parsed.response || aiResponseRaw);
    } catch (err) {
      finalResponse = parsed.response || aiResponseRaw;
    }

    return { finalResponse, actionResult };
  } catch (err) {
    // If anything goes wrong in action processing fall back to raw model text where available
    const msg = (err && err.message) ? err.message : 'Processing error';
    finalResponse = aiResponseRaw || `I encountered an issue processing your request: ${msg}`;
    return { finalResponse, actionResult: actionResult || { success: false, error: msg } };
  }
};
