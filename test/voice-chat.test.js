// 音声の往復が、ひと回り通ることと、事故を起こさないことを見る。
//
// ブラウザの API は偽物を置いて、node の中で最後まで回す。
// ここで固定するのは:
//   ひと回り動く / 読み上げ中に録らない / 二重に送らない / 誤送信しない /
//   履歴が保存され読み戻せる / 渡した作業の進捗が材料として渡る

const test = require('node:test');
const assert = require('node:assert');


// ⚠️ 読みの表は既定で空 (公開リポジトリに案件名を置かないため)。
//    カタカナで名指しする試験は、自分で入れてから始める。
require('../src/voice-command').setAliases([
  ['あおぞら', 'aozora'], ['みどり', 'midori'], ['こはく', 'kohaku'],
  ['みどりおーえす', 'midorios'],
  ['ありや', 'ariya'], ['ありあ', 'ariya'],
]);

// ── ブラウザの偽物 ────────────────────────────────────────────
function makeFakes() {
  const spoken = [];
  let cancelled = 0;
  const g = globalThis;

  g.speechSynthesis = {
    cancel() { cancelled++; },
    getVoices() { return [{ lang: 'ja-JP', name: 'Kyoko' }]; },
    speak(u) { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 1); },
  };
  g.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  g.Blob = class { constructor(parts) { this.parts = parts; }
    async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } };

  const rec = {
    state: 'inactive', mimeType: 'audio/webm',
    start() { this.state = 'recording'; },
    stop() { this.state = 'inactive'; this.onstop && this.onstop(); },
  };
  g.MediaRecorder = function () { return rec; };
  g.MediaRecorder.isTypeSupported = () => true;

  // ⚠️ node には navigator が読み取り専用で既にある。素の代入だと入らない
  //    (これで最初 7 件が落ちた)。defineProperty で置き換える。
  let micReleased = 0;
  Object.defineProperty(g, 'navigator', {
    configurable: true,
    writable: true,
    value: { mediaDevices: { getUserMedia: async () => ({
      getTracks: () => [{ stop() { micReleased++; } }],
    }) } },
  });

  return { spoken, rec, get cancelled() { return cancelled; },
           get micReleased() { return micReleased; } };
}

