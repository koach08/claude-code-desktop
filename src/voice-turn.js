// 音声で往復するときの「判断」だけを切り出したもの。
//
// 画面や録音そのものは触らない。ここに置くのは、間違えると事故になる判断:
//   1. いま録音してよいか        … 読み上げ中に録れると自分の声を拾って無限に回る
//   2. いま送ってよいか          … 二重送信で同じ依頼が 2 回走る
//   3. どこへ渡すか              … 別のタブへ誤送信すると関係ない作業に文字が入る
//   4. これは会話か作業依頼か    … 会話のつもりが端末で走ると危ない
//
// electron を読まないので、node から直接テストできる。

// 状態。画面の表示もこれをそのまま出す。
const STATES = ['idle', 'recording', 'transcribing', 'thinking', 'speaking'];

const LABEL = {
  idle: '待機',
  recording: '聞いています',
  transcribing: '文字にしています',
  thinking: '考えています',
  speaking: '読み上げています',
};

// 状態の遷移。ここに無い組み合わせは起こさない。
const NEXT = {
  idle: { start: 'recording' },
  recording: { stop: 'transcribing', cancel: 'idle' },
  transcribing: { got_text: 'thinking', fail: 'idle', cancel: 'idle' },
  thinking: { got_reply: 'speaking', fail: 'idle', cancel: 'idle' },
  // 読み上げ中にマイクを押したら、読み上げを止めて録音に入る (割り込み)
  speaking: { done: 'idle', barge_in: 'recording', cancel: 'idle' },
};

function nextState(cur, event) {
  const table = NEXT[cur];
  if (!table) throw new Error(`知らない状態: ${cur}`);
  return table[event] || cur; // 知らない出来事は無視して据え置く
}

// ⚠️ 読み上げ中は録音しない。マイクが自分の声を拾って回り続けるため。
// 割り込みたいときは先に読み上げを止める (stopSpeaking) → そのあと start。
function canRecord(state) {
  return state === 'idle';
}

// 押したときに何をするか。画面はこれを見て動く。
function onMicPress(state) {
  if (state === 'recording') return 'stop';
  if (state === 'speaking') return 'barge_in';   // 読み上げを止めて録りはじめる
  if (state === 'idle') return 'start';
  return 'none';                                  // 文字にしている / 考えている間は無視
}

// ── 二重送信よけ ──────────────────────────────────────────────
// 同じ文が続けて飛ぶのは、押し間違いか、認識が二重に返ったとき。
// 送信中は問答無用で断り、直前と同じ文が短い間に来たら断る。
const DUP_WINDOW_MS = 8000;

function makeSendGuard(now = () => Date.now()) {
  let inFlight = false;
  let lastText = '';
  let lastAt = 0;

  return {
    // 送ってよいか。理由も返す (画面に出すため)
    check(text) {
      const t = String(text || '').trim();
      if (!t) return { ok: false, reason: '中身がありません' };
      if (inFlight) return { ok: false, reason: '前の依頼がまだ動いています' };
      if (t === lastText && now() - lastAt < DUP_WINDOW_MS) {
        return { ok: false, reason: '同じ依頼が続けて送られました' };
      }
      return { ok: true };
    },
    begin(text) {
      inFlight = true;
      lastText = String(text || '').trim();
      lastAt = now();
    },
    end() { inFlight = false; },
    get busy() { return inFlight; },
  };
}

// ── 会話か、作業依頼か ────────────────────────────────────────
// ⚠️ 迷ったら「会話」に倒す。会話のつもりの一言が端末で走るほうが害が大きい。
// 判定は語の一致だけ。外部の API を呼ばない (落ちていても必ず動くように)。

const WORK_PATTERNS = [
  /(直して|修正して|なおして)/,
  /(実装して|作って|つくって|足して|追加して)/,
  /(調べて|見て|確認して|チェックして)(おいて|ください|くれ|ね)?$/,
  /(走らせて|実行して|やっといて|やっておいて|進めて)/,
  /(消して|削除して|外して)/,
  /(デプロイして|ビルドして|テストして|コミットして|プッシュして)/,
];

// 逆に、これが入っていたら会話として扱う。質問は作業ではない。
const TALK_PATTERNS = [
  /(どう(なって|思う|かな)|なに(が|を)|何(が|を)|いつ|どこ|なぜ|どうして)/,
  /(教えて|聞きたい|知りたい|わかる\?|どっち)/,
  /\?$|？$/,
];

