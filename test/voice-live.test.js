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

  await utter(400, 1200);          // 0.4 秒話して 1.2 秒黙る
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

test('何も話さなければ、自分から降りる', async () => {
  const { vc, log } = make();
  // 待つ上限を短くして試す
  await vc.startLive();
  mic = 0.001;
  await wait(9400);
  assert.strictEqual(vc.live, false, '無言のまま聞き続けている');
  assert.ok(log.heard.some((n) => n.includes('声が無かった')));
});
