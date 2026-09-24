// 左メニューの束ね先を、タブの「中身」から決める (2026-09-24)。
//
// 本人: 「その他に 32 個もタブが溜まって、そこから探している。メニュー化した意味がない」
// 原因: 左メニューは作業フォルダ(cwd)だけで束ねていた。本人は全タブを ~ から開くので、
//       中身に関係なく全部「その他」に落ちていた。
//
// 手がかりは強い順に 3 つ:
//   1. 本人が手で移したもの(project-assign.json)。これは必ず勝つ。
//   2. 会話の中で触ったファイルの場所。フォルダ名を project-labels.json で呼び名に引く。
//      深い階層から順に引くので Documents/<授業フォルダ> のような場所も拾える。
//   3. タブ名・最初の依頼に出てくる言葉(project-keywords.json: 呼び名 → 言葉の配列)。
//
// ⚠️ 呼び名も言葉も**ソースに書かない**(公開リポジトリ。並べると本人が特定できる)。
//    表はすべて ~/.claude-code-app/ に置き、ここは仕組みだけを持つ。
//
// electron 非依存。fs は引数で受け、テストから一時ディレクトリを渡せるようにする。

const HEAD_BYTES = 300 * 1024;   // 最初の依頼とその直後の作業
const TAIL_BYTES = 400 * 1024;   // いま触っている場所

// 設定・一時置き場は案件ではない(毎回の記憶の読み込みで全タブに出てくる)
const SKIP_PATH = /\/(?:\.claude|\.config|\.cache|\.npm|Library|node_modules|private\/tmp|\.Trash)(?:\/|$)/;
const PATH_RE = /\/Users\/[^/\s"'`\\]+((?:\/[^/\s"'`\\,):;|<>]+){1,6})/g;

// 会話ファイルの先頭と末尾を読む。大きい会話(100MB超)を丸ごと読まない。
function readHeadTail(fs, file) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const headLen = Math.min(st.size, HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    let tail = '';
    if (st.size > headLen) {
      const tailLen = Math.min(st.size - headLen, TAIL_BYTES);
      const tb = Buffer.alloc(tailLen);
      fs.readSync(fd, tb, 0, tailLen, st.size - tailLen);
      tail = tb.toString('utf8');
    }
    return { head: head.toString('utf8'), tail, size: st.size, mtimeMs: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

// 本人の言葉(依頼文)と、Claude Code が付けた題名を先頭から拾う
function extractWords(head, maxPrompts = 3) {
  const prompts = [];
  let aiTitle = null;
  for (const line of head.split('\n')) {
    if (!aiTitle && line.includes('"type":"ai-title"')) {
      try { const d = JSON.parse(line); aiTitle = d.aiTitle || d.title || null; } catch (_) { /* 途中で切れた行 */ }
      continue;
    }
    if (prompts.length >= maxPrompts || !line.includes('"type":"user"')) continue;
    let d;
    try { d = JSON.parse(line); } catch (_) { continue; }
    const c = d && d.message && d.message.content;
    let text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : '';
    text = String(text || '').trim();
    if (!text || text.startsWith('<') || text.startsWith('This session is being continued')
      || text.startsWith('Base directory for this skill')) continue;
    prompts.push(text.slice(0, 2000));
  }
  return { prompts, aiTitle };
}

// パスに出てくるフォルダ名を、深い階層から呼び名の表で引いて数える
function scorePaths(text, labels, scores) {
  for (const m of String(text || '').matchAll(PATH_RE)) {
    const p = m[1];
    if (SKIP_PATH.test(p)) continue;
    const parts = p.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const label = labels[parts[i]];
      if (label) { scores.set(label, (scores.get(label) || 0) + 1); break; }
    }
  }
}

// 言葉の表で数える。依頼文に出た言葉は、パス 1 回より重い
function scoreWords(text, keywords, scores, weight) {
  const low = String(text || '').toLowerCase();
  if (!low) return;
  for (const [label, words] of Object.entries(keywords || {})) {
    if (!Array.isArray(words)) continue;
    for (const w of words) {
      const k = String(w || '').toLowerCase();
      if (k && low.includes(k)) scores.set(label, (scores.get(label) || 0) + weight);
    }
  }
}

// 点数から 1 つに決める。僅差なら決めない(間違って束ねるより「その他」のほうがまし)
function decide(scores, { minScore = 3, margin = 1.5 } = {}) {
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [best, second] = ranked;
  if (best[1] < minScore) return null;
  if (second && best[1] < second[1] * margin) return null;
  return best[0];
}

// 1 本の会話を判定する。tabName は本人がタブに付けた名前(あれば言葉の手がかりに使う)
function classifyText({ head, tail, tabName }, { labels = {}, keywords = {} } = {}) {
  const scores = new Map();
  const { prompts, aiTitle } = extractWords(head || '');
  // 本人の言葉と題名: 1 語 5 点。どこで何をしたかより「何を頼んだか」を重く見る
  scoreWords([tabName, aiTitle, ...prompts].filter(Boolean).join('\n'), keywords, scores, 5);
  // 依頼文に書かれたパスも本人の言葉なので重く(1 回 3 点)
  const promptScores = new Map();
  scorePaths(prompts.join('\n'), labels, promptScores);
  for (const [k, v] of promptScores) scores.set(k, (scores.get(k) || 0) + v * 3);
  // 作業中に触ったパス: 1 回 1 点
  scorePaths(head, labels, scores);
  scorePaths(tail, labels, scores);
  return { project: decide(scores), aiTitle, firstPrompt: prompts[0] || null,
    scores: Object.fromEntries(scores) };
}

module.exports = { classifyText, readHeadTail, extractWords, scorePaths, scoreWords, decide };
