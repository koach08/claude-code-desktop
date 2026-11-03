// 「おまかせ」のモデル選び。短いやり取りは安く、込み入った相談は深く
const test = require('node:test');
const assert = require('node:assert');
const { pickModel, MODELS } = require('../src/chat-presets');

test('おまかせが選べる', () => { assert.ok(MODELS.some((m) => m.id === 'auto')); });
test('短い質問は Haiku', () => { assert.strictEqual(pickModel({ purpose: 'general', text: '明日の天気は?' }).model, 'haiku'); });
test('開発・研究・販売は Sonnet', () => {
  for (const p of ['dev', 'research', 'ship']) assert.strictEqual(pickModel({ purpose: p, text: '直して' }).model, 'sonnet');
});
test('込み入った相談は Opus', () => { assert.strictEqual(pickModel({ purpose: 'general', text: 'この設計で大丈夫か見て' }).model, 'opus'); });
test('資料つき・長文は Sonnet', () => {
  assert.strictEqual(pickModel({ purpose: 'general', text: '要約して', attachments: [{ text: 'x' }] }).model, 'sonnet');
  assert.strictEqual(pickModel({ purpose: 'mail', text: 'あ'.repeat(700) }).model, 'sonnet');
});
