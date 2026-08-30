// 「そのタブが人間の返事を待って止まっているか」の判定。
//
// main(ボード表示) と renderer(通知・バッジ) の両方から同じ規則を使うため、
// Node の require とブラウザの <script> の両方で読めるようにしてある。
//
// ── なぜ作り直したか (実測: ~/.claude-code-app/buffers の19タブ・14MB) ──
//
// 旧: renderer は /\? ?\(y\/n\)|Allow|approve|permission/i で判定していた。
//     4KB刻みで当てると 2966 チャンク中 147 回発火し、**その全部が誤り**だった。
//     引き金は文章中の "allow"(133回) と "approve"(14回)。本物の許可プロンプトは
//     1件も含まれていない。しかもチャンクごとに Notification を出すので、
//     Claude が allow という単語を書くたびに「承認待ち」の通知が飛んでいた。
//
// 旧: board 側は /❯?\s*1\.\s*Yes/ を見ていた。❯ が省略可能なので、
//     ターミナルに `"1. Yes"` という文字列が流れただけで承認待ちになった
//     (実データで 8窓中 4窓が、grep コマンドの echo による誤検出)。
//
// 新: 選択マーカー(❯ › ▶)＋番号付き選択肢 の形だけを見る。TUI が描く枠であって
//     文章には現れない。実データでは 3695窓中 49窓が該当し、誤検出は 0。
//     内訳は Codex の許可プロンプト、Claude Code の再開ピッカー、選択式の質問。
//     どれも「人間が答えるまで進まない」状態なので、同じ扱いでよい。

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AriyaPrompt = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // PTY の生出力から、判定に使える見える文字だけを取り出す。
  // 実際のバッファは ANSI のカーソル移動・色指定・OSC(タイトル設定)が大量に混ざっており、
  // 素で正規表現を当てると「1. Yes」のような並びが色コードで分断されて拾えない。
  function cleanTail(raw, chars = 2000) {
    return String(raw || '')
      .slice(-chars * 4)                                   // 制御文字ぶん多めに取る
      // CSI。パラメータに < > = が入る種類(キーボードプロトコルの \x1b[>4m, \x1b[<u 等)が
      // 実バッファに大量に出るので、それらも含めて落とす。
      .replace(/\x1b\[[0-9;?<>=!]*[ -\/]*[a-zA-Z~]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC (タイトル等)
      .replace(/\x1b[()][AB0]/g, '')                       // 文字集合切替
      .replace(/\x1b[=>78]/g, '')                          // カーソル保存/復帰など
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .slice(-chars);
  }

  // TUI が描く選択肢の枠。マーカーの直後に「数字.」と中身が続くこと。
  // 例: `› 1. Yes, proceed (y)` / `❯1. Resume from summary (recommended)` / `❯ 2. …`
  //
  // マーカーの前は行頭か空白であることを求める。これが無いと、プロンプトの形を
  // **説明した文章** に当たる。実バッファで実際に起きていた:
  //   「本物のプロンプトは必ず選択マーカー＋番号付きの選択肢の形で描かれます。
  //     Codexの› 1. Yes, proceed (y)、ClaudeCode…」
  // (この判定を直したときの説明文そのもの)。20窓 → 10窓に減る。
  //
  // ⚠️ それでも地の文を completely には分離できない。プロンプトを **引用** すると
  // 本物と同じ並びになるため。原理的に無理なので、ツール自身が出す合図
  // (下の titleSaysWaiting) を主に、この判定を従にする。
  const SELECT_PROMPT = /(?:^|[\s\r\n])[❯›▶][ \t]*\d+\.[ \t]*\S/;

  // 素の CLI が使う y/n。行末にあることを求めて、文章中の "(y/n)" と分ける。
  const SHELL_YESNO = /\((?:y\/n|Y\/n|y\/N)\)\s*[?:]?\s*$/im;

  // 会話の再開ピッカー (`claude --resume` の一覧)。
  //
  // ── 2026-08-29: 実物を pty で捕まえて分かったこと ──
  // ここは **番号付きの選択肢ではない**。マーカーの直後に会話のタイトルが来る:
  //   `❯api.ts の detail 削除バグ修正`
  //   `4 days ago · HEAD · 22.3MB`
  // したがって SELECT_PROMPT (マーカー+数字.) には一生かからず、
  // いちばん人間を待たせる画面が「待機」に見えていた。
  // (コメントに書いてあった `❯1. Resume from summary` は別画面のほう。)
  //
  // マーカーだけを条件にすると、実バッファ 24 本中 19 本が該当してしまう
  // (Claude Code の入力行そのものが ❯ を使うため)。フッターの決まり文句と
  // 併せて初めて絞れる。実測: フッター単独でも 24 本中 0 本、併用でも 0 本。
  const PICKER_FOOTER = /Esc to cancel/i;
  const PICKER_MARKER = /[❯›▶]/;

  // 保険。Claude Code の許可プロンプトは実バッファに1件も残っていなかった
  // (全タブが自動承認で走っていたため)。マーカーを描かない版が来ても取り逃さない
  // よう、決まり文句と番号付きの Yes が **両方** 揃ったときだけ通す。
  // 片方だけだと、Claude が文章中に書いた同じ語で誤検出する。
  const ASK_PHRASE = /Do you want to proceed\?/i;
  const NUMBERED_YES = /\d+\.\s*(?:Yes|はい)\b/;

  // 判定に使うのは掃除後の「末尾」だけ。
  //
  // ── なぜ窓を切るか (2026-08-29 実測: buffers 24本) ──
  // 人間が答え終わったあとも、選択肢の枠はスクロールバックに残り続ける。
  // 窓を切らないと「回答済みのプロンプトが視界にある」だけで待ち状態と判定され、
  // タブが永久に「あなた待ち」に貼り付く。
  // 実バッファのプロンプト痕跡は 36 件あり、その **全部** が末尾から
  // 24,043 文字以上うしろ(= すでに答えて出力が流れた跡)だった。
  // 本当に待っている間に描かれるのは選択肢とヒント行くらいなので、
  // 末尾 1500 字を見れば足りる。この幅なら実データの 36 件は全部落ちる。
  const TAIL_WINDOW = 1500;

  // ── ツール自身が名乗る合図(2026-08-30 実測) ──
  //
  // Codex は人間の操作を待っている間、ウィンドウタイトルを
  //   \x1b]0;[ ! ] Action Required | <user>\x07
  //   \x1b]0;[ . ] Action Required | <user>\x07
  // と交互に書き続ける。実バッファで 192 回。これは推測ではなく、ツールが
  // 「人間の操作が要る」と名指しで言っている、いちばん確かな合図。
  //
  // 厄介なのは、この点滅が **出力として途切れない** こと。board は
  // 「直近5秒に出力があれば作業中」と見るので、いちばん人間を呼ぶべきタブが
  // 「作業中」のまま固定され、通知も出なかった。しかも cleanTail が OSC を
  // 捨てるので、テキスト側の判定にも回っていなかった。
  //
  // 見るのは **最後の** タイトルだけ。答えるとタイトルは戻るので、途中に
  // Action Required が残っていても、最後がそれでなければ待ちではない。
  const OSC_TITLE = /\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  const TITLE_WAITING = /Action Required/i;

  function lastWindowTitle(raw) {
    const t = String(raw || '').slice(-20000);
    const re = new RegExp(OSC_TITLE.source, 'g');
    let m, last = null;
    while ((m = re.exec(t))) last = m[1];
    return last;
  }

  // 生の出力を渡すこと。掃除したあとでは OSC が落ちていて判定できない。
  //
  // 戻り値は三値:
  //   true  … タイトルが「人間の操作が要る」と言っている
  //   false … タイトルは読めたが、そうは言っていない(= 待ちではない)
  //   null  … タイトルを出さないツール。テキスト側の判定に任せる
  // false と null を分けるのは、タイトルを出すツールについては **タイトルのほうを
  // 本当とみなす** ため。答えたあとも選択肢の枠は画面に残るが、タイトルは戻る。
  function titleSaysWaiting(raw) {
    const title = lastWindowTitle(raw);
    if (title === null) return null;
    return TITLE_WAITING.test(title);
  }

  // 掃除済みでも生出力でも受け付ける。
  function isAwaitingUser(text) {
    const t = cleanTail(text, 4000).slice(-TAIL_WINDOW);
    if (SELECT_PROMPT.test(t) || SHELL_YESNO.test(t)) return true;
    if (PICKER_MARKER.test(t) && PICKER_FOOTER.test(t)) return true;
    return ASK_PHRASE.test(t) && NUMBERED_YES.test(t);
  }

  return { cleanTail, isAwaitingUser, SELECT_PROMPT, SHELL_YESNO,
           PICKER_FOOTER, PICKER_MARKER, TAIL_WINDOW,
           titleSaysWaiting, lastWindowTitle };
});
