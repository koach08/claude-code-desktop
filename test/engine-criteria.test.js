// エンジンの見分けが koach-os (Alfred) とずれていないか。
//
// src/engine-judge.js は「開くアプリ」を選び、koach-os の backend/engine_choice.py は
// 「呼ぶ API のモデル」を選ぶ。別の問いなので、全部を揃える必要はない。
// ただし **「画面を触る作業か」の見分けだけは揃っていないといけない**。
// ここがずれると、同じ頼みごとがアプリでは Astra に行き、Alfred では普通の相談になる。
// 本人からは「同じことを頼んだのに片方だけ変な返事をする」としか見えない。
//
// ⚠️ 2026-09-25 に実際にずれていた (5 か所)。engine_choice.py 側に
//    GUI / Photoshop / Illustrator / プレビュー / 「代わりに入力して」/
//    「アップロード」/「書類を作って出す」が無く、Astra に送られていなかった。
//
// 例文集は両方のリポジトリに同じ中身で置く:
//   claude-code-desktop/test/engine_criteria_cases.json  ← ここ
//   koach-os-app/tests/engine_criteria_cases.json
//   koach-os-app/tests/test_engine_criteria.py           ← 向こう側の試験
// 片方の判定を変えたら、両方の試験を走らせること。
//
//   実行: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { judgeEngine } = require('../src/engine-judge');

const CASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'engine_criteria_cases.json'), 'utf8'),
);

// koach-os の lane=hands に対応するのは、こちらの engine=astra。
const HANDS = 'astra';

test('画面を触る依頼は astra に行く (Alfred の hands と対応)', () => {
  const bad = CASES.hands.filter((t) => judgeEngine(t).engine !== HANDS);
  assert.deepStrictEqual(
    bad, [],
    'astra に行かなかった例文。Alfred 側は hands に送っている → ずれている',
  );
});

test('それ以外は astra にしない', () => {
  // 取りこぼしより、取りすぎの方が困る。普通の相談まで画面操作に回されると使えない。
  const bad = CASES.not_hands.filter((t) => judgeEngine(t).engine === HANDS);
  assert.deepStrictEqual(bad, [], 'astra に行ってしまった例文');
});

test('例文集が向こう側と同じ版である', () => {
  // ⚠️ 中身が違っていても文字数は同じ、はあり得る。版で人が見分けられるようにしておく。
  assert.ok(CASES._ && CASES._.version, '版が入っていない');
  assert.ok(CASES.hands.length > 20, '例文が少なすぎる');
  assert.ok(CASES.not_hands.length > 5, '例文が少なすぎる');
});
