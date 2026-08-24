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
  const SELECT_PROMPT = /[❯›▶]\s*\d+\.\s*\S/;

  // 素の CLI が使う y/n。行末にあることを求めて、文章中の "(y/n)" と分ける。
  const SHELL_YESNO = /\((?:y\/n|Y\/n|y\/N)\)\s*[?:]?\s*$/im;

  // 保険。Claude Code の許可プロンプトは実バッファに1件も残っていなかった
  // (全タブが自動承認で走っていたため)。マーカーを描かない版が来ても取り逃さない
  // よう、決まり文句と番号付きの Yes が **両方** 揃ったときだけ通す。
  // 片方だけだと、Claude が文章中に書いた同じ語で誤検出する。
  const ASK_PHRASE = /Do you want to proceed\?/i;
  const NUMBERED_YES = /\d+\.\s*(?:Yes|はい)\b/;

  // 掃除済みでも生出力でも受け付ける。
  function isAwaitingUser(text) {
    const t = cleanTail(text, 4000);
    if (SELECT_PROMPT.test(t) || SHELL_YESNO.test(t)) return true;
    return ASK_PHRASE.test(t) && NUMBERED_YES.test(t);
  }

  return { cleanTail, isAwaitingUser, SELECT_PROMPT, SHELL_YESNO };
});
