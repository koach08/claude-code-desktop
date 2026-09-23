// ── ローカルなエンジン判別 (Claude Code / Codex / Gemini / Grok / ターミナル) ──
// タスク説明から、開くべきレーンを1つ推奨する(外部API不要)。
// 旧実装は 4 エンジンの includes() 先勝ちだったため、(a) ターミナルが候補に無い
// (b) 「バグを直す」と「記事を書く」が同時に出ると先に書いた方が勝つ、という穴があった。
// ここでは重み付きスコアで全レーンを競わせ、次点と決め手(hits)も返す。
const ENGINE_LABELS = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', grok: 'Grok',
  astra: 'Astra (ChatGPT)', shell: 'ターミナル',
};
// 各レーンの「これが得意」を1行で。判定結果の説明にそのまま出す。
const ENGINE_STRENGTHS = {
  claude: '設計・新規実装・書き物・MCP連携に強い。同じ資料を何度も直す作業もここ',
  codex: '既存コードの横断理解・影響追跡・リファクタ/バグ修正に強い',
  gemini: '速度・量・ブラウザ/UI検証・コスト効率に強い',
  grok: '低コストなコーディング(opencode × xAI grok)',
  astra: '画面を見ながらの操作・手元のGUIアプリ・外部サイトの手続きに強い',
  shell: 'エージェント不要。決まったコマンドを自分で打つのが速い',
};
// w=3 は決め手級、2 は強い手がかり、1 は補助。why は判定理由としてそのまま表示する。
const ENGINE_SIGNALS = [
  // ── ターミナル: 「エージェントに頼むまでもない」形をした依頼 ──
  { e: 'shell', w: 3, why: 'git 操作', re: /git\s+(push|pull|clone|status|log|diff|stash|rebase|merge|checkout|branch|commit)|git\s*(の|で|を)?\s*(ブランチ|コミット|履歴|タグ|リモート|コンフリクト|stash)/i },
  { e: 'shell', w: 3, why: 'パッケージ操作', re: /(npm|pnpm|yarn|bun)\s+(i\b|install|run|ci\b|build)|pip\s+install|brew\s+(install|upgrade)/i },
  { e: 'shell', w: 3, why: '単発コマンド', re: /\b(lsof|ps aux|kill|chmod|chown|scp|rsync|tail -f|curl|wget|ssh|docker|ffmpeg)\b/i },
  { e: 'shell', w: 2, why: 'ログ/プロセス確認', re: /ログ(を)?(見|確認|追)|プロセス(を)?(確認|見|止|落と)|ポート|空き容量|ディスク/ },
  { e: 'shell', w: 2, why: 'コマンドを打つだけ', re: /コマンド(だけ|を打|を叩)|一発で|叩くだけ|流すだけ|手で打/ },
  { e: 'shell', w: 1, why: '環境まわり', re: /環境変数|パス(を)?通|インストール|アンインストール|バージョン(確認|を上げ)/ },
  // ── Codex: 既存コードベースの横断理解 ──
  { e: 'codex', w: 3, why: '影響範囲の追跡', re: /影響範囲|影響を(受|調)|どこで使わ|全部(直|置換)|横断|一括で直/ },
  { e: 'codex', w: 3, why: 'リファクタ', re: /リファクタ|refactor|作り直|整理し直|構造を(直|変え)/i },
  { e: 'codex', w: 3, why: '原因不明のバグ', re: /なぜ(落ち|動かな|失敗)|原因(が)?(分から|不明|特定)|根本原因|再現しな/ },
  { e: 'codex', w: 2, why: 'バグ修正/デバッグ', re: /バグ|bug|デバッグ|debug|エラーを(直|潰)|テストが(落ち|通らな|失敗)/i },
  { e: 'codex', w: 2, why: '既存コードの把握', re: /既存(の)?(コード|実装)|コードベース|読み解|把握した|全体を(理解|把握)/ },
  { e: 'codex', w: 1, why: 'アルゴリズム/最適化', re: /アルゴリズム|計算量|最適化|パフォーマンス(を)?(改善|上げ)/ },
  { e: 'codex', w: 3, why: '局所的な微修正', re: /(typo|タイポ|誤字|脱字|微修正|軽微|些細|ささい)|[1１一]\s*(行|箇所|カ所|か所)(だけ|のみ)?(を)?(直|変え|足|消)|(少し|ちょっと|ちょい)(だけ)?(直|変え|足|消)/i },
  // ── Gemini: 量・速度・コスト ──
  { e: 'gemini', w: 3, why: '大量/量産', re: /大量|量産|何百|何十(件|個|本)|一括(変換|置換|生成)|まとめて(変換|生成|処理)|[0-9０-９]+\s*[万千]\s*(行|件|本|個|文字|ファイル|枚|語)|[0-9０-９]{3,}\s*(行|件|本|個|ファイル|枚)/ },
  { e: 'gemini', w: 3, why: 'コスト抑制', re: /安く|コスト(を)?(下げ|抑え|削)|無料枠|節約/ },
  { e: 'gemini', w: 2, why: 'ブラウザ/UI検証', re: /ブラウザ|スクショ|画面(を)?(確認|見て|触)|クリックして|実際に(触|動かし)/ },
  { e: 'gemini', w: 2, why: '試作/反復', re: /プロトタイプ|試作|とりあえず(作|動)|叩き台|何度も(回|試)|反復/ },
  { e: 'gemini', w: 1, why: '速度優先', re: /速く|急ぎ|すぐ(欲し|作)|とにかく早/ },
  // ── Astra (ChatGPT): 画面を触る作業 ──
  // ⚠️ 強いのは「画面を見ながら手を動かす」ところ。**同じものを何度も作り直す作業は
  //    向かない**。2026-09-09 に授業スライドで実測: 28 枚を 9 版まで回して丸一日、
  //    トークンも大量に消えた。作り直しが要る資料は Claude Code に寄せる。
  { e: 'astra', w: 3, why: '画面を見ながらの操作', re: /画面(を)?見ながら|GUI|マウスで|クリックして(進|操作)|ログインして(操作|やって|取っ)|フォームに(入力|打ち込)/ },
  { e: 'astra', w: 3, why: '手元のアプリを操作', re: /(Excel|エクセル|PowerPoint|パワポ|Keynote|Finder|Word|ワード|Photoshop|Illustrator|プレビュー)\s*(を|で)?\s*(操作|開いて|触|使って|いじ)/i },
  { e: 'astra', w: 2, why: '外部サイトでの手続き', re: /(サイト|ページ|管理画面|コンソール|窓口)(で|を)(操作|設定|登録|申し込|申請|手続)/ },
  { e: 'astra', w: 2, why: '人がやる操作の代行', re: /代わりに(押|入力|操作|やって|進め|取っ)|手作業(を)?(代|自動)/ },
  { e: 'astra', w: 3, why: 'アプリをまたぐ手続き', re: /(メール|受信箱|添付)(から|の)?.{0,12}(ダウンロード|取っ|開い|落とし).{0,20}(手続|申請|提出|登録|入力|アップロード)|書類(を)?(取っ|出し|提出|作って出)/ },
  // ── Grok: 明示指定のときだけ ──
  { e: 'grok', w: 3, why: 'Grok 指定', re: /grok|グロック|xai|opencode/i },
  // ── Claude Code: 品質・書き物・MCP ──
  { e: 'claude', w: 3, why: '設計/アーキテクチャ', re: /設計|アーキ|方式を(決|選)|技術選定|仕様(を)?(決|書|固)/ },
  { e: 'claude', w: 3, why: '書き物', re: /記事|論文|note|ドキュメント|readme|メール|文章|コピー|販売文|シラバス|申請書/i },
  { e: 'claude', w: 3, why: 'MCP連携が要る', re: /supabase|vercel|stripe|notion|wordpress|\bwp\b|gmail|canva|mcp/i },
  { e: 'claude', w: 2, why: '新規実装', re: /新規(の)?(実装|開発|作成)|ゼロから|新しく(作|足)|新機能/ },
  { e: 'claude', w: 2, why: 'デプロイ/出荷', re: /デプロイ|deploy|出荷|リリース|審査|ストア|公開する/i },
  { e: 'claude', w: 2, why: 'セキュリティ/権限', re: /セキュリティ|\brls\b|権限|認証|脆弱/i },
  { e: 'claude', w: 1, why: '品質重視', re: /丁寧|品質|きちんと|レビューして|相談|方針|戦略|企画/ },
  // ⚠️ 資料は「作り直し」を何度も回す。refactor の語に取られて Codex に行かないよう強めに置く
  { e: 'claude', w: 4, why: '資料・原稿の作成と手直し', re: /スライド|資料|原稿|レジュメ|配布物|講義|授業|シラバス|記事|論文|プレゼン/ },
];

