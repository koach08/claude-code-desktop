// 声のやり取りの通信だけを切り出したもの。
//
// ⚠️ ここは速さがそのまま体感になる。実測 (2026-09-10):
//     文字起こし  Railway 経由 2.5 秒 / 直 1.0 秒
//     返事づくり  Railway 経由 3.3 秒 / 直 0.9〜2.5 秒 (モデル次第)
//     読み上げ    直 1.7 秒
//   つまり中継を1つ挟むだけで往復が 1.5 秒延びる。鍵が手元にあるときは直に叩き、
//   無いときだけ midori-os の hub に落とす。
//
// electron を読まないので、fetch を差し替えれば node からテストできる。

const OPENAI = 'https://api.openai.com/v1';
const ANTHROPIC = 'https://api.anthropic.com/v1';

// 耳で聞くので短くする。hub 側の CONVERSE_SYSTEM と揃えてある。
// ⚠️ 片方だけ直すと、直で喋ったときと hub 経由で喋ったときで口調が変わる。
const VOICE_SYSTEM = `あなたは持ち主の相棒 Alfred です。これは声のやり取りです。

守ること:
- **3 文まで。** 耳で聞いて分かる長さにする
- 箇条書きを読み上げない。並べたいときは「3 つあります」と数だけ言う
- 記号を読み上げない。矢印・括弧・コードの記法を使わない
- 分からないことは「分かりません」と言う。作らない
- 一般論と精神論を書かない
- 「〜性」で終わる抽象名詞を使わない。決め台詞を置かない
- です・ます調

作業を頼まれたとき: 自分では実行しません。どのタブに渡すか聞き返してください。`;

// 直に叩けるのはこの 2 つだけ。ほかは hub に任せる (実装を増やさないため)。
const DIRECT = {
  openai: { key: 'OPENAI_API_KEY', fallbackModel: 'gpt-5.6-sol' },
  claude: { key: 'ANTHROPIC_API_KEY', fallbackModel: 'claude-haiku-4-5-20251001' },
};

// 声の既定。⚠️ 重いモデルは 2.5 秒かかって会話が途切れる。
// 相談で深く考えさせたいときは声で「オーパスで」と言えば切り替わる。
const DEFAULT_VOICE_ENGINE = { provider: 'claude', model: 'claude-haiku-4-5-20251001', label: 'Claude' };

// ⚠️ 送るファイル名は中身と揃える。webm 固定にしていたら m4a を弾かれた。
//    MediaRecorder が何を作るかは環境で変わるので、mime から決める。
function nameFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'audio.m4a';
  if (m.includes('ogg')) return 'audio.ogg';
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio.mp3';
  return 'audio.webm';
}

function create({ fetchImpl, getKey, hubUrl, hubSecret }) {
  const f = fetchImpl;
  const key = (name) => (getKey ? String(getKey(name) || '') : '');

  function hubHeaders(extra) {
    const h = { ...(extra || {}) };
    if (hubSecret) h.Authorization = `Bearer ${hubSecret}`;
    return h;
  }

  // ── 文字起こし ──────────────────────────────────────────────
  async function transcribe(bytes, mimeType) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const mime = mimeType || 'audio/webm';
    const k = key('OPENAI_API_KEY');
    if (k) {
      try {
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: mime }), nameFor(mime));
        fd.append('model', 'gpt-4o-mini-transcribe');
        fd.append('language', 'ja');
        const res = await f(`${OPENAI}/audio/transcriptions`, {
          method: 'POST', headers: { Authorization: `Bearer ${k}` }, body: fd,
        });
        if (res.ok) {
          const j = await res.json();
          if (j && j.text) return { text: String(j.text), via: 'direct' };
        }
      } catch (_) { /* 直が駄目なら hub へ落ちる */ }
      // ⚠️ ここに来たのは直が使えなかったということ。hub でも駄目なら理由を返す。
    }
    try {
      const fd = new FormData();
      fd.append('audio', new Blob([buf], { type: mime }), nameFor(mime));
      const res = await f(`${hubUrl}/transcribe`, { method: 'POST', headers: hubHeaders(), body: fd });
      if (!res.ok) return { error: await res.text() };
      const j = await res.json();
      return { text: String((j && j.text) || ''), via: 'hub' };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ── 返事づくり ──────────────────────────────────────────────
  async function reply(messages, opts = {}) {
    const provider = opts.provider || DEFAULT_VOICE_ENGINE.provider;
    const model = opts.model || (provider === DEFAULT_VOICE_ENGINE.provider ? DEFAULT_VOICE_ENGINE.model : '');
    let system = VOICE_SYSTEM;
    if (opts.context) system += `\n\n# いまの材料\n${opts.context}`;

    const d = DIRECT[provider];
    const k = d ? key(d.key) : '';
    if (d && k) {
      try {
        const out = provider === 'claude'
          ? await claudeDirect(k, model || d.fallbackModel, system, messages)
          : await openaiDirect(k, model || d.fallbackModel, system, messages);
        if (out) return { ok: true, reply: out, via: 'direct' };
      } catch (_) { /* hub へ落ちる */ }
    }

    try {
      const res = await f(`${hubUrl}/converse`, {
        method: 'POST',
        headers: hubHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ provider, model: model || '', messages, context: opts.context || '' }),
      });
      if (!res.ok) return { ok: false, reply: 'うまく届きませんでした。', error: await res.text() };
      const j = await res.json();
      return { ...j, via: 'hub' };
    } catch (e) {
      return { ok: false, reply: 'うまく届きませんでした。', error: e.message };
    }
  }

  async function claudeDirect(k, model, system, messages) {
    const res = await f(`${ANTHROPIC}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': k, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: 400, system, messages }),
    });
    if (!res.ok) throw new Error(await res.text());
    const j = await res.json();
    const t = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    return t || null;
  }

  async function openaiDirect(k, model, system, messages) {
    const res = await f(`${OPENAI}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_completion_tokens: 400,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const j = await res.json();
    const t = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    return t || null;
  }

  // ── 読み上げ ────────────────────────────────────────────────
  // ⚠️ Mac 内蔵の声は素っ気ないので使わない。鍵が無いときだけ画面側が内蔵に落ちる。
  async function tts(text, opts = {}) {
    const k = key('OPENAI_API_KEY');
    if (!k) return { error: 'no-key' };
    try {
      const res = await f(`${OPENAI}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts',
          voice: opts.voice || 'nova',
          input: String(text || '').slice(0, 2000),
          response_format: 'mp3',
          instructions: opts.instructions
            || '落ち着いた低めの声で、早口にならず、間を置いて話してください。',
        }),
      });
      if (!res.ok) return { error: await res.text() };
      const buf = new Uint8Array(await res.arrayBuffer());
      return { audio: buf, mime: 'audio/mpeg' };
    } catch (e) {
      return { error: e.message };
    }
  }

  return { transcribe, reply, tts };
}

module.exports = { create, VOICE_SYSTEM, DEFAULT_VOICE_ENGINE, DIRECT, nameFor };
