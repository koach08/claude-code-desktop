// 声のまま考えるモデル (Realtime) と繋ぐ側。画面の中で動く。
//
// ⚠️ お金の話が設計に直結している。繋いだまま黙っていると、その無音も
//    入力の音として課金される。だからここは **声が出ている間しか送らない**。
//    話し始めの見極めは src/voice-vad.js、道具と関門は src/realtime-tools.js。
//
// 流れ:
//   一時鍵をもらう → WebSocket → 話し始めたら送る → 黙ったら締める →
//   声が返る → 鳴らしている間もマイクは見ている (割り込める)
//
// ⚠️ 本物の鍵は画面に渡さない。main が一時鍵 (数分で切れる) を取ってくる。

(function attach(global) {
  const VD = global.VoiceVad || require('./voice-vad');
  const RT = global.RealtimeTools || require('./realtime-tools');

  const RATE = 24000;              // Realtime は 24kHz の PCM16
  const PREROLL_MS = 400;          // 話し始めの一音節を落とさないための先読み
  const IDLE_HANGUP_MS = 60000;    // 使っていないのに繋がったままにしない
  // ── お金 ────────────────────────────────────────────────
  // 100 万トークンあたりの値段 (ドル)。2026-09-10 に公表価格を確認した。
  // ⚠️ 値上げ・値下げがあるのでここを直す。トークン数だけ出しても高いか安いか
  //    分からないので、円にして常に画面へ出す。
  const PRICE = { audioIn: 32, audioInCached: 0.40, audioOut: 64, textIn: 4, textOut: 16 };
  const YEN_PER_USD = 150;
  const DEFAULT_YEN_CAP = 200;     // 1 回の会話で使ってよい額。届いたら切る

  // 使った量から円を出す。⚠️ 種類ごとに桁が違う (使い回しぶんは 80 分の 1)。
  function costYen(u) {
    const usd = ((u.audioIn || 0) * PRICE.audioIn
      + (u.audioInCached || 0) * PRICE.audioInCached
      + (u.audioOut || 0) * PRICE.audioOut
      + (u.textIn || 0) * PRICE.textIn
      + (u.textOut || 0) * PRICE.textOut) / 1e6;
    return usd * YEN_PER_USD;
  }

  function b64FromPcm(int16) {
    let s = '';
    const b = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    const CH = 0x8000;
    for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
    return global.btoa(s);
  }
  function pcmFromB64(b64) {
    const bin = global.atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const v = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i += 1) v[i] = bin.charCodeAt(i);
    return new Int16Array(buf);
  }
  function toPcm16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i += 1) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function create(deps) {
    const {
      getToken,          // async () => {key, model} … main から一時鍵をもらう
      onState,           // (state, label) => void
      onTurn,            // ({role, content}) => void
      onNotice,          // (text) => void
      onUsage,           // ({tokens, yen, calls, speechSec}) => void
      yenCap,
    } = deps;

    let ws = null;
    let ctx = null, stream = null, node = null, srcNode = null;
    let state = 'idle';
    let sending = false;           // いま声を送っている最中か
    let preroll = [];              // 話し始める前の音 (少しだけ持っておく)
    let prerollMax = 0;
    let playAt = 0;                // 次の音を鳴らす時刻
    let playing = 0;               // 鳴らし終わっていない塊の数
    let lastHeard = 0;
    // ⚠️ 返事を作っている最中にもう一度頼むと弾かれる
    //    (conversation_already_has_active_response)。順番待ちにする。
    let responseActive = false;
    let responseQueued = false;
    let idleTimer = null;
    const usage = {
      tokens: 0, calls: 0, yen: 0,
      audioIn: 0, audioInCached: 0, audioOut: 0, textIn: 0, textOut: 0,
      speechSec: 0,          // 実際に送った声の長さ。無音は送っていない
    };

    function recount() { usage.yen = costYen(usage); }
    const vad = VD.createVad();
    const barge = VD.createBarge();
    const gate = RT.createGate();

    const LABEL = {
      idle: '待機', connecting: 'つないでいます', listening: '聞いています',
      speaking: '話しています', closed: '切りました',
    };
    const setState = (s) => { state = s; if (onState) onState(s, LABEL[s] || s); };
    const send = (o) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (_) {} };

    // 返事を頼む。作っている最中なら、終わってから頼み直す。
    function askForReply() {
      if (responseActive) { responseQueued = true; return; }
      responseActive = true;
      send({ type: 'response.create' });
    }

    // ── 音を鳴らす ──────────────────────────────────────────
    function play(int16) {
      if (!ctx) return;
      const buf = ctx.createBuffer(1, int16.length, RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < int16.length; i += 1) ch[i] = int16[i] / 0x8000;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const now = ctx.currentTime;
      if (playAt < now) playAt = now + 0.03;
      src.start(playAt);
      playAt += buf.duration;
      playing += 1;
      src.onended = () => {
        playing -= 1;
        if (playing <= 0 && state === 'speaking') setState('listening');
      };
      if (state !== 'speaking') setState('speaking');
    }

    function stopPlayback() {
      // ⚠️ 予約した音を消すには文脈ごと作り直すのが確実
      playAt = 0;
      playing = 0;
      try { if (ctx) { ctx.close(); ctx = null; } } catch (_) {}
    }

    // ── マイク ──────────────────────────────────────────────
    async function openMic() {
      stream = await global.navigator.mediaDevices.getUserMedia({
        // ⚠️ 反響消しが無いと、返ってきた声を自分で拾って延々と回る
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      ctx = new (global.AudioContext || global.webkitAudioContext)({ sampleRate: RATE });
      srcNode = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(2048, 1, 1);
      prerollMax = Math.ceil((PREROLL_MS / 1000) * RATE / 2048);
      node.onaudioprocess = (e) => onAudio(e.inputBuffer.getChannelData(0));
      srcNode.connect(node);
      // ⚠️ マイクをスピーカーへ繋がない。destination へは 0 音量で繋いで動かすだけ
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);
    }

    function onAudio(f32) {
      if (!ws || ws.readyState !== 1) return;
      const rms = VD.rmsOf(f32);
      const now = Date.now();

      // 返事を鳴らしている間は、割り込みだけを見る
      if (playing > 0) {
        if (barge.feed(rms)) {
          barge.reset();
          send({ type: 'response.cancel' });
          stopPlayback();
          openMic().catch(() => {});      // 文脈を作り直したので繋ぎ直す
          setState('listening');
        }
        return;
      }

      const pcm = toPcm16(f32);
      if (!sending) {
        // まだ送っていない。少しだけ持っておいて、話し始めたら一緒に送る
        preroll.push(pcm);
        if (preroll.length > prerollMax) preroll.shift();
      }

      const e = vad.feed(rms, now);
      if (e === 'speech' && !sending) {
        sending = true;
        lastHeard = now;
        setState('listening');
        for (const p of preroll) send({ type: 'input_audio_buffer.append', audio: b64FromPcm(p) });
        preroll = [];
      } else if (sending) {
        send({ type: 'input_audio_buffer.append', audio: b64FromPcm(pcm) });
        usage.speechSec += pcm.length / RATE;
      }

      if (e === 'stop' && sending) {
        sending = false;
        vad.reset();
        lastHeard = now;
        gate.heardUser();
        send({ type: 'input_audio_buffer.commit' });
        askForReply();
        if (onUsage) onUsage({ ...usage });
      } else if (e === 'timeout') {
        vad.reset();
        sending = false;
      }
    }

    // ── 道具の呼び出し ──────────────────────────────────────
    async function handleCall(name, callId, argsText) {
      let args = {};
      try { args = JSON.parse(argsText || '{}'); } catch (_) {}
      usage.calls += 1;
      let out;
      try {
        out = await RT.runTool(name, args, deps, gate);
      } catch (e) {
        out = { error: String((e && e.message) || e).slice(0, 160) };
      }
      if (onTurn) onTurn({ role: 'tool', content: `${name} → ${JSON.stringify(out).slice(0, 160)}` });
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(out) },
      });
      askForReply();
    }

    function onEvent(m) {
      if (m.type === 'response.created') { responseActive = true; return; }
      if (m.type === 'response.output_audio.delta') { play(pcmFromB64(m.delta)); return; }
      if (m.type === 'response.output_audio_transcript.done') {
        // ⚠️ 関門はこの「読み上げた文」を見て、渡し先の名前を出して尋ねたかを判断する
        gate.assistantSaid(m.transcript || '');
        if (onTurn) onTurn({ role: 'assistant', content: m.transcript || '' });
        return;
      }
      if (m.type === 'conversation.item.input_audio_transcription.completed') {
        // ⚠️ 断りの言葉をここで拾う。「やめて」と言ったのに実行されないように
        gate.heardUser(m.transcript || '');
        if (onTurn) onTurn({ role: 'user', content: m.transcript || '' });
        return;
      }
      if (m.type === 'response.function_call_arguments.done') {
        handleCall(m.name, m.call_id, m.arguments);
        return;
      }
      if (m.type === 'response.done') {
        responseActive = false;
        if (responseQueued) { responseQueued = false; askForReply(); }
        const u = (m.response && m.response.usage) || {};
        const id = u.input_token_details || {};
        const od = u.output_token_details || {};
        const cached = id.cached_tokens_details || {};
        usage.tokens += u.total_tokens || 0;
        // ⚠️ 使い回しぶん (cached) は 80 分の 1 の値段。分けて数えないと高く出る
        usage.audioInCached += cached.audio_tokens || 0;
        usage.audioIn += Math.max(0, (id.audio_tokens || 0) - (cached.audio_tokens || 0));
        usage.textIn += Math.max(0, (id.text_tokens || 0) - (cached.text_tokens || 0));
        usage.audioOut += od.audio_tokens || 0;
        usage.textOut += (od.text_tokens || 0) + (od.reasoning_tokens || 0);
        recount();
        if (onUsage) onUsage({ ...usage });

        // ⚠️ 上限に届いたら切る。使いすぎを請求で知るのがいちばん困る
        const cap = yenCap || DEFAULT_YEN_CAP;
        if (usage.yen >= cap) {
          if (onNotice) onNotice(`この会話で ${Math.round(usage.yen)} 円を使ったので切りました（上限 ${cap} 円）。`);
          api.disconnect();
        }
        return;
      }
      if (m.type === 'error') {
        if (onNotice) onNotice(`向こう側のエラー: ${(m.error && m.error.message) || ''}`.slice(0, 160));
      }
    }

    const api = {
      get state() { return state; },
      get usage() { return { ...usage }; },
      get connected() { return !!ws && ws.readyState === 1; },

      async connect() {
        if (ws) return true;
        setState('connecting');
        let tk;
        try { tk = await getToken(); } catch (e) { tk = null; }
        if (!tk || !tk.key) {
          if (onNotice) onNotice('一時鍵が取れませんでした。OPENAI_API_KEY を確かめてください。');
          setState('idle');
          return false;
        }
        try { await openMic(); } catch (_) {
          if (onNotice) onNotice('マイクが使えませんでした。許可を確かめてください。');
          setState('idle');
          return false;
        }

        ws = new global.WebSocket(
          `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(tk.model)}`,
          ['realtime', `openai-insecure-api-key.${tk.key}`],
        );
        ws.onopen = () => {
          send({
            type: 'session.update',
            session: {
              type: 'realtime',
              output_modalities: ['audio'],
              instructions: RT.INSTRUCTIONS,
              tools: RT.TOOLS,
              tool_choice: 'auto',
              // ⚠️ 話し終わりの見極めはこちらでやる。向こうに任せると無音も送ることになる
              audio: {
                input: { format: { type: 'audio/pcm', rate: RATE }, turn_detection: null,
                  transcription: { model: 'gpt-4o-mini-transcribe', language: 'ja' } },
                output: { format: { type: 'audio/pcm', rate: RATE }, voice: 'marin' },
              },
              max_output_tokens: 700,
            },
          });
          setState('listening');
          lastHeard = Date.now();
          idleTimer = setInterval(() => {
            if (Date.now() - lastHeard > IDLE_HANGUP_MS) {
              if (onNotice) onNotice('しばらく話していないので切りました。');
              api.disconnect();
            }
          }, 5000);
        };
        ws.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch (_) {} };
        ws.onerror = () => { if (onNotice) onNotice('繋がりが切れました。'); };
        ws.onclose = () => { api.disconnect(); };
        return true;
      },

      disconnect() {
        if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
        try { if (ws) { ws.onclose = null; ws.close(); } } catch (_) {}
        ws = null;
        sending = false;
        preroll = [];
        vad.reset();
        barge.reset();
        gate.clear();
        responseActive = false;
        responseQueued = false;
        stopPlayback();
        try { if (node) node.disconnect(); } catch (_) {}
        try { if (srcNode) srcNode.disconnect(); } catch (_) {}
        node = null; srcNode = null;
        // ⚠️ マイクは必ず止める。繋ぎ終わって開いたままが最悪
        try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        stream = null;
        setState('closed');
      },
    };
    return api;
  }

  const API = { create, costYen, RATE, IDLE_HANGUP_MS, DEFAULT_YEN_CAP, PRICE, YEN_PER_USD };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.Realtime = API;
}(typeof window !== 'undefined' ? window : globalThis));
