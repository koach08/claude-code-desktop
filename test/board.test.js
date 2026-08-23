// 案件ボード (#10 Phase2) の判定の回帰テスト。
//   実行: npm test
const test = require('node:test');
const assert = require('node:assert');
const { inferProject, deriveState, groupIntoTeams, cleanTail, WORKING_MS } = require('../src/board');

// ── 案件の推定 ────────────────────────────────────────────────
// 本人は全タブを ~ から起動するので cwd では分けられない。
// 会話に出てくるリポジトリ名の最頻値を使う。
test('会話に頻出するリポジトリ名を案件として拾う', () => {
  const text = `
    /Users/koachmedia/Desktop/アプリ開発プロジェクト/crypto-trader/bot.py を直す
    /Users/koachmedia/Desktop/アプリ開発プロジェクト/crypto-trader/README.md
    /Users/koachmedia/Desktop/アプリ開発プロジェクト/crypto-trader/test/x.py
    /Users/koachmedia/Desktop/アプリ開発プロジェクト/ai-studio/app.tsx
  `;
  assert.strictEqual(inferProject(text), 'crypto-trader');
});

test('ホーム直下のリポジトリも拾う', () => {
  const t = '/Users/koachmedia/investment-app/a /Users/koachmedia/investment-app/b /Users/koachmedia/investment-app/c';
  assert.strictEqual(inferProject(t), 'investment-app');
});

test('設定ディレクトリは案件として扱わない', () => {
  const t = Array(10).fill('/Users/koachmedia/.claude/projects/x.jsonl').join(' ');
  assert.strictEqual(inferProject(t), null);
});

test('たまたま2回出ただけのものは案件にしない', () => {
  const t = '/Users/koachmedia/Desktop/アプリ開発プロジェクト/whatever/a /Users/koachmedia/Desktop/アプリ開発プロジェクト/whatever/b';
  assert.strictEqual(inferProject(t), null);
});

test('行末の記号を巻き込まない', () => {
  const t = Array(4).fill('`/Users/koachmedia/Desktop/アプリ開発プロジェクト/ichimai`; ').join('');
  assert.strictEqual(inferProject(t), 'ichimai');
});

test('パスが無ければ null(埋めない)', () => {
  assert.strictEqual(inferProject('ただの日本語の文章です'), null);
  assert.strictEqual(inferProject(''), null);
  assert.strictEqual(inferProject(undefined), null);
});

// ── 状態の判定 ────────────────────────────────────────────────
const now = 1_000_000;

test('直近に出力があれば作業中', () => {
  assert.strictEqual(deriveState({ lastOutputAt: now - 500, tail: '' }, now), 'working');
});

test('出力が止まっていれば待機', () => {
  assert.strictEqual(deriveState({ lastOutputAt: now - WORKING_MS - 1, tail: '' }, now), 'idle');
});

test('止まっていて許可を聞いていれば承認待ち', () => {
  const tail = 'Do you want to proceed?\n  1. Yes\n  2. No';
  assert.strictEqual(deriveState({ lastOutputAt: now - 60_000, tail }, now), 'asking');
});

test('作業中は承認待ちより優先する(スピナー中の誤検出を避ける)', () => {
  const tail = 'Do you want to proceed?';
  assert.strictEqual(deriveState({ lastOutputAt: now - 100, tail }, now), 'working');
});

test('終了したタブは終了', () => {
  assert.strictEqual(deriveState({ lastOutputAt: now, tail: '', exited: true }, now), 'exited');
});

// ── チーム分け ────────────────────────────────────────────────
test('同じ案件のタブが1チームに束ねられる', () => {
  const teams = groupIntoTeams([
    { id: '1', project: 'ichimai', lastOutputAt: 0, tail: '' },
    { id: '2', project: 'ichimai', lastOutputAt: 0, tail: '' },
    { id: '3', project: 'crypto-trader', lastOutputAt: 0, tail: '' },
  ], now);
  assert.strictEqual(teams.length, 2);
  assert.strictEqual(teams.find((t) => t.project === 'ichimai').tabs.length, 2);
});

test('案件が取れなかったタブは未分類に入る(捨てない)', () => {
  const teams = groupIntoTeams([{ id: '1', project: null, lastOutputAt: 0, tail: '' }], now);
  assert.strictEqual(teams[0].project, '未分類');
  assert.strictEqual(teams[0].tabs.length, 1);
});

test('動いているチームが上に来る', () => {
  const teams = groupIntoTeams([
    { id: '1', project: 'しずか', lastOutputAt: 0, tail: '' },
    { id: '2', project: 'しずか', lastOutputAt: 0, tail: '' },
    { id: '3', project: 'しずか', lastOutputAt: 0, tail: '' },
    { id: '4', project: 'うごいてる', lastOutputAt: now - 100, tail: '' },
  ], now);
  assert.strictEqual(teams[0].project, 'うごいてる', '作業中のチームが上に来ていない');
  assert.strictEqual(teams[0].counts.working, 1);
});

test('承認待ちを含むチームも上に来る(自分待ちを見落とさない)', () => {
  const teams = groupIntoTeams([
    { id: '1', project: 'しずか', lastOutputAt: 0, tail: '' },
    { id: '2', project: 'しずか', lastOutputAt: 0, tail: '' },
    { id: '3', project: '待たれてる', lastOutputAt: 0, tail: '(y/n)' },
  ], now);
  assert.strictEqual(teams[0].project, '待たれてる');
  assert.strictEqual(teams[0].counts.asking, 1);
});

test('タブが無くても落ちない', () => {
  assert.deepStrictEqual(groupIntoTeams([], now), []);
});

// ── 端末出力の掃除 ────────────────────────────────────────────
// 実バッファ(~/.claude-code-app/buffers/*.buf)に実際に入っていた種類を並べてある。
// 素朴な /\x1b\[[0-9;?]*[a-zA-Z]/ だけだと [>4m や [<u が残り、残骸が判定に混ざる。
test('実際に出てくる制御シーケンスを取りこぼさない', () => {
  const raw = [
    '\x1b[38;5;180m色つき\x1b[0m',
    '\x1b[>4m\x1b[<u',              // キーボードプロトコル
    '\x1b7保存\x1b8復帰',            // カーソル保存/復帰
    '\x1b]0;タイトル\x07',           // OSC
    '\x1b(B',                       // 文字集合切替
    '\x1b[2K\x1b[1A',               // 消去・カーソル移動
    'のこるテキスト',
  ].join('');
  const out = cleanTail(raw);
  assert.ok(!/\x1b/.test(out), 'ESC が残っている: ' + JSON.stringify(out));
  assert.ok(!/\[[<>0-9;?]*[a-zA-Z]/.test(out), '残骸がある: ' + JSON.stringify(out));
  assert.ok(out.includes('のこるテキスト'), '本文が消えた: ' + JSON.stringify(out));
  assert.ok(out.includes('色つき') && out.includes('保存') && out.includes('復帰'));
});

test('色コードで分断された選択肢を判定できる形に戻す', () => {
  // 許可プロンプトは色コードが挟まるので、掃除しないと文面照合が効かない
  const raw = '\x1b[1mDo you want\x1b[0m to proceed?\r\n\x1b[32m 1. Yes\x1b[0m\r\n 2. No';
  const tail = cleanTail(raw);
  assert.strictEqual(deriveState({ lastOutputAt: 0, tail }, 999_999), 'asking');
});

test('長さを指定ぶんに収める', () => {
  assert.ok(cleanTail('あ'.repeat(5000), 100).length <= 100);
});
