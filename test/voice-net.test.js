// 声の通信。⚠️ 見たいのは「速い道を選び、駄目なら必ず落ちる」こと。
// 直の道が黙って死ぬと、声が止まったように見えて原因が分からなくなる。
const test = require('node:test');
const assert = require('node:assert');
const VN = require('../src/voice-net');

function fake(routes) {
  const calls = [];
  const f = async (url, opt) => {
    calls.push({ url, opt });
    for (const [frag, res] of routes) if (String(url).includes(frag)) return res();
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  f.calls = calls;
  return f;
}
const ok = (body) => () => ({ ok: true, json: async () => body, arrayBuffer: async () => new ArrayBuffer(4) });
const bad = (msg) => () => ({ ok: false, status: 500, text: async () => msg });

const HUB = 'https://example.invalid/api/hub';

test('鍵があれば文字起こしは直に行く', async () => {
  const f = fake([['api.openai.com', ok({ text: 'こんばんは' })]]);
  const net = VN.create({ fetchImpl: f, getKey: () => 'sk-test', hubUrl: HUB });
  const r = await net.transcribe(new Uint8Array([1, 2]), 'audio/webm');
  assert.strictEqual(r.text, 'こんばんは');
  assert.strictEqual(r.via, 'direct');
});

test('鍵が無ければ hub に落ちる', async () => {
  const f = fake([[HUB, ok({ text: 'hub から' })]]);
  const net = VN.create({ fetchImpl: f, getKey: () => '', hubUrl: HUB });
  const r = await net.transcribe(new Uint8Array([1]), 'audio/webm');
  assert.strictEqual(r.via, 'hub');
});

test('直が失敗しても黙って止まらず hub に落ちる', async () => {
  // ⚠️ ここが無いと、鍵の期限切れで声だけが無反応になる
  const f = fake([['api.openai.com', bad('expired')], [HUB, ok({ text: '拾えた' })]]);
  const net = VN.create({ fetchImpl: f, getKey: () => 'sk-old', hubUrl: HUB });
  const r = await net.transcribe(new Uint8Array([1]), 'audio/webm');
  assert.strictEqual(r.text, '拾えた');
  assert.strictEqual(r.via, 'hub');
});

test('返事は Claude に直で行き、本文だけ取り出す', async () => {
  const f = fake([['api.anthropic.com', ok({ content: [{ type: 'text', text: '2つ開いています。' }] })]]);
  const net = VN.create({ fetchImpl: f, getKey: () => 'sk-ant', hubUrl: HUB });
  const r = await net.reply([{ role: 'user', content: 'タブは' }]);
  assert.strictEqual(r.reply, '2つ開いています。');
  assert.strictEqual(r.via, 'direct');
});

test('声の既定は速いモデル（重いと会話が途切れる）', async () => {
  let sent = null;
  const f = fake([['api.anthropic.com', () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'はい' }] }) })]]);
  const wrapped = async (u, o) => { if (String(u).includes('anthropic')) sent = JSON.parse(o.body); return f(u, o); };
  const net = VN.create({ fetchImpl: wrapped, getKey: () => 'sk', hubUrl: HUB });
  await net.reply([{ role: 'user', content: 'やあ' }]);
  assert.strictEqual(sent.model, VN.DEFAULT_VOICE_ENGINE.model);
  assert.match(sent.model, /haiku/);
});

test('直で叩けないエンジンは hub が引き受ける', async () => {
  const f = fake([[HUB, ok({ ok: true, reply: 'gemini の返事' })]]);
  const net = VN.create({ fetchImpl: f, getKey: () => 'sk', hubUrl: HUB });
  const r = await net.reply([{ role: 'user', content: 'やあ' }], { provider: 'gemini' });
  assert.strictEqual(r.via, 'hub');
  assert.strictEqual(r.reply, 'gemini の返事');
});

