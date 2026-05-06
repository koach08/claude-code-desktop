const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3900;

// ── Config ──
const API_SECRET = process.env.HUB_API_SECRET || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: (origin, cb) => {
    // Allow Electron apps (no origin) and configured origins
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('CORS blocked'));
    }
  },
}));

// ── Auth middleware ──
function auth(req, res, next) {
  if (!API_SECRET) return next(); // No secret = open (dev mode)
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Provider configs ──
const PROVIDERS = {
  claude: {
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    keyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-20250514',
    models: [
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-haiku-4-5-20251001',
    ],
  },
  openai: {
    name: 'GPT',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    keyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4.1',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini'],
  },
  venice: {
    name: 'Venice.ai',
    baseUrl: 'https://api.venice.ai/api/v1/chat/completions',
    keyEnv: 'VENICE_API_KEY',
    defaultModel: 'llama-3.3-70b',
    models: ['llama-3.3-70b', 'deepseek-r1-671b', 'qwen-2.5-vl', 'dolphin-2.9.2'],
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    keyEnv: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  perplexity: {
    name: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai/chat/completions',
    keyEnv: 'PERPLEXITY_API_KEY',
    defaultModel: 'sonar-pro',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning-pro', 'sonar-reasoning'],
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    keyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it', 'mixtral-8x7b-32768'],
  },
};

// ══════════════════════════════════════
// ── Smart Router ──
// ══════════════════════════════════════
const ROUTE_RULES = [
  // Research / academic → Claude (long context, nuanced)
  { pattern: /論文|paper|研究|research|科研費|kakenhi|査読|review|執筆|draft/i, provider: 'claude', reason: '学術・研究はClaude' },
  { pattern: /英語|English|IELTS|TOEFL|発音|pronunciation|SLA|言語教育/i, provider: 'claude', reason: '言語教育はClaude' },
  { pattern: /設計|アーキテクチャ|リファクタ|architect|design|refactor/i, provider: 'claude', reason: '設計判断はClaude' },

  // Fact-checking / search / citations → Perplexity
  { pattern: /調べ|検索|search|事実|fact.?check|引用|cite|何年|いつ|統計|データ|採択率/i, provider: 'perplexity', reason: 'Web検索+引用はPerplexity' },
  { pattern: /最新|ニュース|news|トレンド|trending|今年|2026/i, provider: 'perplexity', reason: '最新情報はPerplexity' },
  { pattern: /誰|who|どこ|where|比較|compare|ランキング|ranking/i, provider: 'perplexity', reason: '事実照会はPerplexity' },

  // Uncensored / sensitive → Venice
  { pattern: /法的(に|な)|legal|著作権|copyright|訴訟|裁判|NSFW|ノーガード|本音|グレー/i, provider: 'venice', reason: 'フィルタなし相談はVenice' },

  // Quick / simple → Groq (ultra-fast, free)
  { pattern: /翻訳|translate|要約|summarize|explain|説明して|簡単に|手短に|ちょっと/i, provider: 'groq', reason: '即答はGroq（最速）' },
  { pattern: /子(供|ども)|育児|子育て|料理|レシピ|recipe|天気|weather/i, provider: 'groq', reason: '日常の質問はGroq（速い＋無料）' },

  // Long text / bulk → Gemini (free tier, 2M context)
  { pattern: /全文|全体|まとめて|一括|bulk|長い|PDF|ページ/i, provider: 'gemini', reason: '大量テキストはGemini（無料枠大）' },
];

function suggestProvider(text) {
  for (const rule of ROUTE_RULES) {
    if (rule.pattern.test(text)) {
      return { provider: rule.provider, reason: rule.reason, auto: true };
    }
  }
  return null;
}

// ── Route suggestion endpoint ──
app.post('/suggest-route', auth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ suggestion: null });
  const suggestion = suggestProvider(text);
  res.json({ suggestion });
});

// ══════════════════════════════════════
// ── Voice Transcription (Whisper) ──
// ══════════════════════════════════════
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/transcribe', auth, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });

  const openaiKey = process.env[PROVIDERS.openai.keyEnv];
  if (!openaiKey) return res.status(503).json({ error: 'OpenAI API key not configured (needed for Whisper)' });

  try {
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('language', req.body?.language || ''); // auto-detect if empty

    const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}` },
      body: formData,
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return res.status(upstream.status).json({ error: err.slice(0, 500) });
    }

    const data = await upstream.json();
    res.json({ text: data.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ──
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'koach-ai-hub-api', version: '1.0.0' });
});

// ── List available providers and their status ──
app.get('/providers', auth, (_req, res) => {
  const result = {};
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    result[id] = {
      name: cfg.name,
      available: !!process.env[cfg.keyEnv],
      models: cfg.models,
      defaultModel: cfg.defaultModel,
    };
  }
  res.json(result);
});

// ══════════════════════════════════════
// ── Chat endpoint (SSE streaming) ──
// ══════════════════════════════════════
app.post('/chat', auth, async (req, res) => {
  const { provider = 'openai', model, messages, temperature, maxTokens, system } = req.body;

  const cfg = PROVIDERS[provider];
  if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  const apiKey = process.env[cfg.keyEnv];
  if (!apiKey) return res.status(503).json({ error: `${cfg.name} API key not configured` });

  const useModel = model || cfg.defaultModel;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    if (provider === 'claude') {
      await streamClaude(res, apiKey, useModel, messages, system, temperature, maxTokens);
    } else if (provider === 'gemini') {
      await streamGemini(res, apiKey, useModel, messages, system, temperature, maxTokens);
    } else {
      // OpenAI-compatible: openai, grok, venice
      await streamOpenAI(res, cfg.baseUrl, apiKey, useModel, messages, system, temperature, maxTokens);
    }
  } catch (err) {
    const errMsg = err.message || 'Internal error';
    res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

// ── OpenAI-compatible streaming (OpenAI, Grok, Venice.ai) ──
async function streamOpenAI(res, baseUrl, apiKey, model, messages, system, temperature, maxTokens) {
  const body = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    stream: true,
  };
  if (temperature != null) body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;

  const upstream = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    const err = await upstream.text();
    throw new Error(`${upstream.status}: ${err.slice(0, 500)}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      } catch (_) {}
    }
  }
}

// ── Claude API streaming ──
async function streamClaude(res, apiKey, model, messages, system, temperature, maxTokens) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens || 4096,
    stream: true,
  };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    const err = await upstream.text();
    throw new Error(`${upstream.status}: ${err.slice(0, 500)}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);

      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          res.write(`data: ${JSON.stringify({ content: parsed.delta.text })}\n\n`);
        }
      } catch (_) {}
    }
  }
}

// ── Gemini API streaming ──
async function streamGemini(res, apiKey, model, messages, system, temperature, maxTokens) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = { contents };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  if (temperature != null || maxTokens) {
    body.generationConfig = {};
    if (temperature != null) body.generationConfig.temperature = temperature;
    if (maxTokens) body.generationConfig.maxOutputTokens = maxTokens;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    const err = await upstream.text();
    throw new Error(`${upstream.status}: ${err.slice(0, 500)}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);

      try {
        const parsed = JSON.parse(data);
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
        }
      } catch (_) {}
    }
  }
}

// ── Start ──
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Koach AI Hub API running on port ${PORT}`);
    const available = Object.entries(PROVIDERS)
      .filter(([, cfg]) => process.env[cfg.keyEnv])
      .map(([, cfg]) => cfg.name);
    console.log(`Available providers: ${available.length > 0 ? available.join(', ') : '(none - add API keys)'}`);
  });
}

module.exports = app;
