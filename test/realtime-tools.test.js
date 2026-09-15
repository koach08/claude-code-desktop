// 声のまま考えるモデルに道具を渡すときの関門。
//
// ⚠️ 実行を決めるのは向こう側。「モデルがそう言ったから」で端末に文字が入らないよう、
//    こちらで確かめられる事実だけを使って止める:
//      Alfred が渡し先の名前を出して尋ねたか / そのあと本人が声を出したか /
//      その返事が断りでなかったか
const test = require('node:test');
const assert = require('node:assert');
const RT = require('../src/realtime-tools');


// ⚠️ 読みの表は既定で空 (公開リポジトリに案件名を置かないため)。
//    カタカナで名指しする試験は、自分で入れてから始める。
require('../src/voice-command').setAliases([
  ['あおぞら', 'aozora'], ['みどり', 'midori'], ['こはく', 'kohaku'],
  ['みどりおーえす', 'midorios'],
  ['ありや', 'ariya'], ['ありあ', 'ariya'],
]);

const TABS = [
  { id: 'a', name: 'AOZORA', cwd: '/x/aozora-ai', exited: false },
  { id: 'b', name: 'midori-os', cwd: '/x/midori-os', exited: false },
];

function deps() {
  const log = { sent: [], closed: [], opened: [], switched: [] };
  return {
    log,
    listTabs: () => TABS,
    openTab: async (m) => { log.opened.push(m); return { id: 'c', name: m }; },
    switchTab: (id) => log.switched.push(id),
    closeTab: async (id) => log.closed.push(id),
    sendToTab: async (id, t) => log.sent.push({ id, task: t }),
    readTab: async () => 'ビルド中\n完了',
    getHandoff: () => 'a',
  };
}

// 時計を進めながら会話を組み立てる
function scene() {
  let t = 0;
  const g = RT.createGate({ now: () => t });
  return {
    gate: g,
    alfred(text) { t += 100; g.assistantSaid(text); },
    honnin(text) { t += 100; g.heardUser(text); },
  };
}

test('読む・開く・切り替えるは、そのまま通る', async () => {
  const d = deps();
  const s = scene();
  assert.deepStrictEqual(
    (await RT.runTool('list_tabs', {}, d, s.gate)).tabs.map((t) => t.name),
    ['AOZORA', 'midori-os'],
  );
  await RT.runTool('open_tab', { mode: 'codex' }, d, s.gate);
  await RT.runTool('switch_tab', { tab: 'アオゾラ' }, d, s.gate);
  assert.deepStrictEqual(d.log.opened, ['codex']);
  assert.deepStrictEqual(d.log.switched, ['a']);
});

test('名前を出して尋ね、本人が承知すれば通る', async () => {
  const d = deps();
  const s = scene();
  s.honnin('AOZORAのタブでテストを走らせて');
  s.alfred('AOZORA のタブにテストを走らせる作業を渡します。よろしいですか。');
  s.honnin('はい、お願いします');
  const r = await RT.runTool('send_to_tab', { tab: 'AOZORA', task: 'テストを走らせて', confirmed: true }, d, s.gate);
  assert.strictEqual(r.sent_to, 'AOZORA');
  assert.strictEqual(d.log.sent.length, 1);
});

test('尋ねずに confirmed だけ立てても通さない', async () => {
  // ⚠️ 一息で「渡しますね」と実行するのを止める本丸
  const d = deps();
  const s = scene();
  s.honnin('AOZORAのタブでデプロイして');
  const r = await RT.runTool('send_to_tab', { tab: 'AOZORA', task: 'デプロイして', confirmed: true }, d, s.gate);
  assert.strictEqual(r.needs_confirmation, true);
  assert.strictEqual(d.log.sent.length, 0);
});