test('材料は毎回 system に足される', async () => {
  let sent = null;
  const f = async (u, o) => {
    sent = JSON.parse(o.body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'はい' }] }) };
  };
  const net = VN.create({ fetchImpl: f, getKey: () => 'sk', hubUrl: HUB });
  await net.reply([{ role: 'user', content: 'どうなってる' }], { context: 'ビルド中' });
  assert.match(sent.system, /ビルド中/);
});

test('読み上げは音の中身を返す。鍵が無ければそう言う', async () => {
  const f = fake([['audio/speech', ok({})]]);
  const net = VN.create({ fetchImpl: f, getKey: () => 'sk', hubUrl: HUB });
  const r = await net.tts('こんばんは');
  assert.strictEqual(r.mime, 'audio/mpeg');
  assert.ok(r.audio instanceof Uint8Array);

  const net2 = VN.create({ fetchImpl: f, getKey: () => '', hubUrl: HUB });
  assert.strictEqual((await net2.tts('やあ')).error, 'no-key');
});

test('ElevenLabs の鍵があれば読み上げはそちらが一番手', async () => {
  const f = fake([
    ['api.elevenlabs.io', () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })],
    ['audio/speech', ok({})],
  ]);
  const keys = { ELEVENLABS_API_KEY: 'xi-test', ELEVENLABS_VOICE_ID: 'voice123', OPENAI_API_KEY: 'sk' };
  const net = VN.create({ fetchImpl: f, getKey: (n) => keys[n] || '', hubUrl: HUB });
  const r = await net.tts('こんばんは');
  assert.strictEqual(r.via, 'elevenlabs');
  assert.strictEqual(r.mime, 'audio/mpeg');
  assert.strictEqual(r.audio.length, 3);
  // 鍵はヘッダで渡す。声は指定した ID、日本語だと明示、会話向けモデル
  const c = f.calls.find((x) => String(x.url).includes('api.elevenlabs.io'));
  assert.match(c.url, /text-to-speech\/voice123\?output_format=mp3/);
  assert.strictEqual(c.opt.headers['xi-api-key'], 'xi-test');
  const body = JSON.parse(c.opt.body);
  assert.strictEqual(body.language_code, 'ja');
  assert.strictEqual(body.model_id, VN.ELEVEN_MODEL);
  // OpenAI は叩いていない
  assert.ok(!f.calls.some((x) => String(x.url).includes('audio/speech')));
});

test('ElevenLabs が落ちたら OpenAI に落ちる。声が止まらない', async () => {
  const f = fake([
    ['api.elevenlabs.io', () => ({ ok: false, status: 401, text: async () => 'bad key' })],
    ['audio/speech', ok({})],
  ]);
  const keys = { ELEVENLABS_API_KEY: 'xi-bad', OPENAI_API_KEY: 'sk' };
  const net = VN.create({ fetchImpl: f, getKey: (n) => keys[n] || '', hubUrl: HUB });
  const r = await net.tts('こんばんは');
  assert.strictEqual(r.via, 'openai');
  assert.ok(r.audio instanceof Uint8Array);
});

test('ElevenLabs の鍵が空なら今までどおり OpenAI。声の ID 未指定なら既定の声', async () => {
  const f = fake([
    ['api.elevenlabs.io', () => ({ ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer })],
    ['audio/speech', ok({})],
  ]);
  const net = VN.create({ fetchImpl: f, getKey: (n) => (n === 'OPENAI_API_KEY' ? 'sk' : ''), hubUrl: HUB });
  const r = await net.tts('やあ');
  assert.strictEqual(r.via, 'openai');
  assert.ok(!f.calls.some((x) => String(x.url).includes('api.elevenlabs.io')));

  const net2 = VN.create({ fetchImpl: f, getKey: (n) => (n === 'ELEVENLABS_API_KEY' ? 'xi' : ''), hubUrl: HUB });
  const r2 = await net2.tts('やあ');
  assert.strictEqual(r2.via, 'elevenlabs');
  const c = f.calls.find((x) => String(x.url).includes('api.elevenlabs.io'));
  assert.ok(c.url.includes(VN.ELEVEN_DEFAULT_VOICE_ID));
});

