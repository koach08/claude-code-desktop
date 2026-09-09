const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/voice-command');


// ⚠️ 読みの表は既定で空 (公開リポジトリに案件名を置かないため)。
//    カタカナで名指しする試験は、自分で入れてから始める。
require('../src/voice-command').setAliases([
  ['あおぞら', 'aozora'], ['みどり', 'midori'], ['こはく', 'kohaku'],
  ['みどりおーえす', 'midorios'],
  ['ありや', 'ariya'], ['ありあ', 'ariya'],
]);

// 実際に開いているタブの形に合わせる (renderer の listTabs と同じ)
const TABS = [
  { id: 'a', name: 'AOZORA', cwd: '/work/aozora-ai', exited: false },
  { id: 'b', name: 'midori-os', cwd: '/work/midori-os', exited: false },
  { id: 'c', name: 'Ariya Bridge', cwd: '/work/ariya-bridge', exited: false },
  { id: 'd', name: 'kohaku', cwd: '/work/kohaku', exited: true },
];

// ── 名指しの解決 ──────────────────────────────────────────────
test('カタカナの読みで綴りのタブに当たる', () => {
  assert.strictEqual(C.resolveTab('アオゾラ', TABS).tab.id, 'a');
  assert.strictEqual(C.resolveTab('ミドリオーエス', TABS).tab.id, 'b');
});

test('書き起こしが「アリア」と間違えても Ariya のタブに当たる', () => {
  // ⚠️ 実測でこの誤りが出た。綴り一致に頼らないことの確認
  assert.strictEqual(C.resolveTab('アリア', TABS).tab.id, 'c');
});

test('綴りそのままでも当たる', () => {
  assert.strictEqual(C.resolveTab('aozora', TABS).tab.id, 'a');
  assert.strictEqual(C.resolveTab('AOZORA', TABS).tab.id, 'a');
});

test('終わったタブは選ばない', () => {
  const r = C.resolveTab('kohaku', TABS);
  assert.strictEqual(r.ok, false);
});

test('複数当てはまるときは実行せず候補を返す', () => {
  const tabs = [
    { id: '1', name: 'aozora 本体', cwd: '/x/aozora-ai' },
    { id: '2', name: 'aozora worker', cwd: '/x/aozora-worker' },
  ];
  const r = C.resolveTab('アオゾラ', tabs);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.candidates.length, 2);
});

test('無いものは無いと言う', () => {
  assert.strictEqual(C.resolveTab('存在しない案件', TABS).ok, false);
});

// ── エンジンの切り替え ────────────────────────────────────────
test('アストラを指名できる', () => {
  const e = C.readEngine('アストラでお願い');
  assert.strictEqual(e.provider, 'openai');
  assert.strictEqual(e.model, 'gpt-6-astra');
});

test('クロードに戻せる', () => {
  assert.strictEqual(C.readEngine('クロードに戻して').provider, 'claude');
});

test('タブの話をエンジン切り替えと読み違えない', () => {
  // ⚠️ ここが混ざると「Codex のタブを開いて」で声の相手が変わってしまう
  assert.strictEqual(C.readEngine('Claude Code のタブを開いて'), null);
  assert.strictEqual(C.readEngine('ジェミニのタブに切り替えて'), null);
});

test('切り替えの言い方が無ければエンジンとは読まない', () => {
  assert.strictEqual(C.readEngine('クロードはどう思う'), null);
});

// ── 読み取り ──────────────────────────────────────────────────
const ctx = { tabs: TABS, activeId: 'c' };

test('黙れは即座に効く', () => {
  assert.strictEqual(C.parse('黙って', ctx).kind, 'hush');
});

test('タブの一覧を聞かれたら一覧で返す', () => {
  assert.strictEqual(C.parse('いま何のタブが開いてる', ctx).kind, 'list');
});

test('新しいタブはレーンまで読む', () => {
  assert.strictEqual(C.parse('新しいタブを開いて', ctx).mode, 'claude');
  assert.strictEqual(C.parse('Codex のタブを開いて', ctx).mode, 'codex');
  assert.strictEqual(C.parse('ターミナルのタブを開いて', ctx).mode, 'terminal');
});

test('作業の引き渡しは名指しを解いたうえで確認を要る', () => {
  const r = C.parse('アオゾラのタブでテストして', ctx);
  assert.strictEqual(r.kind, 'work');
  assert.strictEqual(r.tab.id, 'a');
  assert.strictEqual(r.confirm, true);
});

test('このタブ、と言われたら今のタブに渡す', () => {
  const r = C.parse('このタブでビルドして', ctx);
  assert.strictEqual(r.kind, 'work');
  assert.strictEqual(r.tab.id, 'c');
});

test('渡し先が決まらない作業依頼は実行せず聞き返す', () => {
  const r = C.parse('テストして', ctx);
  assert.strictEqual(r.kind, 'ask');
  assert.strictEqual(r.task, 'テストして');
});

test('タブを閉じるのは必ず確認を通す', () => {
  const r = C.parse('アオゾラのタブを閉じて', ctx);
  assert.strictEqual(r.kind, 'close');
  assert.strictEqual(r.confirm, true);
});

test('普通の会話は会話のまま', () => {
  assert.strictEqual(C.parse('今日はよく寝られた', ctx).kind, 'talk');
  assert.strictEqual(C.parse('RIPE の論文って採択されたんだっけ', ctx).kind, 'talk');
});

test('進捗は名指しでも、渡した先でも読める', () => {
  assert.strictEqual(C.parse('どうなってる', ctx).kind, 'progress');
  assert.strictEqual(C.parse('アオゾラのタブどこまで進んだ', ctx).tab.id, 'a');
});

// ── 復唱の確認 ────────────────────────────────────────────────
test('はいで実行、いいえで取り消し', () => {
  const cf = C.makeConfirmer();
  const intent = { kind: 'work', tab: TABS[0], task: 'テストして' };
  const said = cf.ask(intent);
  assert.match(said, /AOZORA/);
  assert.strictEqual(cf.answer('はい').verdict, 'yes');

  cf.ask(intent);
  assert.strictEqual(cf.answer('やっぱりやめて').verdict, 'no');
});

test('はい・いいえ以外が来たら待っていた用件は捨てる', () => {
  // ⚠️ 別の話をしたのに、前の依頼が後から走るのがいちばん危ない
  const cf = C.makeConfirmer();
  cf.ask({ kind: 'close', tab: TABS[0] });
  assert.strictEqual(cf.answer('ところで今日の予定は').verdict, 'other');
  assert.strictEqual(cf.pending, null);
});

test('確認は放っておくと時間切れになる', () => {
  let t = 0;
  const cf = C.makeConfirmer(() => t);
  cf.ask({ kind: 'close', tab: TABS[0] });
  t = C.CONFIRM_TTL_MS + 1;
  assert.strictEqual(cf.pending, null);
});
