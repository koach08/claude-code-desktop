// この Mac の中で動く AI(Ollama)と話す。送り先は固定で、設定や画面からは変えられない。
// 中身を外へ出したくない相談に使う。画像はここにだけ渡す(中継サーバーは文字しか運べない)。

const OLLAMA_URL = 'http://127.0.0.1:11434';

async function localModels({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { available: false, models: [] };
    const data = await res.json();
    // Ollama のクラウドモデルは名前が同じ一覧に載るが、中身が外へ出るので「この Mac」には出さない
    const models = (data.models || [])
      .filter((m) => !m.remote_host && !m.remote_model)
      .map((m) => String(m.name || ''))
      .filter((name) => name && !/(^|[:-])cloud$/i.test(name));
    return { available: models.length > 0, running: true, models };
  } catch (_) {
    return { available: false, running: false, models: [] };
  }
}

function buildRequest({ model, messages, system, images }) {
  const out = (messages || []).map((m) => ({ role: m.role, content: m.content }));
  if (images && images.length) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === 'user') { out[i] = { ...out[i], images }; break; }
    }
  }
  if (system) out.unshift({ role: 'system', content: system });
  return { model, messages: out, stream: true };
}

// 1行ずつの JSON を読み、文字が来るたびに onChunk を呼ぶ
async function localChat({ model, messages, system, images, onChunk, fetchImpl = globalThis.fetch }) {
  if (!model) throw new Error('この Mac の AI のモデルが入っていません');
  let res;
  try {
    res = await fetchImpl(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequest({ model, messages, system, images })),
    });
  } catch (_) {
    throw new Error('この Mac の AI(Ollama)が動いていません');
  }
  if (!res.ok) throw new Error(`この Mac の AI がエラーを返しました(HTTP ${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (line) => {
    if (!line.trim()) return;
    let d;
    try { d = JSON.parse(line); } catch (_) { return; }
    if (d.error) throw new Error(String(d.error).slice(0, 300));
    if (d.message && d.message.content) onChunk(d.message.content);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(handle);
  }
  handle(buffer);
}

module.exports = { OLLAMA_URL, localModels, buildRequest, localChat };
