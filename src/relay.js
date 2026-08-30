// 工程リレー: 1つの仕事を、癖の違うエンジンに順に渡していく。
//
// ── なぜ「相互チェック」ではなくリレーなのか ──
// 同じ物を2社に見せて突き合わせると、読む量が増えるのは人間のほうになる。
// ここでやるのは分担で、前の工程の出力がそのまま次の工程の入力になる。
// 人間が間に立たなくても先へ進む形にするのが目的。
//
// ── 担当の決め方 ──
// 「どれが優れているか」では決めない。工程ごとに向き不向きが違うだけで、
// 順位を付ける話ではないため。実装の担当は engine-judge の推奨をそのまま使い、
// 点検はそこと **別の会社** から選ぶ。同じモデルに自分の出力を点検させると、
// 同じ道筋をたどって同じ見落としをする。遠慮の話ではなく、間違え方が
// 揃ってしまうため。
//
// ── 実測メモ (2026-08-29) ──
// 手元で同じコードを Gemini と Claude に別々に読ませたところ、二社とも
// 「マーカーが窓の外に出ると取りこぼす」と同じ指摘をした。結果はどちらも
// 外れだったが、確かめに行った過程で、番号なしの再開ピッカーがそもそも
// 検出されていないという別の穴が見つかった。指摘が当たるかどうかより、
// 確かめる手がかりが増えることのほうが効いた。

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AriyaRelay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // どの会社が動かしているか。点検役を選ぶときに、実装役と重ならないようにする。
  const VENDOR = {
    claude: 'anthropic',
    codex: 'openai',
    gemini: 'google',
    grok: 'xai',
  };

  // 工程の定義。read=true の工程は読み取り専用で走らせる。
  const STAGES = {
    survey: {
      label: '下調べ',
      read: true,
      // 量を読むのが要る工程。速い側から先に当てる。
      prefer: ['gemini', 'codex', 'claude', 'grok'],
    },
    work: {
      label: '本作業',
      read: false,
      prefer: null,   // engine-judge の推奨をそのまま使う
    },
    review: {
      label: '点検',
      read: true,
      prefer: ['codex', 'gemini', 'claude', 'grok'],
    },
  };

  // available: いま実際に使えるエンジン (認証切れや課金停止のものは呼ぶ側が外す)
  function pickEngine(order, available, exclude = []) {
    for (const e of order) {
      if (!available.includes(e)) continue;
      if (exclude.includes(e)) continue;
      return e;
    }
    return null;
  }

  // 実装役と会社がかぶらない相手を探す。全部かぶるなら、かぶったまま返さずに
  // null を返す。点検役がいないことを黙って隠すと、点検した気になるのが一番悪い。
  //
  // 下調べをした相手も、できれば避ける。自分が集めた材料の誤りは見つけにくい。
  // ただし避けきれないときは、点検が無いよりは同じ相手でも通す。
  function pickReviewer(order, available, workEngine, surveyEngine) {
    const workVendor = VENDOR[workEngine];
    const fits = order.filter((e) => available.includes(e) && VENDOR[e] !== workVendor);
    return fits.find((e) => e !== surveyEngine) || fits[0] || null;
  }

  // judge: judgeEngine() の戻り。available: 使えるエンジンの配列。
  function planRelay(task, judge, available, opts = {}) {
    const avail = (available || []).filter((e) => VENDOR[e]);
    if (!avail.length) return { ok: false, error: '使えるエンジンが1つも無い' };

    const wanted = judge && judge.engine && VENDOR[judge.engine] ? judge.engine : 'claude';
    const work = avail.includes(wanted) ? wanted : pickEngine(['claude', 'codex', 'gemini', 'grok'], avail);
    if (!work) return { ok: false, error: '本作業を任せられるエンジンが無い' };

    const steps = [];
    let surveyor = null;
    if (opts.survey !== false) {
      // 下調べは本作業と別の相手に振る。同じ相手が続くと、下調べの見落としが
      // そのまま本作業に持ち越される。相手がいなければ工程ごと落とす。
      surveyor = pickEngine(STAGES.survey.prefer, avail, [work]);
      if (surveyor) steps.push({ stage: 'survey', label: STAGES.survey.label, engine: surveyor, read: true });
    }
    steps.push({ stage: 'work', label: STAGES.work.label, engine: work, read: !opts.write });
    if (opts.review !== false) {
      const reviewer = pickReviewer(STAGES.review.prefer, avail, work, surveyor);
      if (reviewer) steps.push({ stage: 'review', label: STAGES.review.label, engine: reviewer, read: true });
    }
    return {
      ok: true,
      task,
      steps,
      // 点検役が付かなかったことは、結果と一緒に必ず持ち回る。
      unreviewed: !steps.some((s) => s.stage === 'review'),
    };
  }

  // 前の工程の出力を、次の工程の入力に畳み込む。
  // prior: [{stage, engine, out}]
  // extra.diff: 本作業が実際に書き換えた差分。点検はこれを見る。
  //
  // ⚠️ 差分を渡さないと、点検役は本作業の **自己申告** しか読めない。
  // 本作業が何も書き換えていなくても、報告の文面だけ見て「問題なし」が返る。
  // 書き込み運用でいちばん効いてほしい工程が素通りする(リレー自身の点検で出た)。
  function buildStagePrompt(step, task, prior = [], extra = {}) {
    const parts = [];
    if (step.stage === 'survey') {
      parts.push('次の依頼に取りかかる前の下調べです。手を入れず、現状だけを述べてください。');
      parts.push(`依頼: ${task}`);
      parts.push('関係するファイルと、いま実際にどう動いているか。憶測は「憶測」と書くこと。');
      parts.push('読んだファイルは、パスと行番号で示してください。あとから確かめられるようにするためです。');
    } else if (step.stage === 'work') {
      parts.push(`依頼: ${task}`);
      const survey = prior.find((p) => p.stage === 'survey');
      if (survey) {
        parts.push('別のエンジンによる下調べです。誤りが含まれている前提で、使う前に確かめてください。');
        parts.push('----\n' + survey.out.trim() + '\n----');
      }
    } else if (step.stage === 'review') {
      parts.push('別のエンジンがやった作業の点検です。あなたが手を入れる必要はありません。');
      parts.push(`元の依頼: ${task}`);
      const work = prior.find((p) => p.stage === 'work');
      if (work) parts.push('作業の報告(本人の申告なので、そのまま信じないこと):\n----\n' + work.out.trim() + '\n----');
      if (extra.diff && extra.diff.trim()) {
        parts.push('実際に書き換わった差分:\n----\n' + extra.diff.trim() + '\n----');
        parts.push('報告と差分が食い違っていたら、差分のほうを本当とみなしてください。');
      } else if (extra.expectedWrite) {
        // 書き込むはずの回で差分が空。報告がどれだけ立派でも、何も起きていない。
        parts.push('この作業は書き換えを伴うはずでしたが、実際の差分は空でした。'
          + '報告の内容にかかわらず、まずその点を指摘してください。');
      }
      parts.push('実際に壊れる箇所、依頼から外れている箇所を挙げてください。');
      // 今日の実測から。2社が独立に同じ指摘を出しても、両方外れることがある。
      // 一致は正しさの証拠にならないので、多数決ではなく「確かめられる形」を求める。
      // 実際に効いたのは、指摘そのものではなく、確かめに行く手がかりだった。
      parts.push('指摘には、それが本当かどうかを確かめる最短の手順を必ず添えてください。'
        + '実行できるコマンド、または見るべきファイルと行番号です。'
        + '確かめようのない指摘は書かないでください。');
      parts.push('問題が無ければ「問題なし」とだけ答えてください。無理に指摘を作らないこと。');
    }
    return parts.join('\n\n');
  }

  return { planRelay, buildStagePrompt, VENDOR, STAGES };
});
