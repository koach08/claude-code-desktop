// エンジン判定(Cmd+Shift+E)の回帰テスト。
// 判定表は手で足しやすい分、既存の判定を静かに壊しやすい。ここで見張る。
//   実行: npm test
const test = require('node:test');
const assert = require('node:assert');
const { judgeEngine, ENGINE_SIGNALS } = require('../src/engine-judge');

// [入力, 期待レーン, 補足]
const CASES = [
  // ── ターミナル ──
  ['git のブランチを整理して不要なものを消したい', 'shell', '日本語語順の git'],
  ['git push しておいて', 'shell', '英語サブコマンド'],
  ['git のコンフリクトを解消したい', 'shell', '日本語語順の git'],
  ['npm install が失敗する', 'shell', 'パッケージ操作'],
  ['3000番ポートを掴んでるプロセスを止めて', 'shell', 'ポート/プロセス'],

  // ── Codex: 既存コードの横断・修正 ──
  ['この関数の typo を1行直して', 'codex', '局所的な微修正'],
  ['誤字を直すだけ', 'codex', '微修正'],
  ['1箇所だけ直してほしい', 'codex', '微修正'],
  ['この設定がどこで使われてるか影響範囲を調べて', 'codex', '影響範囲'],
  ['なぜ落ちるのか原因が分からない', 'codex', '原因不明のバグ'],
  ['テストが通らないので直して', 'codex', 'バグ修正'],

  // ── Gemini: 量・速度・コスト ──
  ['10万行のログを全部読んで傾向をまとめて', 'gemini', '実数表記の量'],
  ['5000件のCSVを変換したい', 'gemini', '実数表記の量'],
  ['大量に画像を量産したい', 'gemini', '大量/量産'],
  ['ブラウザで実際に触って動くか確認して', 'gemini', 'ブラウザ検証'],

  // ── Grok: 明示指定のときだけ ──
  ['grok で書かせてみて', 'grok', '明示指定'],

  // ── Claude Code ──
  ['Next.jsアプリを新規で作って、Supabase認証とStripe決済まで入れたい', 'claude', 'MCP+新規実装'],
  ['設計から考え直したい。アーキテクチャの方針を相談したい', 'claude', '設計'],
  ['note の記事を書きたい', 'claude', '書き物'],
  ['RLS の権限まわりを見てほしい', 'claude', 'セキュリティ'],
];

for (const [input, expected, note] of CASES) {
  test(`${expected.padEnd(6)} ← ${input}  (${note})`, () => {
    const r = judgeEngine(input);
    assert.strictEqual(
      r.engine, expected,
      `期待 ${expected} / 実際 ${r.engine}  scores=${JSON.stringify(r.scores)} hits=${JSON.stringify(r.hits)}`
    );
  });
}

// 「1行直して」を量(gemini)側が誤って攫わないことの明示的な確認。
// gemini の実数パターンは 万/千 か3桁以上を要求する、という約束を固定する。
test('1行/2件のような小さい数は「量」と見なさない', () => {
  for (const s of ['1行だけ直して', '2件だけ足して', '10行のスクリプト']) {
    assert.strictEqual(judgeEngine(s).scores.gemini, 0, `${s} が量判定に入っている`);
  }
});

// 決め手が無ければ Claude Code に落ちる(品質側に倒す既定)。
test('決め手なしは Claude Code の low に落ちる', () => {
  const r = judgeEngine('あれをいい感じにしておいて');
  assert.strictEqual(r.engine, 'claude');
  assert.strictEqual(r.confidence, 'low');
});

// 判定表そのものの健全性。
test('判定表に壊れた行が無い', () => {
  const lanes = new Set(['claude', 'codex', 'gemini', 'grok', 'shell']);
  for (const s of ENGINE_SIGNALS) {
    assert.ok(lanes.has(s.e), `未知のレーン: ${s.e}`);
    assert.ok(s.w >= 1 && s.w <= 3, `重みが範囲外: ${s.why}`);
    assert.ok(s.why && s.re instanceof RegExp, `why/re が欠けている: ${JSON.stringify(s)}`);
  }
  for (const lane of lanes) {
    assert.ok(ENGINE_SIGNALS.some((s) => s.e === lane), `${lane} の signal が1本も無い`);
  }
});