// ── エフォート(どれだけ重い頭で考えさせるか) ────────────────────────
// 2026-09-23 追加。エンジンだけ振り分けても、全部いちばん重いモデルで走ると
// 結局トークンが尽きる(本人: 「結果的に claude code のみを使ってて、昨日トークンの
// 使用量に限界がくる感じになりそうだった」)。仕事の重さも一緒に判定する。
//
// ⚠️ モデルは**別名(alias)で持つ**。opus/sonnet/haiku のように別名で指せば、
//    エンジンが新しくなったときに毎回ここを書き換えずに済む。版を固定すると
//    「新しくなったのに古いので走り続ける」が起きる(実際に何度も起きた)。
const EFFORT_LABELS = { light: '軽め', normal: '普通', deep: 'じっくり' };
const EFFORT_SIGNALS = [
  // 軽い: 見るだけ・一箇所・決まった手順
  { f: 'light', w: 3, re: /(typo|タイポ|誤字|脱字)|[1１一]\s*(行|箇所|カ所|か所)|ちょっとだけ|軽く|さっと|ざっと|とりあえず見|確認(だけ|して)|見てきて|教えて|どうなって|状況は|何件|いくつ/i },
  { f: 'light', w: 2, re: /(直|変え|足|消|付け)(して|といて|ておいて)$|一言|短く|要約|まとめるだけ/ },
  // 重い: 設計・原因不明・横断・書き物
  { f: 'deep', w: 3, re: /設計|アーキ|方式を(決|選)|技術選定|なぜ(落ち|動かな|失敗)|原因(が)?(分から|不明|特定)|根本原因|横断|影響範囲|リファクタ|作り直/i },
  { f: 'deep', w: 3, re: /論文|申請書|科研費|査読|投稿|章立て|構成を(考|練)/ },
  { f: 'deep', w: 2, re: /全部|すべて|一通り|通しで|端から端|棚卸し|監査|洗い出/ },
  { f: 'deep', w: 2, re: /戦略|方針|企画|比較して(決|選)|トレードオフ|判断材料/ },
];
// エンジン × エフォート → 渡すモデル。空文字は「CLI の既定に任せる」。
// ⚠️ ここを埋めるときは必ず**別名**で。版番号を書くと更新のたびに腐る。
const EFFORT_MODELS = {
  claude: { light: 'haiku', normal: 'sonnet', deep: 'opus' },   // ⚠️ 9/23 本人の指摘で fable → opus。黙って既定を変えない
  codex:  { light: '', normal: '', deep: '' },          // codex は CLI 既定に任せる(版を固定しない)
  gemini: { light: 'gemini-flash-latest', normal: '', deep: 'gemini-pro-latest' },
  grok:   { light: '', normal: '', deep: '' },
  astra:  { light: '', normal: '', deep: '' },
  shell:  { light: '', normal: '', deep: '' },
};

