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

test('renderer は <script> で読むので UMD が window に生える', () => {
  // 画面側の導線(engine-dialog の「リレーで回す」)がここを直接使う。
  // UMD の分岐が壊れるとボタンが黙って何もしない、という気付きにくい壊れ方をする。
  const vm = require('node:vm');
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'relay.js'), 'utf-8');
  const win = {};
  vm.createContext(win);
  vm.runInContext(src, win);          // module が無い = ブラウザと同じ条件
  assert.strictEqual(typeof win.AriyaRelay?.planRelay, 'function');
  assert.strictEqual(typeof win.AriyaRelay?.buildStagePrompt, 'function');
  const p = win.AriyaRelay.planRelay('x', { engine: 'claude', confidence: 'high' }, ['claude', 'gemini']);
  assert.strictEqual(p.ok, true);
});

test('relay.js は Node の組み込みに依存しない(ブラウザで読めること)', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'relay.js'), 'utf-8');
  assert.ok(!/\brequire\s*\(/.test(src), 'require が入るとブラウザで読めない');
});

// ── 指摘には確かめ方を添えさせる ─────────────────────────────
//
// 2026-08-29 の実測: Gemini と Claude が独立に同じ指摘を出したが、両方とも
// 外れだった。一致は正しさの証拠にならない。効いたのは、確かめに行く手がかりが
// 増えたこと。だから多数決ではなく「確かめられる形」を求める。

test('点検には確かめる手順を添えさせる', () => {
  const prompt = buildStagePrompt({ stage: 'review' }, 'x',
    [{ stage: 'work', engine: 'codex', out: 'やりました' }], {});
  assert.ok(/確かめる最短の手順/.test(prompt));
  assert.ok(/確かめようのない指摘は書かないで/.test(prompt));
});

test('下調べには参照した場所を示させる', () => {
  const prompt = buildStagePrompt({ stage: 'survey' }, 'x', []);
  assert.ok(/行番号/.test(prompt));
  assert.ok(/憶測/.test(prompt));
});

test('工程ごとに制限時間が付く(調べものは本作業より短く)', () => {
  const p = planRelay('x', judgeEngine('設計を決めたい'), ALL);
  const by = Object.fromEntries(p.steps.map((s) => [s.stage, s.timeoutMs]));
  assert.ok(by.survey > 0 && by.work > 0 && by.review > 0);
  // 読み取り専用のエージェントは放っておくといくらでも読み続ける(実測10分近く)。
  assert.ok(by.survey < by.work, '下調べが本作業より長い');
  assert.ok(by.review < by.work, '点検が本作業より長い');
});

// ── 工程間の受け渡しに上限 ─────────────────────────────────
//
// 持ち越した文字列はプロンプトになり、argv の一要素として spawn に渡る。
// このマシンの ARG_MAX は 1,048,576。ワーカーの溜め込み上限が 2MB なので、
// そのまま渡すと spawn が E2BIG で落ち、画面には「失敗」としか出ない。

test('長すぎる下調べは切って渡す', () => {
  const huge = 'あ'.repeat(500000);
  const prompt = buildStagePrompt({ stage: 'work' }, '依頼', [{ stage: 'survey', out: huge }]);
  assert.ok(prompt.length < 100000, `切られていない: ${prompt.length}`);
});

test('切ったことを受け手に伝える(途中で終わったと気づけるように)', () => {
  const prompt = buildStagePrompt({ stage: 'work' }, '依頼',
    [{ stage: 'survey', out: 'x'.repeat(500000) }]);
  assert.ok(/ここまで。全体は 500000 字/.test(prompt));
});

test('点検に渡す報告と差分にも同じ上限がかかる', () => {
  const prompt = buildStagePrompt({ stage: 'review' }, '依頼',
    [{ stage: 'work', out: 'x'.repeat(300000) }],
    { diff: 'y'.repeat(300000), expectedWrite: true });
  assert.ok(prompt.length < 120000, `切られていない: ${prompt.length}`);
});

test('組み上がったプロンプトは argv の上限に収まる', () => {
  // 実測: /usr/bin/true に 2MB の引数を渡すと E2BIG。900KB は通る。
  const prompt = buildStagePrompt({ stage: 'review' }, 'x'.repeat(1000),
    [{ stage: 'work', out: 'a'.repeat(2 * 1024 * 1024) }],
    { diff: 'b'.repeat(2 * 1024 * 1024), expectedWrite: true });
  const r = require('child_process').spawnSync('/usr/bin/true', [prompt], { stdio: 'ignore' });
  assert.ok(!r.error, `spawn できない: ${r.error && r.error.code}`);
});

test('短い出力はそのまま渡す(不要に切らない)', () => {
  const prompt = buildStagePrompt({ stage: 'work' }, '依頼',
    [{ stage: 'survey', out: '描画は renderer.js の 700 行目' }]);
  assert.ok(prompt.includes('描画は renderer.js の 700 行目'));
  assert.ok(!/ここまで/.test(prompt));
});
