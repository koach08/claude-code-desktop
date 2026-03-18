const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.claude-code-app');
const sessions = new Map();
let mainWindow = null;
let pty = null;

// ── Resolve shell env (Electron doesn't inherit profile) ──
let shellEnv = { ...process.env };
try {
  const out = require('child_process').execSync(
    '/bin/zsh -ilc "env"', { encoding: 'utf-8', timeout: 10000 }
  );
  out.split('\n').forEach(line => {
    const i = line.indexOf('=');
    if (i > 0) shellEnv[line.substring(0, i)] = line.substring(i + 1);
  });
} catch (_) {}

function getPty() {
  if (!pty) pty = require('node-pty');
  return pty;
}

function createWindow() {
  // Load saved window bounds
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
    title: 'Claude Code Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Save window bounds on close
  mainWindow.on('close', () => {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(SESSIONS_DIR, 'window.json'),
        JSON.stringify(mainWindow.getBounds())
      );
    } catch (_) {}
  });
}

// ── IPC: Create session ──
// mode: 'claude' | 'shell'
ipcMain.handle('create-session', async (_event, { cwd, name, mode }) => {
  const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const nodePty = getPty();
  const sessionCwd = cwd || os.homedir();
  const sessionMode = mode || 'claude';

  let cmd, args;
  if (sessionMode === 'claude') {
    cmd = 'claude';
    args = [];
  } else {
    cmd = '/bin/zsh';
    args = ['--login', '-i'];
  }

  const ptyProcess = nodePty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: sessionCwd,
    env: shellEnv,
  });

  const sessionData = {
    pty: ptyProcess,
    cwd: sessionCwd,
    name: name || (sessionMode === 'claude' ? 'Claude Code' : 'Terminal'),
    mode: sessionMode,
    createdAt: new Date().toISOString(),
  };
  sessions.set(id, sessionData);

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-output-${id}`, data);
    }
  });
  ptyProcess.onExit(({ exitCode, signal }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-exit-${id}`, { exitCode, signal });
    }
  });

  return { id, name: sessionData.name, cwd: sessionData.cwd, mode: sessionMode };
});

// ── IPC: Switch mode (kills current, starts new) ──
ipcMain.handle('switch-mode', async (_event, { sessionId, newMode }) => {
  const old = sessions.get(sessionId);
  if (!old) return null;
  const { cwd } = old;
  try { old.pty.kill(); } catch (_) {}
  sessions.delete(sessionId);

  const nodePty = getPty();
  let cmd, args;
  if (newMode === 'claude') {
    cmd = 'claude';
    args = [];
  } else {
    cmd = '/bin/zsh';
    args = ['--login', '-i'];
  }

  const newId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const ptyProcess = nodePty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: shellEnv,
  });

  sessions.set(newId, {
    pty: ptyProcess,
    cwd,
    name: newMode === 'claude' ? 'Claude Code' : 'Terminal',
    mode: newMode,
    createdAt: new Date().toISOString(),
  });

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-output-${newId}`, data);
    }
  });
  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-exit-${newId}`, { exitCode });
    }
  });

  return { newId, name: sessions.get(newId).name, cwd, mode: newMode };
});

ipcMain.handle('send-input', async (_e, { sessionId, input }) => {
  const s = sessions.get(sessionId);
  if (s && s.pty) s.pty.write(input);
});

ipcMain.handle('resize-terminal', async (_e, { sessionId, cols, rows }) => {
  const s = sessions.get(sessionId);
  if (s && s.pty) { try { s.pty.resize(cols, rows); } catch (_) {} }
});

ipcMain.handle('close-session', async (_e, { sessionId }) => {
  const s = sessions.get(sessionId);
  if (s && s.pty) { try { s.pty.kill(); } catch (_) {} sessions.delete(sessionId); }
});

// ── Check if Claude Code CLI is installed ──
ipcMain.handle('check-claude-cli', async () => {
  try {
    const result = require('child_process').execSync(
      '/bin/zsh -ilc "which claude"', { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    if (result && result.includes('claude')) {
      // Get version too
      let version = '';
      try {
        version = require('child_process').execSync(
          '/bin/zsh -ilc "claude --version"', { encoding: 'utf-8', timeout: 10000 }
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
    require('child_process').execSync(
      '/bin/zsh -ilc "npm install -g @anthropic-ai/claude-code"',
      { encoding: 'utf-8', timeout: 120000 }
    );
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

// ── Persistence ──
function saveSessionsSync() {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const data = [];
    for (const [id, s] of sessions) {
      data.push({ id, name: s.name, cwd: s.cwd, mode: s.mode, createdAt: s.createdAt, savedAt: new Date().toISOString() });
    }
    fs.writeFileSync(path.join(SESSIONS_DIR, 'sessions.json'), JSON.stringify(data, null, 2));
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

// ── Lifecycle ──
let timer;
app.whenReady().then(() => {
  createWindow();
  timer = setInterval(saveSessionsSync, 30000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { saveSessionsSync(); if (timer) clearInterval(timer); });
app.on('window-all-closed', () => {
  for (const [, s] of sessions) { try { s.pty.kill(); } catch (_) {} }
  sessions.clear();
  if (process.platform !== 'darwin') app.quit();
});