function classify(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'talk', why: '中身がありません' };
  for (const re of TALK_PATTERNS) {
    if (re.test(t)) return { kind: 'talk', why: '質問として読みました' };
  }
  for (const re of WORK_PATTERNS) {
    if (re.test(t)) return { kind: 'work', why: '作業の言い方が入っています' };
  }
  return { kind: 'talk', why: '作業の言い方が無いので会話にしました' };
}

// ── 渡し先の確かめ ────────────────────────────────────────────
// ⚠️ 別のタブへ入れると、関係ない作業の途中に文字が割り込む。
// 選んだ id が今も在ることと、選んだときと同じものであることを両方見る。

function checkTarget(targetId, tabs, opts = {}) {
  const id = String(targetId || '').trim();
  if (!id) return { ok: false, reason: '渡し先が選ばれていません' };
  const found = (tabs || []).find((t) => String(t.id) === id);
  if (!found) return { ok: false, reason: 'そのタブはもうありません' };
  if (found.exited) return { ok: false, reason: 'そのタブは終わっています' };
  // 選んだときの見た目 (cwd) が変わっていたら、別物になったとみなす
  if (opts.expectCwd && found.cwd !== opts.expectCwd) {
    return { ok: false, reason: 'そのタブの場所が変わっています' };
  }
  return { ok: true, tab: found };
}

// ── 履歴 ──────────────────────────────────────────────────────
// 長くなりすぎると毎回の送信が重くなるので、渡すぶんだけ切る。
// 保存するほうは全部残す (再起動して読み返せるように)。
const SEND_TURNS = 12;

function forSending(history) {
  return (history || [])
    .filter((h) => h && h.role && h.content)
    .slice(-SEND_TURNS)
    .map((h) => ({ role: h.role, content: String(h.content) }));
}

// ── 聞き取りのゴミ ─────────────────────────────────────────────
// ⚠️ Whisper 系はほぼ無音・一瞬の音を渡すと、動画の締めの言葉を作り出す。
//    実測で「ご視聴ありがとうございました」「夢をありがとう」が届いた。
//    定型そのものと、意味を持たない短い断片は捨てて、聞き続ける。
const PHANTOM = [
  /^ご視聴(ありがとうございました|ありがとう)[。.!！]*$/,
  /^(最後まで)?(ご覧|見て)(いただき|くださり)?ありがとうございました[。.!！]*$/,
  /^チャンネル登録/, /^(夢|ご視聴|視聴)をありがとう/,
  /^(おっ|あっ|えっ|うっ|んっ|あ|え|ん|お|う)[。.!！?？]*$/,
  /^[。.、,!！?？\s]*$/,
];
function isPhantom(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return PHANTOM.some((re) => re.test(t));
}

// 話した長さがこれより短ければ、送らずに聞き直す（秒）。
// ⚠️ 短いと「おっ」だけが飛ぶ。長いと「はい」を落とす。0.45 秒は「はい」が通る長さ
const MIN_SPEECH_SEC = 0.45;

// ── 読み上げの区切り ──────────────────────────────────────────
// ⚠️ 返事を丸ごと音にすると、長いほど待たされる (実測で 3 文 3.25 秒)。
//    先頭の一文だけ先に鳴らし、残りは鳴らしている間に作る。
//    短すぎる断片 (「はい。」など) は不自然に切れて聞こえるので、次とくっつける。
//    ⚠️ ここを大きくすると先頭が長くなり、先に鳴らす意味が薄れる。
const MIN_CHUNK = 8;

function chunksForSpeech(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const parts = t.split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].length < MIN_CHUNK) out[out.length - 1] += p;
    else out.push(p);
  }
  // 最後だけ短くなったときも、前にくっつける
  if (out.length > 1 && out[out.length - 1].length < MIN_CHUNK) {
    out[out.length - 2] += out.pop();
  }
  return out;
}

const API = {
  STATES, LABEL, nextState, canRecord, onMicPress, chunksForSpeech, MIN_CHUNK,
  isPhantom, PHANTOM, MIN_SPEECH_SEC,
  makeSendGuard, DUP_WINDOW_MS,
  classify, checkTarget, forSending, SEND_TURNS,
};

// node からはテストで読む。画面からは <script> で読むので window に載せる。
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof window !== 'undefined') window.VoiceTurn = API;
