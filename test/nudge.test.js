const test = require('node:test');
const assert = require('node:assert');
const { shouldNudge, MIN_CHARS } = require('../src/nudge');
const { judgeEngine } = require('../src/engine-judge');

// 判定そのものは engine-judge.test.js が見ている。ここは「普段の入力欄に
// 口を出してよいか」だけを固定する。出しすぎると誰も読まなくなるので、
// 黙るべき場面のほうを厚く押さえておく。

test('別エンジン向きで確信が高ければ出す', () => {
  const j = judgeEngine('この関数をリファクタして影響範囲も調べて');
  assert.strictEqual(j.confidence, 'high');
  const d = shouldNudge(j, 'claude', 'この関数をリファクタして影響範囲も調べて');
  assert.strictEqual(d.show, true);
  assert.strictEqual(d.engine, 'codex');
});

test('いま開いているタブと同じエンジンなら黙る', () => {
  const j = judgeEngine('この関数をリファクタして影響範囲も調べて');
  const d = shouldNudge(j, 'codex', 'この関数をリファクタして影響範囲も調べて');
  assert.strictEqual(d.show, false);
  assert.strictEqual(d.why, 'same');
});

test('確信が high でなければ黙る', () => {
  const d = shouldNudge({ engine: 'gemini', label: 'Gemini', confidence: 'medium' },
    'claude', 'なんとなく速く作ってほしいのだけど');
  assert.strictEqual(d.show, false);
  assert.strictEqual(d.why, 'lowconf');
});

test('書きかけの短い入力では黙る', () => {
  const d = shouldNudge({ engine: 'codex', label: 'Codex', confidence: 'high' }, 'claude', 'バグ直');
  assert.strictEqual(d.show, false);
  assert.strictEqual(d.why, 'short');
});

test('判定が取れなければ黙る', () => {
  assert.strictEqual(shouldNudge(null, 'claude', '十分に長い文章を書いています').show, false);
});

test('ターミナル向きは自動送信しない(コマンドの暴発を防ぐ)', () => {
  const j = judgeEngine('git のブランチを整理してタグも打ち直して');
  const d = shouldNudge(j, 'claude', 'git のブランチを整理してタグも打ち直して');
  assert.strictEqual(d.show, true);
  assert.strictEqual(d.engine, 'shell');
  assert.strictEqual(d.autoSend, false);
});

test('エンジンへの受け渡しは自動送信する', () => {
  const j = judgeEngine('この関数をリファクタして影響範囲も調べて');
  assert.strictEqual(shouldNudge(j, 'claude', 'この関数をリファクタして影響範囲も調べて').autoSend, true);
});

test('MIN_CHARS の境目', () => {
  const j = { engine: 'codex', label: 'Codex', confidence: 'high' };
  const s = 'あ'.repeat(MIN_CHARS - 1);
  assert.strictEqual(shouldNudge(j, 'claude', s).show, false);
  assert.strictEqual(shouldNudge(j, 'claude', s + 'あ').show, true);
});

test('renderer は <script> で読むので UMD が window に生える', () => {
  const vm = require('node:vm');
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'nudge.js'), 'utf-8');
  const win = {};
  vm.createContext(win);
  vm.runInContext(src, win);
  assert.strictEqual(typeof win.AriyaNudge?.shouldNudge, 'function');
});