// 短く言われても軽く扱ってはいけない種類の仕事。書き物・本番・生成物。
const CREATIVE_OR_PROD = /記事|論文|note|原稿|スライド|資料|申請|シラバス|メール(の)?(文|下書き)|実装|作って|作り直|直して|落ち(る|て)|動かな|失敗|エラー|生成|学習/i;
// ⚠️ これは「軽め」になってはいけない。間違えたときに戻せない種類の仕事。
//    実測(2026-09-23): 「セキュリティを直して」が短さ＋「直して」で軽めに倒れた。
const NEVER_LIGHT = /本番|デプロイ|リリース|セキュリティ|脆弱|権限|認証|鍵|課金|決済|支払|削除|消す|落とす|停止|移行/i;

function judgeEffort(task) {
  const t = String(task || '');
  let light = 0, deep = 0;
  for (const s of EFFORT_SIGNALS) {
    if (s.re.test(t)) { if (s.f === 'light') light += s.w; else deep += s.w; }
  }
  // 長い依頼はそれだけで重い。短さは**補助**にとどめる。
  // ⚠️ 実測(2026-09-23): 長さだけで light に倒すと「note の記事を1本書いて」「EGAKU の
  //    生成が落ちる」まで軽めになった。短いのは言い方であって、仕事の重さではない。
  if (t.length >= 160) deep += 2; else if (t.length <= 24) light += 1;
  // 作る・調べる・直すの本番仕事は、短く言われても軽めに落とさない。
  if (CREATIVE_OR_PROD.test(t)) { deep += 1; light -= 1; }
  if (NEVER_LIGHT.test(t)) { light = 0; deep += 1; }
  if (deep >= 2 && deep > light) return 'deep';
  if (light >= 2 && light > deep) return 'light';
  return 'normal';
}

