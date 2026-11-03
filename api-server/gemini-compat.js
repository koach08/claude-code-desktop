// Gemini 2.5 Flash/Pro redirect on 2026-12-01. Keep old saved selections usable.
const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_MODELS = ['gemini-3.8-flash', GEMINI_DEFAULT_MODEL];
const LEGACY_MODELS = Object.freeze({
  'gemini-2.5-flash': GEMINI_DEFAULT_MODEL,
  'gemini-2.5-pro': 'gemini-3.8-flash',
});

function buildGeminiRequest(model, messages, system, temperature, maxTokens) {
  if (model != null && typeof model !== 'string') throw new Error('Gemini model must be a string');
  const resolvedModel = Object.hasOwn(LEGACY_MODELS, model) ? LEGACY_MODELS[model] : (model || GEMINI_DEFAULT_MODEL);
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Gemini requires at least one user message');
  }
  const submittedLast = messages.at(-1);
  if (typeof submittedLast?.content !== 'string' || !submittedLast.content.trim()) {
    throw new Error('Gemini requests must end with a non-empty message');
  }
  const contents = messages.map(m => {
    if (!m || !['assistant', 'user'].includes(m.role) || typeof m.content !== 'string') {
      throw new Error('Gemini chat supports user/assistant text messages only');
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  }).filter(turn => turn.parts[0].text.trim());
  const legacyModel = /^gemini-2\./.test(resolvedModel);
  if (!legacyModel && contents.at(-1).role !== 'user') {
    throw new Error('Gemini requests must end with a non-empty user message; model prefilling is unsupported');
  }
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const generationConfig = {};
  // Sampling values are deprecated/ignored in Gemini 3.5+; do not send them.
  // Keep compatibility for explicitly selected, still-supported 2.x models.
  if (legacyModel && temperature != null) {
    generationConfig.temperature = temperature;
  }
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return { model: resolvedModel, body };
}

function geminiVisibleText(response) {
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
}

module.exports = { GEMINI_DEFAULT_MODEL, GEMINI_MODELS, buildGeminiRequest, geminiVisibleText };