function makeChat(over = {}) {
  const VC = require('../src/voice-chat');
  const saved = { value: null };
  const states = [];
  const notices = [];
  const turns = [];
  const sent = [];
  const tabs = [{ id: 'tab1', name: 'kohaku', cwd: '/work/kohaku' }];

  const chat = VC.create({
    transcribe: over.transcribe || (async () => ({ text: 'テストの文です' })),
    converse: over.converse || (async () => ({ ok: true, reply: 'はい、分かりました。' })),
    sendToTab: async (id, text) => { sent.push({ id, text }); },
    readTab: over.readTab || (async () => 'ビルド中\nテスト実行中\n完了'),
    listTabs: () => tabs,
    onState: (s) => states.push(s),
    onTurn: (t) => turns.push(t),
    onNotice: (n) => notices.push(n),
    loadHistory: () => saved.value,
    saveHistory: (h) => { saved.value = JSON.parse(JSON.stringify(h)); },
  });
  return { chat, saved, states, notices, turns, sent, tabs };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test('ひと回り: 押す → 録る → 文字 → 返事 → 読み上げ → 待機', async () => {
  const f = makeFakes();
  const { chat, states, turns } = makeChat();

  await chat.press();
  assert.equal(chat.state, 'recording');

  await chat.press();          // 止める → 以降は自動で進む
  await settle();

  assert.equal(chat.state, 'idle', `終わりが idle でない: ${chat.state}`);
  assert.deepEqual(states, ['recording', 'transcribing', 'thinking', 'speaking', 'idle']);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant']);
  assert.deepEqual(f.spoken, ['はい、分かりました。']);
  assert.ok(f.micReleased >= 1, 'マイクが解放されていない');
});

test('読み上げ中に押すと、読み上げを止めて録りはじめる', async () => {
  const f = makeFakes();
  // 読み上げが終わらないようにして、speaking の間に押す
  globalThis.speechSynthesis.speak = (u) => { f.spoken.push(u.text); };
  const { chat } = makeChat();

  await chat.press();
  await chat.press();
  await settle();
  assert.equal(chat.state, 'speaking');

  const before = f.cancelled;
  await chat.press();
  await settle();
  assert.ok(f.cancelled > before, '読み上げが止まっていない');
  assert.equal(chat.state, 'recording');
});

test('文字にしている間に押しても、録音は始まらない', async () => {
  makeFakes();
  let release;
  const { chat, notices } = makeChat({
    transcribe: () => new Promise((r) => { release = () => r({ text: 'あ' }); }),
  });
  await chat.press();
  await chat.press();
  await settle();
  assert.equal(chat.state, 'transcribing');

  await chat.press();
  assert.equal(chat.state, 'transcribing', '状態が動いてしまった');
  assert.ok(notices.some((n) => /待って/.test(n)));
  release();
  await settle();
});

test('同じ文が続けて来たら送らない（二重送信よけ）', async () => {
  makeFakes();
  let calls = 0;
  const { chat, notices } = makeChat({
    converse: async () => { calls++; return { ok: true, reply: 'はい。' }; },
  });
  await chat.press(); await chat.press(); await settle();
  assert.equal(calls, 1);

  await chat.press(); await chat.press(); await settle();
  assert.equal(calls, 1, '同じ文で 2 回送ってしまった');
  assert.ok(notices.some((n) => /同じ依頼/.test(n)));
});

test('聞き取れなかったら送らない', async () => {
  makeFakes();
  let calls = 0;
  const { chat, notices } = makeChat({
    transcribe: async () => ({ text: '' }),
    converse: async () => { calls++; return { ok: true, reply: 'x' }; },
  });
  await chat.press(); await chat.press(); await settle();
  assert.equal(calls, 0);
  assert.equal(chat.state, 'idle');
  assert.ok(notices.some((n) => /聞き取れません/.test(n)));
});

test('履歴が保存され、読み戻せる', async () => {
  makeFakes();
  const { chat, saved } = makeChat();
  await chat.press(); await chat.press(); await settle();
  assert.equal(saved.value.length, 2);

  // 別の回として作り直し、同じ保存先から読む
  const VC = require('../src/voice-chat');
  const seen = [];
  const chat2 = VC.create({
    transcribe: async () => ({ text: '' }), converse: async () => ({}),
    sendToTab: async () => {}, readTab: async () => '', listTabs: () => [],
    onState: () => {}, onTurn: (t) => seen.push(t), onNotice: () => {},
    loadHistory: () => saved.value, saveHistory: () => {},
  });
  assert.equal(chat2.restore(), 2);
  assert.equal(seen.length, 2, '読み戻した往復が画面に出ていない');
  assert.equal(seen[0].role, 'user');
});

test('渡し先が無い・違うタブには渡さない', async () => {
  makeFakes();
  const { chat, sent, notices } = makeChat();
  const bad = await chat.handOff('存在しない', 'テストして');
  assert.equal(bad.ok, false);
  assert.equal(sent.length, 0, '無いタブに送ってしまった');
  assert.ok(notices.some((n) => /渡せませんでした/.test(n)));

  const moved = await chat.handOff('tab1', 'テストして', '/選んだときの場所');
  assert.equal(moved.ok, false, '場所が変わったのに渡してしまった');
  assert.equal(sent.length, 0);
});

test('正しいタブには渡せて、進捗が読める', async () => {
  makeFakes();
  const { chat, sent } = makeChat();
  const r = await chat.handOff('tab1', 'テストを走らせて', '/work/kohaku');
  assert.equal(r.ok, true);
  assert.deepEqual(sent, [{ id: 'tab1', text: 'テストを走らせて' }]);
  assert.match(await chat.progress(), /完了/);
});

test('渡した作業の進捗が、次の返事の材料になる', async () => {
  makeFakes();
  let gotContext = '';
  const { chat } = makeChat({
    converse: async (_msgs, ctx) => { gotContext = ctx || ''; return { ok: true, reply: 'はい。' }; },
  });
  await chat.handOff('tab1', 'ビルドして', '/work/kohaku');
  await chat.press(); await chat.press(); await settle();
  assert.match(gotContext, /ビルドして/);
  assert.match(gotContext, /完了/);
});

test('渡していないときは進捗を作らない', async () => {
  makeFakes();
  const { chat } = makeChat();
  assert.match(await chat.progress(), /ありません/);
});
