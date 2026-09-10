// 音声で往復する仕掛け。画面と録音と読み上げを繋ぐ。
//
// 判断そのものは src/voice-turn.js にある (node からテストできるように分けてある)。
// ここはブラウザの API を触る側。
//
// 流れ:
//   マイクを押す → 録る → 文字にする → Alfred に聞く → 読み上げる → 待機
//   読み上げ中にもう一度押すと、読み上げを止めて録りはじめる (割り込み)
//
// ⚠️ 読み上げ中は録音しない。マイクが自分の声を拾って永久に回るため。
//    割り込みのときも「止める → 少し待つ → 録る」の順にする。
//
// 読み上げは OS 内蔵の声を使う (speechSynthesis)。日本語の声が入っているので
// 追加の課金は無い。有料の読み上げに替えたくなったら speak() だけ差し替える。

(function attach(global) {
  // node からはテストで require、画面では先に読み込んだ window.VoiceTurn を使う。
  // ⚠️ electron の renderer には require が居ることがあるので、
  //    window.VoiceTurn があればそちらを優先する (二重に読まない)。
  const V = (typeof global !== 'undefined' && global.VoiceTurn)
    ? global.VoiceTurn
    : require('./voice-turn');

  // 操作の読み取り。会話と違い、間違えると端末に文字が入るので別部品にしてある。
  const VC = (typeof global !== 'undefined' && global.VoiceCommand)
    ? global.VoiceCommand
    : require('./voice-command');

  // 話し終わりの見極め。⚠️ 無いときは押して止める昔の動きに落ちる。
  const VD = (typeof global !== 'undefined' && global.VoiceVad)
    ? global.VoiceVad
    : require('./voice-vad');

  const HISTORY_KEY = 'ariya.voice.history';
  const MAX_KEEP = 200;          // 保存しておく往復の数
  const BARGE_GAP_MS = 250;      // 読み上げを止めてから録りはじめるまでの間
  const PROGRESS_TAIL = 12;      // 進捗として読む行数

  function create(deps) {
    const {
      transcribe,        // async (blobArray, mimeType) => {text} | {error}
      tts,               // async (text) => {audio, mime} | {error}  … 良い声で読む
      converse,          // async (messages, context) => {ok, reply}
      sendToTab,         // async (tabId, text) => void   … 作業の引き渡し
      readTab,           // async (tabId) => string       … 進捗を読む
      listTabs,          // () => [{id, cwd, name, exited}]
      // ── ここから下はアプリそのものの操作。無くても会話だけは動く ──
      openTab,           // async (mode) => {id, name} … 新しいタブ
      closeTab,          // async (tabId) => void
      switchTab,         // (tabId) => void
      getActiveId,       // () => string
      onEngine,          // (engine) => void  … 声の相手が変わったことを画面に出す
      loadEngine,        // () => {provider, model, label} | null
      saveEngine,        // (engine) => void
      onState,           // (state, label) => void
      onTurn,            // (turn) => void  … 画面に出す
      onNotice,          // (text) => void  … 断った理由など
      loadHistory,       // () => array | null
      saveHistory,       // (array) => void
    } = deps;

    let state = 'idle';
    let recorder = null;
    let chunks = [];
    let stream = null;
    let utter = null;
    let history = [];
    // 作業を渡した先を覚えておく。進捗を読むときに使う
    let handoff = null;   // {tabId, cwd, task, at}

    // ── 押さずに話すための道具 ──────────────────────────────
    // ⚠️ マイクは開けっぱなしにする。ひと言ごとに開き直すと、そのたび待たされる。
    let liveMode = false;      // 連続で聞き続けるか
    let meter = null;          // {ctx, analyser, buf} … 音量を見る
    let ticker = null;         // 50ms ごとの見張り
    let player = null;         // mp3 を鳴らす Audio
    let speakToken = 0;        // 読み上げの世代。割り込んだら古いものを捨てる
    let speechStartedAt = 0;   // 話し始めた時刻。短すぎる音を送らないため
    const vad = VD.createVad();
    const barge = VD.createBarge();

    const guard = V.makeSendGuard();
    // ⚠️ 取り違えたまま実行しないための関門。閉じる/渡すは必ずここを通す。
    const confirmer = VC.makeConfirmer();

    // 声の返事を作るエンジン。既定は Claude。声で切り替えられる。
    let engine = { provider: '', model: '', label: '' };
    try {
      const e = loadEngine ? loadEngine() : null;
      if (e && e.provider) engine = e;
    } catch (_) {}

    function setState(s) {
      state = s;
      if (onState) onState(s, V.LABEL[s] || s);
    }

    function push(role, content, extra) {
      const turn = { role, content, at: Date.now(), ...(extra || {}) };
      history.push(turn);
      if (history.length > MAX_KEEP) history = history.slice(-MAX_KEEP);
      if (onTurn) onTurn(turn);
      try { saveHistory(history); } catch (_) {}
      return turn;
    }

    // ── 音量を見る ──────────────────────────────────────────
    // ⚠️ AudioContext が無い環境 (テストなど) では黙って諦める。
    //    そのときは「押して止める」昔の動きのままになる。
    function openMeter() {
      if (meter || !stream) return;
      try {
        const Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        meter = { ctx, analyser, buf: new Float32Array(analyser.fftSize) };
      } catch (_) { meter = null; }
    }

    function level() {
      if (!meter) return 0;
      try {
        meter.analyser.getFloatTimeDomainData(meter.buf);
        return VD.rmsOf(meter.buf);
      } catch (_) { return 0; }
    }

    function startTicker() {
      if (ticker || !meter) return;
      ticker = setInterval(() => {
        const rms = level();
        if (state === 'recording') {
          const e = vad.feed(rms, Date.now());
          if (e === 'speech') speechStartedAt = Date.now();
          if (e === 'stop') stopRecording();
          else if (e === 'timeout') {
            // 何も話さなかった。送らずに降りる。
            // ⚠️ 先に liveMode を下ろす。順番を逆にすると cancelRecording が
            //    「ライブ中だから開けておく」と判断し、マイクと見張りが
            //    開きっぱなしで残る (聞かれ続けているのと同じ)。
            const wasLive = liveMode;
            liveMode = false;
            cancelRecording();
            if (wasLive && onNotice) onNotice('しばらく声が無かったので、いったん切りました。');
          }
        } else if (state === 'speaking' && liveMode) {
          // ⚠️ 読み上げの回り込みで誤爆しないよう、はっきりした声だけ拾う
          if (barge.feed(rms)) { barge.reset(); stopSpeaking(); listen(); }
        }
      }, 50);
    }

    function stopTicker() {
      if (ticker) { clearInterval(ticker); ticker = null; }
    }

    // ── 読み上げ ────────────────────────────────────────────
    function stopSpeaking() {
      speakToken += 1;         // ⚠️ 作りかけの音が後から鳴らないようにする
      try { if (player) { player.pause(); player.src = ''; } } catch (_) {}
      player = null;
      try { if (global.speechSynthesis) global.speechSynthesis.cancel(); } catch (_) {}
      utter = null;
    }

    // 良い声 (mp3) を先に試し、駄目なら Mac 内蔵に落ちる。
    // ⚠️ mp3 を画面の中で鳴らすと、マイクの反響消しが効くので割り込める。
    //    内蔵の声は OS 側で鳴るため反響消しの対象外で、割り込みは当てにできない。
    function playOne(bytes, mime) {
      return new Promise((resolve) => {
        const blob = new global.Blob([bytes], { type: mime || 'audio/mpeg' });
        const url = global.URL.createObjectURL(blob);
        const a = new global.Audio(url);
        player = a;
        const done = () => {
          try { global.URL.revokeObjectURL(url); } catch (_) {}
          if (player === a) player = null;
          resolve();
        };
        a.onended = done;
        a.onerror = done;
        a.play().catch(done);
      });
    }

    async function speak(text) {
      if (!text) return;
      stopSpeaking();
      const my = speakToken;

      // ⚠️ 返事を丸ごと音にすると長いぶん待たされる (実測 3 文で 3.25 秒)。
      //    先頭の一文を鳴らしながら、次の文を作る。
      if (tts && global.Audio && global.URL && global.Blob) {
        const parts = V.chunksForSpeech(text);
        if (parts.length) {
          try {
            let pending = tts(parts[0]).catch(() => null);
            for (let i = 0; i < parts.length; i += 1) {
              const r = await pending;
              if (my !== speakToken) return;                 // 割り込まれた
              pending = (i + 1 < parts.length)
                ? tts(parts[i + 1]).catch(() => null) : null;
              if (!r || !r.audio) throw new Error('tts');
              await playOne(r.audio, r.mime);
              if (my !== speakToken) return;
            }
            return;
          } catch (_) { /* 内蔵の声に落ちる */ }
        }
      }

      await new Promise((resolve) => {
        if (!global.speechSynthesis) return resolve();
        const u = new global.SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP';
        u.rate = 1.05;
        try {
          const v = global.speechSynthesis.getVoices().find((x) => /ja[-_]JP/i.test(x.lang));
          if (v) u.voice = v;
        } catch (_) {}
        u.onend = () => { utter = null; resolve(); };
        u.onerror = () => { utter = null; resolve(); };
        utter = u;
        global.speechSynthesis.speak(u);
        return undefined;
      });
    }

    // ── 録音 ────────────────────────────────────────────────
    async function openMic() {
      if (stream) return true;
      try {
        // ⚠️ 反響消しを頼む。これが無いと、読み上げを自分で聞き取って回り続ける
        stream = await global.navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (_) {
        if (onNotice) onNotice('マイクが使えませんでした。許可を確かめてください。');
        return false;
      }
      openMeter();
      return true;
    }

    async function listen() {
      // ⚠️ ここを飛ばすと自分の声を拾う
      if (!V.canRecord(state)) return;
      if (!(await openMic())) { liveMode = false; return; }
      chunks = [];
      vad.reset();
      barge.reset();
      const mime = global.MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      recorder = new global.MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => { finish().catch(() => setState('idle')); };
      recorder.start();
      setState(V.nextState('idle', 'start'));
      startTicker();
    }

    const startRecording = listen;

    function stopRecording() {
      try { if (recorder && recorder.state === 'recording') recorder.stop(); } catch (_) {}
    }

    // 送らずにやめる (何も話さなかったとき)
    function cancelRecording() {
      try {
        if (recorder) { recorder.onstop = null; if (recorder.state === 'recording') recorder.stop(); }
      } catch (_) {}
      recorder = null;
      chunks = [];
      setState('idle');
      if (!liveMode) releaseMic();
    }

    function releaseMic() {
      stopTicker();
      try { if (meter && meter.ctx) meter.ctx.close(); } catch (_) {}
      meter = null;
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      stream = null;
    }

    // ── 操作 ────────────────────────────────────────────────
    // ⚠️ ここは端末に文字を入れる側。読み取り (voice-command) と分けてある。

    function tabName(t) {
      if (!t) return 'そのタブ';
      return t.name || VC.basename(t.cwd || '') || String(t.id);
    }

    // 返事を 1 つ出して読み上げる。状態も進める。
    async function respond(reply, extra) {
      push('assistant', reply, extra || {});
      if (state === 'thinking') setState(V.nextState('thinking', 'got_reply'));
      else setState('speaking');
      await speak(reply);
      setState(V.nextState('speaking', 'done'));
    }

    function tail(text) {
      const lines = String(text || '').split('\n').filter((x) => x.trim()).slice(-PROGRESS_TAIL);
      return lines.join('\n');
    }

    // 確認を通ったものだけがここへ来る
    async function runIntent(intent) {
      if (intent.kind === 'close') {
        if (!closeTab) return respond('この版ではタブを閉じられません。');
        await closeTab(intent.tab.id);
        if (handoff && handoff.tabId === intent.tab.id) handoff = null;
        return respond(`${tabName(intent.tab)} を閉じました。`);
      }
      if (intent.kind === 'work') {
        const chk = V.checkTarget(intent.tab.id, listTabs(), { expectCwd: intent.tab.cwd });
        if (!chk.ok) return respond(`渡せませんでした。${chk.reason}。`);
        await sendToTab(intent.tab.id, intent.task);
        handoff = { tabId: intent.tab.id, cwd: chk.tab.cwd, task: intent.task, at: Date.now() };
        return respond(`${tabName(intent.tab)} に渡しました。`, { kind: 'handoff' });
      }
      return respond('分かりませんでした。');
    }

    async function handleCommand(cmd) {
      // 黙るのは即座に。読み上げないので respond を通さない。
      if (cmd.kind === 'hush') { stopSpeaking(); setState('idle'); return undefined; }

      if (cmd.kind === 'engine') {
        engine = { provider: cmd.provider, model: cmd.model, label: cmd.label };
        try { if (saveEngine) saveEngine(engine); } catch (_) {}
        try { if (onEngine) onEngine(engine); } catch (_) {}
        return respond(`これからは ${cmd.label} が答えます。`);
      }

      if (cmd.kind === 'list') {
        const live = listTabs().filter((t) => !t.exited);
        if (!live.length) return respond('開いているタブはありません。');
        const names = live.map(tabName);
        const head = names.slice(0, 6).join('、');
        const more = names.length > 6 ? `、ほか ${names.length - 6} つ` : '';
        return respond(`${names.length} つ開いています。${head}${more}です。`);
      }

      if (cmd.kind === 'open') {
        if (!openTab) return respond('この版ではタブを開けません。');
        const t = await openTab(cmd.mode);
        return respond(`${cmd.mode} のタブを開きました。`, { tabId: t && t.id });
      }

      if (cmd.kind === 'switch') {
        if (!switchTab) return respond('この版ではタブを切り替えられません。');
        switchTab(cmd.tab.id);
        return respond(`${tabName(cmd.tab)} に切り替えました。`);
      }

      if (cmd.kind === 'progress') {
        const target = cmd.tab ? cmd.tab.id : (handoff && handoff.tabId);
        if (!target) return respond('渡してある作業はありません。');
        const t = tail(await readTab(target));
        return respond(t ? `直近はこうです。${t}` : 'まだ何も出ていません。');
      }

      if (cmd.kind === 'ask') {
        const cand = cmd.candidates && cmd.candidates.length
          ? ` ${cmd.candidates.slice(0, 4).join('、')}のどれですか。` : '';
        return respond(`${cmd.why}。${cand || 'どのタブか言ってください。'}`);
      }

      // 閉じる・渡す は復唱して確かめる
      if (cmd.confirm) return respond(confirmer.ask(cmd));

      return respond('分かりませんでした。');
    }

    // ── ひと回り ────────────────────────────────────────────
    async function finish() {
      // ⚠️ ライブ中はマイクを開けたままにする。ひと言ごとに開き直すと、
      //    そのたびに待たされて会話に聞こえない。
      if (!liveMode) releaseMic();
      setState(V.nextState('recording', 'stop'));   // transcribing

      const blob = new global.Blob(chunks, { type: recorder.mimeType });
      const buf = await blob.arrayBuffer();
      const r = await transcribe(Array.from(new Uint8Array(buf)), recorder.mimeType);
      const text = (r && r.text ? String(r.text) : '').trim();

      if (!text) {
        setState(V.nextState('transcribing', 'fail'));
        if (onNotice) onNotice(r && r.error ? `聞き取れませんでした: ${r.error}` : '聞き取れませんでした。');
        return;
      }
      // ⚠️ 一瞬の音や無音を渡すと、聞き取りが「ご視聴ありがとうございました」のような
      //    定型を作り出す（実測）。話した長さが短いか、定型そのものなら捨てて聞き続ける。
      const spokeSec = speechStartedAt ? (Date.now() - speechStartedAt) / 1000 : 99;
      speechStartedAt = 0;
      if (V.isPhantom(text) || (liveMode && spokeSec < V.MIN_SPEECH_SEC)) {
        setState(V.nextState('transcribing', 'fail'));
        return;
      }

      // ⚠️ 二重送信よけ。押し間違いと二重認識をここで止める
      const ok = guard.check(text);
      if (!ok.ok) {
        setState(V.nextState('transcribing', 'fail'));
        if (onNotice) onNotice(ok.reason);
        return;
      }
      guard.begin(text);

      push('user', text);
      setState(V.nextState('transcribing', 'got_text'));   // thinking

      try {
        // 1) 確認待ちがあるなら、まずその返事として読む。
        //    ⚠️ 「はい」を会話として流すと、待っていた用件が宙に浮く。
        const ans = confirmer.answer(text);
        if (ans.verdict === 'yes') { await runIntent(ans.intent); return; }
        if (ans.verdict === 'no') { await respond('やめました。'); return; }
        // 'other' は待っていた用件を捨てて、新しい話として続ける

        // 2) アプリの操作か。迷ったら talk に落ちる作りにしてある。
        const cmd = VC.parse(text, {
          tabs: listTabs(),
          activeId: getActiveId ? getActiveId() : '',
        });
        if (cmd.kind !== 'talk') { await handleCommand(cmd); return; }

        // 3) 会話。⚠️ 会話側のモデルに手は無い。せめて実物（開いているタブ）は渡す。
        //    渡さないと「確認してみます」とだけ言って何もしない返事になる（実測）。
        let context = '';
        try {
          const live = listTabs().filter((t) => !t.exited);
          if (live.length) context += `開いているタブ: ${live.map(tabName).join('、')}\n`;
        } catch (_) {}
        if (handoff && handoff.tabId) {
          try {
            context += `渡してある作業: ${handoff.task}\n直近の様子:\n${tail(await readTab(handoff.tabId))}`;
          } catch (_) {}
        }

        const res = await converse(V.forSending(history), context, engine);
        const reply = (res && res.reply) ? String(res.reply) : '返事が来ませんでした。';
        await respond(reply, { kind: 'talk' });
      } catch (e) {
        setState('idle');
        if (onNotice) onNotice(`うまくいきませんでした: ${String(e && e.message || e).slice(0, 120)}`);
      } finally {
        guard.end();
        // 返事が終わったら、そのまま次を聞く。確認待ちのときも聞き続ける。
        if (liveMode && state === 'idle') listen().catch(() => { liveMode = false; });
      }
    }

    // ── 外から呼ぶもの ──────────────────────────────────────
    return {
      get state() { return state; },
      get history() { return history.slice(); },
      get handoff() { return handoff; },
      get engine() { return { ...engine }; },
      get live() { return liveMode; },
      get waiting() { return confirmer.pending; },

      // 画面から切り替えたいとき (声で言えるので必須ではない)
      setEngine(e) {
        engine = { provider: e.provider || '', model: e.model || '', label: e.label || '' };
        try { if (saveEngine) saveEngine(engine); } catch (_) {}
        try { if (onEngine) onEngine(engine); } catch (_) {}
      },

      // マイクを押したとき。状態によって意味が変わる
      async press() {
        const act = V.onMicPress(state);
        if (act === 'start') return startRecording();
        if (act === 'stop') return stopRecording();
        if (act === 'barge_in') {
          // ⚠️ 止めてから少し置く。止めた直後に録ると尾を拾うことがある
          stopSpeaking();
          setState(V.nextState('speaking', 'barge_in'));
          await new Promise((r) => setTimeout(r, BARGE_GAP_MS));
          setState('idle');
          return startRecording();
        }
        // 文字にしている間・考えている間は何もしない
        if (onNotice) onNotice(`${V.LABEL[state]}なので、少し待ってください。`);
        return undefined;
      },

      // ── 押さずに話す ────────────────────────────────────
      // ⚠️ 開始も終了もここだけ。press() は昔ながらの押して録るほう。
      async startLive() {
        if (liveMode) return true;
        if (!(await openMic())) return false;
        if (!meter) {
          // 音量が見られない環境。押して止める形でしか使えない
          if (onNotice) onNotice('この環境では自動で区切れません。押して止めてください。');
          return false;
        }
        liveMode = true;
        stopSpeaking();
        if (state !== 'idle') setState('idle');
        await listen();
        return true;
      },

      stopLive() {
        liveMode = false;
        stopSpeaking();
        try { if (recorder && recorder.state === 'recording') { recorder.onstop = null; recorder.stop(); } } catch (_) {}
        recorder = null;
        releaseMic();
        setState('idle');
      },

      // 読み上げだけ止める (次を喋らず黙らせたいとき)
      hush() {
        stopSpeaking();
        if (state === 'speaking') setState('idle');
      },

      // 作業を渡す。⚠️ 渡し先は本人が選ぶ。ここでは確かめるだけ
      async handOff(tabId, task, expectCwd) {
        const chk = V.checkTarget(tabId, listTabs(), { expectCwd });
        if (!chk.ok) {
          if (onNotice) onNotice(`渡せませんでした: ${chk.reason}`);
          return { ok: false, reason: chk.reason };
        }
        await sendToTab(tabId, task);
        handoff = { tabId, cwd: chk.tab.cwd, task, at: Date.now() };
        push('assistant', `${chk.tab.name || tabId} に渡しました。`, { kind: 'handoff' });
        return { ok: true, tab: chk.tab };
      },

      // 渡した作業の様子を短く読む
      async progress() {
        if (!handoff) return '渡してある作業はありません。';
        const tail = await readTab(handoff.tabId);
        const lines = String(tail || '').split('\n').filter(Boolean).slice(-PROGRESS_TAIL);
        return lines.length ? lines.join('\n') : 'まだ何も出ていません。';
      },

      clearHandoff() { handoff = null; },

      // 起動時に読み戻す
      restore() {
        try {
          const h = loadHistory();
          if (Array.isArray(h)) {
            history = h.slice(-MAX_KEEP);
            for (const t of history) if (onTurn) onTurn(t);
          }
        } catch (_) {}
        return history.length;
      },

      clear() {
        history = [];
        try { saveHistory(history); } catch (_) {}
      },
    };
  }

  const api = { create, HISTORY_KEY, MAX_KEEP, BARGE_GAP_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.VoiceChat = api;
}(typeof window !== 'undefined' ? window : globalThis));
