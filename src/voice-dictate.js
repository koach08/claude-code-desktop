// 🎤 の書き取り。話している最中から文字が出るようにする側。
//
// 以前は「⏹ を押すまで丸ごと録って、押してから一括で文字にする」だったので、
// 長く話すほど押したあとの待ちが伸びた。💬 (会話) が声の区切りごとに文字に
// できているのと同じ見極め (src/voice-vad.js) を使い、黙った瞬間にそこまでを
// 文字にして入力欄へ足す。⏹ は「これで終わり」の合図に変わる。
//
// 流れ:
//   🎤 → マイクを開けたまま → 声が途切れた → そこまでを文字にして足す →
//   録り直し (マイクは開けたまま) → … → ⏹ → 最後の切れ端も文字にして閉じる
//
// ⚠️ 文字にする順番は守る。2 つ目の切れ端が先に返ってきて前後が入れ替わると、
//    読めない文になる。返事は一列に並べて順に足す。
// ⚠️ 声の無い切れ端は送らない。Whisper 系は無音を渡すと定型文を作り出す (voice-turn.js)。
//
// ブラウザの部品 (getUserMedia / MediaRecorder / AudioContext) は外から渡す。
// node からテストできるようにするため。

(function attach(global) {
  const VD = (typeof global !== 'undefined' && global.VoiceVad)
    ? global.VoiceVad
    : require('./voice-vad');
  const V = (typeof global !== 'undefined' && global.VoiceTurn)
    ? global.VoiceTurn
    : require('./voice-turn');

  // 会話 (1500ms) より少し早めに切る。書き取りは切れ端を空白で繋ぐだけなので、
  // 息継ぎで切れても困らない。⚠️ 短すぎると単語の途中で切れて聞き取りが崩れる。
  const SEGMENT = {
    silenceMs: 1100,
    maxMs: 20000,        // 一息で長く話しても、ここで一度文字にする (待ちを伸ばさない)
    noSpeechMs: 600000,  // 考え込んでいても勝手に止めない。⏹ を押すまで聞く
  };
  const TICK_MS = 50;

  function create(deps) {
    const {
      transcribe,     // async (bytesArray, mimeType) => {text} | {error}
      onText,         // (text) => void   … 文字が出来た順に呼ぶ
      onState,        // (state) => void  … 'recording' | 'transcribing' | 'idle'
      onNotice,       // (text) => void
      getUserMedia,   // async (constraints) => MediaStream
      MediaRecorder,  // class
      AudioContext,   // class | undefined (無ければ区切りは効かず ⏹ まで丸ごと)
      setInterval: setI = global.setInterval,
      clearInterval: clearI = global.clearInterval,
      now = () => Date.now(),
    } = deps;

    let stream = null;
    let recorder = null;
    let meter = null;
    let ticker = null;
    let vad = null;
    let speechAt = 0;        // この切れ端で話し始めた時刻 (0 = まだ声が無い)
    let running = false;
    let pending = 0;         // 文字にしている途中の切れ端の数
    let chain = Promise.resolve();   // 順番を守るための列

    function setState(s) { if (onState) onState(s); }

    function mime() {
      return (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
        ? 'audio/webm;codecs=opus' : 'audio/webm';
    }

    function level() {
      if (!meter) return 0;
      try {
        meter.analyser.getFloatTimeDomainData(meter.buf);
        return VD.rmsOf(meter.buf);
      } catch (_) { return 0; }
    }

    function openMeter() {
      if (meter || !stream || !AudioContext) return;
      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        meter = { ctx, analyser, buf: new Float32Array(analyser.fftSize) };
      } catch (_) { meter = null; }
    }

    // 切れ端を一つ録りはじめる。マイクは開けたまま
    function arm() {
      speechAt = 0;
      vad.reset();
      const rec = new MediaRecorder(stream, { mimeType: mime() });
      // ⚠️ 切れ端ごとに入れ物を分ける。共有すると、次を録りはじめた後に届く
      //    前の切れ端の最後の音が、次の入れ物に混ざる
      const parts = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) parts.push(e.data); };
      rec.parts = parts;
      rec.start();
      recorder = rec;
    }

    // いま録っている切れ端を締めて文字にする。keep=true なら続けて次を録る。
    // force=true は声の見極めが無いとき (音量計なし) に丸ごと送るため
    function cut(keep, force) {
      const rec = recorder;
      if (!rec) return;
      const hadSpeech = force || speechAt > 0;
      const spokeSec = force ? 99 : (hadSpeech ? (now() - speechAt) / 1000 : 0);
      recorder = null;
      const done = new Promise((resolve) => {
        rec.onstop = () => resolve(rec.parts.slice());
        try { if (rec.state === 'recording') rec.stop(); else resolve(rec.parts.slice()); } catch (_) { resolve([]); }
      });
      // ⚠️ 声が無かった切れ端は送らない (無音 → 定型文の誤認)
      if (hadSpeech && spokeSec >= V.MIN_SPEECH_SEC) enqueue(done, rec.mimeType || mime());
      if (keep) arm();
    }

    function enqueue(blobsPromise, mimeType) {
      pending += 1;
      setState('transcribing');
      chain = chain.then(async () => {
        try {
          const blobs = await blobsPromise;
          if (!blobs.length) return;
          const blob = new global.Blob(blobs, { type: mimeType });
          const buf = await blob.arrayBuffer();
          const r = await transcribe(Array.from(new Uint8Array(buf)), mimeType);
          const text = (r && r.text ? String(r.text) : '').trim();
          if (!text) {
            if (r && r.error && onNotice) onNotice(`聞き取れませんでした: ${r.error}`);
            return;
          }
          if (V.isPhantom(text)) return;
          if (onText) onText(text);
        } catch (e) {
          if (onNotice) onNotice(`聞き取れませんでした: ${e && e.message ? e.message : e}`);
        } finally {
          pending -= 1;
          if (pending === 0) setState(running ? 'recording' : 'idle');
        }
      });
      return chain;
    }

    function tick() {
      if (!recorder) return;
      const e = vad.feed(level(), now());
      if (e === 'speech') speechAt = now();
      else if (e === 'stop') cut(true);
      else if (e === 'timeout') { cut(true); }   // 声の無いまま長く経った。捨てて録り直す
    }

    async function start() {
      if (running) return false;
      try {
        stream = await getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (_) {
        if (onNotice) onNotice('マイクが使えませんでした。許可を確かめてください。');
        return false;
      }
      running = true;
      vad = VD.createVad(SEGMENT);
      openMeter();
      arm();
      // ⚠️ 音量計が作れない環境では区切れない。⏹ まで丸ごと (前と同じ動き) に落ちる
      if (meter) ticker = setI(tick, TICK_MS);
      setState('recording');
      return true;
    }

    // ⏹。最後の切れ端も文字にしてから閉じる。文字が全部出たら resolve
    async function stop() {
      if (!running) return;
      running = false;
      if (ticker) { clearI(ticker); ticker = null; }
      // ⚠️ 音量計が無いときは声の見極めが無い。丸ごと送る
      cut(false, !meter);
      try { if (meter && meter.ctx && meter.ctx.close) meter.ctx.close(); } catch (_) {}
      meter = null;
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      stream = null;
      await chain;
      if (pending === 0) setState('idle');
    }

    return {
      start,
      stop,
      get running() { return running; },
      get pending() { return pending; },
    };
  }

  const API = { create, SEGMENT, TICK_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.VoiceDictate = API;
}(typeof window !== 'undefined' ? window : globalThis));
