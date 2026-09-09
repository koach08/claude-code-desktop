// 料金の勘定。⚠️ ここを間違えると、上限で切れずに使い続ける。
const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/realtime');

test('種類ごとの値段で円になる', () => {
  // 音声出力 100 万トークンで 64 ドル = 9,600 円
  assert.ok(Math.abs(R.costYen({ audioOut: 1e6 }) - 64 * R.YEN_PER_USD) < 0.01);
  assert.ok(Math.abs(R.costYen({ audioIn: 1e6 }) - 32 * R.YEN_PER_USD) < 0.01);
});

test('使い回しぶんは桁違いに安く数える', () => {
  // ⚠️ ここを普通の入力と同じ値段で数えると、実際の 80 倍に見える
  const normal = R.costYen({ audioIn: 100000 });
  const cached = R.costYen({ audioInCached: 100000 });
  assert.ok(cached < normal / 50, `使い回しが安く数えられていない: ${cached} vs ${normal}`);
});

test('空なら 0 円', () => {
  assert.strictEqual(R.costYen({}), 0);
  assert.strictEqual(R.costYen({ audioOut: 0, audioIn: 0 }), 0);
});

test('実測した往復ぶんが、現実的な額に収まる', () => {
  // 2026-09-10 に測った 4 往復 (道具 2 回) を、音声で返した場合に引き直したもの
  const yen = R.costYen({ audioIn: 300, audioInCached: 3000, audioOut: 700, textIn: 600, textOut: 500 });
  assert.ok(yen > 0.5 && yen < 20, `見込みから外れています: ${yen} 円`);
});

test('上限の既定は、うっかり使い切っても痛くない額', () => {
  assert.ok(R.DEFAULT_YEN_CAP <= 500);
});
