const test = require('node:test');
const assert = require('node:assert');
const { planRelay, buildStagePrompt, VENDOR } = require('../src/relay');
const { judgeEngine } = require('../src/engine-judge');

const ALL = ['claude', 'codex', 'gemini', 'grok'];
const stagesOf = (p) => p.steps.map((s) => `${s.stage}:${s.engine}`);

test('本作業は engine-judge の推奨をそのまま使う', () => {
  const j = judgeEngine('この関数をリファクタして影響範囲も調べて');
  const p = planRelay('...', j, ALL);
  assert.strictEqual(p.steps.find((s) => s.stage === 'work').engine, 'codex');
});

test('点検は本作業と別の会社に回す', () => {
  for (const task of ['この関数をリファクタして影響範囲も調べて', '設計を決めて仕様を書きたい', '大量のファイルを一括変換したい']) {
    const p = planRelay(task, judgeEngine(task), ALL);
    const work = p.steps.find((s) => s.stage === 'work');
    const review = p.steps.find((s) => s.stage === 'review');
    assert.ok(review, `点検が付いていない: ${task}`);
    assert.notStrictEqual(VENDOR[review.engine], VENDOR[work.engine],
      `同じ会社が自分の仕事を点検している: ${task}`);
  }
});

test('下調べと点検は、できれば別の相手にする', () => {
  const j = judgeEngine('この関数をリファクタして影響範囲も調べて');
  const p = planRelay('...', j, ALL);
  const survey = p.steps.find((s) => s.stage === 'survey');
  const review = p.steps.find((s) => s.stage === 'review');
  assert.notStrictEqual(survey.engine, review.engine);
});

test('下調べは本作業と別の相手にする', () => {
  const j = judgeEngine('この関数をリファクタして影響範囲も調べて');
  const p = planRelay('...', j, ALL);
  const survey = p.steps.find((s) => s.stage === 'survey');
  assert.notStrictEqual(survey.engine, p.steps.find((s) => s.stage === 'work').engine);
});

test('使えるエンジンが1社だけなら、点検は付けず「点検なし」を立てる', () => {
  const p = planRelay('...', judgeEngine('設計を決めたい'), ['claude']);
  assert.deepStrictEqual(stagesOf(p), ['work:claude']);
  assert.strictEqual(p.unreviewed, true);
});

test('点検が付いたら unreviewed は立たない', () => {
  const p = planRelay('...', judgeEngine('設計を決めたい'), ['claude', 'gemini']);
  assert.strictEqual(p.unreviewed, false);
});

test('認証切れのエンジンは計画に入らない', () => {
  // codex が落ちている日でも、リレー自体は組めること。
  const j = judgeEngine('この関数をリファクタして影響範囲も調べて');
  const p = planRelay('...', j, ['claude', 'gemini']);
  assert.ok(!stagesOf(p).some((s) => s.includes('codex')));
  assert.strictEqual(p.steps.find((s) => s.stage === 'work').engine, 'claude');
});

test('使えるエンジンが無ければ失敗を返す', () => {
  assert.strictEqual(planRelay('...', judgeEngine('設計'), []).ok, false);
  assert.strictEqual(planRelay('...', judgeEngine('設計'), ['shell']).ok, false);
});

test('既定では本作業も読み取り専用', () => {
  const p = planRelay('...', judgeEngine('設計を決めたい'), ALL);
  assert.strictEqual(p.steps.every((s) => s.read), true);
});

test('write を明示したときだけ本作業が書き込める', () => {
  const p = planRelay('...', judgeEngine('設計を決めたい'), ALL, { write: true });
  assert.strictEqual(p.steps.find((s) => s.stage === 'work').read, false);
  // 点検は書き込ませない。
  assert.strictEqual(p.steps.find((s) => s.stage === 'review').read, true);
});

test('下調べの出力が本作業の入力に畳み込まれる', () => {
  const prompt = buildStagePrompt({ stage: 'work' }, '表示を速くしたい',
    [{ stage: 'survey', engine: 'gemini', out: '描画は renderer.js の 700 行目' }]);
  assert.ok(prompt.includes('表示を速くしたい'));
  assert.ok(prompt.includes('renderer.js の 700 行目'));
  // 前工程を鵜呑みにさせない一文が要る(今日 Gemini の指摘が1件外れた)。
  assert.ok(/誤り/.test(prompt));
});

test('点検には作業の報告が渡り、無理に指摘を作らせない', () => {
  const prompt = buildStagePrompt({ stage: 'review' }, '表示を速くしたい',
    [{ stage: 'work', engine: 'codex', out: 'キャッシュを足した' }]);
  assert.ok(prompt.includes('キャッシュを足した'));
  assert.ok(prompt.includes('問題なし'));
});

// ── 点検には実物を見せる ───────────────────────────────────────
//
// リレー自身にリレーを点検させたときに出た穴。点検役が本作業の「報告」しか
// 読めないと、何も書き換えていなくても立派な報告文だけで「問題なし」が返る。

test('差分があれば点検に渡り、報告より差分を優先させる', () => {
  const prompt = buildStagePrompt({ stage: 'review' }, '速くしたい',
    [{ stage: 'work', engine: 'codex', out: 'キャッシュを足しました' }],
    { diff: '--- a/x.js\n+++ b/x.js\n+const cache = new Map();', expectedWrite: true });
  assert.ok(prompt.includes('const cache = new Map()'));
  assert.ok(/差分のほうを本当/.test(prompt));
});

test('書き込むはずの回で差分が空なら、それを先に指摘させる', () => {
  const prompt = buildStagePrompt({ stage: 'review' }, '速くしたい',
    [{ stage: 'work', engine: 'codex', out: '完璧に実装しました' }],
    { diff: '', expectedWrite: true });
  assert.ok(/差分は空/.test(prompt));
});

test('読み取り専用の回では、差分が無くても文句を言わせない', () => {
  const prompt = buildStagePrompt({ stage: 'review' }, '調べたい',
    [{ stage: 'work', engine: 'codex', out: '調べました' }], {});
  assert.ok(!/差分は空/.test(prompt));
});

test('報告は本人の申告だと明示して渡す', () => {
  const prompt = buildStagePrompt({ stage: 'review' }, 'x',
    [{ stage: 'work', engine: 'codex', out: 'やりました' }], {});
  assert.ok(/そのまま信じない/.test(prompt));
});