test('尋ねた文に渡し先の名前が無ければ通さない', async () => {
  // ⚠️ 「渡しますね」だけだと、本人はどこへ渡るのか分からないまま返事をしている
  const d = deps();
  const s = scene();
  s.alfred('では渡しますね。よろしいですか。');
  s.honnin('はい');
  const r = await RT.runTool('send_to_tab', { tab: 'AOZORA', task: 'テスト', confirmed: true }, d, s.gate);
  assert.strictEqual(r.needs_confirmation, true);
  assert.strictEqual(d.log.sent.length, 0);
});

test('尋ねたあと本人が黙っていれば通さない', async () => {
  const d = deps();
  const s = scene();
  s.honnin('AOZORAのタブでテストして');
  s.alfred('AOZORA のタブに渡します。よろしいですか。');
  // ここで本人は何も言っていない
  const r = await RT.runTool('send_to_tab', { tab: 'AOZORA', task: 'テスト', confirmed: true }, d, s.gate);
  assert.strictEqual(r.needs_confirmation, true);
  assert.match(r.reason, /返事/);
});

test('断られたら実行しないし、言い直しも通さない', async () => {
  const d = deps();
  const s = scene();
  s.alfred('AOZORA のタブに渡します。よろしいですか。');
  s.honnin('いや、やっぱりやめて');
  const r = await RT.runTool('send_to_tab', { tab: 'AOZORA', task: 'テスト', confirmed: true }, d, s.gate);
  assert.strictEqual(r.refused, true);
  assert.strictEqual(d.log.sent.length, 0);
});

test('道具を2回呼ぶ流儀でも通る', async () => {
  const d = deps();
  const s = scene();
  const first = await RT.runTool('close_tab', { tab: 'ミドリ', confirmed: false }, d, s.gate);
  assert.strictEqual(first.needs_confirmation, true);
  s.alfred('midori-os のタブを閉じます。よろしいですか。');
  s.honnin('はい');
  const r = await RT.runTool('close_tab', { tab: 'ミドリ', confirmed: true }, d, s.gate);
  assert.strictEqual(r.closed, 'midori-os');
});

test('確認したのと違う内容にすり替えても、名前と尋ねが揃っていなければ止まる', async () => {
  const d = deps();
  const s = scene();
  s.alfred('midori-os のタブを閉じます。よろしいですか。');
  s.honnin('はい');
  // 別のタブへ、別の内容で実行しようとする
  const r = await RT.runTool('send_to_tab', { tab: 'AOZORA', task: '全部消して', confirmed: true }, d, s.gate);
  assert.strictEqual(r.needs_confirmation, true);
  assert.strictEqual(d.log.sent.length, 0);
});

test('渡し先が決まらないときは候補を返す', async () => {
  const d = deps();
  d.listTabs = () => [
    { id: '1', name: 'aozora 本体', cwd: '/x/aozora-ai' },
    { id: '2', name: 'aozora worker', cwd: '/x/aozora-worker' },
  ];
  const s = scene();
  const r = await RT.runTool('switch_tab', { tab: 'アオゾラ' }, d, s.gate);
  assert.ok(r.error);
  assert.strictEqual(r.candidates.length, 2);
});

test('道具の説明と話し方の指示に、決まりが書いてある', () => {
  const send = RT.TOOLS.find((t) => t.name === 'send_to_tab');
  assert.match(send.description, /確認/);
  assert.ok(send.parameters.required.includes('confirmed'));
  assert.match(RT.INSTRUCTIONS, /です・ます調/);
  assert.match(RT.INSTRUCTIONS, /名前を口に出す/);
});

test('渡し先を省くと、いま見ているタブに渡す (名前を出して尋ねてから)', async () => {
  const d = deps();
  d.getActiveId = () => 'b';
  const s = scene();
  const lst = await RT.runTool('list_tabs', {}, d, s.gate);
  assert.ok(lst.tabs.find((t) => t.name === 'midori-os').current);
  s.honnin('スライドを直して');
  s.alfred('midori-os に渡します。よろしいですか。');
  s.honnin('はい');
  const r = await RT.runTool('send_to_tab', { task: 'スライドを直す', confirmed: true }, d, s.gate);
  assert.strictEqual(r.sent_to, 'midori-os');
  assert.deepStrictEqual(d.log.sent.map((x) => x.id), ['b']);
});

