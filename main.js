const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');

const SESSIONS_DIR = path.join(os.homedir(), '.claude-code-app');
const BUFFERS_DIR = path.join(SESSIONS_DIR, 'buffers');
const CRASH_FLAG = path.join(SESSIONS_DIR, '.running');
const sessions = new Map();
const sessionBuffers = new Map();
const MAX_BUFFER = 1024 * 1024; // 1MB per session
let mainWindow = null;
let pty = null;

// ── Resolve shell env (Electron apps don't inherit shell profile) ──
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

let shellEnv = { ...process.env };
// Grok コーディングレーンの既定モデル。grok-4.6 = xAI の現行最上位。
// TUI 内で /models から grok-build-0.1（速い・安いコーディング特化）等へ切替可。
const GROK_MODEL = 'xai/grok-4.6';
// Claude Code レーンで起動時に渡すモデル。'opus[1m]' = 最新 Opus への公式エイリアス
// (CLI が現行最上位 Opus = Opus 5 を自動解決) の 1M コンテキスト版。バージョン固定に
// すると新 Opus が出るたび書き換えが要るため、エイリアス + [1m] で最新へ自動追従する。
// 上位ティア Fable 5 は輸出規制で非公開。
const CLAUDE_MODEL = 'opus[1m]';
if (!IS_WIN) {
  try {
    const shell = IS_MAC ? '/bin/zsh' : '/bin/bash';
    const out = require('child_process').execSync(
      `${shell} -ilc "env"`, { encoding: 'utf-8', timeout: 10000 }
    );
    out.split('\n').forEach(line => {
      const i = line.indexOf('=');
      if (i > 0) shellEnv[line.substring(0, i)] = line.substring(i + 1);
    });
  } catch (_) {}
}

function getPty() {
  if (!pty) pty = require('node-pty');
  return pty;
}

function createWindow() {
  let bounds = { width: 1300, height: 850 };
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, 'window.json'), 'utf-8'));
    bounds = saved;
  } catch (_) {}

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 700,
    minHeight: 450,
    backgroundColor: '#1a1b26',
    title: 'Ariya Bridge 開発エージェント',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 12, y: 12 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('close', () => {
    // Save sessions + buffers BEFORE the window closes (critical for restore)
    saveSessionsSync();
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(SESSIONS_DIR, 'window.json'),
        JSON.stringify(mainWindow.getBounds())
      );
    } catch (_) {}
  });

  // Save sessions when window loses focus (crash resilience)
  mainWindow.on('blur', () => saveSessionsSync());

  // 起動中に ariya:// で叩かれた分は、タブ復元が落ち着いてから渡す
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) setTimeout(flushPendingDeepLink, 1200);
  });
}

// ── Application Menu ──
function createMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: `${app.name} について` },
        { type: 'separator' },
        { role: 'hide', label: '隠す' },
        { role: 'hideOthers', label: 'ほかを隠す' },
        { role: 'unhide', label: 'すべて表示' },
        { type: 'separator' },
        { role: 'quit', label: '終了' }
      ]
    }] : []),
    {
      label: 'ファイル',
      submenu: [
        {
          label: '新しいタブ',
          accelerator: 'CmdOrCtrl+T',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'new-tab'); }
        },
        {
          label: 'タブを閉じる',
          accelerator: 'CmdOrCtrl+W',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'close-tab'); }
        },
        { type: 'separator' },
        {
          label: 'セッションを保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            saveSessionsSync();
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'saved');
          }
        },
        ...(!isMac ? [{ type: 'separator' }, { role: 'quit', label: '終了' }] : [])
      ]
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '元に戻す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべて選択' }
      ]
    },
    {
      label: 'ツール',
      submenu: [
        {
          label: '設定...',
          accelerator: 'CmdOrCtrl+,',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'settings'); }
        },
        { type: 'separator' },
        {
          label: 'このアプリを Claude Code で編集',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'edit-app-claude'); }
        },
        {
          label: 'アプリフォルダを開く',
          click: () => { shell.openPath(path.join(__dirname)); }
        },
        { type: 'separator' },
        {
          label: 'アップデートを確認...',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'check-update'); }
        },
      ]
    },
    {
      label: 'ウインドウ',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: 'ズーム' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '前面に移動' }] : [])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC: Create session ──
// Read a KEY=value entry from the user's local secrets file (non-persistent use).
function readSecretKey(name) {
  try {
    const p = path.join(os.homedir(), '.config', 'app-secrets', 'env.txt');
    const line = fs.readFileSync(p, 'utf-8').split('\n').find(l => l.trim().startsWith(name + '='));
    if (line) return line.slice(line.indexOf('=') + 1).trim();
  } catch (_) {}
  return '';
}

// Derive a friendly, project-aware tab name from the working directory.
// Known project folders map to readable labels; otherwise the folder basename is used.
function deriveSessionName(cwd, mode) {
  const norm = String(cwd || '').replace(/\/+$/, '');
  const base = (norm === os.homedir() || !norm) ? '' : norm.split('/').pop();
  const MAP = {
    'ai-studio': 'EGAKU', 'egaku-ai': 'EGAKU', 'egaku-diffusion': 'EGAKU Diffusion',
    'crypto-trader': '仮想通貨AI', 'code-harness': 'Code Harness',
    'claude-code-desktop': 'CC Desktop', 'koach-voice': 'koach-voice',
    'english-platform-commercial': 'SpeakSmart', 'english-platform-next': '英語大学版',
    'spanish-platform': 'スペイン語', 'persian-learning': 'ペルシア語',
    'english_assessment_v2': '英語評価', 'koach-os-app-live': 'Koach OS',
    'uni-agent-app': 'UniAgent', 'eduplanner': 'EduPlanner', 'souji': 'Souji',
    'investment-app': '投資分析', 'RIPE2026-paper': 'RIPE論文',
  };
  const project = MAP[base] || base;
  if (!project) {
    return mode === 'claude' ? 'Claude Code' : mode === 'codex' ? 'Codex' : mode === 'gemini' ? 'Gemini' : mode === 'grok' ? 'Grok' : 'Terminal';
  }
  const suffix = mode === 'codex' ? ' · Codex' : mode === 'gemini' ? ' · Gemini' : mode === 'grok' ? ' · Grok' : mode === 'shell' ? ' · sh' : '';
  return project + suffix;
}

