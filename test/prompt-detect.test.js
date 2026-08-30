const test = require('node:test');
const assert = require('node:assert');
const { isAwaitingUser, cleanTail } = require('../src/prompt-detect');

// ここに並ぶ「本物」は、実際のタブのバッファ(~/.claude-code-app/buffers/*.buf)に
// 入っていた形をそのまま写したもの。個人の作業内容にあたる部分だけ置き換えてある。
// 「偽」は、旧判定が実データで実際に誤検出していた文字列。

// ── 本物: 人間が答えるまで先へ進まない画面 ──────────────────────

test('Codex の許可プロンプト', () => {
  const tail = "  $ zsh -n build.sh\n › 1. Yes, proceed (y)\n   2. Yes, and don't ask again for commands that start with `zsh -n build.sh` (p)\n   3. No, and tell Codex what to do differently (esc)\n\n Press enter to confirm or esc to cancel";
  assert.ok(isAwaitingUser(tail));
});

test('Codex の許可プロンプト(選択肢が2つの版)', () => {
  const tail = ' › 1. Yes, proceed (y)\n   2. No, and tell Codex what to do differently (esc)\n\n Press enter to confirm or esc to cancel';
  assert.ok(isAwaitingUser(tail));
});

test('Claude Code の再開ピッカー(マーカーと数字がくっつく)', () => {
  const tail = '❯1. Resume from summary (recommended)\n 2. Resume full session as-is';
  assert.ok(isAwaitingUser(tail), 'マーカーの直後に数字が来る形を取り逃している');
});

test('選択式の質問も「あなた待ち」として拾う', () => {
  // 承認ではないが、答えるまでタブは止まっている。ボードでは同じ扱いにする。
  const tail = '❯ 1. 先に机上で詰める\n  2. すぐ実装に入る\n  3. 今夜はここまで';
  assert.ok(isAwaitingUser(tail));
});

test('文字装飾で分断されていても掃除して拾う', () => {
  const raw = '\x1b[1m\x1b[38;5;6m›\x1b[0m \x1b[1m1.\x1b[0m Yes, proceed \x1b[2m(y)\x1b[0m';
  assert.ok(isAwaitingUser(raw));
});

test('素の CLI の (y/n) は行末にあれば拾う', () => {
  assert.ok(isAwaitingUser('Overwrite existing file? (y/n)'));
});

test('マーカーを描かない版の許可プロンプトも取り逃さない', () => {
  // 実バッファには1件も残っていなかった形。決まり文句と番号付きの Yes が
  // 両方揃ったときだけ通す(片方だけでは通さない)。
  assert.ok(isAwaitingUser('Do you want to proceed?\n  1. Yes\n  2. No'));
});

// ── 偽: 旧判定が実データで誤って承認待ちにしていたもの ──────────────

test('文章中の allow / approve / permission で発火しない', () => {
  // 旧 renderer の判定 /Allow|approve|permission/i は、実データの 2966 チャンク中
  // 147 回発火し、その全部がこの種の誤検出だった(本物は1件も含まない)。
  const prose = 'This change will allow the caller to approve the request later; '
    + 'the permission check itself lives in auth.ts and PermissionError is raised there.';
  assert.ok(!isAwaitingUser(prose));
});

test('コマンド行に "1. Yes" と書いてあるだけでは発火しない', () => {
  // 旧 board の判定は ❯ を省略可にしていたため、grep の引数が画面に出ただけで
  // 承認待ちになっていた(実データで確認)。
  const echoed = 'for pat in "Do you want" "No, and tell" "1. Yes" "y/n"; do grep -l -F "$pat" *.buf; done';
  assert.ok(!isAwaitingUser(echoed));
});

test('決まり文句だけ、番号付き Yes だけでは発火しない', () => {
  assert.ok(!isAwaitingUser('Do you want to proceed with the migration first?'));
  assert.ok(!isAwaitingUser('手順は 1. Yes を選ぶ、2. その後に確認する、の順です'));
});

test('文章中の (y/n) は行末でなければ拾わない', () => {
  assert.ok(!isAwaitingUser('引数は (y/n) のどちらかを渡してください。詳しくは README を見てください。'));
});

test('空・undefined でも落ちない', () => {
  assert.ok(!isAwaitingUser(''));
  assert.ok(!isAwaitingUser(undefined));
  assert.ok(!isAwaitingUser(null));
});