test('台帳で切り詰められた名前「…」でも、声の名指しが当たる', async () => {
  // ⚠️ 実測: 22 本全部のタブ名に「…」が付いていて、本物の確認まで弾いていた
  const d = deps();
  d.listTabs = () => [{ id: 'z', name: 'ariya bridge updateしたい…', cwd: '/x/ariya', exited: false }];
  const s = scene();
  s.honnin('音声を自然にして');
  s.alfred('ariya bridge updateしたい に渡します。よろしいですか。');
  s.honnin('お願いします');
  const r = await RT.runTool('send_to_tab', { tab: 'ariya bridge updateしたい', task: '音声を自然に', confirmed: true }, d, s.gate);
  assert.strictEqual(r.sent_to, 'ariya bridge updateしたい…');
});

test('1 回目を止めたあと本人が答えれば、依頼文を言い換えていても通る', async () => {
  // ⚠️ 鍵に task を入れていたので、2 回目の言い換えで「別の用件」扱いになり永久に通らなかった
  const d = deps();
  const s = scene();
  s.honnin('テストして');
  const r1 = await RT.runTool('send_to_tab', { tab: 'AOZORA', task: 'テストを走らせる', confirmed: true }, d, s.gate);
  assert.strictEqual(r1.sent, false);
  assert.match(r1.reason, /まだ渡していません/);
  s.alfred('AOZORA に渡します。よろしいですか。');
  s.honnin('はい');
  const r2 = await RT.runTool('send_to_tab', { tab: 'AOZORA', task: 'テストを実行して結果を報告', confirmed: true }, d, s.gate);
  assert.strictEqual(r2.sent_to, 'AOZORA');
});

test('渡し先がいま見ているタブなら「このタブに渡します」でも名指しとして通る', async () => {
  const d = deps();
  d.getActiveId = () => 'a';
  const s = scene();
  s.honnin('スライドを直して');
  s.alfred('いま見ているタブに渡します。よろしいですか。');
  s.honnin('よろしいです');
  const r = await RT.runTool('send_to_tab', { task: 'スライドを直す', confirmed: true }, d, s.gate);
  assert.strictEqual(r.sent_to, 'AOZORA');
});

test('会話の最初の一手で止めても待ちを記録し、本人の返事で通る', async () => {
  const d = deps();
  const s = scene();
  s.honnin('テストして');                     // まだ Alfred は何も言っていない
  const r1 = await RT.runTool('send_to_tab', { tab: 'AOZORA', task: 'テスト', confirmed: true }, d, s.gate);
  assert.strictEqual(r1.sent, false);
  s.alfred('AOZORA に渡します。よろしいですか。');
  s.honnin('よろしいです');
  const r2 = await RT.runTool('send_to_tab', { tab: 'AOZORA', task: 'テスト', confirmed: true }, d, s.gate);
  assert.strictEqual(r2.sent_to, 'AOZORA');
});

test('長いタブ名は一部を口にしていれば名指しと見る', async () => {
  const d = deps();
  d.listTabs = () => [{ id: 'z', name: '授業のスライド作成を再開したい…', cwd: '/x/slides', exited: false }];
  const s = scene();
  s.honnin('スライドを見て');
  s.alfred('スライド作成のタブにチェックを頼みます。よろしいですか？');
  s.honnin('よろしいです');
  const r = await RT.runTool('send_to_tab', { tab: '授業のスライド作成を再開したい', task: '見る', confirmed: true }, d, s.gate);
  assert.strictEqual(r.sent_to, '授業のスライド作成を再開したい…');
});
