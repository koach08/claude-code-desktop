// ── State ──
const tabs = new Map();
let activeId = null;
let currentMode = 'claude'; // 'claude' | 'shell'
let uiMode = 'simple';      // 'simple' | 'advanced'
const history = [];
let histIdx = 0;

// ── Boot ──
document.addEventListener('DOMContentLoaded', async () => {
  const prefs = await window.api.loadPrefs();
  if (prefs.uiMode) setUiMode(prefs.uiMode);
  if (prefs.lastMode) currentMode = prefs.lastMode;

  setupListeners();

  // Check if Claude Code CLI is installed
  const cli = await window.api.checkClaudeCli();
  if (!cli.installed) {
    showSetupDialog();
    return;
  }

  // All good — open Claude Code tab
  await newTab(currentMode);
  setInterval(() => window.api.saveSessions(), 30000);
});

// ── Listeners ──
function setupListeners() {
  document.getElementById('new-tab-btn').addEventListener('click', () => newTab(currentMode));
  document.getElementById('send-btn').addEventListener('click', send);

  // Mode toggle (Claude / Terminal)
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.addEventListener('click', () => switchSessionMode(b.dataset.mode));
  });

  // UI toggle (Simple / Advanced)
  document.querySelectorAll('.ui-btn').forEach(b => {
    b.addEventListener('click', () => {
      setUiMode(b.dataset.ui);
      window.api.savePrefs({ uiMode: b.dataset.ui, lastMode: currentMode });
    });
  });

  // Textarea
  const ta = document.getElementById('prompt-input');
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); navHist(-1); }
    if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); navHist(1); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  });

  // Quick buttons
  document.querySelectorAll('.qbtn').forEach(b => {
    b.addEventListener('click', () => {
      if (!activeId) return;
      const raw = b.dataset.input
        .replace(/\\r/g, '\r')
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      window.api.sendInput(activeId, raw);
    });
  });

  // Sidebar: click command to send
  document.querySelectorAll('.cmd').forEach(el => {
    el.addEventListener('click', () => {
      if (!activeId) return;
      window.api.sendInput(activeId, el.dataset.cmd + '\r');
    });
  });

  // Sidebar: click prompt example to fill input
  document.querySelectorAll('.prompt-ex').forEach(el => {
    el.addEventListener('click', () => {
      const ta = document.getElementById('prompt-input');
      ta.value = el.dataset.prompt;
      ta.focus();
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 't') { e.preventDefault(); newTab(currentMode); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'w') { e.preventDefault(); if (activeId) closeTab(activeId); }
    if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      const ids = [...tabs.keys()];
      if (ids[parseInt(e.key) - 1]) switchTab(ids[parseInt(e.key) - 1]);
    }
  });

  // ── Drag & Drop: フォルダをドロップ → そのディレクトリで新タブ ──
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('app').classList.add('drag-over');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.target === document.documentElement || e.target === document.body) {
      document.getElementById('app').classList.remove('drag-over');
    }
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('app').classList.remove('drag-over');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      // Use the path from the dropped item
      const droppedPath = files[0].path;
      if (droppedPath) {
        newTabWithCwd(currentMode, droppedPath);
      }
    }
  });
}

// ── UI Mode ──
function setUiMode(mode) {
  uiMode = mode;
  document.body.dataset.ui = mode;
  document.querySelectorAll('.ui-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.ui === mode);
  });
  // Refit terminals
  tabs.forEach(t => {
    if (t.pane.classList.contains('active')) {
      requestAnimationFrame(() => {
        t.fit.fit();
        window.api.resizeTerminal(t.session.id, t.term.cols, t.term.rows);
      });
    }
  });
}

