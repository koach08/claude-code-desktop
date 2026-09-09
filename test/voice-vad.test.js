const test = require('node:test');
const assert = require('node:assert');
const { createVad, createBarge, rmsOf, DEFAULTS } = require('../src/voice-vad');

// 音量の並びを流し込んで、どこで区切られたかを見る。1 フレーム 50ms とする。
function run(vad, frames, step = 50) {
  const events = [];
  let t = 0;
  for (const rms of frames) {
    const e = vad.feed(rms, t);
    if (e) events.push({ at: t, e });
    if (e === 'stop' || e === 'timeout') break;
    t += step;
  }
  return events;
}
const rep = (v, n) => Array(n).fill(v);

test('話して黙ったら、そこで区切る', () => {
  const vad = createVad();
  // 少し無音 → 1 秒話す → 1 秒黙る
  const ev = run(vad, [...rep(0.005, 4), ...rep(0.09, 20), ...rep(0.004, 24)]);
  assert.strictEqual(ev[0].e, 'speech');
  assert.strictEqual(ev[ev.length - 1].e, 'stop');
});

test('言葉の切れ目では切らない', () => {
  // ⚠️ 「えー、」のあと 0.4 秒空くのは普通。ここで切ると半分しか送られない
  const vad = createVad();
  const ev = run(vad, [
    ...rep(0.09, 10), ...rep(0.004, 8),   // 400ms の間
    ...rep(0.09, 10), ...rep(0.004, 24),  // 話し直して、最後に本当に黙る
  ]);
  const stops = ev.filter((x) => x.e === 'stop');
  assert.strictEqual(stops.length, 1);
  assert.ok(stops[0].at > 1400, `早すぎる区切り: ${stops[0].at}ms`);
});

test('咳や物音では録りはじめない', () => {
  const vad = createVad();
  const ev = run(vad, [0.2, ...rep(0.004, 40)]);   // 単発の大きな音
  assert.ok(!ev.some((x) => x.e === 'speech'), '物音で話し始めたことになっている');
});

test('何も話さなければ、待ちくたびれて自分から降りる', () => {
  const vad = createVad();
  const ev = run(vad, rep(0.003, 400));
  assert.strictEqual(ev[ev.length - 1].e, 'timeout');
  assert.ok(ev[ev.length - 1].at <= DEFAULTS.noSpeechMs + 100);
});

test('延々と話し続けても上限で切る', () => {
  const vad = createVad();
  const ev = run(vad, rep(0.09, 1000));
  const last = ev[ev.length - 1];
  assert.strictEqual(last.e, 'stop');
  assert.ok(last.at <= DEFAULTS.maxMs + 100);
});

test('割り込みは、はっきりした声が続いたときだけ', () => {
  const b = createBarge();
  // 読み上げの回り込みくらいの音量では割り込まない
  for (const v of rep(0.05, 20)) assert.strictEqual(b.feed(v), false);
  // はっきり話しかけたら割り込む
  b.reset();
  assert.strictEqual(b.feed(0.2), false);
  assert.strictEqual(b.feed(0.2), false);
  assert.strictEqual(b.feed(0.2), true);
});

test('音量の出し方', () => {
  assert.strictEqual(rmsOf([0, 0, 0]), 0);
  assert.ok(Math.abs(rmsOf([1, -1, 1, -1]) - 1) < 1e-9);
  assert.strictEqual(rmsOf([]), 0);
});
