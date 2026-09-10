// 声で Ariya Bridge そのものを動かすときの「読み取り」だけを切り出したもの。
//
// 画面も録音も触らない。ここに置くのは、間違えると事故になる読み取り:
//   1. どのタブのことを言っているか … 取り違えると関係ない作業に文字が入る
//   2. これは取り返しがつくか       … 閉じる・作業を渡すは、先に復唱して確かめる
//   3. どのエンジンに聞くか         … 声の返事を作る側を切り替える
//
// electron を読まないので、node から直接テストできる。
//
// ⚠️ 音声の書き起こしは固有名詞をカタカナにする。実測で「Ariya」は「アリア」に
//    なった (アリヤではない)。名前で引くときは、綴りの一致に頼らないこと。

(function attach(global) {
  // ── 表記ゆれをならす ────────────────────────────────────────
  // 全角→半角、カタカナ→ひらがな、記号と空白を落とす。
  function norm(s) {
    return String(s || '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .toLowerCase()
      .replace(/[\s　・,.。、_\-/]+/g, '');
  }

  // 綴りとカタカナを繋ぐ表。
  //
  // ⚠️ **中身をここに書かない。** 案件の名前は手元の
  //    `~/.claude-code-app/voice-aliases.json` に置く。このリポジトリは公開して
  //    あるので、扱っている案件の名前が並ぶと、それだけで持ち主が分かる。
  //
  // 形は [[読み, 綴り], ...]。例: [["あおぞら", "aozora"]]
  // 表が空でも綴りが一致すれば当たる。読みで呼びたいときだけ足せばよい。
  let ALIASES = [];

  function setAliases(rows) {
    ALIASES = (Array.isArray(rows) ? rows : [])
      .filter((r) => Array.isArray(r) && r.length >= 2 && r[0] && r[1])
      .map((r) => [norm(r[0]), norm(r[1])]);
    return ALIASES.length;
  }
  function getAliases() { return ALIASES.map((r) => [...r]); }

  // 読みを綴りに置き換えた別名も作る。どちらでも当たるようにする。
  function variants(s) {
    const base = norm(s);
    const out = new Set([base]);
    for (const [yomi, spell] of ALIASES) {
      if (base.includes(yomi)) out.add(base.split(yomi).join(spell));
      if (base.includes(spell)) out.add(base.split(spell).join(yomi));
    }
    return [...out].filter(Boolean);
  }

  function basename(p) {
    const parts = String(p || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  // ── タブの名指しを解く ──────────────────────────────────────
  // ⚠️ 1 つに決まらないときは実行しない。候補を返して聞き返す。
  function resolveTab(phrase, tabs) {
    const live = (tabs || []).filter((t) => t && !t.exited);
    const said = variants(phrase);
    if (!said.length || !said[0]) return { ok: false, reason: 'どのタブか分かりませんでした' };

    const hit = [];
    for (const t of live) {
      const hay = [
        ...variants(t.name || ''),
        ...variants(basename(t.cwd || '')),
        ...variants(t.cwd || ''),
      ].filter(Boolean);
      const match = said.some((s) => hay.some((h) => h.includes(s) || (s.length >= 3 && s.includes(h))));
      if (match) hit.push(t);
    }
    if (!hit.length) return { ok: false, reason: 'そのタブは見つかりませんでした' };
    if (hit.length > 1) {
      return {
        ok: false,
        reason: `${hit.length} つ当てはまります`,
        candidates: hit.map((t) => t.name || basename(t.cwd) || String(t.id)),
      };
    }
    return { ok: true, tab: hit[0] };
  }

  // ── どのエンジンに聞くか ────────────────────────────────────
  // hub の provider 名に合わせる (claude / openai / gemini / grok / venice / groq / perplexity)。
  const ENGINES = [
    { re: /(あすとら|アストラ|astra)/i, provider: 'openai', model: 'gpt-6-astra', label: 'Astra' },
    { re: /(じーぴーてぃー|gpt|オープンエーアイ|openai|おーぷんえーあい)/i, provider: 'openai', model: '', label: 'OpenAI' },
    { re: /(くろーど|クロード|claude|あんそろぴっく)/i, provider: 'claude', model: '', label: 'Claude' },
    { re: /(じぇみに|ジェミニ|gemini|じぇみない)/i, provider: 'gemini', model: '', label: 'Gemini' },
    { re: /(ぐろっく|グロック|grok)/i, provider: 'grok', model: '', label: 'Grok' },
    { re: /(ぱーぷれ|perplexity|パープレ)/i, provider: 'perplexity', model: '', label: 'Perplexity' },
  ];

  // 「アストラで」「クロードに戻して」のように、切り替えの言い方が付いたときだけ拾う。
  // ⚠️ 「Claude Code のタブを開いて」で engine に化けないよう、切り替え語を必須にする。
  const SWITCH_TAIL = /(で(いこう|お願い|おねがい)?|に(して|かえて|変えて|戻して|もどして|切り替え)|にしてください|でお願いします|に変更)/;

  function readEngine(text) {
    const t = String(text || '');
    if (!SWITCH_TAIL.test(t)) return null;
    if (/(タブ|たぶ)/.test(t)) return null;          // タブの話は別
    for (const e of ENGINES) {
      if (e.re.test(t)) return { provider: e.provider, model: e.model, label: e.label };
    }
    return null;
  }

  // ── 言い方の表 ──────────────────────────────────────────────
  const SAY = {
    hush: /(黙って|だまって|静かに|読み上げを?(止|と)めて|しゃべらないで)/,
    // ⚠️ 実際の言い方は「何が開いているか」「開いてる?」のように、タブという語を
 //    使わないことが多い（実測）。開いている、という言い方そのものを拾う。
    list: /(どんな|なに|何|いくつ|どの)(の)?(タブ|たぶ)|タブ(を|は)?(教えて|一覧|見せて)|(何|なに|どれ)(が|か)?(開いて|ひらいて)|開いて(いる|る)(か|の|やつ|もの|タブ)?[?？]?/,
    progress: /(進捗|しんちょく|どこまで|どうなって(る|ますか)|様子|途中経過|終わった\?|終わってる)/,
    open: /(新しい|あたらしい)?(タブ|たぶ)(を)?(開いて|ひらいて|作って|つくって|足して)/,
    close: /(タブ|たぶ)(を)?(閉じて|とじて|消して)/,
    switchTo: /(に|へ)(切り替え|きりかえ|移動|うつって|行って|いって)|(を)?(見せて|開いて)$/,
  };

  // 作業を渡す言い方。voice-turn の WORK_PATTERNS と揃える。
  const WORK = /(直して|修正して|なおして|実装して|作って|つくって|足して|追加して|走らせて|実行して|やっといて|やっておいて|進めて|消して|削除して|デプロイして|ビルドして|テストして|コミットして|プッシュして)/;

  // 「〜のタブ」「〜で」の前に来る名前を取り出す。
  function pickTabPhrase(text) {
    const t = String(text || '');
    let m = t.match(/([^、。\s]{2,20}?)\s*(?:の)?(?:タブ|たぶ)/);
    if (m) return m[1];
    m = t.match(/^([^、。\s]{2,20}?)\s*(?:で|に)\s*/);
    return m ? m[1] : '';
  }

  // 「このタブ」「今のタブ」を指しているか
  function saysCurrent(text) {
    return /(この|いまの|今の|開いてる|現在の)(タブ|たぶ)|ここ(で|に)/.test(String(text || ''));
  }

  // ── 読み取りの本体 ──────────────────────────────────────────
  // ⚠️ 迷ったら talk に倒す。会話のつもりの一言が端末で走るほうが害が大きい。
  //    kind が 'work' と 'close' のときだけ confirm を true にする。
  function parse(text, ctx = {}) {
    const t = String(text || '').trim();
    if (!t) return { kind: 'talk', why: '中身がありません' };
    const tabs = ctx.tabs || [];

    if (SAY.hush.test(t)) return { kind: 'hush', why: '黙るように言われました' };

    const eng = readEngine(t);
    if (eng) return { kind: 'engine', ...eng, why: 'エンジンの切り替え' };

    if (SAY.list.test(t)) return { kind: 'list', why: 'タブの一覧' };

    if (SAY.open.test(t)) {
      // 「Codex のタブを開いて」のようにレーン名が付いていたら拾う
      const mode = /(codex|コーデックス|こーでっくす)/i.test(t) ? 'codex'
        : /(gemini|じぇみに|ジェミニ)/i.test(t) ? 'gemini'
          : /(grok|ぐろっく|グロック)/i.test(t) ? 'grok'
            : /(ターミナル|たーみなる|terminal|端末)/i.test(t) ? 'terminal'
              : 'claude';
      return { kind: 'open', mode, why: '新しいタブ' };
    }

    if (SAY.close.test(t)) {
      const target = saysCurrent(t)
        ? { ok: true, tab: tabs.find((x) => String(x.id) === String(ctx.activeId)) }
        : resolveTab(pickTabPhrase(t), tabs);
      if (!target.ok || !target.tab) {
        return { kind: 'ask', why: target.reason || 'どのタブか分かりませんでした', candidates: target.candidates };
      }
      return { kind: 'close', tab: target.tab, confirm: true, why: 'タブを閉じる' };
    }

    // 作業の言い方が入っているなら、渡し先を探す
    if (WORK.test(t)) {
      const target = saysCurrent(t)
        ? { ok: true, tab: tabs.find((x) => String(x.id) === String(ctx.activeId)) }
        : resolveTab(pickTabPhrase(t), tabs);
      if (!target.ok || !target.tab) {
        return { kind: 'ask', why: target.reason || 'どのタブに渡しますか', candidates: target.candidates, task: t };
      }
      return { kind: 'work', tab: target.tab, task: t, confirm: true, why: '作業の引き渡し' };
    }

    if (SAY.progress.test(t)) {
      const phrase = pickTabPhrase(t);
      if (phrase) {
        const target = resolveTab(phrase, tabs);
        if (target.ok) return { kind: 'progress', tab: target.tab, why: '名指しの進捗' };
      }
      return { kind: 'progress', why: '渡した先の進捗' };
    }

    if (SAY.switchTo.test(t)) {
      const target = resolveTab(pickTabPhrase(t), tabs);
      if (target.ok) return { kind: 'switch', tab: target.tab, why: 'タブの切り替え' };
    }

    return { kind: 'talk', why: '操作の言い方が無いので会話にしました' };
  }

  // ── 復唱して確かめる ────────────────────────────────────────
  // ⚠️ 取り違えたまま実行しないための最後の関門。
  //    はい・いいえ以外が来たら、待っている用件は捨てて新しい話として読む。
  const YES = /^(はい|うん|ええ|そう|お願い|おねがい|やって|いいよ|良いよ|オーケー|おーけー|ok|どうぞ|進めて|すすめて)/i;
  const NO = /^(いいえ|いや|違う|ちがう|やめ|止めて|だめ|駄目|キャンセル|きゃんせる|中止|やっぱり)/i;
  const CONFIRM_TTL_MS = 90000;

  function describe(intent) {
    const name = intent.tab ? (intent.tab.name || basename(intent.tab.cwd) || intent.tab.id) : '';
    if (intent.kind === 'close') return `${name} のタブを閉じます。よろしいですか。`;
    if (intent.kind === 'work') return `${name} に渡します。よろしいですか。`;
    return 'よろしいですか。';
  }

  function makeConfirmer(now = () => Date.now()) {
    let pending = null;
    return {
      ask(intent) { pending = { intent, at: now() }; return describe(intent); },
      get pending() {
        if (pending && now() - pending.at > CONFIRM_TTL_MS) pending = null;
        return pending ? pending.intent : null;
      },
      // 返事を読む。'yes' / 'no' / 'other'
      answer(text) {
        const cur = this.pending;
        if (!cur) return { verdict: 'none' };
        const t = String(text || '').trim();
        if (YES.test(t)) { pending = null; return { verdict: 'yes', intent: cur }; }
        if (NO.test(t)) { pending = null; return { verdict: 'no', intent: cur }; }
        pending = null;                       // 別の話が来た → 待っていた用件は捨てる
        return { verdict: 'other', intent: cur };
      },
      clear() { pending = null; },
    };
  }

  const API = {
    norm, variants, basename, resolveTab, readEngine, parse,
    makeConfirmer, describe, ENGINES, CONFIRM_TTL_MS,
    setAliases, getAliases,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.VoiceCommand = API;
}(typeof window !== 'undefined' ? window : globalThis));