// ── 掃除そのもの ────────────────────────────────────────────

test('制御シーケンスを落としても本文は残る', () => {
  const raw = '\x1b[38;5;180m色つき\x1b[0m\x1b[>4m\x1b[<u\x1b]0;タイトル\x07のこる';
  const out = cleanTail(raw);
  assert.ok(!/\x1b/.test(out));
  assert.ok(out.includes('色つき') && out.includes('のこる'));
});

test('ブラウザ側でも同じ規則が読める形になっている', () => {
  // renderer は require が使えないので <script> で読み込む。UMD の分岐が壊れると
  // 通知だけ旧挙動に戻る、という気付きにくい壊れ方をするため固定しておく。
  const vm = require('node:vm');
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'prompt-detect.js'), 'utf-8');
  const win = {};
  vm.createContext(win);
  vm.runInContext(src, win);          // module が無い = ブラウザと同じ条件
  assert.strictEqual(typeof win.AriyaPrompt?.isAwaitingUser, 'function',
    'window.AriyaPrompt が生えていない');
  assert.ok(win.AriyaPrompt.isAwaitingUser(' › 1. Yes, proceed (y)'));
});

// ── 答え終わったあと: 選択肢の枠が残っていても待ちではない ──────────
//
// 2026-08-29 に Gemini が指摘し、実バッファ(24本・痕跡36件)で裏を取った。
// 痕跡は全部が末尾から 24,043 字以上うしろ = すでに答えて出力が流れた跡。
// 窓を切らないと、これらが「あなた待ち」として永久に残る。

test('答えたあとに出力が続いたら、待ちではない', () => {
  const tail = ' › 1. Yes, proceed (y)\n   2. No, and tell Codex what to do differently (esc)\n'
    + 'Committing changes...\n'
    + 'Done! Successfully pushed to main.\n'
    + 'x'.repeat(2000);
  assert.strictEqual(isAwaitingUser(tail), false);
});

test('古い選択肢が視界の外にあるだけなら、待ちではない', () => {
  const tail = '❯1. Resume from summary\n  2. Start fresh\n' + '作業ログ '.repeat(500);
  assert.strictEqual(isAwaitingUser(tail), false);
});

test('答えたあとでも直後で静かなら拾う(距離では割り切れない残り)', () => {
  // 出力がほとんど無いまま止まった場合は区別できない。
  // board 側で「5秒以上静か」を併用して初めて意味を持つ、という前提を明示しておく。
  const tail = ' › 1. Yes, proceed (y)\n   2. No (esc)\nok\n';
  assert.strictEqual(isAwaitingUser(tail), true);
});

test('待ちの最中は末尾に枠があるので拾える', () => {
  const noise = '前の作業の出力\n'.repeat(300);
  const tail = noise + '\n Do you want to proceed?\n › 1. Yes, proceed (y)\n   2. No (esc)\n\n Press enter to confirm';
  assert.ok(isAwaitingUser(tail));
});

// ── 会話の再開ピッカー ────────────────────────────────────────
//
// 2026-08-29 に `claude --resume` を pty で起こして実物を取った。
// 番号付き選択肢ではなくマーカー＋会話タイトルなので、SELECT_PROMPT では
// 一生拾えていなかった。以下は実物の形（会話タイトルだけ差し替え）。

test('会話の再開ピッカーを待ちとして拾う', () => {
  const tail = '╭──────────────────────────────╮\r│⌕ Search…│\r╰──────────────────────────────╯\r'
    + '❯ある案件の修正\r4 days ago · HEAD · 22.3MB\r'
    + '別の案件の実装\r5 days ago · main · 2.3MB\r'
    + 'Ctrl+A to show all projects · Type to search · Esc to cancel';
  assert.ok(isAwaitingUser(tail));
});

test('マーカーだけでは拾わない(入力行の ❯ で誤検出しないため)', () => {
  // 実バッファ24本中19本が末尾窓に ❯ を持っていた。単独条件にすると全部誤検出になる。
  const tail = '作業が終わりました。次は何をしますか。\n❯ ';
  assert.strictEqual(isAwaitingUser(tail), false);
});

test('フッターの決まり文句だけでも拾わない', () => {
  const tail = 'ピッカーの操作は Esc to cancel でしたね、と説明している文章です。';
  assert.strictEqual(isAwaitingUser(tail), false);
});
