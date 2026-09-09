// 声でアプリそのものを動かすところの通し試験。
// ひと回りが通ることは voice-chat.test.js が見ている。ここで見るのは操作の側:
//   確認を通るまで端末に何も入らない / 別の話をしたら前の依頼は消える /
//   声で選んだエンジンに会話が行く / 一覧は外に聞かずに答える
//
// ⚠️ ここが破れると、関係ないタブの作業の途中に文字が割り込む。
const test = require('node:test');
const assert = require('node:assert');

// ── ブラウザの偽物 ────────────────────────────────────────────
let heard = '';                       // マイクが拾ったことにする文字
function installFakes() {
  const def = (k, v) => Object.defineProperty(globalThis, k, {
    value: v, writable: true, configurable: true,
  });
  def('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
  def('MediaRecorder', class {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: { size: 1 } }); this.onstop(); }
  });
  def('Blob', class { constructor() {} async arrayBuffer() { return new ArrayBuffer(1); } });
  def('speechSynthesis', undefined);  // 読み上げは走らせない (無くても finish は進む)
}
installFakes();

const VoiceChat = require('../src/voice-chat');


// ⚠️ 読みの表は既定で空 (公開リポジトリに案件名を置かないため)。
//    カタカナで名指しする試験は、自分で入れてから始める。
require('../src/voice-command').setAliases([
  ['あおぞら', 'aozora'], ['みどり', 'midori'], ['こはく', 'kohaku'],
  ['みどりおーえす', 'midorios'],
  ['ありや', 'ariya'], ['ありあ', 'ariya'],
]);

const TABS = [
  { id: 'a', name: 'AOZORA', cwd: '/x/aozora-ai', exited: false },
  { id: 'b', name: 'Ariya Bridge', cwd: '/x/ariya-bridge', exited: false },
];

function make(over = {}) {
  const log = { sent: [], closed: [], opened: [], switched: [], said: [], engine: null };
  const vc = VoiceChat.create({
    transcribe: async () => ({ text: heard }),
    converse: async (msgs, ctx, engine) => {
      log.engine = engine;
      return { ok: true, reply: '会話の返事です。' };
    },
    sendToTab: async (id, text) => { log.sent.push({ id, text }); },
    readTab: async () => 'いちばん下の行\nそのつぎ',
    listTabs: () => TABS,
    openTab: async (mode) => { log.opened.push(mode); return { id: 'c', name: mode }; },
    closeTab: async (id) => { log.closed.push(id); },
    switchTab: (id) => { log.switched.push(id); },
    getActiveId: () => 'b',
    onEngine: (e) => { log.engineSet = e; },
    loadEngine: () => null,
    saveEngine: () => {},
    onState: () => {},
    onTurn: (t) => { if (t.role === 'assistant') log.said.push(t.content); },
    onNotice: (n) => { log.said.push(`[notice] ${n}`); },
    loadHistory: () => null,
    saveHistory: () => {},
    ...over,
  });
  return { vc, log };
}

// ひと言しゃべらせる
async function say(vc, text) {
  heard = text;
  await vc.press();          // 録りはじめ
  await vc.press();          // 止める → finish が走る
  // finish は onstop から非同期で入るので、マイクロタスクを流す
  await new Promise((r) => setTimeout(r, 5));
}

test('会話はそのまま会話として返る（端末には何も入らない）', async () => {
  const { vc, log } = make();
  await say(vc, '今日はよく寝られた');
  assert.strictEqual(log.sent.length, 0);
  assert.ok(log.said.some((s) => s.includes('会話の返事')));
});

test('作業依頼は確認を挟み、はいと言うまで端末に入らない', async () => {
  const { vc, log } = make();
  await say(vc, 'アオゾラのタブでテストして');
  assert.strictEqual(log.sent.length, 0, '確認前に送ってはいけない');
  assert.ok(log.said.some((s) => s.includes('AOZORA') && s.includes('よろしいですか')));

  await say(vc, 'はい');
  assert.strictEqual(log.sent.length, 1);
  assert.strictEqual(log.sent[0].id, 'a');
  assert.match(log.sent[0].text, /テストして/);
});

test('いいえと言えば何も起きない', async () => {
  const { vc, log } = make();
  await say(vc, 'アオゾラのタブでビルドして');
  await say(vc, 'やっぱりやめて');
  assert.strictEqual(log.sent.length, 0);
});

test('確認の途中で別の話をしたら、前の依頼は実行されない', async () => {
  // ⚠️ ここが破れると、関係ない一言で前の作業が走る
  const { vc, log } = make();
  await say(vc, 'アオゾラのタブでデプロイして');
  await say(vc, '今日はよく寝られた');
  assert.strictEqual(log.sent.length, 0);
  await say(vc, 'はい');
  assert.strictEqual(log.sent.length, 0, '捨てたはずの依頼が後から走った');
});

test('タブを閉じるのも確認を通る', async () => {
  const { vc, log } = make();
  await say(vc, 'アオゾラのタブを閉じて');
  assert.strictEqual(log.closed.length, 0);
  await say(vc, 'はい');
  assert.deepStrictEqual(log.closed, ['a']);
});

test('タブを開く・切り替えるは確認なしで通す（取り返しがつく）', async () => {
  const { vc, log } = make();
  await say(vc, 'Codex のタブを開いて');
  assert.deepStrictEqual(log.opened, ['codex']);
  await say(vc, 'アオゾラのタブに切り替えて');
  assert.deepStrictEqual(log.switched, ['a']);
});

test('エンジンを声で切り替えると、以後の会話がそのエンジンに行く', async () => {
  const { vc, log } = make();
  await say(vc, 'アストラでお願い');
  assert.strictEqual(vc.engine.provider, 'openai');
  assert.strictEqual(vc.engine.model, 'gpt-6-astra');

  await say(vc, '今日はよく寝られた');
  assert.strictEqual(log.engine.model, 'gpt-6-astra', '会話が指定のエンジンに渡っていない');
});

test('渡し先が決まらない作業依頼は、聞き返して止まる', async () => {
  const { vc, log } = make();
  await say(vc, 'テストして');
  assert.strictEqual(log.sent.length, 0);
  assert.ok(log.said.some((s) => s.includes('タブ')));
});

test('タブの一覧は外に聞かずに答える', async () => {
  const { vc, log } = make({ converse: async () => { throw new Error('会話 API を呼んではいけない'); } });
  await say(vc, 'いま何のタブが開いてる');
  assert.ok(log.said.some((s) => s.includes('AOZORA')));
});
