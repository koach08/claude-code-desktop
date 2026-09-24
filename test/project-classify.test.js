'use strict';
// 左メニューの「中身で束ねる」判定。⚠️ 呼び名はテスト用の架空のもの(公開リポジトリ)
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyText, decide } = require('../src/project-classify');

const labels = { 'app-one': 'アプリ1', 'lesson-prep': '授業', Documents: '資料' };
const keywords = { 'アプリ1': ['appone'], '授業': ['スライド'], '随筆': ['俳句'] };
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const tool = (p) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `cd ${p} && ls` } }] } });

test('会話で触ったフォルダで束ねる(cwd が ~ でも)', () => {
  const head = [user('直してほしい'), tool('/Users/u/work/app-one/src'), tool('/Users/u/work/app-one'), tool('/Users/u/work/app-one/x')].join('\n');
  assert.strictEqual(classifyText({ head, tail: '' }, { labels, keywords }).project, 'アプリ1');
});

test('深い階層のフォルダも拾う(Documents の下の授業フォルダ)', () => {
  const head = [user('続き'), ...Array(4).fill(tool('/Users/u/Documents/lesson-prep/07'))].join('\n');
  assert.strictEqual(classifyText({ head, tail: '' }, { labels, keywords }).project, '授業');
});

test('依頼文の言葉だけでも束ねる', () => {
  const head = user('秋の俳句をまとめたい');
  assert.strictEqual(classifyText({ head, tail: '' }, { labels, keywords }).project, '随筆');
});

test('設定や一時置き場のパスは数えない(記憶の読み込みは全タブに出る)', () => {
  const lab = { ...labels, memory: '記憶' };
  const head = [user('やあ'), ...Array(10).fill(tool('/Users/u/.claude/projects/x/memory'))].join('\n');
  assert.strictEqual(classifyText({ head, tail: '' }, { labels: lab, keywords }).project, null);
});

test('手がかりが無ければ決めない(その他に残す)', () => {
  assert.strictEqual(classifyText({ head: user('こんにちは'), tail: '' }, { labels, keywords }).project, null);
});

test('僅差なら決めない', () => {
  assert.strictEqual(decide(new Map([['A', 5], ['B', 4]])), null);
  assert.strictEqual(decide(new Map([['A', 9], ['B', 4]])), 'A');
});

test('ai-title と最初の依頼を返す(タブ名に使う)', () => {
  const head = [JSON.stringify({ type: 'ai-title', aiTitle: '題名です' }), user('最初の依頼')].join('\n');
  const r = classifyText({ head, tail: '' }, { labels, keywords });
  assert.strictEqual(r.aiTitle, '題名です');
  assert.strictEqual(r.firstPrompt, '最初の依頼');
});
