const test = require('node:test');
const assert = require('node:assert');
const { OLLAMA_URL, localModels, buildRequest, localChat } = require('../src/local-ai');

function streamRes(lines, status = 200) {
  const enc = new TextEncoder();
  const chunks = lines.map((l) => enc.encode(l));
  let i = 0;
  return {
    ok: status < 400,
    status,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }) },
  };
}

test('送り先はこの Mac の中に固定', () => {
  assert.strictEqual(OLLAMA_URL, 'http://127.0.0.1:11434');
});

test('モデルの一覧を読む', async () => {
  const r = await localModels({ fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'a:1' }, { name: 'b:2' }] }) }) });
  assert.deepStrictEqual(r, { available: true, running: true, models: ['a:1', 'b:2'] });
});

test('外で動くクラウドモデルは「この Mac」に出さない', async () => {
  const r = await localModels({ fetchImpl: async () => ({ ok: true, json: async () => ({ models: [
    { name: 'local:4b' }, { name: 'big:cloud' }, { name: 'big:70b-cloud' }, { name: 'other:1', remote_host: 'https://ollama.com' },
  ] }) }) });
  assert.deepStrictEqual(r.models, ['local:4b']);
});

test('動いていなくても落ちない。モデルが無ければ使えない扱い', async () => {
  const off = await localModels({ fetchImpl: async () => { throw new Error('refused'); } });
  assert.strictEqual(off.available, false);
  assert.strictEqual(off.running, false);
  const empty = await localModels({ fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }) });
  assert.strictEqual(empty.available, false);
  assert.strictEqual(empty.running, true);
});

test('system は先頭、画像は最後の本人の発言にだけ付く', () => {
  const r = buildRequest({
    model: 'm',
    system: 'S',
    images: ['B64'],
    messages: [{ role: 'user', content: '1' }, { role: 'assistant', content: '2' }, { role: 'user', content: '3' }],
  });
  assert.strictEqual(r.messages[0].role, 'system');
  assert.strictEqual(r.messages[1].images, undefined);
  assert.deepStrictEqual(r.messages[3].images, ['B64']);
  assert.strictEqual(r.stream, true);
});

test('分割されて届いた行をつないで読む', async () => {
  const got = [];
  await localChat({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    onChunk: (c) => got.push(c),
    fetchImpl: async (url) => {
      assert.strictEqual(url, 'http://127.0.0.1:11434/api/chat');
      return streamRes(['{"message":{"content":"こん"}}\n{"mess', 'age":{"content":"にちは"}}\n', '{"done":true}']);
    },
  });
  assert.strictEqual(got.join(''), 'こんにちは');
});

test('動いていないとき・モデルが無いときは分かる言葉で失敗する', async () => {
  await assert.rejects(localChat({ model: 'm', messages: [], onChunk() {}, fetchImpl: async () => { throw new Error('refused'); } }), /動いていません/);
  await assert.rejects(localChat({ model: '', messages: [], onChunk() {}, fetchImpl: async () => streamRes([]) }), /モデル/);
  await assert.rejects(localChat({ model: 'm', messages: [], onChunk() {}, fetchImpl: async () => streamRes(['{"error":"boom"}\n']) }), /boom/);
});
