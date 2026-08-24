// 会話ID検出の回帰テスト。ここが外れると「再起動したら会話が消えた」が再発する。
//   実行: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeProjectSlug, findConversationId } = require('../src/conversation-id');

// ── スラッグの作り方 ──────────────────────────────────────────────
// 「英数字以外を全て '-'」。'/' だけ置換する実装だと日本語パスで一致しない。
// 期待値は実際に ~/.claude/projects/ に存在するディレクトリ名から取っている。
test('英数字以外は全て - になる(日本語パスを含む)', () => {
  const cases = [
    ['/Users/dev', '-Users-dev'],
    ['/Users/dev/Desktop/アプリ開発プロジェクト/image-studio',
     '-Users-dev-Desktop-------------image-studio'],
    ['/Users/dev/money-app', '-Users-dev-money-app'],
    ['/private/tmp', '-private-tmp'],
  ];
  for (const [cwd, expected] of cases) {
    assert.strictEqual(claudeProjectSlug(cwd), expected, cwd);
  }
});

test('日本語1文字はダッシュ1つになる(バイト数ではない)', () => {
  // 「アプリ開発プロジェクト」= 11文字 → 前後の / と合わせて 13 ダッシュ。
  const s = claudeProjectSlug('/a/アプリ開発プロジェクト/b');
  assert.strictEqual(s, '-a-------------b');
  assert.strictEqual(s.match(/-+/g)[1].length, 13);
});

test('空・undefined でも落ちない', () => {
  assert.strictEqual(claudeProjectSlug(''), '');
  assert.strictEqual(claudeProjectSlug(undefined), '');
  assert.strictEqual(claudeProjectSlug(null), '');
});

// ── 会話ファイルの絞り込み ────────────────────────────────────────
// 一時ディレクトリに projects/<slug>/*.jsonl を作って挙動を固定する。
function makeHome(cwd, files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ariya-convid-'));
  const dir = path.join(home, '.claude', 'projects', claudeProjectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(dir, name), '{}\n');
  return home;
}

const CWD = '/Users/dev/Desktop/アプリ開発プロジェクト/dummy';

test('セッション開始以降に作られた会話を拾う', () => {
  const home = makeHome(CWD, ['aaa.jsonl']);
  const found = findConversationId(CWD, Date.now(), { homedir: home });
  assert.strictEqual(found, 'aaa');
});

test('セッション開始より前に作られた会話は拾わない', () => {
  const home = makeHome(CWD, ['old.jsonl']);
  // 1時間後に始まったセッション = この会話より新しい
  const found = findConversationId(CWD, Date.now() + 3600_000, { homedir: home });
  assert.strictEqual(found, null);
});

test('既に他タブが使っている会話は候補から外す(二重 --resume 防止)', () => {
  const home = makeHome(CWD, ['taken.jsonl']);
  const found = findConversationId(CWD, Date.now(), {
    homedir: home, claimed: new Set(['taken']),
  });
  assert.strictEqual(found, null, '使用中の ID を掴んでいる');
});

test('候補が複数なら新しい方を採る', () => {
  const home = makeHome(CWD, ['first.jsonl']);
  const dir = path.join(home, '.claude', 'projects', claudeProjectSlug(CWD));
  // birthtime を確実に分けるため、少し間を空けて2本目を作る
  const until = Date.now() + 30;
  while (Date.now() < until) { /* spin */ }
  fs.writeFileSync(path.join(dir, 'second.jsonl'), '{}\n');
  const found = findConversationId(CWD, Date.now() - 10_000, { homedir: home });
  assert.strictEqual(found, 'second');
});

test('.jsonl 以外は無視する', () => {
  const home = makeHome(CWD, ['notes.txt', 'memory.json']);
  assert.strictEqual(findConversationId(CWD, Date.now() - 10_000, { homedir: home }), null);
});

test('ディレクトリが無くても落ちずに null を返す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ariya-empty-'));
  assert.strictEqual(findConversationId(CWD, Date.now(), { homedir: home }), null);
});

test('旧スラッグ(/ だけ置換)のディレクトリも拾える', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ariya-oldslug-'));
  const oldKey = CWD.replace(/\//g, '-');
  const dir = path.join(home, '.claude', 'projects', oldKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'legacy.jsonl'), '{}\n');
  assert.strictEqual(findConversationId(CWD, Date.now() - 10_000, { homedir: home }), 'legacy');
});
