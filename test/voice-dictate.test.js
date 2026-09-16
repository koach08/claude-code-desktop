// 🎤 の書き取りが「黙った所で区切って、順番どおりに文字が出る」ことを確かめる。
// ブラウザは無いので、マイク・録音機・音量計を偽物で置く。
const test = require('node:test');
const assert = require('node:assert');
const VD = require('../src/voice-vad');
const D = require('../src/voice-dictate');

// 偽の部品。音量は rmsNow() で外から操る
function fakes() {
  let rms = 0;
  let clock = 0;
  const tickers = [];
  const stopped = [];
  class Recorder {
    constructor(_s, opts) { this.mimeType = opts.mimeType; this.state = 'inactive'; this.id = Recorder.n++; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      // 実物と同じく、止めたあとに音の塊が届き、その後 onstop
      this.ondataavailable({ data: { size: 1, id: this.id } });
      stopped.push(this.id);
      this.onstop();
    }
    static isTypeSupported() { return true; }
  }
  Recorder.n = 0;
  class Ctx {
    createAnalyser() {
      return { fftSize: 0, getFloatTimeDomainData(buf) { buf.fill(rms); } };
    }
    createMediaStreamSource() { return { connect() {} }; }
    close() {}
  }
  const stream = { tracks: [{ stopped: false, stop() { this.stopped = true; } }], getTracks() { return this.tracks; } };
  return {
    stream, stopped,
    setRms(v) { rms = v; },
    advance(ms) {
      // 50ms ずつ時計を進めて、ティッカーを回す
      for (let t = 0; t < ms; t += D.TICK_MS) { clock += D.TICK_MS; tickers.forEach((f) => f()); }
    },
    deps: {
      getUserMedia: async () => stream,
      MediaRecorder: Recorder,
      AudioContext: Ctx,
      setInterval: (f) => { tickers.push(f); return 1; },
      clearInterval: () => { tickers.length = 0; },
      now: () => clock,
    },
  };
}

// Blob と arrayBuffer の代わり (node には Blob があるが id を運びたいので薄く包む)
function withBlob(fn) {
  const orig = globalThis.Blob;
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } async arrayBuffer() { return new Uint8Array([this.parts[0].id]).buffer; } };
  return fn().finally(() => { globalThis.Blob = orig; });
}

test('黙った所で区切り、⏹ を待たずに文字が出る', () => withBlob(async () => {
  const f = fakes();
  const out = [];
  const states = [];
  const d = D.create({
    ...f.deps,
    transcribe: async (bytes) => ({ text: `seg${bytes[0]}` }),
    onText: (t) => out.push(t),
    onState: (s) => states.push(s),
  });
  assert.strictEqual(await d.start(), true);
  // 話す 2 秒 → 黙る 1.2 秒 → 区切られる
  f.setRms(0.1); f.advance(2000);
  f.setRms(0); f.advance(D.SEGMENT.silenceMs + 200);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(out, ['seg0'], '⏹ を押す前に最初の切れ端が文字になる');
  assert.ok(d.running, 'まだ録っている');
  // 2 つ目
  f.setRms(0.1); f.advance(1500);
  f.setRms(0); f.advance(D.SEGMENT.silenceMs + 200);
  await d.stop();
  assert.deepStrictEqual(out, ['seg0', 'seg1']);
  assert.ok(f.stream.tracks[0].stopped, 'マイクを閉じた');
  assert.strictEqual(states.at(-1), 'idle');
}));

test('順番が入れ替わらない (後の切れ端が先に返っても)', () => withBlob(async () => {
  const f = fakes();
  const out = [];
  const delays = { 0: 80, 1: 5 };   // 最初の切れ端の聞き取りが遅い
  const d = D.create({
    ...f.deps,
    transcribe: async (bytes) => {
      await new Promise((r) => setTimeout(r, delays[bytes[0]] || 1));
      return { text: `seg${bytes[0]}` };
    },
    onText: (t) => out.push(t),
  });
  await d.start();
  f.setRms(0.1); f.advance(1000); f.setRms(0); f.advance(D.SEGMENT.silenceMs + 200);
  f.setRms(0.1); f.advance(1000); f.setRms(0); f.advance(D.SEGMENT.silenceMs + 200);
  await d.stop();
  assert.deepStrictEqual(out, ['seg0', 'seg1']);
}));

test('声の無い切れ端と定型文は送らない・足さない', () => withBlob(async () => {
  const f = fakes();
  const out = [];
  let calls = 0;
  const d = D.create({
    ...f.deps,
    transcribe: async () => { calls += 1; return { text: 'ご視聴ありがとうございました' }; },
    onText: (t) => out.push(t),
  });
  await d.start();
  // 何も話さず ⏹
  f.setRms(0); f.advance(800);
  await d.stop();
  assert.strictEqual(calls, 0, '無音は送らない');
  // 話したが定型が返った
  const d2 = D.create({ ...f.deps, transcribe: async () => { calls += 1; return { text: 'ご視聴ありがとうございました' }; }, onText: (t) => out.push(t) });
  await d2.start();
  f.setRms(0.1); f.advance(1500); f.setRms(0);
  await d2.stop();
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(out, [], '定型文は足さない');
}));

test('一息が長くても maxMs で一度文字にする', () => withBlob(async () => {
  const f = fakes();
  const out = [];
  const d = D.create({ ...f.deps, transcribe: async (b) => ({ text: `seg${b[0]}` }), onText: (t) => out.push(t) });
  await d.start();
  f.setRms(0.1); f.advance(D.SEGMENT.maxMs + 1000);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(out, ['seg0'], '黙っていなくても途中で一度出る');
  await d.stop();
  assert.strictEqual(out.length, 2, '残りは ⏹ で出る');
}));

test('音量計が無い環境では前と同じく ⏹ で丸ごと', () => withBlob(async () => {
  const f = fakes();
  const out = [];
  const d = D.create({ ...f.deps, AudioContext: undefined, transcribe: async (b) => ({ text: `seg${b[0]}` }), onText: (t) => out.push(t) });
  await d.start();
  await d.stop();
  assert.deepStrictEqual(out, ['seg0']);
}));

test('区切りの数値は会話より短く、上限は保つ', () => {
  assert.ok(D.SEGMENT.silenceMs < VD.DEFAULTS.silenceMs);
  assert.ok(D.SEGMENT.silenceMs >= 900, '短すぎると単語の途中で切れる');
});
