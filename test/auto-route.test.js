// 自動振り分け(2026-09-23)の回帰テスト。
//
// なぜ要るか: 示唆を出すだけでは押されず、結果として全部 Claude Code のまま走って
// トークンが尽きかけた(本人 9/23)。Enter の時点で自動で回すようにしたが、
// 「回してよい/いけない」の線引きを静かに壊すと、書いた指示が知らない場所へ飛ぶ。
//   実行: npm test
const test = require('node:test');
const assert = require('node:assert');
const { judgeEngine, judgeEffort, EFFORT_MODELS } = require('../src/engine-judge');
const { shouldAutoRoute, NO_AUTO } = require('../src/nudge');

test('エフォート: 短く言われても本番の仕事を軽めに落とさない', () => {
  // ⚠️ 実測でここを踏んだ。長さだけで判定すると下の2つが「軽め」になった
  assert.notStrictEqual(judgeEffort('note の記事を1本書いて'), 'light');
  assert.notStrictEqual(judgeEffort('EGAKUの生成が落ちる'), 'light');
  assert.notStrictEqual(judgeEffort('セキュリティを直して'), 'light');
});

test('エフォート: 見るだけ・一箇所は軽め', () => {
  assert.strictEqual(judgeEffort('このタイポ直しといて'), 'light');
  assert.strictEqual(judgeEffort('いま何件たまってる？'), 'light');
});

test('エフォート: 設計・原因不明・申請書はじっくり', () => {
  assert.strictEqual(judgeEffort('なぜ本番で落ちるのか原因が分からない。影響範囲も追って'), 'deep');
  assert.strictEqual(judgeEffort('科研費の申請書を書きたい'), 'deep');
});

test('Claude のモデルは別名で持つ(版を固定しない)', () => {
  // 版番号を書くと、エンジンが新しくなったとき古いまま走り続ける
  for (const m of Object.values(EFFORT_MODELS.claude)) {
    assert.ok(/^[a-z]+$/.test(m), `別名であること: ${m}`);
  }
  assert.strictEqual(EFFORT_MODELS.claude.light, 'haiku');
  assert.strictEqual(EFFORT_MODELS.claude.deep, 'fable');   // 最上位(Mythos)
});

test('ターミナルと画面操作には自動で回さない', () => {
  // コマンドの自動実行と、人の手が要る GUI 操作は事故のもと
  assert.ok(NO_AUTO.has('shell'));
  assert.ok(NO_AUTO.has('astra'));
  assert.strictEqual(shouldAutoRoute(judgeEngine('git push しといて'), 'claude'), false);
  assert.strictEqual(shouldAutoRoute(judgeEngine('Excel を開いて数字を入力して'), 'claude'), false);
});

test('確信が high でなければ回さない', () => {
  const weak = { engine: 'codex', confidence: 'medium' };
  assert.strictEqual(shouldAutoRoute(weak, 'claude'), false);
  assert.strictEqual(shouldAutoRoute(null, 'claude'), false);
});

test('いまのタブと同じエンジンなら回さない', () => {
  const j = judgeEngine('なぜ落ちるのか原因が分からない。影響範囲も追って');
  assert.strictEqual(j.engine, 'codex');
  assert.strictEqual(shouldAutoRoute(j, 'codex'), false);
});

test('別エンジン向きで確信が高ければ回す', () => {
  assert.strictEqual(shouldAutoRoute(judgeEngine('このタイポ直しといて'), 'claude'), true);
  assert.strictEqual(shouldAutoRoute(judgeEngine('大量に画像を変換したい'), 'claude'), true);
});

test('EGAKU は自動でも他社エンジンへ出さない', () => {
  const j = judgeEngine('EGAKU の NSFW 生成が落ちている');
  assert.strictEqual(j.engine, 'claude');
  assert.strictEqual(shouldAutoRoute(j, 'claude'), false);   // Claude のまま = 回さない
});