// ⚠️ EGAKU(NSFW を含む生成 SaaS)の作業は Claude / Claude Code 以外に出さない(本人の決定 2026-09-11)。
//    OpenAI(Astra/Codex)・Google(Gemini)・xAI(Grok)に画面や中身を流さないため。点数で競わせず、先に決める。
const EGAKU_ONLY_CLAUDE = /egaku|えがく|エガク|画く|egaku\.ai|nsfw|venice|civitai|runpod.{0,20}(worker|生成)|α[123]|character_set/i;

function effortOf(engine, t) {
  const effort = judgeEffort(t);
  return { effort, effortLabel: EFFORT_LABELS[effort], model: (EFFORT_MODELS[engine] || {})[effort] || '' };
}

function judgeEngine(task) {
  const t = String(task || '');
  if (EGAKU_ONLY_CLAUDE.test(t)) {
    return {
      engine: 'claude', label: ENGINE_LABELS.claude,
      reason: 'EGAKU の作業 → Claude 固定(他社のエンジンに画面・中身を出さない)',
      confidence: 'high', hits: ['EGAKU 固定'], scores: {}, runnerUp: null,
      ...effortOf('claude', t),
    };
  }
  // ⚠️ レーンを足したらここも増える。手で並べていたので astra を足したとき落ちた。
  //    ラベルの一覧から作れば、次からは足すだけで済む。
  const scores = {};
  const hits = {};
  for (const k of Object.keys(ENGINE_LABELS)) { scores[k] = 0; hits[k] = []; }
  for (const s of ENGINE_SIGNALS) {
    if (s.re.test(t)) { scores[s.e] += s.w; if (!hits[s.e].includes(s.why)) hits[s.e].push(s.why); }
  }
  const ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0], second = ranked[1];
  const gap = scores[top] - scores[second];

  // 何も引っかからなければ既定 = Claude Code(迷ったら品質側)。
  if (scores[top] === 0) {
    return {
      engine: 'claude', label: ENGINE_LABELS.claude,
      reason: `決め手なし → 既定：${ENGINE_STRENGTHS.claude}`,
      confidence: 'low', hits: [], scores, runnerUp: null,
      ...effortOf('claude', t),
    };
  }
  const confidence = (scores[top] >= 3 && gap >= 2) ? 'high' : (gap >= 1 ? 'medium' : 'low');
  return {
    engine: top,
    label: ENGINE_LABELS[top],
    reason: `${hits[top].join('・')} → ${ENGINE_STRENGTHS[top]}`,
    confidence,
    hits: hits[top],
    scores,
    runnerUp: scores[second] > 0
      ? { engine: second, label: ENGINE_LABELS[second], reason: hits[second].join('・') || ENGINE_STRENGTHS[second] }
      : null,
    ...effortOf(top, t),
  };
}

module.exports = { judgeEngine, judgeEffort, ENGINE_LABELS, ENGINE_STRENGTHS, ENGINE_SIGNALS, EFFORT_LABELS, EFFORT_MODELS };
