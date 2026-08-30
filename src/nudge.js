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
  else root.AriyaNudge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // これ未満の入力では判定しない。日本語だと 10 文字あれば動詞まで出る。
  const MIN_CHARS = 10;

  // judge   : judgeEngine() の戻り (engine/label/reason/confidence/hits)
  // current : いま開いているタブのエンジン ('claude'|'codex'|'gemini'|'grok'|'shell')
  // text    : 入力欄の中身
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

  return { shouldNudge, MIN_CHARS };
});
