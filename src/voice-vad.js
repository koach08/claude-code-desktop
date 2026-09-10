// 「いま話しているか」の見極めだけを切り出したもの。
//
// ボタンを押さずに話すには、こちらが話し終わりを当てるしかない。⚠️ ここを外すと:
//   早すぎる  … 言い終わる前に切られて、半分だけ送られる
//   遅すぎる  … 黙ってから返事まで間が空いて、会話に聞こえない
//   敏感すぎる… 咳や物音で勝手に録りはじめる
//
// 音そのものは触らない。音量 (0〜1 の RMS) を渡すと、区切りだけを返す。
// electron も Web Audio も読まないので node からテストできる。

// ⚠️ 関数で包む。<script> で読むファイルはグローバルを共有するので、裸の
//    `const API` は voice-turn.js のものと衝突して読み込み時に落ちる（実際に落ちて、
//    💬 を押しても何も起きない状態になった）。
(function attach(global) {
const DEFAULTS = {
  startRms: 0.030,     // これを超えたら「話し始めた」
  stopRms: 0.015,      // これを下回り続けたら「話し終わった」
  startFrames: 2,      // 単発の物音で始めない
  silenceMs: 850,      // 話し終わりと決めるまでの静けさ。短いと言葉の途中で切れる
  noSpeechMs: 9000,    // 何も話さないまま待つ上限
  maxMs: 30000,        // 一度に録る上限 (延々と録り続けない)
  bargeRms: 0.075,     // ⚠️ 読み上げ中に割り込むには、はっきりした声が要る
  bargeFrames: 3,      // 読み上げの回り込みで誤爆しないよう連続を要求する
};

// 録っている間の見極め。feed は毎フレーム呼ぶ。
// 返り値: null | 'speech' | 'stop' | 'timeout'
function createVad(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let startedAt = null;
  let loud = 0;
  let speaking = false;
  let quietSince = null;

  return {
    get speaking() { return speaking; },
    reset() { startedAt = null; loud = 0; speaking = false; quietSince = null; },
    feed(rms, now) {
      if (startedAt === null) startedAt = now;
      if (now - startedAt > o.maxMs) return speaking ? 'stop' : 'timeout';

      if (!speaking) {
        // まだ話し始めていない
        if (rms >= o.startRms) {
          loud += 1;
          if (loud >= o.startFrames) { speaking = true; quietSince = null; return 'speech'; }
        } else {
          loud = 0;
          if (now - startedAt > o.noSpeechMs) return 'timeout';
        }
        return null;
      }

      // 話している最中
      if (rms > o.stopRms) { quietSince = null; return null; }
      if (quietSince === null) { quietSince = now; return null; }
      if (now - quietSince >= o.silenceMs) return 'stop';
      return null;
    },
  };
}

// 読み上げ中の割り込み。こちらは「はっきりした声が続いたか」だけを見る。
function createBarge(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let loud = 0;
  return {
    reset() { loud = 0; },
    feed(rms) {
      if (rms >= o.bargeRms) { loud += 1; return loud >= o.bargeFrames; }
      loud = 0;
      return false;
    },
  };
}

// 波形 (-1〜1) から音量を出す。画面側から呼ぶ。
function rmsOf(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

  const API = { createVad, createBarge, rmsOf, DEFAULTS };
  // node からはテストで require、画面からは <script> で読むので window にも載せる。
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.VoiceVad = API;
}(typeof window !== 'undefined' ? window : globalThis));