ipcMain.handle('create-session', async (_event, { cwd, name, mode, restoreFromId, conversationId }) => {
  const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const nodePty = getPty();
  const sessionCwd = cwd || os.homedir();
  const sessionMode = mode || 'claude';
  const isRestore = !!(restoreFromId || conversationId);

  let cmd, args;
  if (sessionMode === 'claude') {
    cmd = IS_WIN ? 'claude.cmd' : 'claude';
    if (conversationId) {
      args = ['--model', CLAUDE_MODEL, '--resume', conversationId];
    } else {
      args = ['--model', CLAUDE_MODEL];
    }
  } else if (sessionMode === 'codex') {
    cmd = IS_WIN ? 'codex.cmd' : 'codex';
    args = [];
  } else if (sessionMode === 'gemini') {
    cmd = IS_WIN ? 'gemini.cmd' : 'gemini';
    args = [];
  } else if (sessionMode === 'grok') {
    // Grok コーディングレーン: Grok 専用 CLI は現行 xAI API と噛み合わない(Codex→xAI は
    // responses API 非互換、@vibe-kit/grok-cli は廃止 live-search で 410)。実績ある
    // opencode(TUI エージェント)を xAI/grok に向けて起動する。認証は XAI_API_KEY を注入。
    cmd = IS_WIN ? 'opencode.cmd' : 'opencode';
    args = ['-m', GROK_MODEL];
  } else {
    if (IS_WIN) {
      cmd = 'powershell.exe';
      args = [];
    } else {
      cmd = IS_MAC ? '/bin/zsh' : (process.env.SHELL || '/bin/bash');
      args = ['--login', '-i'];
    }
  }

  const spawnEnv = { ...shellEnv };
  if (sessionMode === 'gemini' && !spawnEnv.GEMINI_API_KEY) {
    const k = readSecretKey('GEMINI_API_KEY');
    if (k) spawnEnv.GEMINI_API_KEY = k;
  }
  if (sessionMode === 'grok' && !spawnEnv.XAI_API_KEY) {
    const k = readSecretKey('XAI_API_KEY');
    if (k) { spawnEnv.XAI_API_KEY = k; spawnEnv.GROK_API_KEY = k; }
  }
  const ptyProcess = nodePty.spawn(cmd, args, {
    name: IS_WIN ? undefined : 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: sessionCwd,
    env: spawnEnv,
  });

  const sessionData = {
    pty: ptyProcess,
    cwd: sessionCwd,
    name: name || deriveSessionName(sessionCwd, sessionMode),
    mode: sessionMode,
    conversationId: conversationId || null,
    createdAt: new Date().toISOString(),
  };
  sessions.set(id, sessionData);

  // Start with empty buffer — don't replay stale old output
  sessionBuffers.set(id, '');

  // Auto-detect conversation ID by matching the .jsonl session file Claude creates
  // for this cwd. Runs for the whole session lifetime (throttled) until found — so a
  // tab whose first message comes late still gets a resumable conversationId, which is
  // what lets a restart --resume the real conversation instead of losing it.
  const sessionStartMs = Date.now();
  let convIdDetected = !!conversationId;
  let lastConvCheck = 0;

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-output-${id}`, data);
    }
    let buf = (sessionBuffers.get(id) || '') + data;
    if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
    sessionBuffers.set(id, buf);

    // Detect conversation ID from Claude's project directory (throttled to ~1.5s).
    if (sessionMode === 'claude' && !convIdDetected) {
      const now = Date.now();
      if (now - lastConvCheck > 1500) {
        lastConvCheck = now;
        const s = sessions.get(id);
        if (s && !s.conversationId) {
          const cwdKey = sessionCwd.replace(/\//g, '-');
          const projectDir = path.join(os.homedir(), '.claude', 'projects', cwdKey);
          try {
            if (fs.existsSync(projectDir)) {
              // Only consider .jsonl files created at/after this session started, so we
              // attach THIS session's conversation, not an older one in the same cwd.
              const files = fs.readdirSync(projectDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
                .filter(f => f.mtime >= sessionStartMs - 2000)
                .sort((a, b) => b.mtime - a.mtime);
              if (files.length > 0) {
                s.conversationId = files[0].name.replace('.jsonl', '');
                convIdDetected = true;
              }
            }
          } catch (_) {}
        }
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-exit-${id}`, { exitCode, signal });
    }
  });

  return { id, name: sessionData.name, cwd: sessionData.cwd, mode: sessionMode, restored: isRestore };
});

