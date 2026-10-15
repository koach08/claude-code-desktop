// 押さずに話すところの通し試験。時間を実際に進めて、区切られるまで見る。
//
// ⚠️ ここで見たいのは 3 つ:
//   黙ったら勝手に送られること / 返事のあと勝手にまた聞くこと /
//   やめたらマイクが確かに閉じること (開きっぱなしは盗聴に見える)
const test = require('node:test');
const assert = require('node:assert');

let mic = 0;                    // いまの音量。テストから動かす
let tracksStopped = 0;
let ctxClosed = 0;

function installFakes() {
  const def = (k, v) => Object.defineProperty(globalThis, k, {
    value: v, writable: true, configurable: true,
  });
  def('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() { tracksStopped += 1; } }] }),
    },
  });
  def('AudioContext', class {
    createAnalyser() {
      return {
        fftSize: 1024,
        getFloatTimeDomainData(buf) { for (let i = 0; i < buf.length; i += 1) buf[i] = mic; },
      };
    }
    createMediaStreamSource() { return { connect() {} }; }
    close() { ctxClosed += 1; }
  });
  def('MediaRecorder', class {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      if (this.state !== 'recording') return;
      this.state = 'inactive';
      if (this.ondataavailable) this.ondataavailable({ data: { size: 10 } });
      if (this.onstop) this.onstop();
    }
  });
  def('Blob', class { constructor(p) { this.p = p; } async arrayBuffer() { return new ArrayBuffer(8); } });
  def('URL', { createObjectURL: () => 'blob:x', revokeObjectURL() {} });
  def('Audio', class {
    constructor() { this.src = ''; }
    async play() { setTimeout(() => this.onended && this.onended(), 10); }
    pause() {}
  });
  def('speechSynthesis', undefined);
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

function make(over = {}) {
  const log = { heard: [], spoken: [], states: [] };
  const vc = VoiceChat.create({
    transcribe: async () => ({ text: log.next || 'こんばんは' }),
    tts: async (t) => { log.spoken.push(t); return { audio: new Uint8Array([1]), mime: 'audio/mpeg' }; },
    converse: async () => ({ ok: true, reply: 'はい、聞こえています。' }),
    sendToTab: async () => {},
    readTab: async () => '',
    listTabs: () => [{ id: 'a', name: 'AOZORA', cwd: '/x/aozora' }],
    getActiveId: () => 'a',
    onState: (s) => log.states.push(s),
    onTurn: () => {},
    onNotice: (n) => log.heard.push(n),
    loadHistory: () => null,
    saveHistory: () => {},
    ...over,
  });
  return { vc, log };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 音量を並べて流し込む。1 段 60ms。
async function utter(loudMs, quietMs) {
  mic = 0.12; await wait(loudMs);
  mic = 0.002; await wait(quietMs);
}

test('黙ったら、押さなくても送られる', async () => {
  const { vc, log } = make();
  assert.strictEqual(await vc.startLive(), true);
  assert.strictEqual(vc.state, 'recording');

  // ⚠️ 0.45 秒 (MIN_SPEECH_SEC) より短い声は捨てられ、静けさは 1.5 秒 (silenceMs) 要る。
  //    以前の 0.4 秒 / 1.2 秒は、息継ぎで切られる実測を受けて閾値を上げたあと合わなくなっていた
  await utter(700, 1800);          // 0.7 秒話して 1.8 秒黙る
  await wait(300);

  assert.ok(log.spoken.length >= 1, '返事が読み上げられていない');
  assert.match(log.spoken[0], /聞こえています/);
  vc.stopLive();
});

test('返事のあと、そのまま次を聞きに戻る', async () => {
  const { vc, log } = make();
  await vc.startLive();
  await utter(400, 1200);
  await wait(400);
  assert.strictEqual(vc.state, 'recording', '返事のあと聞く体勢に戻っていない');
  assert.strictEqual(vc.live, true);
  vc.stopLive();
});

test('やめたらマイクは確かに閉じる', async () => {
  const before = tracksStopped;
  const beforeCtx = ctxClosed;
  const { vc } = make();
  await vc.startLive();
  await wait(100);
  vc.stopLive();
  assert.ok(tracksStopped > before, 'マイクの回線が止まっていない');
  assert.ok(ctxClosed > beforeCtx, '音量の見張りが閉じていない');
  assert.strictEqual(vc.live, false);
  assert.strictEqual(vc.state, 'idle');
});

test('家事の合間に黙っても切らない (1 回の聞き取りの上限を過ぎても聞き続ける)', async () => {
  const { vc, log } = make();
  await vc.startLive();
  mic = 0.001;
  await wait(25400);
  assert.strictEqual(vc.live, true, '25 秒の沈黙で切れている (家事の合間に切れる)');
  assert.strictEqual(vc.state, 'recording');
  assert.ok(!log.heard.some((n) => n.includes('声が無かった')));
  vc.stopLive();
});

test('長く声が無ければ、自分から降りてマイクを閉じる', async () => {
  const awake = [];
  const { vc, log } = make({ liveIdleMaxMs: 1000, keepAwake: (on) => awake.push(on) });
  await vc.startLive();
  mic = 0.001;
  await wait(25400);
  assert.strictEqual(vc.live, false, '無言のまま聞き続けている');
  assert.ok(log.heard.some((n) => n.includes('声が無かった')));
  assert.deepStrictEqual(awake, [true, false], 'Mac を眠らせない設定が戻っていない');
});

test('声の相手を切り替えていなければ、本物の Alfred に聞く', async () => {
  const asked = [];
  const { vc, log } = make({
    askAlfred: async (text, context) => { asked.push({ text, context }); return { ok: true, spoken: 'かしこまりました。' }; },
    converse: async () => { throw new Error('Ariya 独自の頭に聞いている'); },
  });
  log.next = '明日の予定を教えて';
  await vc.startLive();
  await utter(700, 1800);
  await wait(300);
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].text, '明日の予定を教えて');
  assert.match(asked[0].context, /AOZORA/, 'タブの様子を Alfred に渡していない');
  assert.match(log.spoken[0], /かしこまりました/);
  vc.stopLive();
});

test('Alfred が渡す作業を返したら、名前を出して尋ね、「はい」で渡す (Enter は要らない)', async () => {
  const sent = [];
  const { vc, log } = make({
    askAlfred: async () => ({ ok: true, spoken: '承知しました。【渡す先】AOZORA\n【渡す】読み上げの速さを直してください【ここまで】' }),
    sendToTab: async (id, task) => sent.push({ id, task }),
  });
  log.next = 'さっきの声の件、どうしようか';
  await vc.startLive();
  await utter(700, 1800);
  await wait(400);
  assert.strictEqual(sent.length, 0, '尋ねる前に渡している');
  assert.match(log.spoken.join(' '), /よろしいですか/);
  log.next = 'はい';
  await utter(700, 1800);
  await wait(400);
  assert.deepStrictEqual(sent, [{ id: 'a', task: '読み上げの速さを直してください' }]);
  vc.stopLive();
});

test('Alfred の返事が遅いときは「少々お待ちください」と言ってから答える', async () => {
  const { vc, log } = make({
    askAlfred: async () => { await wait(2500); return { ok: true, spoken: '明日は 9 時から会議です。' }; },
  });
  log.next = '明日の朝は何があったかな';
  await vc.startLive();
  await utter(700, 1800);
  await wait(3200);
  assert.deepStrictEqual(log.spoken.slice(0, 2), ['少々お待ちください。', '明日は 9 時から会議です。']);
  vc.stopLive();
});
