// services/actionHandlers/chatActions.js
'use strict';

const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Eve';
const COMPANY_NAME = process.env.COMPANY_NAME || 'EveAI';

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

/**
 * Build system prompt with a concise personality that includes company.
 */
function systemPrompt(personality = {}) {
  const voice = personality.voice || `${ASSISTANT_NAME} is direct, practical, and slightly wry. Built by ${COMPANY_NAME}.`;
  const rules = [
    'Answer first. Short sentences. No fluff.',
    'If user asked a plain chat question reply as chat.',
    'If input contains JSON or DB objects, ignore the JSON and answer the user question unless explicitly asked to process JSON.',
    'Do not ask multiple clarifying questions. Ask one pointed question when needed and stop.',
    'When user requests code, return a full working file unless told otherwise.'
  ];
  return [voice, ...rules].join('\n');
}

/**
 * Coerce params to a human prompt.
 * Robustly detect and ignore JSON/DB dumps.
 */
function coercePrompt(params = {}, action = {}) {
  if (typeof params === 'string') return params.trim();
  if (params.userMessage) return String(params.userMessage).trim();
  if (params.originalUserMessage) return String(params.originalUserMessage).trim();
  if (action && action.text) return String(action.text).trim();

  const raw = String((params && (params.prompt || params.text)) || '').trim();
  if (!raw) return '';

  const jsonLike = /[\{\}\[\]"_id|ObjectId\(|ISODate\(|T[0-9]{2}:[0-9]{2}:[0-9]{2}Z]/m;
  if (!jsonLike.test(raw)) return raw;

  const stripped = raw
    .replace(/ObjectId\([^)]*\)/g, '')
    .replace(/\{[\s\S]*?\}|\[[\s\S]*?\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (stripped) {
    const sentences = stripped.split(/(?<=[.?!])\s+/);
    for (let i = sentences.length - 1; i >= 0; i--) {
      const s = sentences[i].trim();
      if (s && s.length <= 200) return s;
    }
    return stripped.length > 400 ? stripped.slice(0, 400).trim() : stripped;
  }

  return '';
}

/**
 * Call OpenAI or fallback. Enforce short persona-aligned replies.
 */
async function modelReply(userMessage, personality = {}) {
  const system = systemPrompt(personality);
  const prompt = (String(userMessage || '')).trim() || 'How can I help?';

  if (!client) {
    const lower = prompt.toLowerCase();
    if (/(what('?s| is) your name|who are you)\??/.test(lower)) {
      return `${ASSISTANT_NAME}. Built by ${COMPANY_NAME}. I give concise, practical answers.`;
    }
    if (/how can you help|what can you do/.test(lower)) {
      return `${ASSISTANT_NAME}. I answer, debug, and produce full code files on request.`;
    }
    return prompt;
  }

  try {
    const resp = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.15,
      max_tokens: 400,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    });

    const text = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
    if (!text) return prompt;
    return String(text).trim();
  } catch (err) {
    console.error('[chatActions:modelReply] OpenAI error:', err && err.message);
    const lower = prompt.toLowerCase();
    if (/(what('?s| is) your name|who are you)\??/.test(lower)) {
      return `${ASSISTANT_NAME}. Built by ${COMPANY_NAME}.`;
    }
    return prompt;
  }
}

/**
 * Public handler.
 * Returns { success: true, type: 'chat', response: string }
 */
exports.handleChatAction = async (_userId, action = {}, params = {}) => {
  try {
    const personality = (params && params.personality) || {};

    // Build a clean prompt from available inputs.
    const prompt = coercePrompt(params, action) || '';

    let finalPrompt = prompt;
    if (!finalPrompt) {
      if (params && params.hint) finalPrompt = String(params.hint).trim();
      else if (params && params.question) finalPrompt = String(params.question).trim();
    }

    if (!finalPrompt && action && action.text) finalPrompt = String(action.text).trim();
    if (!finalPrompt) finalPrompt = 'How can I help?';

    const responseText = await modelReply(finalPrompt, personality);

    // Defensive: avoid model asking about JSON handling.
    const jsonQuestionLike = /what do you want to do with the json|how should i handle the json/i;
    let finalResponse = responseText;
    if (jsonQuestionLike.test(responseText.toLowerCase())) {
      finalResponse = 'I can answer questions or manipulate that data. Which do you want: (1) Explain the JSON, (2) Extract a value, (3) Convert to another format?';
    }

    return { success: true, type: 'chat', response: finalResponse };
  } catch (err) {
    console.error('[chatActions] error:', err && err.message);
    return { success: true, type: 'chat', response: 'Sorry. I could not respond.' };
  }
};