// ── IPC: Switch mode (kills current, starts new) ──
ipcMain.handle('switch-mode', async (_event, { sessionId, newMode }) => {
  const old = sessions.get(sessionId);
  if (!old) return null;
  const { cwd } = old;
  try { old.pty.kill(); } catch (_) {}
  sessionBuffers.delete(sessionId);
  sessions.delete(sessionId);

  const nodePty = getPty();
  let cmd, args;
  if (newMode === 'claude') {
    cmd = IS_WIN ? 'claude.cmd' : 'claude';
    args = ['--model', CLAUDE_MODEL];
  } else if (newMode === 'codex') {
    cmd = IS_WIN ? 'codex.cmd' : 'codex';
    args = [];
  } else if (newMode === 'gemini') {
    cmd = IS_WIN ? 'gemini.cmd' : 'gemini';
    args = [];
  } else if (newMode === 'grok') {
    cmd = IS_WIN ? 'opencode.cmd' : 'opencode';
    args = ['-m', GROK_MODEL];
  } else {
    if (IS_WIN) { cmd = 'powershell.exe'; args = []; }
    else { cmd = IS_MAC ? '/bin/zsh' : (process.env.SHELL || '/bin/bash'); args = ['--login', '-i']; }
  }

  // create-session と同じくエンジン別の API キーを注入(gemini/grok)。
  const switchEnv = { ...shellEnv };
  if (newMode === 'gemini' && !switchEnv.GEMINI_API_KEY) {
    const k = readSecretKey('GEMINI_API_KEY');
    if (k) switchEnv.GEMINI_API_KEY = k;
  }
  if (newMode === 'grok' && !switchEnv.XAI_API_KEY) {
    const k = readSecretKey('XAI_API_KEY');
    if (k) { switchEnv.XAI_API_KEY = k; switchEnv.GROK_API_KEY = k; }
  }

  const newId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const ptyProcess = nodePty.spawn(cmd, args, {
    name: IS_WIN ? undefined : 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: switchEnv,
  });

  const modeName = newMode === 'claude' ? 'Claude Code' : newMode === 'codex' ? 'Codex' : newMode === 'gemini' ? 'Gemini' : newMode === 'grok' ? 'Grok' : 'Terminal';
  sessions.set(newId, {
    pty: ptyProcess,
    cwd,
    name: modeName,
    mode: newMode,
    createdAt: new Date().toISOString(),
  });
  sessionBuffers.set(newId, '');

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-output-${newId}`, data);
    }
    let buf = (sessionBuffers.get(newId) || '') + data;
    if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
    sessionBuffers.set(newId, buf);
  });
  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-exit-${newId}`, { exitCode });
    }
  });

  return { newId, name: modeName, cwd, mode: newMode };
});