test('口調の指示は hub 側と同じ文言を使う', () => {
  // ⚠️ 片方だけ直すと、直と hub で口調が変わる
  assert.match(VN.VOICE_SYSTEM, /3 文まで/);
  assert.match(VN.VOICE_SYSTEM, /です・ます調/);
});

test('送るファイル名は中身に合わせる', () => {
  // ⚠️ webm 固定にしていたら m4a を弾かれた (実測)。録音の形式は環境で変わる
  assert.strictEqual(VN.nameFor('audio/webm;codecs=opus'), 'audio.webm');
  assert.strictEqual(VN.nameFor('audio/mp4'), 'audio.m4a');
  assert.strictEqual(VN.nameFor('audio/ogg'), 'audio.ogg');
  assert.strictEqual(VN.nameFor(''), 'audio.webm');
});

test('道具を渡すと Claude に tools として届き、呼び出しが calls で返る', async () => {
  const f = fake([['api.anthropic.com', ok({ content: [
    { type: 'text', text: '見てみます。' },
    { type: 'tool_use', id: 'tu1', name: 'list_tabs', input: {} },
  ] })]]);
  const net = VN.create({ fetchImpl: f, getKey: () => 'sk-ant', hubUrl: HUB });
  const tools = [{ type: 'function', name: 'list_tabs', description: '一覧', parameters: { type: 'object', properties: {} } }];
  const r = await net.reply([{ role: 'user', content: '何が開いてる' }], { tools });
  const body = JSON.parse(f.calls[0].opt.body);
  assert.strictEqual(body.tools[0].name, 'list_tabs');
  assert.ok(body.tools[0].input_schema, 'Claude の形 (input_schema) になっていない');
  assert.match(body.system, /道具の使い方/);
  assert.strictEqual(r.calls[0].id, 'tu1');
  assert.strictEqual(r.reply, '見てみます。');
});

test('道具の結果 (steps) は tool_result として会話に足される', async () => {
  const f = fake([['api.anthropic.com', ok({ content: [{ type: 'text', text: '2 個です。' }] })]]);
  const net = VN.create({ fetchImpl: f, getKey: () => 'sk-ant', hubUrl: HUB });
  const tools = [{ type: 'function', name: 'list_tabs', description: '一覧', parameters: { type: 'object', properties: {} } }];
  const steps = [{ assistant: [{ type: 'tool_use', id: 'tu1', name: 'list_tabs', input: {} }], results: [{ id: 'tu1', output: { tabs: [] } }] }];
  await net.reply([{ role: 'user', content: '何が開いてる' }], { tools, steps });
  const body = JSON.parse(f.calls[0].opt.body);
  assert.strictEqual(body.messages.length, 3);
  assert.strictEqual(body.messages[1].role, 'assistant');
  assert.strictEqual(body.messages[2].content[0].type, 'tool_result');
  assert.strictEqual(body.messages[2].content[0].tool_use_id, 'tu1');
});

test('道具が無いときの指示は「どのタブか」を聞き返さず、【渡す】で返すよう書いてある', () => {
  assert.match(VN.HANDOFF_GUIDE, /どのタブですか」とは聞き返さない/);
  assert.match(VN.HANDOFF_GUIDE, /【渡す】/);
  assert.match(VN.TOOL_GUIDE, /current が true/);
  assert.ok(!/どのタブに渡すか聞き返して/.test(VN.VOICE_SYSTEM));
});

// 2026-09-24: Alfred と同じ読みの辞書を当てる。⚠️ 語はテスト用の架空のもの(公開リポジトリ)
test('読みの辞書は長い語から当てる', () => {
  const VN2 = require('../src/voice-net');
  const got = VN2.applyYomi('あいう大学とあいう', { 'あいう大学': 'えおだいがく', 'あいう': 'かき' });
  assert.strictEqual(got, 'えおだいがくとかき');
  assert.strictEqual(VN2.applyYomi('そのまま', {}), 'そのまま');
});
