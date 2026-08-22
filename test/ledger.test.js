// タブ台帳の読み書きの回帰テスト。
// この1ファイルが壊れると全タブが一度に消えるので、壊れ方を先に固定しておく。
//   実行: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveLedger, loadLedger, dedupeConversationIds, MAIN, PREV } = require('../src/ledger');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ariya-ledger-'));
const TABS = [
  { id: 'a', name: 'CC Desktop', cwd: '/x', mode: 'claude', conversationId: 'conv-a' },
  { id: 'b', name: '仮想通貨AI', cwd: '/y', mode: 'claude', conversationId: 'conv-b' },
];

test('書いたものがそのまま読める', () => {
  const d = tmpdir();
  saveLedger(d, TABS);
  const { sessions, from } = loadLedger(d);
  assert.deepStrictEqual(sessions, TABS);
  assert.strictEqual(from, 'main');
});

test('台帳が無ければ空を返す', () => {
  const { sessions, from } = loadLedger(tmpdir());
  assert.deepStrictEqual(sessions, []);
  assert.strictEqual(from, 'none');
});

test('書き込み途中で切れた台帳から復帰する(全滅させない)', () => {
  const d = tmpdir();
  saveLedger(d, TABS);          // 1回目: 正常
  saveLedger(d, TABS);          // 2回目: prev に完全な内容が残る
  // プロセスが書き込み中に落ちた状況を再現する
  fs.writeFileSync(path.join(d, MAIN), '[\n  {\n    "id": "a",\n    "na');
  const { sessions, from } = loadLedger(d);
  assert.strictEqual(from, 'prev', '壊れた台帳から復帰していない');
  assert.strictEqual(sessions.length, 2);
  assert.strictEqual(sessions[0].conversationId, 'conv-a');
});

test('中身が空(全タブを閉じた)は正当な状態として尊重する', () => {
  const d = tmpdir();
  saveLedger(d, TABS);
  saveLedger(d, []);            // 全部閉じた
  const { sessions, from } = loadLedger(d);
  assert.deepStrictEqual(sessions, [], '閉じたはずのタブが蘇っている');
  assert.strictEqual(from, 'main');
});

test('配列でないものが入っていたら壊れていると見なす', () => {
  const d = tmpdir();
  saveLedger(d, TABS);
  saveLedger(d, TABS);
  fs.writeFileSync(path.join(d, MAIN), '{"oops": true}');
  assert.strictEqual(loadLedger(d).from, 'prev');
});

test('本体も退避分も壊れていたら空に落ちる(例外は投げない)', () => {
  const d = tmpdir();
  saveLedger(d, TABS);
  fs.writeFileSync(path.join(d, MAIN), 'garbage');
  fs.writeFileSync(path.join(d, PREV), 'garbage');
  const { sessions, from } = loadLedger(d);
  assert.deepStrictEqual(sessions, []);
  assert.strictEqual(from, 'none');
});

test('一時ファイルを残さない', () => {
  const d = tmpdir();
  saveLedger(d, TABS);
  const leftovers = fs.readdirSync(d).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], `.tmp が残っている: ${leftovers}`);
});

test('ディレクトリが無ければ作る', () => {
  const d = path.join(tmpdir(), 'nested', 'deeper');
  saveLedger(d, TABS);
  assert.strictEqual(loadLedger(d).sessions.length, 2);
});

// ── 会話の重複解除 ───────────────────────────────────────────────
// v1.5.3 以前の検出ミスで、同じ会話を複数タブが掴んだ台帳が実際に出来ている。
// そのまま復元すると `claude --resume <同じID>` が同時に何本も走る。
test('同じ会話を掴んだタブは先頭だけが引き継ぐ', () => {
  const { sessions, stripped } = dedupeConversationIds([
    { id: '1', name: 'A', conversationId: 'x' },
    { id: '2', name: 'B', conversationId: 'x' },
    { id: '3', name: 'C', conversationId: 'y' },
  ]);
  assert.strictEqual(sessions[0].conversationId, 'x');
  assert.strictEqual(sessions[1].conversationId, null, '2つ目が同じ会話を掴んだまま');
  assert.strictEqual(sessions[2].conversationId, 'y');
  assert.strictEqual(stripped.length, 1);
  assert.strictEqual(stripped[0].tab, 'B');
});

test('重複を外してもタブ自体は消さない', () => {
  const input = Array.from({ length: 5 }, (_, i) => ({ id: String(i), conversationId: 'same' }));
  const { sessions } = dedupeConversationIds(input);
  assert.strictEqual(sessions.length, 5, 'タブが減っている');
  assert.strictEqual(sessions.filter((s) => s.conversationId === 'same').length, 1);
});

test('会話IDを持たないタブはそのまま通す', () => {
  const input = [{ id: '1', conversationId: null }, { id: '2' }, { id: '3', conversationId: 'z' }];
  const { sessions, stripped } = dedupeConversationIds(input);
  assert.deepStrictEqual(sessions, input);
  assert.strictEqual(stripped.length, 0);
});

test('重複が無ければ何も変えない', () => {
  const input = [{ id: '1', conversationId: 'a' }, { id: '2', conversationId: 'b' }];
  const { sessions, stripped } = dedupeConversationIds(input);
  assert.deepStrictEqual(sessions, input);
  assert.strictEqual(stripped.length, 0);
});

test('実際の台帳の形(13タブ/会話7本)を通しても件数が変わらない', () => {
  // 稼働中の 1.5.3 が実際に書いた分布を再現する
  const dist = { '06bf4492': 5, a010025f: 2, '00f14067': 2, '17bfbe21': 1, ed13a68a: 1, a6c3f93b: 1, '9534f6e5': 1 };
  const input = [];
  for (const [cid, n] of Object.entries(dist)) {
    for (let i = 0; i < n; i++) input.push({ id: `${cid}-${i}`, conversationId: cid });
  }
  const { sessions, stripped } = dedupeConversationIds(input);
  assert.strictEqual(sessions.length, 13, 'タブ数が変わった');
  assert.strictEqual(sessions.filter((s) => s.conversationId).length, 7, '生き残る会話が7本でない');
  assert.strictEqual(stripped.length, 6, '外された重複が6件でない');
});