ipcMain.handle('send-input', async (_e, { sessionId, input }) => {
  const s = sessions.get(sessionId);
  if (!s || !s.pty) return { ok: false, reason: 'no-session' };
  try {
    s.pty.write(input);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('resize-terminal', async (_e, { sessionId, cols, rows }) => {
  const s = sessions.get(sessionId);
  if (s && s.pty) { try { s.pty.resize(cols, rows); } catch (_) {} }
});

ipcMain.handle('close-session', async (_e, { sessionId }) => {
  const s = sessions.get(sessionId);
  if (s && s.pty) { try { s.pty.kill(); } catch (_) {} sessions.delete(sessionId); }
  sessionBuffers.delete(sessionId);
  try { fs.unlinkSync(path.join(BUFFERS_DIR, `${sessionId}.buf`)); } catch (_) {}
});

// ── Check if Claude Code CLI is installed ──
ipcMain.handle('check-claude-cli', async () => {
  try {
    const whichCmd = IS_WIN
      ? 'where claude'
      : `${IS_MAC ? '/bin/zsh' : '/bin/bash'} -ilc "which claude"`;
    const result = require('child_process').execSync(
      whichCmd, { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    if (result && result.includes('claude')) {
      let version = '';
      try {
        const verCmd = IS_WIN
          ? 'claude --version'
          : `${IS_MAC ? '/bin/zsh' : '/bin/bash'} -ilc "claude --version"`;
        version = require('child_process').execSync(
          verCmd, { encoding: 'utf-8', timeout: 10000 }
        ).trim();
      } catch (_) {}
      return { installed: true, path: result, version };
    }
    return { installed: false };
  } catch {
    return { installed: false };
  }
});

// ── Install Claude Code CLI ──
ipcMain.handle('install-claude-cli', async () => {
  try {
    const installCmd = IS_WIN
      ? 'npm install -g @anthropic-ai/claude-code'
      : `${IS_MAC ? '/bin/zsh' : '/bin/bash'} -ilc "npm install -g @anthropic-ai/claude-code"`;
    require('child_process').execSync(installCmd, { encoding: 'utf-8', timeout: 120000 });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Resolve dropped path to directory ──
ipcMain.handle('resolve-cwd', async (_e, droppedPath) => {
  try {
    const stat = fs.statSync(droppedPath);
    return stat.isDirectory() ? droppedPath : path.dirname(droppedPath);
  } catch {
    return os.homedir();
  }
});

// ── Load buffer for session restore ──
ipcMain.handle('load-buffer', async (_e, { sessionId }) => {
  try {
    return fs.readFileSync(path.join(BUFFERS_DIR, `${sessionId}.buf`), 'utf-8');
  } catch { return null; }
});

// ── Clean up old buffer files after restore ──
ipcMain.handle('cleanup-old-buffers', async (_e, { oldIds }) => {
  for (const id of oldIds) {
    try { fs.unlinkSync(path.join(BUFFERS_DIR, `${id}.buf`)); } catch (_) {}
  }
});

// ── Get app directory (for editing this app) ──
ipcMain.handle('get-app-dir', async () => {
  return path.join(__dirname);
});

// ── Scan project directory for Builder mode ──
ipcMain.handle('scan-project', async (_e, { cwd }) => {
  const result = {
    name: path.basename(cwd),
    cwd,
    framework: null,
    language: null,
    dependencies: [],
    configs: [],
    suggestions: [],
  };

  try {
    const exists = (f) => fs.existsSync(path.join(cwd, f));
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, f), 'utf-8')); } catch { return null; } };
    const readText = (f) => { try { return fs.readFileSync(path.join(cwd, f), 'utf-8'); } catch { return ''; } };

    // ── Node.js / JavaScript ──
    if (exists('package.json')) {
      const pkg = readJson('package.json');
      if (pkg) {
        result.packageName = pkg.name;
        result.version = pkg.version;
        result.scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        result.dependencies = Object.keys(allDeps);

        // Framework detection
        if (allDeps['next']) { result.framework = 'Next.js'; result.language = 'JavaScript'; }
        else if (allDeps['nuxt']) { result.framework = 'Nuxt'; result.language = 'JavaScript'; }
        else if (allDeps['react']) { result.framework = 'React'; result.language = 'JavaScript'; }
        else if (allDeps['vue']) { result.framework = 'Vue'; result.language = 'JavaScript'; }
        else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) { result.framework = 'Svelte'; result.language = 'JavaScript'; }
        else if (allDeps['express']) { result.framework = 'Express'; result.language = 'JavaScript'; }
        else if (allDeps['electron']) { result.framework = 'Electron'; result.language = 'JavaScript'; }

        if (allDeps['typescript'] || exists('tsconfig.json')) result.language = 'TypeScript';

        // Deployment configs
        if (exists('vercel.json')) result.configs.push('vercel');
        if (exists('netlify.toml')) result.configs.push('netlify');
        if (exists('railway.json') || exists('railway.toml')) result.configs.push('railway');
        if (exists('Dockerfile')) result.configs.push('docker');
        if (exists('docker-compose.yml') || exists('docker-compose.yaml')) result.configs.push('docker-compose');
        if (exists('capacitor.config.ts') || exists('capacitor.config.json')) result.configs.push('capacitor');
        if (exists('electron-builder.yml') || (pkg.build && pkg.build.appId)) result.configs.push('electron-builder');
        if (exists('tauri.conf.json') || exists('src-tauri')) result.configs.push('tauri');

        // Infrastructure detection
        if (allDeps['@supabase/supabase-js']) result.configs.push('supabase');
        if (allDeps['firebase'] || allDeps['firebase-admin']) result.configs.push('firebase');
        if (allDeps['stripe']) result.configs.push('stripe');
        if (allDeps['@capacitor/core']) result.configs.push('capacitor');
        if (allDeps['@prisma/client']) result.configs.push('prisma');
      }
    }

    // ── Python ──
    if (exists('requirements.txt') || exists('pyproject.toml') || exists('setup.py')) {
      result.language = result.language || 'Python';
      const req = readText('requirements.txt') + readText('pyproject.toml');
      if (req.includes('streamlit')) result.framework = result.framework || 'Streamlit';
      else if (req.includes('fastapi')) result.framework = result.framework || 'FastAPI';
      else if (req.includes('django')) result.framework = result.framework || 'Django';
      else if (req.includes('flask')) result.framework = result.framework || 'Flask';
      if (req.includes('supabase')) result.configs.push('supabase');
    }

    // ── Swift ──
    if (exists('Package.swift') || exists('.xcodeproj') || exists('.xcworkspace')) {
      result.language = result.language || 'Swift';
      result.framework = result.framework || 'Xcode';
      result.configs.push('xcode');
    }
    // ── Xcode project detection ──
    try {
      const entries = fs.readdirSync(cwd);
      for (const e of entries) {
        if (e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace')) {
          result.configs.push('xcode');
          result.language = result.language || 'Swift';
          break;
        }
      }
    } catch (_) {}

    // ── Rust ──
    if (exists('Cargo.toml')) {
      result.language = result.language || 'Rust';
      result.framework = result.framework || 'Cargo';
      const cargo = readText('Cargo.toml');
      if (cargo.includes('tauri')) result.configs.push('tauri');
    }

    // ── Go ──
    if (exists('go.mod')) {
      result.language = result.language || 'Go';
    }

    // ── Flutter / Dart ──
    if (exists('pubspec.yaml')) {
      result.language = result.language || 'Dart';
      result.framework = result.framework || 'Flutter';
    }

    // ── Build suggestions based on detected stack ──
    if (!result.framework && !result.language) {
      result.suggestions.push('empty');
    } else {
      // Web deploy
      if (['Next.js', 'React', 'Vue', 'Svelte', 'Nuxt'].includes(result.framework)) {
        result.suggestions.push('vercel', 'netlify', 'docker');
      }
      if (['Express', 'FastAPI', 'Flask', 'Django'].includes(result.framework)) {
        result.suggestions.push('railway', 'docker', 'vps');
      }
      if (result.framework === 'Streamlit') {
        result.suggestions.push('streamlit-cloud', 'docker');
      }
      // Desktop
      if (result.framework === 'Electron') {
        result.suggestions.push('electron-mac', 'electron-win', 'electron-linux');
      }
      if (['Next.js', 'React', 'Vue', 'Svelte'].includes(result.framework)) {
        result.suggestions.push('tauri-mac', 'tauri-win', 'tauri-linux', 'capacitor-ios', 'capacitor-android');
      }
      // Native
      if (result.language === 'Swift') {
        result.suggestions.push('xcode-ios', 'xcode-mac');
      }
      if (result.framework === 'Flutter') {
        result.suggestions.push('flutter-ios', 'flutter-android', 'flutter-mac', 'flutter-web');
      }
      // SaaS infra
      result.suggestions.push('supabase', 'stripe', 'auth');
    }
  } catch (_) {}

  return result;
});

// ══════════════════════════════════════
// ── AI Hub Chat API ──
// ══════════════════════════════════════
const HUB_CONFIG_FILE = path.join(SESSIONS_DIR, 'hub-config.json');
const DEFAULT_HUB_CONFIG = {
  apiUrl: 'http://localhost:3900',
  apiSecret: '',
  defaultProvider: 'openai',
};

ipcMain.handle('hub-load-config', async () => {
  try {
    if (fs.existsSync(HUB_CONFIG_FILE)) {
      return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
    }
  } catch (_) {}
  return { ...DEFAULT_HUB_CONFIG };
});

ipcMain.handle('hub-save-config', async (_e, cfg) => {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(HUB_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('hub-providers', async () => {
  const cfg = (() => {
    try {
      if (fs.existsSync(HUB_CONFIG_FILE)) {
        return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
      }
    } catch (_) {}
    return { ...DEFAULT_HUB_CONFIG };
  })();
  try {
    const headers = {};
    if (cfg.apiSecret) headers['Authorization'] = `Bearer ${cfg.apiSecret}`;
    const res = await fetch(`${cfg.apiUrl}/providers`, { headers });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('hub-transcribe', async (_e, { audioBuffer, mimeType }) => {
  const cfg = (() => {
    try {
      if (fs.existsSync(HUB_CONFIG_FILE)) {
        return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
      }
    } catch (_) {}
    return { ...DEFAULT_HUB_CONFIG };
  })();

  try {
    const formData = new FormData();
    formData.append('audio', new Blob([Buffer.from(audioBuffer)], { type: mimeType || 'audio/webm' }), 'audio.webm');

    const headers = {};
    if (cfg.apiSecret) headers['Authorization'] = `Bearer ${cfg.apiSecret}`;

    const res = await fetch(`${cfg.apiUrl}/transcribe`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      return { error: err };
    }
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
});

// ── Smart Router (Hub チャットのプロバイダ提案) ──
// タイプ中のテキストからキーワードで最適な LLM プロバイダを1つ提案する。
// 外部 API 不要のローカル判定なので、api-server が落ちていても必ず動く
// (以前は /suggest-route への fetch 依存で、サーバー停止時に無反応=機能消失していた)。
const HUB_ROUTE_RULES = [
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

ipcMain.handle('hub-suggest-route', async (_e, { text }) => {
  const t = String(text || '');
  for (const rule of HUB_ROUTE_RULES) {
    if (rule.pattern.test(t)) {
      return { provider: rule.provider, reason: rule.reason, auto: true };
    }
  }
  return null;
});

// ── ローカルなエンジン判別 (Claude Code / Codex / Gemini) ──
// タスク説明のキーワードから最適な開発エンジンを1つ推奨する(外部API不要)。
ipcMain.handle('suggest-engine', async (_e, { task }) => {
  const t = String(task || '').toLowerCase();
  const has = (arr) => arr.some(k => t.includes(k));
  const codexKw = ['リファクタ', 'refactor', 'バグ', 'bug', 'デバッグ', 'debug', '修正', '直し', '横断', '全体を', 'どこで使', '影響範囲', '影響を', '既存の', 'アルゴリズム', '最適化', 'テストを', 'コードベース'];
  const geminiKw = ['速く', '急ぎ', '大量', '量産', 'たくさん', 'ui', '画面', 'フロント', 'front', 'ブラウザ', 'browser', 'デザイン', 'スクショ', 'プロトタイプ', '試作', '安く', 'コスト', '反復'];
  const claudeKw = ['設計', 'アーキ', '新規', '実装して', '記事', '論文', 'ドキュメント', '書い', '説明', 'レビュー', '丁寧', '品質', 'mcp', 'supabase', 'vercel', 'デプロイ', '戦略', '企画'];
  const grokKw = ['grok', 'グロック', 'xai', 'grok-code'];
  let engine = 'claude', reason = '既定：品質・繊細な作業・書き物・MCP連携に強い';
  if (has(grokKw)) { engine = 'grok'; reason = '高速・低コストなコーディング(grok-code-fast)。Grok 指定時に'; }
  else if (has(codexKw)) { engine = 'codex'; reason = '既存コードの横断理解・影響追跡・リファクタ/バグ修正に強い'; }
  else if (has(geminiKw)) { engine = 'gemini'; reason = '速度・量・UI/ブラウザ検証・コスト効率に強い'; }
  else if (has(claudeKw)) { engine = 'claude'; reason = '設計・新規実装・書き物・MCP連携に強い'; }
  const label = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', grok: 'Grok' }[engine];
  return { engine, label, reason };
});

// ── 出荷プラン生成 (#8): 配布先を自動判定し RELEASE.md を書き出す ──
ipcMain.handle('generate-release-plan', async (_e, { cwd }) => {
  try {
    const dir = cwd || os.homedir();
    const exists = (p) => { try { return fs.existsSync(path.join(dir, p)); } catch { return false; } };
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')); } catch (_) {}
    const dep = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const has = (n) => Object.keys(dep).some(k => k.includes(n));

    let channel, steps;
    if (exists('capacitor.config.ts') || exists('capacitor.config.json') || exists('ios')) {
      channel = 'iOS App Store';
      steps = `1. [自動] npm run build && npx cap sync ios\n2. [自動] Info.plist: ITSAppUsesNonExemptEncryption=false 確認\n3. [要本人] Xcode で Archive → Distribute → App Store Connect Upload\n4. [自動/事前] スクショ 6.7"(1290x2796)/6.5"(1242x2688)/iPad 12.9"(2048x2732)\n5. [要本人] App Store Connect: メタデータ・App Privacy・審査提出`;
    } else if (has('electron')) {
      const masish = JSON.stringify(pkg.build || {}).includes('mas');
      channel = masish ? 'Mac App Store' : 'Gumroad (DMG)';
      steps = masish
        ? `1. [自動] electron-builder --mac mas (3rd Party Mac Developer 署名+provisioning)\n2. [自動] .pkg 検証\n3. [要本人] Transporter/altool で App Store Connect アップロード\n4. [要本人] メタデータ・スクショ(2880x1800)・審査提出`
        : `1. [自動] electron-builder --mac (Developer ID Application 署名)\n2. [自動] notarize: xcrun notarytool submit <dmg> --keychain-profile "notarytool-profile" --wait\n3. [自動] staple: xcrun stapler staple <dmg> && spctl -a -vvv -t install <dmg>\n4. [自動] 販売文(EN/JP)生成\n5. [要本人] gumroad.com で商品作成→DMGアップロード→価格→公開`;
    } else if (exists('next.config.js') || exists('next.config.ts') || exists('vercel.json') || has('next')) {
      channel = 'Web SaaS (Vercel)';
      steps = `1. [自動] ship-check(SEO/OG/決済/本番設定)\n2. [自動] vercel --prod (EGAKU系はwebhook故障のためcommit後に必須)\n3. [要本人] Stripe本番キー・Webエンドポイント確認、テストキー残留チェック\n4. [自動] Search Console/sitemap/OG 最終確認`;
    } else {
      channel = '汎用 / Gumroad(デジタル)';
      steps = `1. [自動] 成果物パッケージング(zip/pdf等)\n2. [自動] 販売文(志柿スタイル)生成\n3. [要本人] gumroad.com で商品作成→アップロード→公開`;
    }

    const name = pkg.name || path.basename(dir);
    const md = `# RELEASE — ${name}\n\n配布先(自動判定): **${channel}**\n\n> GitHub push はゴールではなく途中の1ステップ。全項目 ✅ になるまで「完成」と言わない。\n> [自動]=アプリ/AIが実行 / [要本人]=Apple・Gumroad等の対話操作。\n\n## 手順\n${steps}\n\n---\n- Apple Team ID: HDSYA72T8Z / notarytool profile: notarytool-profile\n- プライバシーポリシー: https://gist.github.com/koach08/fe3cf9201983f03b64dcad8bce4f74f0\n- 方針: まず Gumroad で最速公開 → 売れたら App Store 追加\n`;
    const outPath = path.join(dir, 'RELEASE.md');
    fs.writeFileSync(outPath, md, 'utf-8');
    return { ok: true, path: outPath, channel };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-path', async (_e, { p }) => { try { shell.openPath(p); } catch (_) {} });

ipcMain.handle('hub-chat', async (_e, { provider, model, messages, system, temperature }) => {
  const cfg = (() => {
    try {
      if (fs.existsSync(HUB_CONFIG_FILE)) {
        return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
      }
    } catch (_) {}
    return { ...DEFAULT_HUB_CONFIG };
  })();

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiSecret) headers['Authorization'] = `Bearer ${cfg.apiSecret}`;

  try {
    const res = await fetch(`${cfg.apiUrl}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider, model, messages, system, temperature }),
    });

    if (!res.ok) {
      const err = await res.text();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hub-chat-error', { error: err });
      }
      return;
    }

    // Read SSE stream
    const reader = res.body.getReader();
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

        if (data === '[DONE]') {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hub-chat-done', {});
          }
          return;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('hub-chat-error', { error: parsed.error });
            }
            return;
          }
          if (parsed.content && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hub-chat-chunk', { content: parsed.content });
          }
        } catch (_) {}
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hub-chat-done', {});
    }
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hub-chat-error', { error: e.message });
    }
  }
});

// ── Harness Engineering: CLAUDE.md ──
ipcMain.handle('harness-read-claudemd', async (_e, { cwd }) => {
  const filePath = path.join(cwd, 'CLAUDE.md');
  try {
    if (fs.existsSync(filePath)) {
      return { exists: true, content: fs.readFileSync(filePath, 'utf-8') };
    }
    return { exists: false, content: '' };
  } catch { return { exists: false, content: '' }; }
});

ipcMain.handle('harness-write-claudemd', async (_e, { cwd, content }) => {
  try {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('harness-read-user-claudemd', async () => {
  const filePath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  try {
    if (fs.existsSync(filePath)) {
      return { exists: true, content: fs.readFileSync(filePath, 'utf-8') };
    }
    return { exists: false, content: '' };
  } catch { return { exists: false, content: '' }; }
});

ipcMain.handle('harness-write-user-claudemd', async (_e, { content }) => {
  const dir = path.join(os.homedir(), '.claude');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Harness Engineering: Hooks (settings.json) ──
ipcMain.handle('harness-read-hooks', async (_e, { cwd }) => {
  const projectSettings = path.join(cwd, '.claude', 'settings.json');
  const userSettings = path.join(os.homedir(), '.claude', 'settings.json');
  const result = { project: null, user: null };
  try {
    if (fs.existsSync(projectSettings)) {
      const data = JSON.parse(fs.readFileSync(projectSettings, 'utf-8'));
      result.project = data.hooks || null;
    }
  } catch (_) {}
  try {
    if (fs.existsSync(userSettings)) {
      const data = JSON.parse(fs.readFileSync(userSettings, 'utf-8'));
      result.user = data.hooks || null;
    }
  } catch (_) {}
  return result;
});

ipcMain.handle('harness-write-hooks', async (_e, { cwd, hooks }) => {
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  try {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    let data = {};
    try { data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch (_) {}
    data.hooks = hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Harness Engineering: Memory ──
ipcMain.handle('harness-read-memory', async () => {
  const memoryDir = path.join(os.homedir(), '.claude', 'memory');
  const result = [];
  try {
    if (!fs.existsSync(memoryDir)) return result;
    const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');
        const nameMatch = content.match(/^name:\s*(.+)/m);
        const typeMatch = content.match(/^type:\s*(.+)/m);
        const descMatch = content.match(/^description:\s*(.+)/m);
        result.push({
          file,
          name: nameMatch ? nameMatch[1].trim() : file.replace('.md', ''),
          type: typeMatch ? typeMatch[1].trim() : 'unknown',
          description: descMatch ? descMatch[1].trim() : '',
        });
      } catch (_) {}
    }
  } catch (_) {}
  return result;
});

ipcMain.handle('harness-read-memory-content', async (_e, { file }) => {
  const memoryDir = path.join(os.homedir(), '.claude', 'memory');
  try {
    return { content: fs.readFileSync(path.join(memoryDir, file), 'utf-8') };
  } catch (e) {
    return { content: '', error: e.message };
  }
});

ipcMain.handle('harness-write-memory', async (_e, { file, content }) => {
  const memoryDir = path.join(os.homedir(), '.claude', 'memory');
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, file), content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('harness-delete-memory', async (_e, { file }) => {
  const memoryDir = path.join(os.homedir(), '.claude', 'memory');
  try {
    fs.unlinkSync(path.join(memoryDir, file));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Harness Engineering: Projects ──
const PROJECTS_FILE = path.join(SESSIONS_DIR, 'projects.json');

ipcMain.handle('harness-load-projects', async () => {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
    }
  } catch (_) {}
  return [];
});

ipcMain.handle('harness-save-projects', async (_e, projects) => {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('harness-pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ── Persistence ──
function saveSessionsSync() {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.mkdirSync(BUFFERS_DIR, { recursive: true });
    const data = [];
    for (const [id, s] of sessions) {
      data.push({ id, name: s.name, cwd: s.cwd, mode: s.mode, conversationId: s.conversationId || null, createdAt: s.createdAt, savedAt: new Date().toISOString() });
    }
    fs.writeFileSync(path.join(SESSIONS_DIR, 'sessions.json'), JSON.stringify(data, null, 2));
    // Save output buffers
    for (const [id, buf] of sessionBuffers) {
      fs.writeFileSync(path.join(BUFFERS_DIR, `${id}.buf`), buf, 'utf-8');
    }
  } catch (_) {}
}
ipcMain.handle('save-sessions', async () => saveSessionsSync());
ipcMain.handle('load-sessions', async () => {
  try {
    const f = path.join(SESSIONS_DIR, 'sessions.json');
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch { return []; }
});

// ── Crash detection ──
ipcMain.handle('check-crash', async () => {
  try {
    if (fs.existsSync(CRASH_FLAG)) return true;
  } catch (_) {}
  return false;
});

function setCrashFlag() {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(CRASH_FLAG, new Date().toISOString());
  } catch (_) {}
}

function clearCrashFlag() {
  try { fs.unlinkSync(CRASH_FLAG); } catch (_) {}
}

// ── Work Log (track prompts for crash recovery) ──
const WORKLOG_FILE = path.join(SESSIONS_DIR, 'work-log.json');
const MAX_LOG_ENTRIES = 200;

function loadWorkLog() {
  try {
    if (fs.existsSync(WORKLOG_FILE)) return JSON.parse(fs.readFileSync(WORKLOG_FILE, 'utf-8'));
  } catch (_) {}
  return [];
}

function saveWorkLogEntry(entry) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const log = loadWorkLog();
    log.push(entry);
    if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
    fs.writeFileSync(WORKLOG_FILE, JSON.stringify(log, null, 2));
  } catch (_) {}
}

ipcMain.handle('log-prompt', async (_e, { sessionId, prompt, sessionName, cwd }) => {
  saveWorkLogEntry({
    sessionId,
    sessionName: sessionName || 'unknown',
    cwd: cwd || '',
    prompt,
    timestamp: new Date().toISOString(),
  });
});

ipcMain.handle('load-work-log', async () => loadWorkLog());

ipcMain.handle('clear-work-log', async () => {
  try { fs.writeFileSync(WORKLOG_FILE, '[]'); } catch (_) {}
});

// ── Prefs (UI mode etc.) ──
const PREFS_FILE = path.join(SESSIONS_DIR, 'prefs.json');
ipcMain.handle('load-prefs', async () => {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8')); } catch { return {}; }
});
ipcMain.handle('save-prefs', async (_e, prefs) => {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch (_) {}
});

// ── Settings ──
const SETTINGS_FILE = path.join(SESSIONS_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  fontSize: 14,
  autoSaveInterval: 10,
  doubleEnterDelay: 500,
  autoUpdateClis: true,
};

ipcMain.handle('load-settings', async () => {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    return { ...DEFAULT_SETTINGS, ...data };
  } catch { return { ...DEFAULT_SETTINGS }; }
});

ipcMain.handle('save-settings', async (_e, settings) => {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (_) {}
});

// ── CLI auto-update (codex / gemini), throttled to once per 24h ──
const CLI_UPDATE_STAMP = path.join(SESSIONS_DIR, 'cli-update.json');
function autoUpdateClisInBackground() {
  try {
    let settings;
    try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) }; }
    catch { settings = { ...DEFAULT_SETTINGS }; }
    if (!settings.autoUpdateClis) return;

    let last = 0;
    try { last = JSON.parse(fs.readFileSync(CLI_UPDATE_STAMP, 'utf-8')).ts || 0; } catch (_) {}
    if (Date.now() - last < 24 * 60 * 60 * 1000) return; // 1日1回まで
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); fs.writeFileSync(CLI_UPDATE_STAMP, JSON.stringify({ ts: Date.now() })); } catch (_) {}

    const { exec } = require('child_process');
    const run = (label, cmd) => exec(cmd, { env: shellEnv, timeout: 180000 }, (err) => {
      const msg = `[cli-update] ${label}: ${err ? 'skip/err (' + (err.message || '').split('\n')[0] + ')' : 'up to date'}`;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cli-update-log', msg);
    });
    // Codex は専用 update サブコマンド、Gemini は npm グローバル更新。無ければ静かに失敗。
    run('codex', 'codex update');
    run('gemini', 'npm install -g @google/gemini-cli@latest');
  } catch (_) {}
}

// ── Open app folder in Finder/Explorer ──
ipcMain.handle('open-app-folder', async () => {
  shell.openPath(path.join(__dirname));
});

// ── Auto-Update (git-based for dev, GitHub API for packaged) ──
function getSourceDir() {
  const appDir = path.join(__dirname);
  // Packaged Electron: __dirname is inside .asar (a file, not a directory).
  // Electron patches fs to work with asar paths, but child_process does NOT —
  // execSync with cwd pointing through .asar causes ENOTDIR.
  if (appDir.includes('.asar')) return null;
  try {
    fs.accessSync(path.join(appDir, '.git'), fs.constants.R_OK);
    return appDir;
  } catch (_) {
    return null;
  }
}

ipcMain.handle('check-update', async () => {
  const sourceDir = getSourceDir();

  if (sourceDir) {
    // Dev mode: use git
    try {
      execSync('git fetch origin', { cwd: sourceDir, encoding: 'utf-8', timeout: 15000 });
      const status = execSync('git status -uno --porcelain -b', { cwd: sourceDir, encoding: 'utf-8', timeout: 5000 });
      const behind = status.includes('behind');
      let remoteLog = '';
      if (behind) {
        try {
          remoteLog = execSync('git log HEAD..origin/main --oneline -10', { cwd: sourceDir, encoding: 'utf-8', timeout: 5000 }).trim();
        } catch (_) {}
      }
      return { updateAvailable: behind, changes: remoteLog };
    } catch (e) {
      return { updateAvailable: false, error: e.message };
    }
  }

  // Packaged app: check GitHub releases via API
  try {
    const https = require('https');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    const currentVersion = pkg.version;
    const repoUrl = (pkg.repository && pkg.repository.url) || '';
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (!match) return { updateAvailable: false, error: 'リポジトリURL未設定' };

    const [, owner, repo] = match;
    const data = await new Promise((resolve, reject) => {
      https.get(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        headers: { 'User-Agent': 'claude-code-desktop' }
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode === 200) resolve(JSON.parse(body));
          else reject(new Error(`GitHub API: ${res.statusCode}`));
        });
      }).on('error', reject);
    });

    const latestTag = (data.tag_name || '').replace(/^v/, '');
    // semver比較: 更新ありは latest > current のときだけ。
    // (GitHub最新releaseが実体より古い場合にダウングレードを"更新"と誤表示するのを防ぐ)
    const isNewer = (a, b) => {
      const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
      }
      return false;
    };
    const updateAvailable = !!latestTag && isNewer(latestTag, currentVersion);
    return {
      updateAvailable,
      changes: updateAvailable ? `${currentVersion} → ${latestTag}\n${data.body || ''}`.trim() : '',
      latestVersion: latestTag,
      currentVersion,
      downloadUrl: data.html_url || '',
    };
  } catch (e) {
    return { updateAvailable: false, error: e.message };
  }
});

ipcMain.handle('apply-update', async () => {
  const sourceDir = getSourceDir();

  if (sourceDir) {
    // Dev mode: git pull
    try {
      execSync('git stash', { cwd: sourceDir, encoding: 'utf-8', timeout: 10000 });
      execSync('git pull origin main', { cwd: sourceDir, encoding: 'utf-8', timeout: 30000 });
      try { execSync('git stash pop', { cwd: sourceDir, encoding: 'utf-8', timeout: 10000 }); } catch (_) {}
      try {
        const diff = execSync('git diff HEAD~1 --name-only', { cwd: sourceDir, encoding: 'utf-8', timeout: 5000 });
        if (diff.includes('package.json') || diff.includes('package-lock.json')) {
          execSync('npm install', { cwd: sourceDir, encoding: 'utf-8', timeout: 120000 });
        }
      } catch (_) {}
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Packaged app: open GitHub releases page for manual download
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  const repoUrl = (pkg.repository && pkg.repository.url) || '';
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (match) {
    shell.openExternal(`https://github.com/${match[1]}/${match[2]}/releases/latest`);
    return { success: true, openedBrowser: true };
  }
  return { success: false, error: 'リポジトリURL未設定' };
});

ipcMain.handle('restart-app', async () => {
  // Save all sessions and buffers before exit — app.exit() bypasses lifecycle events
  saveSessionsSync();
  clearCrashFlag();
  // Kill PTY processes cleanly
  for (const [, s] of sessions) { try { s.pty.kill(); } catch (_) {} }
  app.relaunch();
  app.exit(0);
});

// ── Get app info ──
ipcMain.handle('get-app-info', async () => {
  let gitHash = '';
  const srcDir = getSourceDir();
  if (srcDir) {
    try { gitHash = execSync('git rev-parse --short HEAD', { cwd: srcDir, encoding: 'utf-8', timeout: 3000 }).trim(); } catch (_) {}
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  return { version: pkg.version, gitHash, electronVersion: process.versions.electron, nodeVersion: process.versions.node };
});

// ── Deep link (ariya://) ──
// 外部ツール (Fleet View など) から「このセッションのタブを開いて」と呼ばれる入口。
//   ariya://resume?session=<Claude Code の sessionId>&cwd=<作業フォルダ>&name=<表示名>
//   ariya://new?cwd=<作業フォルダ>&mode=<claude|codex|gemini|grok|shell>
// macOS は起動済みインスタンスに open-url を届けるので single-instance lock は使わない
// (入れると開発用の `npm start` が黙って起動しなくなる)。
const DEEP_LINK_SCHEME = 'ariya';
const DEEP_LINK_MODES = ['claude', 'codex', 'gemini', 'grok', 'shell'];
let pendingDeepLink = null;

function parseDeepLink(url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // ariya://resume?… は hostname に、ariya:///resume?… は pathname に出る
  const action = (u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
  const q = u.searchParams;
  const cwd = q.get('cwd') || '';
  const mode = (q.get('mode') || 'claude').toLowerCase();
  const req = {
    action,
    cwd,
    mode: DEEP_LINK_MODES.includes(mode) ? mode : 'claude',
    name: q.get('name') || '',
    conversationId: q.get('session') || q.get('conversationId') || '',
  };
  if (action === 'resume') return req.conversationId ? req : null;
  if (action === 'new') return req;
  return null;
}

function handleDeepLink(url) {
  const req = parseDeepLink(url);
  if (!req) return;
  if (!app.isReady()) { pendingDeepLink = req; return; }
  if (!mainWindow || mainWindow.isDestroyed()) { pendingDeepLink = req; createWindow(); return; }
  // 呼ばれたら前に出る (Dock から探させない)
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  try { app.focus({ steal: true }); } catch (_) {}
  deliverDeepLink(req);
}

function deliverDeepLink(req) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (req.action === 'resume') {
    // 同じ会話のタブが既にあるなら、新しく起こさずそのタブへ切り替える
    for (const [id, s] of sessions) {
      if (s.conversationId && s.conversationId === req.conversationId) {
        mainWindow.webContents.send('open-session', { ...req, action: 'focus', sessionId: id });
        return;
      }
    }
  }
  mainWindow.webContents.send('open-session', req);
}

function flushPendingDeepLink() {
  if (!pendingDeepLink) return;
  const req = pendingDeepLink;
  pendingDeepLink = null;
  deliverDeepLink(req);
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// ── Lifecycle ──
let timer;
app.whenReady().then(() => {
  setCrashFlag();
  try { app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME); } catch (_) {}
  createWindow();
  createMenu();
  timer = setInterval(saveSessionsSync, 10000);
  setTimeout(autoUpdateClisInBackground, 8000); // 起動を邪魔しないよう遅延実行
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => {
  // Save sessions if not already saved by window-all-closed (e.g. Cmd+Q path)
  if (!sessionsSavedOnClose) {
    saveSessionsSync();
    sessionsSavedOnClose = true;
  }
  clearCrashFlag();
  if (timer) clearInterval(timer);
});
let sessionsSavedOnClose = false;

app.on('window-all-closed', () => {
  // Save sessions to disk BEFORE clearing in-memory data
  if (!sessionsSavedOnClose) {
    saveSessionsSync();
    sessionsSavedOnClose = true;
  }
  for (const [, s] of sessions) { try { s.pty.kill(); } catch (_) {} }
  sessions.clear();
  sessionBuffers.clear();
  clearCrashFlag();
  app.quit();
});
