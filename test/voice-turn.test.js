// 音声で往復するときの判断が、事故を起こさないことを見張る。
//
// ここで固定するのは 4 つ:
//   自分の声を拾って回らない / 二重に送らない / 誤送信しない / 会話を勝手に走らせない

const test = require('node:test');
const assert = require('node:assert');
const V = require('../src/voice-turn');

test('読み上げ中は録音できない（自分の声を拾って回らない）', () => {
  assert.equal(V.canRecord('speaking'), false);
  assert.equal(V.canRecord('recording'), false);
  assert.equal(V.canRecord('transcribing'), false);
  assert.equal(V.canRecord('thinking'), false);
  assert.equal(V.canRecord('idle'), true);
});

test('読み上げ中にマイクを押すと、割り込みになる', () => {
  assert.equal(V.onMicPress('speaking'), 'barge_in');
  assert.equal(V.nextState('speaking', 'barge_in'), 'recording');
});

test('文字にしている間・考えている間は、押しても何も起きない', () => {
  assert.equal(V.onMicPress('transcribing'), 'none');
  assert.equal(V.onMicPress('thinking'), 'none');
});

test('ひと回りの状態が想定どおり流れる', () => {
  let s = 'idle';
  s = V.nextState(s, 'start');      assert.equal(s, 'recording');
  s = V.nextState(s, 'stop');       assert.equal(s, 'transcribing');
  s = V.nextState(s, 'got_text');   assert.equal(s, 'thinking');
  s = V.nextState(s, 'got_reply');  assert.equal(s, 'speaking');
  s = V.nextState(s, 'done');       assert.equal(s, 'idle');
});

test('知らない出来事では状態が動かない', () => {
  assert.equal(V.nextState('idle', 'got_reply'), 'idle');
  assert.equal(V.nextState('speaking', 'start'), 'speaking');
});

test('どの状態にも表示の名前がある', () => {
  for (const s of V.STATES) assert.ok(V.LABEL[s], `${s} の表示が無い`);
});

test('送信中は次の送信を断る', () => {
  const g = V.makeSendGuard();
  assert.equal(g.check('直して').ok, true);
  g.begin('直して');
  const r = g.check('別のこと');
  assert.equal(r.ok, false);
  assert.match(r.reason, /まだ動いています/);
  g.end();
  assert.equal(g.check('別のこと').ok, true);
});

test('同じ文が続けて来たら断る（押し間違い・二重認識）', () => {
  let t = 1000;
  const g = V.makeSendGuard(() => t);
  g.begin('テストを走らせて'); g.end();
  t += 3000;
  const r = g.check('テストを走らせて');
  assert.equal(r.ok, false);
  assert.match(r.reason, /同じ依頼/);
  // 時間が経てば通す
  t += V.DUP_WINDOW_MS;
  assert.equal(g.check('テストを走らせて').ok, true);
});

test('空の文は送らない', () => {
  const g = V.makeSendGuard();
  assert.equal(g.check('').ok, false);
  assert.equal(g.check('   ').ok, false);
});

test('質問は会話として扱う（勝手に走らせない）', () => {
  for (const q of ['いまどうなってる', '何が残ってる', 'テストは通った？',
                   'どっちがいいと思う', '状況を教えて']) {
    assert.equal(V.classify(q).kind, 'talk', `「${q}」が work になった`);
  }
});

test('はっきりした作業の言い方だけを作業依頼にする', () => {
  for (const w of ['このバグを直して', 'テストを走らせて', '認証を実装して',
                   'デプロイして', 'その行を消して']) {
    assert.equal(V.classify(w).kind, 'work', `「${w}」が talk になった`);
  }
});

test('迷ったら会話に倒す', () => {
  assert.equal(V.classify('うーん').kind, 'talk');
  assert.equal(V.classify('なるほどね').kind, 'talk');
  // 「確認して」は語としては作業だが、質問形なら会話
  assert.equal(V.classify('あれ確認してくれた？').kind, 'talk');
});

test('渡し先が無い・消えた・終わったタブには渡さない', () => {
  const tabs = [{ id: 'a', cwd: '/x' }, { id: 'b', cwd: '/y', exited: true }];
  assert.equal(V.checkTarget('', tabs).ok, false);
  assert.equal(V.checkTarget('zzz', tabs).ok, false);
  assert.match(V.checkTarget('zzz', tabs).reason, /もうありません/);
  assert.equal(V.checkTarget('b', tabs).ok, false);
  assert.match(V.checkTarget('b', tabs).reason, /終わっています/);
  assert.equal(V.checkTarget('a', tabs).ok, true);
});

test('選んだときと場所が変わったタブには渡さない', () => {
  const tabs = [{ id: 'a', cwd: '/新しい場所' }];
  const r = V.checkTarget('a', tabs, { expectCwd: '/選んだときの場所' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /場所が変わって/);
  assert.equal(V.checkTarget('a', tabs, { expectCwd: '/新しい場所' }).ok, true);
});

test('送るのは直近の往復だけに切る', () => {
  const h = [];
  for (let i = 0; i < 40; i++) h.push({ role: 'user', content: `${i}` });
  const out = V.forSending(h);
  assert.equal(out.length, V.SEND_TURNS);
  assert.equal(out[out.length - 1].content, '39');
});

test('壊れた履歴は落とす', () => {
  const out = V.forSending([{ role: 'user', content: 'ok' }, null, { role: 'user' }, {}]);
  assert.equal(out.length, 1);
});

// ── 読み上げの区切り ──────────────────────────────────────────
test('先頭の一文だけ先に鳴らせるように切る', () => {
  const c = V.chunksForSpeech('3つ開いています。AOZORA、midori-os、ariya bridge です。どれを見ますか。');
  assert.strictEqual(c.length, 3);
  assert.strictEqual(c[0], '3つ開いています。');
});

test('短すぎる断片は次とくっつける（不自然に切れて聞こえるため）', () => {
  const c = V.chunksForSpeech('はい。AOZORA のタブに渡しました。');
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0], 'はい。AOZORA のタブに渡しました。');
});

test('末尾が短いときは前にくっつける', () => {
  const c = V.chunksForSpeech('ビルドは通りました。テストも全部通っています。以上。');
  assert.strictEqual(c[c.length - 1].endsWith('以上。'), true);
  assert.ok(c[c.length - 1].length >= V.MIN_CHUNK);
});

test('空なら何も鳴らさない', () => {
  assert.deepStrictEqual(V.chunksForSpeech(''), []);
  assert.deepStrictEqual(V.chunksForSpeech('   '), []);
});
