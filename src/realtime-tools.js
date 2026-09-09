// 声のまま考えるモデル (Realtime) に渡す道具と、その関門。
//
// ⚠️ ここが今までといちばん違うのは、**実行を決めるのが向こう側**だということ。
//    こちらの言葉の判定を通らない。だから「モデルがそう言ったから」で実行しない。
//    取り返しのつかない道具は、こちら側で二度手間を強制する:
//      1 回目 … 必ず断る。何を確かめるべきかを返す
//      2 回目 … 1 回目のあとに**本人が実際に声を出していた**ときだけ通す
//    これで、モデルが一息で確認と実行を続けても止まる。
//
// electron を読まないので node からテストできる。

(function attach(global) {
  const VC = (typeof global !== 'undefined' && global.VoiceCommand)
    ? global.VoiceCommand
    : require('./voice-command');

  // 取り返しがつかないもの。ここに入れた道具は必ず確認を通る。
  const DANGEROUS = new Set(['close_tab', 'send_to_tab']);

  const TOOLS = [
    {
      type: 'function',
      name: 'list_tabs',
      description: 'いま開いているタブの一覧を返す。名前と作業場所が分かる。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      type: 'function',
      name: 'open_tab',
      description: '新しいタブを開く。取り返しがつくので確認は要らない。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini', 'grok', 'terminal'],
            description: 'どのレーンで開くか。指定が無ければ claude。',
          },
        },
        required: ['mode'],
      },
    },
    {
      type: 'function',
      name: 'switch_tab',
      description: '表示するタブを切り替える。取り返しがつくので確認は要らない。',
      parameters: {
        type: 'object',
        properties: { tab: { type: 'string', description: 'タブの名前か作業場所の一部' } },
        required: ['tab'],
      },
    },
    {
      type: 'function',
      name: 'read_tab',
      description: 'そのタブの直近の様子を読む。進捗を聞かれたときに使う。',
      parameters: {
        type: 'object',
        properties: { tab: { type: 'string', description: 'タブの名前。省略すると直前に作業を渡した先' } },
        required: [],
      },
    },
    {
      type: 'function',
      name: 'close_tab',
      description: 'タブを閉じる。⚠️ 必ず先に声で確認を取り、本人が承知してから confirmed を true にすること。',
      parameters: {
        type: 'object',
        properties: {
          tab: { type: 'string' },
          confirmed: { type: 'boolean', description: '本人が承知したあとだけ true' },
        },
        required: ['tab', 'confirmed'],
      },
    },
    {
      type: 'function',
      name: 'send_to_tab',
      description: 'そのタブで動いている Claude Code などに作業を渡す。⚠️ 必ず先に声で確認を取ること。',
      parameters: {
        type: 'object',
        properties: {
          tab: { type: 'string' },
          task: { type: 'string', description: '渡す依頼の文' },
          confirmed: { type: 'boolean', description: '本人が承知したあとだけ true' },
        },
        required: ['tab', 'task', 'confirmed'],
      },
    },
  ];

  const INSTRUCTIONS = `あなたは持ち主の相棒 Alfred です。声で話しています。

話し方:
- 短く。ふつうは1文、長くても3文
- 箇条書きを読み上げない。数だけ言う
- 記号や括弧、コードの書き方を読み上げない
- 分からないことは分からないと言う。作らない
- 一般論と精神論を言わない。決め台詞を置かない
- 「〜性」で終わる抽象名詞を使わない
- です・ます調

道具の使い方:
- タブのことを聞かれたら list_tabs で実際に見てから答える。憶測で言わない
- 開く・切り替える・読む は、そのまま実行してよい
- **閉じる・作業を渡す は、先に「どのタブに」「何を」するかを名前を出して言い、
  返事を待つ。** 返事を聞いてから confirmed を true にして呼ぶ
  ⚠️ 尋ねるときは必ずタブの名前を口に出すこと。名前が無いと実行できない
- 断られたら「やめました」とだけ言う。言い換えて誘わない
- 作業場所が1つに決まらないときは、候補を言って選んでもらう`;

  // ── 関門 ──────────────────────────────────────────────────
  // ⚠️ 実測で分かったこと: モデルは道具を 2 回呼ばない。**口で確認して、
  //    そのまま confirmed を立てて呼ぶ。** だから「1 回目は必ず断る」だけの
  //    作りだと永久に通らない堂々巡りになる。
  //
  //    代わりに、こちらで確かめられる事実だけで判断する:
  //      1. Alfred が声に出して尋ねたか (読み上げの文が手元にある)
  //      2. その尋ねに渡し先の名前が入っていたか
  //      3. そのあとで本人が実際に声を出したか
  //      4. その返事が断りでなかったか
  //    4 つ揃わなければ通さない。モデルが一息で確認と実行を続けても、
  //    本人の声が間に挟まっていないので止まる。

  const ASKING = /(よろしい|いいです|ますか|ますが|しますか|渡します|閉じます|でしょうか|\?|？)/;
  const REFUSED = /(いいえ|いや|違う|ちがう|やめ|止め|だめ|駄目|キャンセル|中止|やっぱり|あとで|後で)/;

  function keyOf(name, args) {
    return `${name}:${String((args && args.tab) || '')}:${String((args && args.task) || '')}`;
  }

  function createGate(opts = {}) {
    const now = opts.now || (() => Date.now());
    let lastUser = { at: 0, text: '' };
    let lastAssistant = { at: 0, text: '' };
    let pending = null;          // 道具を 2 回呼ぶ流儀のとき用

    return {
      // 本人が話し終わるたびに呼ぶ
      heardUser(text) { lastUser = { at: now(), text: String(text || '') }; },
      // Alfred が読み上げ終わるたびに呼ぶ
      assistantSaid(text) { lastAssistant = { at: now(), text: String(text || '') }; },
      get pending() { return pending ? pending.key : null; },
      clear() { pending = null; },

      // target には、名前を解いたあとの渡し先を渡す (尋ねた文に入っているか見る)
      check(name, args, target) {
        if (!DANGEROUS.has(name)) return { ok: true };
        const key = keyOf(name, args);

        if (!args || args.confirmed !== true) {
          pending = { key, userAt: lastUser.at };
          return { ok: false, needsConfirm: true, reason: '先に、何をするかを声に出して伝えて、本人の返事を待ってください。' };
        }

        // 本人が、こちらが喋ったあとに声を出しているか
        if (!(lastUser.at > lastAssistant.at) || !lastAssistant.at) {
          return { ok: false, needsConfirm: true, reason: '本人の返事をまだ聞いていません。尋ねて、返事を待ってください。' };
        }
        // 断られていないか
        if (REFUSED.test(lastUser.text)) {
          pending = null;
          return { ok: false, refused: true, reason: '本人が断りました。実行しません。' };
        }

        // 道具を 2 回呼ぶ流儀なら、それも通す
        const viaPending = pending && pending.key === key && lastUser.at > pending.userAt;

        // 声で尋ねた流儀。尋ねた文に渡し先の名前と、尋ねる言い方が要る
        const said = VC.norm(lastAssistant.text);
        const named = target ? VC.variants(target).some((v) => v && said.includes(v)) : false;
        const viaVoice = named && ASKING.test(lastAssistant.text);

        if (!viaPending && !viaVoice) {
          pending = { key, userAt: lastUser.at };
          return { ok: false, needsConfirm: true, reason: `${target || 'どのタブか'} を名前で言って、何をするかを尋ねてから、返事を待ってください。` };
        }
        pending = null;
        return { ok: true };
      },
    };
  }

  // ── 実行 ──────────────────────────────────────────────────
  // deps: {listTabs, openTab, switchTab, closeTab, sendToTab, readTab, getHandoff, setHandoff}
  async function runTool(name, args, deps, gate) {
    const a = args || {};
    const tabs = deps.listTabs ? deps.listTabs() : [];

    const findTab = (phrase) => {
      const r = VC.resolveTab(phrase, tabs);
      if (r.ok) return { tab: r.tab };
      return { error: r.reason, candidates: r.candidates };
    };

    if (name === 'list_tabs') {
      return {
        tabs: tabs.filter((t) => !t.exited).map((t) => ({
          name: t.name || VC.basename(t.cwd) || String(t.id),
          place: VC.basename(t.cwd || ''),
        })),
      };
    }

    if (name === 'open_tab') {
      const t = await deps.openTab(a.mode || 'claude');
      return { opened: (t && (t.name || t.id)) || a.mode || 'claude' };
    }

    if (name === 'switch_tab') {
      const f = findTab(a.tab);
      if (f.error) return f;
      deps.switchTab(f.tab.id);
      return { switched: f.tab.name || f.tab.id };
    }

    if (name === 'read_tab') {
      const id = a.tab ? (findTab(a.tab).tab || {}).id : (deps.getHandoff && deps.getHandoff());
      if (!id) return { error: '読む先がありません' };
      const text = await deps.readTab(id);
      const lines = String(text || '').split('\n').filter((x) => x.trim()).slice(-12);
      return { tail: lines.join('\n') || '(まだ何も出ていません)' };
    }

    // ⚠️ 関門にかける前に渡し先を解く。尋ねた文にその名前が入っていたかを見るため。
    const found = a.tab ? findTab(a.tab) : {};
    if (found.error) return found;
    const targetName = found.tab ? (found.tab.name || VC.basename(found.tab.cwd) || found.tab.id) : a.tab;

    const gated = gate.check(name, a, targetName);
    if (!gated.ok) {
      return {
        needs_confirmation: !gated.refused,
        refused: !!gated.refused,
        reason: gated.reason,
        target: targetName,
      };
    }

    if (name === 'close_tab') {
      await deps.closeTab(found.tab.id);
      return { closed: targetName };
    }

    if (name === 'send_to_tab') {
      await deps.sendToTab(found.tab.id, a.task);
      if (deps.setHandoff) deps.setHandoff(found.tab.id, a.task);
      return { sent_to: targetName };
    }

    return { error: `知らない道具です: ${name}` };
  }

  const API = { TOOLS, INSTRUCTIONS, DANGEROUS, createGate, runTool };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.RealtimeTools = API;
}(typeof window !== 'undefined' ? window : globalThis));
