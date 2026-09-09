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
