// 会話タブの「用途」と「キャラ」。main(起動時の追記プロンプト)と画面(選ぶボタン)の両方で使う。
//
// 用途を分けるのは、Claude デスクトップ / ChatGPT アプリへ行き来していた理由が
// 「開発以外(研究・メール・大学業務)はあっちでやる」だったため(本人、2026-11-03)。
// 中身は Claude Code なので、Gmail・カレンダー・Notion の連携と email-draft などのスキルは
// そのまま使える。用途ごとに「どれを使うか」「どこで止まって確認するか」だけを足す。
//
// キャラは見た目(名前・頭文字・色)と口調だけ。判断の基準は変えない。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AriyaChatPresets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PURPOSES = [
    {
      id: 'general', label: 'なんでも', icon: '💬',
      hint: '質問・調べもの・下書き。必要ならファイルやコマンドも使えます',
      prompt: '',
    },
    {
      id: 'dev', label: '開発', icon: '🛠',
      hint: 'アプリ開発・バグ修正・出荷。作業フォルダの中で動きます',
      prompt: 'この会話はアプリ開発の作業です。作業フォルダのコードを読んでから手を入れ、変更後はテストやビルドで確かめてから報告してください。',
    },
    {
      id: 'research', label: '研究', icon: '📚',
      hint: '文献・論文・分析。引用は実在を確かめます',
      prompt: 'この会話は研究の作業です。文献調査・論文執筆・分析では、使えるときは deep-research / academic-paper / literature-review / citation-verification などのスキルを使ってください。引用は実在を確かめたものだけを使い、確かめられないものはその旨を書いてください。',
    },
    {
      id: 'mail', label: 'メール', icon: '✉️',
      hint: 'Gmail の下書き・返信。送信は必ず確認してから',
      prompt: 'この会話はメールの作業です。下書きは email-draft スキルの文体で書き、Gmail の連携が使えるときは下書きとして保存してください。送信・転送・削除は、本人がこの会話で明示的に「送って」と言うまで絶対に行わないでください。',
    },
    {
      id: 'univ', label: '大学業務', icon: '🎓',
      hint: 'シラバス・ルーブリック・TA・事務連絡・予定',
      prompt: 'この会話は大学業務です。syllabus-gen / exam-rubric / ta-management / email-draft などのスキルとカレンダーの連携を、使えるときは使ってください。学生の個人情報は必要な範囲だけ扱い、外部への送信・予定の作成は本人の確認を取ってから行ってください。',
    },
  ];

  const CHARACTERS = [
    { id: 'ariya', name: 'アリヤ', initial: 'A', color: '#5b6cff', voice: null,
      prompt: 'あなたの名前はアリヤです。持ち主の仕事を支える落ち着いた執事として、丁寧だが簡潔な日本語で話してください。' },
    { id: 'sora', name: 'ソラ', initial: 'ソ', color: '#10a37f', voice: null,
      prompt: 'あなたの名前はソラです。明るく前向きな相棒として、親しみのある日本語で、でも要点から話してください。' },
    { id: 'kuro', name: 'クロ', initial: 'ク', color: '#333333', voice: null,
      prompt: 'あなたの名前はクロです。辛口のレビュアーとして、遠慮せず問題点から先に、短く指摘してください。' },
    { id: 'none', name: 'Claude', initial: 'C', color: '#d97757', voice: null, prompt: '' },
  ];

  const MODELS = [
    { id: 'opus', label: 'Opus', hint: 'いちばん賢い' },
    { id: 'sonnet', label: 'Sonnet', hint: 'ふだん使い' },
    { id: 'haiku', label: 'Haiku', hint: '速い・安い' },
  ];

  function purposeOf(id) { return PURPOSES.find((p) => p.id === id) || PURPOSES[0]; }
  function characterOf(id, extra) {
    const all = CHARACTERS.concat(Array.isArray(extra) ? extra : []);
    return all.find((c) => c.id === id) || CHARACTERS[0];
  }

  // claude --append-system-prompt に渡す文。空なら付けない。
  function systemPromptFor(opts = {}, extraCharacters) {
    const parts = [];
    const c = characterOf(opts.character, extraCharacters);
    if (c.prompt) parts.push(c.prompt);
    const p = purposeOf(opts.purpose);
    if (p.prompt) parts.push(p.prompt);
    parts.push('この会話は Ariya Bridge の会話画面から来ています。返事は Markdown で読みやすく、日本語で書いてください。');
    return parts.join('\n\n');
  }

  return { PURPOSES, CHARACTERS, MODELS, purposeOf, characterOf, systemPromptFor };
});