// ── Session Mode Switch ──
async function switchSessionMode(newMode) {
  if (!activeId) return;
  const tab = tabs.get(activeId);
  if (!tab) return;

  currentMode = newMode;
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === newMode);
  });

  // Kill old, start new
  window.api.removeListeners(tab.session.id);
  tab.term.clear();
  tab.term.write(`\x1b[36m${newMode === 'claude' ? 'Claude Code を起動中...' : 'Terminal を起動中...'}\x1b[0m\r\n`);

  const result = await window.api.switchMode(tab.session.id, newMode);
  if (!result) return;

  // Update references
  tab.session = { id: result.newId, name: result.name, cwd: result.cwd, mode: newMode };

  // Re-bind output
  window.api.onSessionOutput(result.newId, (d) => {
    tab.term.write(d);
    detectActivity(d);
  });
  window.api.onSessionExit(result.newId, () => {
    tab.term.write('\r\n\x1b[33m[終了]\x1b[0m\r\n');
    tab.tabEl.classList.add('ended');
    setStatus('ended', '終了しました');
  });

  // Resize
  window.api.resizeTerminal(result.newId, tab.term.cols, tab.term.rows);

  // Update tab name
  tab.tabEl.querySelector('.tname').textContent = result.name;
  tab.tabEl.querySelector('.tab-icon').textContent = newMode === 'claude' ? 'AI' : '>';

  // Need to update the Map key since session ID changed
  tabs.delete(activeId);
  activeId = result.newId;
  tabs.set(result.newId, tab);

  updateStatusMode(newMode);
  window.api.savePrefs({ uiMode, lastMode: currentMode });
}

// ── Tab Management ──
async function newTab(mode, cwd) {
  try {
    const session = await window.api.createSession({ mode: mode || 'claude', cwd });
    addTab(session);
  } catch (err) {
    console.error('Session create failed:', err);
  }
}

async function newTabWithCwd(mode, droppedPath) {
  // Check if it's a directory; if file, use parent dir
  const cwd = await window.api.resolveCwd(droppedPath);
  await newTab(mode, cwd);
}

function addTab(session) {
  const term = new Terminal({
    theme: {
      background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5',
      selectionBackground: '#33467c',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
      brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
    fontSize: 14,
    fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
    scrollback: 10000,
    cursorBlink: true,
    convertEol: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  // Direct terminal input (for quick typing)
  term.onData((data) => window.api.sendInput(session.id, data));

  // Tab element
  const icon = session.mode === 'claude' ? 'AI' : '>';
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = `<span class="tab-icon">${icon}</span><span class="tname">${esc(session.name)}</span><span class="tclose">&times;</span>`;
  document.getElementById('tabs').appendChild(tabEl);

  // Pane
  const pane = document.createElement('div');
  pane.className = 'pane';
  document.getElementById('terminal-container').appendChild(pane);
  term.open(pane);

  const data = { term, fit, tabEl, pane, session };
  tabs.set(session.id, data);

  tabEl.querySelector('.tname').addEventListener('click', () => switchTab(session.id));
  tabEl.querySelector('.tclose').addEventListener('click', (e) => { e.stopPropagation(); closeTab(session.id); });

  window.api.onSessionOutput(session.id, (d) => {
    term.write(d);
    detectActivity(d);
  });
  window.api.onSessionExit(session.id, () => {
    term.write('\r\n\x1b[33m[終了]\x1b[0m\r\n');
    tabEl.classList.add('ended');
    setStatus('ended', '終了しました');
  });

  // Resize observer
  const ro = new ResizeObserver(() => {
    if (pane.classList.contains('active')) {
      fit.fit();
      window.api.resizeTerminal(session.id, term.cols, term.rows);
    }
  });
  ro.observe(pane);
  data.ro = ro;

  switchTab(session.id);
  requestAnimationFrame(() => {
    fit.fit();
    window.api.resizeTerminal(session.id, term.cols, term.rows);
  });

  // Show cwd in status bar
  document.getElementById('status-cwd').textContent = session.cwd || '';

  // Update mode buttons
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === session.mode);
  });
  currentMode = session.mode;
  updateStatusMode(session.mode);
}

function switchTab(id) {
  activeId = id;
  tabs.forEach((t, tid) => {
    const on = tid === id;
    t.tabEl.classList.toggle('active', on);
    t.pane.classList.toggle('active', on);
    if (on) {
      requestAnimationFrame(() => {
        t.fit.fit();
        window.api.resizeTerminal(tid, t.term.cols, t.term.rows);
      });
      // Update mode buttons to match tab's mode
      const mode = t.session.mode || 'claude';
      document.querySelectorAll('.mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
      currentMode = mode;
      updateStatusMode(mode);
    }
  });
  document.getElementById('prompt-input').focus();
}

async function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.ro) t.ro.disconnect();
  window.api.removeListeners(id);
  await window.api.closeSession(id);
  t.term.dispose(); t.tabEl.remove(); t.pane.remove();
  tabs.delete(id);
  if (tabs.size > 0) switchTab(tabs.keys().next().value);
  else activeId = null;
}

