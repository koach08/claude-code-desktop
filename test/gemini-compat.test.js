const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { GEMINI_DEFAULT_MODEL, GEMINI_MODELS, buildGeminiRequest, geminiVisibleText } = require('../api-server/gemini-compat');
const messages = [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: '続きを' }];

test('new defaults and aliases migrate saved 2.5 selections', () => {
  assert.equal(GEMINI_DEFAULT_MODEL, 'gemini-3.5-flash-lite');
  assert.deepEqual(GEMINI_MODELS, ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
  assert.equal(buildGeminiRequest('gemini-2.5-flash', messages).model, GEMINI_DEFAULT_MODEL);
  assert.equal(buildGeminiRequest('gemini-2.5-pro', messages).model, 'gemini-3.8-flash');
  assert.equal(buildGeminiRequest('', messages).model, GEMINI_DEFAULT_MODEL);
});
test('chat roles, transcript, system and token cap are preserved', () => {
  const original = JSON.stringify(messages);
  const { body } = buildGeminiRequest('gemini-3.8-flash', messages, '日本語で', .4, 8192);
  assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(body.contents.map(x => x.role), ['user', 'model', 'user']);
  assert.deepEqual(body.contents.map(x => x.parts[0].text), messages.map(x => x.content));
  assert.deepEqual(body.systemInstruction, { parts: [{ text: '日本語で' }] });
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 8192 });
});
test('sampling is removed for new models and mapped legacy models', () => {
  for (const model of [...GEMINI_MODELS, 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-4-argon']) {
    assert.equal(buildGeminiRequest(model, messages, '', .2).body.generationConfig, undefined);
  }
});
test('unaffected 2.5 Flash-Lite remains selectable with its sampling option', () => {
  const r = buildGeminiRequest('gemini-2.5-flash-lite', messages, '', .2);
  assert.equal(r.model, 'gemini-2.5-flash-lite');
  assert.deepEqual(r.body.generationConfig, { temperature: .2 });
});
test('empty and model-prefill requests fail before any external call', () => {
  for (const turns of [[], null, [{ role: 'assistant', content: 'Answer:' }], [{ role: 'user', content: ' ' }], [{ role: 'tool', content: 'result' }], [{ role: 'user', content: {} }]]) {
    assert.throws(() => buildGeminiRequest(GEMINI_DEFAULT_MODEL, turns));
  }
  assert.throws(() => buildGeminiRequest(GEMINI_DEFAULT_MODEL, [{ role: 'assistant', content: 'prefix' }, { role: 'user', content: ' ' }]));
});
test('all visible text parts are returned without thought summaries', () => {
  const r = { candidates: [{ content: { parts: [{ thought: true, text: 'private thought summary' }, { text: 'Hello' }, { text: ' world' }, { thoughtSignature: 'opaque' }] } }] };
  assert.equal(geminiVisibleText(r), 'Hello world');
  assert.equal(geminiVisibleText({}), '');
});
test('server wires adapter and sends API key in header, never URL', () => {
  const server = fs.readFileSync(require.resolve('../api-server/server'), 'utf8');
  const gemini = server.slice(server.indexOf('async function streamGemini'));
  assert.match(gemini, /buildGeminiRequest\(model, messages, system, temperature, maxTokens\)/);
  assert.match(gemini, /geminiVisibleText\(parsed\)/);
  assert.match(gemini, /'x-goog-api-key': apiKey/);
  assert.doesNotMatch(gemini, /\?[^`]*key=|&key=/);
});

test('model aliases use only own keys and reject invalid model types', () => {
  assert.equal(buildGeminiRequest('constructor', messages).model, 'constructor');
  assert.throws(() => buildGeminiRequest({}, messages));
});


test('an unaffected 2.x model keeps its assistant-prefill behavior', () => {
  const turns = [{ role: 'user', content: 'Complete this' }, { role: 'assistant', content: 'Answer:' }];
  const r = buildGeminiRequest('gemini-2.5-flash-lite', turns);
  assert.equal(r.body.contents.at(-1).role, 'model');
  assert.equal(r.body.contents.at(-1).parts[0].text, 'Answer:');
  assert.throws(() => buildGeminiRequest('gemini-2.5-flash', turns));
});
test('a blank final turn never replays an earlier question', () => {
  for (const model of [GEMINI_DEFAULT_MODEL, 'gemini-2.5-flash-lite']) {
    assert.throws(() => buildGeminiRequest(model, [{ role: 'user', content: 'old question' }, { role: 'user', content: '  ' }]));
  }
});
