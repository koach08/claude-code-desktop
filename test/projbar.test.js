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