// ── Input ──
function send() {
  const ta = document.getElementById('prompt-input');
  const text = ta.value;
  if (!text || !activeId) return;
  history.push(text);
  if (history.length > 100) history.shift();
  histIdx = history.length;
  window.api.sendInput(activeId, text + '\r');
  ta.value = '';
  ta.style.height = 'auto';
}

function navHist(dir) {
  if (!history.length) return;
  histIdx = Math.max(0, Math.min(histIdx + dir, history.length));
  document.getElementById('prompt-input').value =
    histIdx === history.length ? '' : history[histIdx];
}

// ── Activity Detection (Simple mode status) ──
let activityTimer = null;

function detectActivity(output) {
  // Detect what Claude is doing from terminal output patterns
  const patterns = [
    { re: /Reading|Read\s/i, msg: 'ファイルを読み込んでいます...' },
    { re: /Writing|Write\s|Edit\s/i, msg: 'ファイルを編集しています...' },
    { re: /Running|Bash\s/i, msg: 'コマンドを実行しています...' },
    { re: /Searching|Grep|Glob/i, msg: 'ファイルを検索しています...' },
    { re: /Agent/i, msg: 'エージェントが作業中...' },
    { re: /\? \(y\/n\)|Allow|approve/i, msg: '承認を待っています — Y/N ボタンで応答' },
    { re: /Thinking|thinking/i, msg: '考えています...' },
    { re: /\$\s*$|❯|>\s*$/m, msg: '入力待ち' },
  ];

  for (const { re, msg } of patterns) {
    if (re.test(output)) {
      if (/\? \(y\/n\)|Allow|approve/i.test(output)) {
        setStatus('waiting', msg);
      } else if (/\$\s*$|❯|>\s*$/m.test(output)) {
        setStatus('ready', msg);
      } else {
        setStatus('busy', msg);
      }
      break;
    }
  }

  // Reset to ready after inactivity
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => setStatus('ready', '準備完了'), 5000);
}

function setStatus(state, text) {
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  indicator.className = '';
  indicator.classList.add(state);
  statusText.textContent = text;
}

function updateStatusMode(mode) {
  document.getElementById('status-mode').textContent =
    mode === 'claude' ? 'Claude Code' : 'Terminal';
}

// ── Setup Dialog (Claude CLI not found) ──
function showSetupDialog() {
  const dlg = document.getElementById('setup-dialog');
  dlg.classList.remove('hidden');

  document.getElementById('setup-auto-install').addEventListener('click', async () => {
    const btn = document.getElementById('setup-auto-install');
    const status = document.getElementById('setup-status');
    btn.disabled = true;
    btn.textContent = 'インストール中...';
    status.textContent = 'npm install -g @anthropic-ai/claude-code を実行中（最大2分）...';
    status.style.color = 'var(--yellow)';

    const result = await window.api.installClaudeCli();
    if (result.success) {
      status.textContent = 'インストール完了！起動します...';
      status.style.color = 'var(--green)';
      setTimeout(async () => {
        dlg.classList.add('hidden');
        await newTab(currentMode);
        setInterval(() => window.api.saveSessions(), 30000);
      }, 1000);
    } else {
      status.textContent = 'インストール失敗: ' + (result.error || '不明なエラー');
      status.style.color = 'var(--red)';
      btn.disabled = false;
      btn.textContent = '再試行';
    }
  });

  document.getElementById('setup-skip').addEventListener('click', async () => {
    dlg.classList.add('hidden');
    // Open as terminal mode instead
    currentMode = 'shell';
    await newTab('shell');
    setInterval(() => window.api.saveSessions(), 30000);
  });
}

// ── Util ──
function esc(t) {
  const el = document.createElement('span');
  el.textContent = t;
  return el.innerHTML;
}
