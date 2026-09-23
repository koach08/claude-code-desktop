'use strict';
// 左メニューの束ね方。「どのフォルダがどのプロジェクトに入るか」を固定する。
// ⚠️ ここがずれると、EGAKU のタブが「ai-studio」という別の名前で並んだり、
//    ホーム直下の端末が全部ばらばらの塊になったりする(本人が探せなくなる)。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// renderer.js は画面用なので丸ごとは読めない。projectOf の定義だけ取り出して評価する
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const names = src.slice(src.indexOf('const PROJ_NAMES'), src.indexOf('function renderProjbar'));
const projectOf = new Function(`${names}; return projectOf;`)();

test('アプリのフォルダは本人の呼び名になる', () => {
  assert.strictEqual(projectOf({ cwd: '/Users/koachmedia/Desktop/アプリ開発プロジェクト/ai-studio' }).name, 'EGAKU AI');
  assert.strictEqual(projectOf({ cwd: '/Users/koachmedia/Desktop/アプリ開発プロジェクト/koach-os-app-live/frontend' }).name, 'koach-os');
  assert.strictEqual(projectOf({ cwd: '/Users/koachmedia/Desktop/アプリ開発プロジェクト/claude-code-desktop' }).name, 'Ariya Bridge');
});

test('同じプロジェクトの下の階層も同じ塊に入る', () => {
  const a = projectOf({ cwd: '/Users/koachmedia/Desktop/アプリ開発プロジェクト/ai-studio' });
  const b = projectOf({ cwd: '/Users/koachmedia/Desktop/アプリ開発プロジェクト/ai-studio/backend/app' });
  assert.strictEqual(a.key, b.key);
});

test('ホーム直下と空は「その他」にまとめる(ばらけさせない)', () => {
  for (const cwd of ['', '~', '/Users/koachmedia']) {
    assert.strictEqual(projectOf({ cwd }).name, 'その他', `cwd=${cwd}`);
  }
  assert.strictEqual(projectOf({}).name, 'その他');
});

test('知らないフォルダはフォルダ名で束ねる(捨てない)', () => {
  const p = projectOf({ cwd: '/Users/koachmedia/Desktop/なにか新しい箱' });
  assert.strictEqual(p.name, 'なにか新しい箱');
});

test('末尾のスラッシュで別の塊にならない', () => {
  const a = projectOf({ cwd: '/Users/koachmedia/Desktop/アプリ開発プロジェクト/ichimai' });
  const b = projectOf({ cwd: '/Users/koachmedia/Desktop/アプリ開発プロジェクト/ichimai/' });
  assert.strictEqual(a.key, b.key);
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
