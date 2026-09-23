'use strict';
// 左メニューの束ね方。「どのフォルダがどのプロジェクトに入るか」を固定する。
// ⚠️ ここがずれると、EGAKU のタブが「ai-studio」という別の名前で並んだり、
//    ホーム直下の端末が全部ばらばらの塊になったりする(本人が探せなくなる)。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// renderer.js は画面用なので丸ごとは読めない。projectOf だけ取り出して評価する
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const fnSrc = src.slice(src.indexOf('function projectOf'), src.indexOf('// 会話の一覧を作り直す'));
const projectOf = new Function(`const PROJ_LABELS = {}; ${fnSrc}; return projectOf;`)();
// 呼び名の表はテスト用の架空のもの。⚠️ 本物の呼び名はソースにもテストにも書かない(公開リポジトリ)
const L = { 'app-one': 'アプリ1', 'app-two': 'アプリ2' };

test('表にあるフォルダは呼び名になる', () => {
  assert.strictEqual(projectOf({ cwd: '/Users/u/work/app-one' }, L).name, 'アプリ1');
  assert.strictEqual(projectOf({ cwd: '/Users/u/work/app-two' }, L).name, 'アプリ2');
});

test('同じプロジェクトの下の階層も同じ塊に入る', () => {
  assert.strictEqual(projectOf({ cwd: '/Users/u/work/app-one' }, L).key, projectOf({ cwd: '/Users/u/work/app-one/backend/src' }, L).key);
});

test('ホーム直下と空は「その他」にまとめる(ばらけさせない)', () => {
  for (const cwd of ['', '~', '/Users/u']) assert.strictEqual(projectOf({ cwd }, L).name, 'その他', `cwd=${cwd}`);
  assert.strictEqual(projectOf({}, L).name, 'その他');
});

test('表に無いフォルダはフォルダ名で束ねる(捨てない)', () => {
  assert.strictEqual(projectOf({ cwd: '/Users/u/work/なにか新しい箱' }, L).name, 'なにか新しい箱');
});

test('末尾のスラッシュで別の塊にならない', () => {
  assert.strictEqual(projectOf({ cwd: '/Users/u/work/app-one' }, L).key, projectOf({ cwd: '/Users/u/work/app-one/' }, L).key);
});

test('ソースに個人の呼び名を書いていない(公開リポジトリ)', () => {
  // 手元の表にある本物の呼び名が、ソースに漏れていないこと
  let local = {};
  try { local = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.claude-code-app', 'project-labels.json'), 'utf8')); } catch (_) { /* CI など表が無い所では飛ばす */ }
  // このリポジトリ自身の道具の名前は元から公開されている
  const own = new Set(['Ariya Bridge', 'Fleet View', 'CC Desktop', 'Code Harness']);
  const leaked = [...new Set(Object.values(local))].filter(v => !own.has(v) && v.length >= 3 && /[^\x00-\x7f]|[A-Z]/.test(v) && src.includes(v));
  assert.deepStrictEqual(leaked, [], `ソースに呼び名が入っている: ${leaked.join(', ')}`);
});

// ── 入力欄と音声ボタン(2026-09-23) ────────────────────────────
// 本人「音声のやりとり、音声入力、チャットの入力もその方が分かりやすい」
// ⚠️ 波形ボタン(音声モード)は **1 つしか無い**こと。複製すると id が重なり、
//    既存の handler が片方にしか付かず「押しても何も起きない」になる。

test('波形ボタン(音声モード)は画面に 1 つだけ', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const hits = html.match(/id="voice-talk-btn"/g) || [];
  assert.strictEqual(hits.length, 1, `voice-talk-btn が ${hits.length} 個ある`);
});

test('入力欄はモードごとに 1 つずつで、重複 id が無い', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  for (const id of ['prompt-input', 'chat-input', 'builder-prompt', 'input-row', 'chat-compose']) {
    const hits = html.match(new RegExp(`id="${id}"`, 'g')) || [];
    assert.strictEqual(hits.length, 1, `${id} が ${hits.length} 個`);
  }
});

test('音声ボタンは今のモードの入力欄へ移す(作り直さない)', () => {
  const src2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const fn = src2.slice(src2.indexOf('function placeVoiceButton'));
  assert.ok(/getElementById\('voice-talk-btn'\)/.test(fn), '既存のボタンを引いていない');
  assert.ok(!/createElement\('button'\)/.test(fn.slice(0, 900)), 'ボタンを作り直している');
  assert.ok(/insertBefore|appendChild/.test(fn), '移す処理が無い');
});
