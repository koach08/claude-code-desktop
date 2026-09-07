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

  const HISTORY_KEY = 'ariya.voice.history';
  const MAX_KEEP = 200;          // 保存しておく往復の数
  const BARGE_GAP_MS = 250;      // 読み上げを止めてから録りはじめるまでの間
  const PROGRESS_TAIL = 12;      // 進捗として読む行数

  function create(deps) {
    const {
      transcribe,        // async (blobArray, mimeType) => {text} | {error}
      converse,          // async (messages, context) => {ok, reply}
      sendToTab,         // async (tabId, text) => void   … 作業の引き渡し
      readTab,           // async (tabId) => string       … 進捗を読む
      listTabs,          // () => [{id, cwd, name, exited}]
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

    const guard = V.makeSendGuard();

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

    // ── 読み上げ ────────────────────────────────────────────
    function stopSpeaking() {
      try {
        if (global.speechSynthesis) global.speechSynthesis.cancel();
      } catch (_) {}
      utter = null;
    }

    function speak(text) {
      return new Promise((resolve) => {
        if (!global.speechSynthesis || !text) return resolve();
        stopSpeaking();
        const u = new global.SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP';
        u.rate = 1.05;
        // 日本語の声を選ぶ。無ければ既定のまま
        try {
          const v = global.speechSynthesis.getVoices()
            .find((x) => /ja[-_]JP/i.test(x.lang));
          if (v) u.voice = v;
        } catch (_) {}
        u.onend = () => { utter = null; resolve(); };
        u.onerror = () => { utter = null; resolve(); };
        utter = u;
        global.speechSynthesis.speak(u);
      });
    }

    // ── 録音 ────────────────────────────────────────────────
    async function startRecording() {
      // ⚠️ ここを飛ばすと自分の声を拾う
      if (!V.canRecord(state)) return;
      try {
        stream = await global.navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (_) {
        if (onNotice) onNotice('マイクが使えませんでした。許可を確かめてください。');
        return;
      }
      chunks = [];
      const mime = global.MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      recorder = new global.MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => { finish().catch(() => setState('idle')); };
      recorder.start();
      setState(V.nextState('idle', 'start'));
    }

    function stopRecording() {
      try { if (recorder && recorder.state === 'recording') recorder.stop(); } catch (_) {}
    }

    function releaseMic() {
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      stream = null;
    }

    // ── ひと回り ────────────────────────────────────────────
    async function finish() {
      releaseMic();
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
        // 作業を渡した先があるなら、その進捗を材料として渡す
        let context = '';
        if (handoff && handoff.tabId) {
          try {
            const tail = await readTab(handoff.tabId);
            const lines = String(tail || '').split('\n').filter(Boolean).slice(-PROGRESS_TAIL);
            context = `渡してある作業: ${handoff.task}\n直近の様子:\n${lines.join('\n')}`;
          } catch (_) {}
        }

        const kind = V.classify(text);
        const res = await converse(V.forSending(history), context);
        const reply = (res && res.reply) ? String(res.reply) : '返事が来ませんでした。';
        push('assistant', reply, { kind: kind.kind });

        setState(V.nextState('thinking', 'got_reply'));   // speaking
        await speak(reply);
        setState(V.nextState('speaking', 'done'));        // idle
      } catch (e) {
        setState('idle');
        if (onNotice) onNotice(`うまくいきませんでした: ${String(e && e.message || e).slice(0, 120)}`);
      } finally {
        guard.end();
      }
    }

    // ── 外から呼ぶもの ──────────────────────────────────────
    return {
      get state() { return state; },
      get history() { return history.slice(); },
      get handoff() { return handoff; },

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
