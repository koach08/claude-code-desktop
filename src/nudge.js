// 「いま打っている指示は、このタブより別のエンジン向きではないか」の判定。
//
// ── なぜ作ったか ──
// エンジン判定 (src/engine-judge.js) は 2026-07 から入っていたが、呼び出し口は
// Cmd+Shift+E の専用ダイアログだけだった。つまり「わざわざダイアログを開いて
// タスク文をもう一度打ち直した人」にしか動かない。普段の入力欄からは一度も
// 呼ばれていなかったので、判定はあっても日常の導線に乗っていなかった。
// ここは「普段の入力欄に出してよいか」だけを決める。表示と受け渡しは renderer。
//
// 出しすぎないための線引き:
//  - 確信が high のときだけ。medium/low は黙る(毎回出ると誰も読まなくなる)。
//  - いま開いているタブと同じエンジンなら黙る(合っているものに口を出さない)。
//  - 短すぎる入力では黙る。書きかけの数文字で判定しても当たらない。
//  - 「ターミナル向き」は勝手に流さない。コマンドの自動実行は事故のもとなので、
//    受け渡しても送信はせず、入力欄に置くだけにする(handoff.autoSend=false)。

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BridgeworkNudge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // これ未満の入力では判定しない。日本語だと 10 文字あれば動詞まで出る。
  const MIN_CHARS = 10;

  // judge   : judgeEngine() の戻り (engine/label/reason/confidence/hits)
  // current : いま開いているタブのエンジン ('claude'|'codex'|'gemini'|'grok'|'shell')
  // text    : 入力欄の中身
  // 自動で回してよいか。2026-09-23 追加。
  // ── なぜ ──
  // 示唆を出すだけでは押されなかった(本人: 「わざわざそのアイコンをクリックして
  // とかじゃなくてね」)。結果、全部 Claude Code のまま走ってトークンが尽きかけた。
  // Enter を押した時点で、確信が高ければこちらで回す。
  // ── 回さない線引き ──
  //  - ターミナル向き: コマンドの自動実行は事故。入力欄に置くだけ(autoSend=false)。
  //  - Astra(画面操作): 人の手が要るので自動で回さない。示唆だけ。
  //  - 確信が high でないとき: 外すと本人が書いた指示が知らない場所へ行く。
  //  - いまのタブと同じエンジン: 回す先が同じなので何もしない。
  const NO_AUTO = new Set(['shell', 'astra']);
  function shouldAutoRoute(judge, current) {
    if (!judge || !judge.engine) return false;
    if (judge.confidence !== 'high') return false;
    if (judge.engine === current) return false;
    if (NO_AUTO.has(judge.engine)) return false;
    return true;
  }

  function shouldNudge(judge, current, text) {
    const t = String(text || '').trim();
    if (t.length < MIN_CHARS) return { show: false, why: 'short' };
    if (!judge || !judge.engine) return { show: false, why: 'nojudge' };
    if (judge.confidence !== 'high') return { show: false, why: 'lowconf' };
    if (judge.engine === current) return { show: false, why: 'same' };
    return {
      show: true,
      engine: judge.engine,
      label: judge.label,
      hits: judge.hits || [],
      // ターミナルへの受け渡しは「入力欄に置くだけ」。Enter は人間が押す。
      autoSend: judge.engine !== 'shell',
    };
  }

  return { shouldNudge, shouldAutoRoute, MIN_CHARS, NO_AUTO };
});
