// ── State ──
const tabs = new Map();
let activeId = null;
let currentMode = 'claude'; // 'claude' | 'codex' | 'shell'
let uiMode = 'simple';      // 'simple' | 'advanced'
const history = [];
let histIdx = 0;
let appSettings = { fontSize: 14, autoSaveInterval: 10, doubleEnterDelay: 500 };

// ── Boot ──
document.addEventListener('DOMContentLoaded', async () => {
  const prefs = await window.api.loadPrefs();
  if (prefs.uiMode) setUiMode(prefs.uiMode);
  if (prefs.lastMode) currentMode = prefs.lastMode;

  appSettings = await window.api.loadSettings();

  setupListeners();

  // Check if Claude Code CLI is installed
  const cli = await window.api.checkClaudeCli();
  if (!cli.installed) {
    showSetupDialog();
    return;
  }

  // Check if previous session crashed
  const crashed = await window.api.checkCrash();

  // Try to restore saved sessions
  const saved = await window.api.loadSessions();
  if (saved && saved.length > 0) {
    const oldIds = [];
    const activeIdx = prefs.activeTabIndex || 0;
    for (const s of saved) {
      oldIds.push(s.id);
      await restoreTab(s);
    }
    const tabIds = [...tabs.keys()];
    if (tabIds.length > 0) {
      const idx = Math.min(activeIdx, tabIds.length - 1);
      switchTab(tabIds[idx]);
    }
    window.api.cleanupOldBuffers(oldIds);

    // Show restore notification
    const msg = crashed
      ? `${saved.length}個のセッションを復元しました (前回クラッシュ検出)`
      : `${saved.length}個のセッションを復元しました`;
    setStatus('ready', msg);

    const log = await window.api.loadWorkLog();
    if (log && log.length > 0) {
      const lastEntries = log.slice(-3).reverse();
      const activeTab = tabs.get(activeId);
      if (activeTab) {
        activeTab.term.write(`\r\n\x1b[33m[復元] 最近の作業:\x1b[0m\r\n`);
        for (const e of lastEntries) {
          const d = new Date(e.timestamp);
          const time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
          const short = e.prompt.length > 80 ? e.prompt.slice(0, 80) + '...' : e.prompt;
          activeTab.term.write(`\x1b[36m  ${time}\x1b[0m \x1b[2m${e.sessionName}\x1b[0m ${short}\r\n`);
        }
        activeTab.term.write(`\r\n`);
      }
    }
  } else {
    await newTab(currentMode);
  }

  startAutoSave();
});

function startAutoSave() {
  setInterval(() => {
    window.api.saveSessions();
    saveTabState();
  }, (appSettings.autoSaveInterval || 10) * 1000);
}

function saveTabState() {
  const tabIds = [...tabs.keys()];
  const idx = tabIds.indexOf(activeId);
  window.api.savePrefs({
    uiMode,
    lastMode: currentMode,
    activeTabIndex: idx >= 0 ? idx : 0,
  });
}

// ── Restore a saved session ──
async function restoreTab(savedSession) {
  try {
    const oldBuffer = await window.api.loadBuffer(savedSession.id);
    const session = await window.api.createSession({
      mode: savedSession.mode || 'claude',
      cwd: savedSession.cwd,
      name: savedSession.name,
      restoreFromId: savedSession.id,
    });
    addTab(session, oldBuffer);
  } catch (err) {
    console.error('Session restore failed:', err);
    await newTab(savedSession.mode || currentMode);
  }
}

// ── Helper: get current session ID for a tab element ──
function getTabSessionId(tabEl) {
  return tabEl ? tabEl.dataset.sid : null;
}

// ── Listeners ──
function setupListeners() {
  document.getElementById('new-tab-btn').addEventListener('click', () => newTab(currentMode));
  document.getElementById('send-btn').addEventListener('click', send);
  document.getElementById('settings-btn').addEventListener('click', openSettings);

  // Work log
  document.getElementById('worklog-toggle').addEventListener('click', toggleWorkLog);
  document.getElementById('worklog-close').addEventListener('click', () => {
    document.getElementById('worklog-panel').classList.add('hidden');
  });

  // Settings dialog
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-dialog').addEventListener('click', (e) => {
    if (e.target.id === 'settings-dialog') closeSettings();
  });
  document.getElementById('font-dec').addEventListener('click', () => {
    applyFontSize(Math.max(10, (appSettings.fontSize || 14) - 1));
  });
  document.getElementById('font-inc').addEventListener('click', () => {
    applyFontSize(Math.min(24, (appSettings.fontSize || 14) + 1));
  });
  document.getElementById('double-enter-delay').addEventListener('input', (e) => {
    appSettings.doubleEnterDelay = parseInt(e.target.value);
    document.getElementById('double-enter-val').textContent = e.target.value;
    window.api.saveSettings(appSettings);
  });
  document.getElementById('autosave-interval').addEventListener('input', (e) => {
    appSettings.autoSaveInterval = parseInt(e.target.value);
    document.getElementById('autosave-val').textContent = e.target.value;
    window.api.saveSettings(appSettings);
  });

  // Builder
  document.getElementById('builder-scan-btn').addEventListener('click', scanCurrentProject);
  document.querySelectorAll('.bcard').forEach(card => {
    card.addEventListener('click', () => builderCardClicked(card.dataset.target));
  });

  // Edit this app buttons
  document.getElementById('btn-edit-claude').addEventListener('click', editAppWithClaude);
  document.getElementById('btn-edit-codex').addEventListener('click', editAppWithCodex);
  document.getElementById('btn-open-folder').addEventListener('click', () => window.api.openAppFolder());
  document.getElementById('btn-check-update').addEventListener('click', checkForUpdate);
  document.getElementById('btn-apply-update').addEventListener('click', applyUpdate);
  document.getElementById('btn-clear-worklog').addEventListener('click', async () => {
    await window.api.clearWorkLog();
    const btn = document.getElementById('btn-clear-worklog');
    btn.textContent = '完了';
    setTimeout(() => { btn.textContent = 'クリア'; }, 2000);
  });
  document.getElementById('btn-build-app').addEventListener('click', buildApp);

  // Mode toggle
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.addEventListener('click', () => switchSessionMode(b.dataset.mode));
  });

  // UI toggle
  document.querySelectorAll('.ui-btn').forEach(b => {
    b.addEventListener('click', () => {
      setUiMode(b.dataset.ui);
      saveTabState();
    });
  });

  // ── Textarea input ──
  const ta = document.getElementById('prompt-input');
  let isComposing = false;
  let lastEnterTime = 0;
  let enterHintTimer = null;

  ta.addEventListener('compositionstart', () => { isComposing = true; });
  ta.addEventListener('compositionend', () => { isComposing = false; });

  ta.addEventListener('keydown', (e) => {
    // Cmd+Enter: immediate send
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      hideEnterHint();
      send();
      return;
    }
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); navHist(-1); return; }
    if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); navHist(1); return; }

    // Double-Enter to send
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (isComposing || e.isComposing) return;

      const now = Date.now();
      const delay = appSettings.doubleEnterDelay || 500;

      if (lastEnterTime > 0 && (now - lastEnterTime) < delay) {
        // Second Enter: send
        e.preventDefault();
        hideEnterHint();
        // Remove trailing newline from first Enter
        ta.value = ta.value.replace(/\n$/, '');
        send();
        lastEnterTime = 0;
        return;
      }

      // First Enter: show hint, set timer
      lastEnterTime = now;
      showEnterHint();
      clearTimeout(enterHintTimer);
      enterHintTimer = setTimeout(() => {
        lastEnterTime = 0;
        hideEnterHint();
      }, delay);
    }
  });

  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  });

  // Quick buttons (Y/N/interrupt/escape)
  document.querySelectorAll('.qbtn').forEach(b => {
    b.addEventListener('click', () => {
      if (!activeId || !b.dataset.input) return;
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

  // Keyboard shortcuts (global)
  document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in textarea
    const inTextarea = document.activeElement === ta;

    if ((e.metaKey || e.ctrlKey) && e.key === 't') { e.preventDefault(); newTab(currentMode); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'w') { e.preventDefault(); if (activeId) closeTab(activeId); }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      window.api.saveSessions();
      saveTabState();
      setStatus('ready', '保存しました');
      setTimeout(() => setStatus('ready', '準備完了'), 2000);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
    if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      const ids = [...tabs.keys()];
      if (ids[parseInt(e.key) - 1]) switchTab(ids[parseInt(e.key) - 1]);
    }
  });

  // Menu actions
  window.api.onMenuAction((action) => {
    switch (action) {
      case 'new-tab': newTab(currentMode); break;
      case 'close-tab': if (activeId) closeTab(activeId); break;
      case 'saved':
        setStatus('ready', '保存しました');
        setTimeout(() => setStatus('ready', '準備完了'), 2000);
        break;
      case 'settings': openSettings(); break;
      case 'edit-app-claude': editAppWithClaude(); break;
      case 'check-update': openSettings(); checkForUpdate(); break;
    }
  });

  // Drag & Drop
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
    if (files.length > 0 && files[0].path) {
      newTabWithCwd(currentMode, files[0].path);
    }
  });
}

// ── Enter hint ──
function showEnterHint() {
  const hint = document.getElementById('enter-hint');
  if (hint) {
    hint.classList.remove('hidden');
    document.getElementById('prompt-input').classList.add('enter-pending');
  }
}
function hideEnterHint() {
  const hint = document.getElementById('enter-hint');
  if (hint) {
    hint.classList.add('hidden');
    document.getElementById('prompt-input').classList.remove('enter-pending');
  }
}

// ── UI Mode ──
function setUiMode(mode) {
  uiMode = mode;
  document.body.dataset.ui = mode;
  document.querySelectorAll('.ui-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.ui === mode);
  });
  tabs.forEach(t => {
    if (t.pane.classList.contains('active')) {
      requestAnimationFrame(() => {
        t.fit.fit();
        const sid = getTabSessionId(t.tabEl);
        if (sid) window.api.resizeTerminal(sid, t.term.cols, t.term.rows);
      });
    }
  });
  if (mode === 'simple' || mode === 'builder') {
    document.getElementById('prompt-input').focus();
    if (mode === 'builder') scanCurrentProject();
  } else {
    const tab = tabs.get(activeId);
    if (tab) tab.term.focus();
  }
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

  const oldSid = getTabSessionId(tab.tabEl);
  window.api.removeListeners(oldSid);
  tab.term.clear();
  const modeLabel = newMode === 'claude' ? 'Claude Code' : newMode === 'codex' ? 'Codex' : 'Terminal';
  tab.term.write(`\x1b[36m${modeLabel} を起動中...\x1b[0m\r\n`);

  const result = await window.api.switchMode(oldSid, newMode);
  if (!result) return;

  // Update session and tab data attribute
  tab.session = { id: result.newId, name: result.name, cwd: result.cwd, mode: newMode };
  tab.tabEl.dataset.sid = result.newId;
  tab.ended = false;
  tab.tabEl.classList.remove('ended');

  // Re-bind output
  window.api.onSessionOutput(result.newId, (d) => {
    tab.term.write(d);
    detectActivity(d);
  });
  window.api.onSessionExit(result.newId, () => {
    tab.term.write('\r\n\x1b[33m[終了]\x1b[0m\r\n');
    tab.tabEl.classList.add('ended');
    tab.ended = true;
    setStatus('ended', '終了しました');
  });

  window.api.resizeTerminal(result.newId, tab.term.cols, tab.term.rows);

  // Update tab UI
  tab.tabEl.querySelector('.tname').textContent = result.name;
  const icon = newMode === 'claude' ? 'AI' : newMode === 'codex' ? 'CX' : '>';
  tab.tabEl.querySelector('.tab-icon').textContent = icon;

  // Update Map key
  tabs.delete(activeId);
  activeId = result.newId;
  tabs.set(result.newId, tab);

  updateStatusMode(newMode);
  saveTabState();
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
  const cwd = await window.api.resolveCwd(droppedPath);
  await newTab(mode, cwd);
}

function addTab(session, replayBuffer) {
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
    fontSize: appSettings.fontSize || 14,
    fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
    scrollback: 10000,
    cursorBlink: true,
    convertEol: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  // Forward terminal keyboard input to PTY (works in both Simple and Advanced modes)
  term.onData((data) => {
    if (activeId) window.api.sendInput(activeId, data);
  });

  // Tab element
  const icon = session.mode === 'claude' ? 'AI' : session.mode === 'codex' ? 'CX' : '>';
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.sid = session.id; // Store session ID on element (updated on mode switch)
  tabEl.innerHTML = `<span class="tab-icon">${icon}</span><span class="tname">${esc(session.name)}</span><span class="tclose">&times;</span>`;
  document.getElementById('tabs').appendChild(tabEl);

  // Pane
  const pane = document.createElement('div');
  pane.className = 'pane';
  document.getElementById('terminal-container').appendChild(pane);
  term.open(pane);

  const data = { term, fit, tabEl, pane, session, ended: false };
  tabs.set(session.id, data);

  // Tab click: use data attribute (not closure) to get current session ID
  tabEl.addEventListener('click', (e) => {
    if (!e.target.closest('.tclose')) {
      const sid = getTabSessionId(tabEl);
      if (sid) switchTab(sid);
    }
  });
  tabEl.querySelector('.tclose').addEventListener('click', (e) => {
    e.stopPropagation();
    const sid = getTabSessionId(tabEl);
    if (sid) closeTab(sid);
  });

  // Replay old buffer
  if (replayBuffer) {
    term.write(replayBuffer);
    term.write('\r\n\x1b[2m\x1b[36m── セッション復元 ──\x1b[0m\r\n\r\n');
  }

  // Live output
  window.api.onSessionOutput(session.id, (d) => {
    term.write(d);
    detectActivity(d);
  });
  window.api.onSessionExit(session.id, () => {
    term.write('\r\n\x1b[33m[終了]\x1b[0m\r\n');
    tabEl.classList.add('ended');
    data.ended = true;
    setStatus('ended', '終了しました — 新しいタブを開くか、モードを切替えてください');
  });

  // Resize observer: use data attribute for session ID
  const ro = new ResizeObserver(() => {
    if (pane.classList.contains('active')) {
      fit.fit();
      const sid = getTabSessionId(tabEl);
      if (sid) window.api.resizeTerminal(sid, term.cols, term.rows);
    }
  });
  ro.observe(pane);
  data.ro = ro;

  switchTab(session.id);
  requestAnimationFrame(() => {
    fit.fit();
    window.api.resizeTerminal(session.id, term.cols, term.rows);
  });

  document.getElementById('status-cwd').textContent = session.cwd || '';
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
      const mode = t.session.mode || 'claude';
      document.querySelectorAll('.mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
      currentMode = mode;
      updateStatusMode(mode);
      document.getElementById('status-cwd').textContent = t.session.cwd || '';
    }
  });
  if (uiMode === 'simple') {
    document.getElementById('prompt-input').focus();
  } else {
    const tab = tabs.get(id);
    if (tab) tab.term.focus();
  }
}

async function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.ro) t.ro.disconnect();
  window.api.removeListeners(id);
  await window.api.closeSession(id);
  t.term.dispose();
  t.tabEl.remove();
  t.pane.remove();
  tabs.delete(id);
  if (tabs.size > 0) {
    switchTab(tabs.keys().next().value);
  } else {
    activeId = null;
    await newTab(currentMode);
  }
  saveTabState();
}

// ── Input ──
function send() {
  const ta = document.getElementById('prompt-input');
  const text = ta.value.trim();
  if (!text || !activeId) return;

  // Check if session ended, offer restart
  const tab = tabs.get(activeId);
  if (tab && tab.ended) {
    tab.term.write(`\r\n\x1b[33m[セッション終了済み] モードを切替えて再起動します...\x1b[0m\r\n`);
    switchSessionMode(currentMode);
    return;
  }

  history.push(text);
  if (history.length > 100) history.shift();
  histIdx = history.length;
  window.api.sendInput(activeId, text + '\r');

  // Log for crash recovery
  if (tab) {
    window.api.logPrompt({
      sessionId: activeId,
      prompt: text,
      sessionName: tab.session.name || '',
      cwd: tab.session.cwd || '',
    });
  }

  window.api.saveSessions();

  ta.value = '';
  ta.style.height = 'auto';
}

function navHist(dir) {
  if (!history.length) return;
  histIdx = Math.max(0, Math.min(histIdx + dir, history.length));
  document.getElementById('prompt-input').value =
    histIdx === history.length ? '' : history[histIdx];
}

// ── Activity Detection ──
let activityTimer = null;

function detectActivity(output) {
  const patterns = [
    { re: /Reading|Read\s/i, msg: 'ファイル読込中...' },
    { re: /Writing|Write\s|Edit\s/i, msg: 'ファイル編集中...' },
    { re: /Running|Bash\s/i, msg: 'コマンド実行中...' },
    { re: /Searching|Grep|Glob/i, msg: '検索中...' },
    { re: /Agent/i, msg: 'エージェント作業中...' },
    { re: /\? ?\(y\/n\)|Allow|approve|permission/i, msg: '承認待ち — Yes/No ボタンまたはターミナルで y/n' },
    { re: /Thinking|thinking/i, msg: '思考中...' },
    { re: /\$\s*$|❯|>\s*$/m, msg: '入力待ち' },
  ];

  for (const { re, msg } of patterns) {
    if (re.test(output)) {
      if (/\? ?\(y\/n\)|Allow|approve|permission/i.test(output)) {
        setStatus('waiting', msg);
      } else if (/\$\s*$|❯|>\s*$/m.test(output)) {
        setStatus('ready', msg);
      } else {
        setStatus('busy', msg);
      }
      break;
    }
  }

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
  const labels = { claude: 'Claude Code', codex: 'Codex', shell: 'Terminal' };
  document.getElementById('status-mode').textContent = labels[mode] || mode;
}

// ── Setup Dialog ──
function showSetupDialog() {
  const dlg = document.getElementById('setup-dialog');
  dlg.classList.remove('hidden');

  document.getElementById('setup-auto-install').addEventListener('click', async () => {
    const btn = document.getElementById('setup-auto-install');
    const status = document.getElementById('setup-status');
    btn.disabled = true;
    btn.textContent = 'インストール中...';
    status.textContent = 'npm install -g @anthropic-ai/claude-code ...';
    status.style.color = 'var(--yellow)';

    const result = await window.api.installClaudeCli();
    if (result.success) {
      status.textContent = 'インストール完了！';
      status.style.color = 'var(--green)';
      setTimeout(async () => {
        dlg.classList.add('hidden');
        await newTab(currentMode);
        startAutoSave();
      }, 1000);
    } else {
      status.textContent = '失敗: ' + (result.error || '');
      status.style.color = 'var(--red)';
      btn.disabled = false;
      btn.textContent = '再試行';
    }
  });

  document.getElementById('setup-skip').addEventListener('click', async () => {
    dlg.classList.add('hidden');
    currentMode = 'shell';
    await newTab('shell');
    startAutoSave();
  });
}

// ── Work Log Panel ──
async function toggleWorkLog() {
  const panel = document.getElementById('worklog-panel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  const log = await window.api.loadWorkLog();
  const list = document.getElementById('worklog-list');

  if (!log || log.length === 0) {
    list.innerHTML = '<div class="worklog-empty">ログなし</div>';
  } else {
    const recent = log.slice(-50).reverse();
    list.innerHTML = recent.map(entry => {
      const d = new Date(entry.timestamp);
      const time = `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
      const prompt = esc(entry.prompt.length > 200 ? entry.prompt.slice(0, 200) + '...' : entry.prompt);
      return `<div class="worklog-entry" data-prompt="${esc(entry.prompt).replace(/"/g, '&quot;')}">
        <span class="wl-time">${time}</span><span class="wl-session">${esc(entry.sessionName)}</span>
        <div class="wl-prompt">${prompt}</div>
        <div class="wl-cwd">${esc(entry.cwd)}</div>
      </div>`;
    }).join('');

    list.querySelectorAll('.worklog-entry').forEach(el => {
      el.addEventListener('click', () => {
        document.getElementById('prompt-input').value = el.dataset.prompt;
        document.getElementById('prompt-input').focus();
        panel.classList.add('hidden');
      });
    });
  }

  panel.classList.remove('hidden');
}

// ── Settings Dialog ──
async function openSettings() {
  const dlg = document.getElementById('settings-dialog');
  dlg.classList.remove('hidden');

  appSettings = await window.api.loadSettings();
  document.getElementById('font-size-val').textContent = appSettings.fontSize;
  document.getElementById('double-enter-delay').value = appSettings.doubleEnterDelay;
  document.getElementById('double-enter-val').textContent = appSettings.doubleEnterDelay;
  document.getElementById('autosave-interval').value = appSettings.autoSaveInterval;
  document.getElementById('autosave-val').textContent = appSettings.autoSaveInterval;

  const info = await window.api.getAppInfo();
  document.getElementById('app-info').textContent =
    `v${info.version} (${info.gitHash}) | Electron ${info.electronVersion} | Node ${info.nodeVersion}`;
}

function closeSettings() {
  document.getElementById('settings-dialog').classList.add('hidden');
}

function applyFontSize(size) {
  appSettings.fontSize = size;
  document.getElementById('font-size-val').textContent = size;
  tabs.forEach(t => { t.term.options.fontSize = size; t.fit.fit(); });
  window.api.saveSettings(appSettings);
}

// ── Edit this app ──
async function editAppWithClaude() {
  closeSettings();
  const appDir = await window.api.getAppDir();
  await newTab('claude', appDir);
}

async function editAppWithCodex() {
  closeSettings();
  const appDir = await window.api.getAppDir();
  await newTab('codex', appDir);
}

// ── Build native app ──
async function buildApp() {
  const btn = document.getElementById('btn-build-app');
  const status = document.getElementById('build-status');
  btn.disabled = true;
  btn.textContent = 'ビルド中...';
  status.textContent = 'ビルドを開始します...';
  status.style.color = 'var(--yellow)';

  // Open a shell tab to run the build
  closeSettings();
  const appDir = await window.api.getAppDir();
  const session = await window.api.createSession({ mode: 'shell', cwd: appDir });
  addTab(session);

  // Send build command
  setTimeout(() => {
    window.api.sendInput(session.id, 'npm run build:mac\r');
  }, 500);

  btn.disabled = false;
  btn.textContent = 'ビルド開始';
}

// ── Update ──
async function checkForUpdate() {
  const label = document.getElementById('update-status-label');
  const btn = document.getElementById('btn-check-update');
  const infoEl = document.getElementById('update-info');

  btn.disabled = true;
  btn.textContent = '確認中...';
  label.textContent = '確認中...';

  const result = await window.api.checkUpdate();
  btn.disabled = false;
  btn.textContent = '確認';

  if (result.error) {
    label.textContent = 'エラー: ' + result.error;
    return;
  }
  if (result.updateAvailable) {
    label.textContent = 'アップデートあり';
    label.style.color = 'var(--green)';
    document.getElementById('update-changes').textContent = result.changes || '';
    infoEl.classList.remove('hidden');
  } else {
    label.textContent = '最新版です';
    label.style.color = 'var(--green)';
    infoEl.classList.add('hidden');
  }
}

async function applyUpdate() {
  const btn = document.getElementById('btn-apply-update');
  btn.disabled = true;
  btn.textContent = '更新中...';
  document.getElementById('update-status-label').textContent = 'ダウンロード中...';

  const result = await window.api.applyUpdate();
  if (result.success) {
    document.getElementById('update-status-label').textContent = '完了！再起動します...';
    setTimeout(() => window.api.restartApp(), 1500);
  } else {
    document.getElementById('update-status-label').textContent = '失敗: ' + (result.error || '');
    btn.disabled = false;
    btn.textContent = '更新してリスタート';
  }
}

// ══════════════════════════════════════════════════
// ── App Builder ──
// ══════════════════════════════════════════════════

let lastScanResult = null;

async function scanCurrentProject() {
  const tab = tabs.get(activeId);
  if (!tab) return;
  const cwd = tab.session.cwd;
  if (!cwd) return;

  const btn = document.getElementById('builder-scan-btn');
  btn.textContent = 'スキャン中...';
  btn.disabled = true;

  try {
    const result = await window.api.scanProject(cwd);
    lastScanResult = result;
    renderProjectInfo(result);
    highlightSuggestedCards(result);
  } catch (e) {
    console.error('Scan failed:', e);
  }

  btn.textContent = 'プロジェクトをスキャン';
  btn.disabled = false;
}

function renderProjectInfo(info) {
  const noProject = document.getElementById('builder-no-project');
  const detected = document.getElementById('builder-detected');

  if (!info.framework && !info.language) {
    noProject.innerHTML = '<p>プロジェクトが検出されませんでした</p><small>コードのあるディレクトリでタブを開いてください</small>';
    noProject.classList.remove('hidden');
    detected.classList.add('hidden');
    return;
  }

  noProject.classList.add('hidden');
  detected.classList.remove('hidden');

  document.getElementById('bp-name').textContent = info.packageName || info.name || '-';
  document.getElementById('bp-framework').textContent = info.framework || '(未検出)';
  document.getElementById('bp-language').textContent = info.language || '(未検出)';
  document.getElementById('bp-configs').textContent = info.configs.length > 0 ? info.configs.join(', ') : 'なし';
}

function highlightSuggestedCards(info) {
  // Reset all cards
  document.querySelectorAll('.bcard').forEach(c => {
    c.classList.remove('active', 'configured');
  });

  // Mark configured
  for (const cfg of info.configs) {
    const mapping = {
      'vercel': 'vercel', 'netlify': 'netlify', 'railway': 'railway',
      'docker': 'docker', 'docker-compose': 'docker',
      'capacitor': 'capacitor-ios', 'electron-builder': 'electron-mac',
      'tauri': 'tauri', 'supabase': 'supabase', 'firebase': 'firebase',
      'stripe': 'stripe', 'xcode': 'xcode-native',
    };
    const target = mapping[cfg];
    if (target) {
      const card = document.querySelector(`.bcard[data-target="${target}"]`);
      if (card) card.classList.add('configured');
    }
  }

  // Highlight suggestions
  for (const s of info.suggestions) {
    const card = document.querySelector(`.bcard[data-target="${s}"]`);
    if (card && !card.classList.contains('configured')) {
      card.classList.add('active');
    }
  }
}

function builderCardClicked(target) {
  if (!activeId) return;
  const tab = tabs.get(activeId);
  if (!tab) return;

  const info = lastScanResult || {};
  const fw = info.framework || '(不明)';
  const lang = info.language || '(不明)';
  const name = info.packageName || info.name || 'このプロジェクト';

  // Build a detailed prompt for Claude Code
  const prompts = {
    // ── Web Deploy ──
    'vercel': `このプロジェクト「${name}」(${fw}/${lang}) を Vercel にデプロイしたい。以下を順番にやって：
1. vercel.json の作成・確認（環境変数、ビルド設定）
2. 必要なら package.json の build スクリプトを確認・修正
3. Vercel CLI でデプロイする手順をガイド
4. カスタムドメインの設定方法も教えて`,

    'railway': `このプロジェクト「${name}」(${fw}/${lang}) を Railway にデプロイしたい。以下を順番にやって：
1. railway.toml の作成
2. 環境変数の設定
3. データベースが必要なら Railway の PostgreSQL/Redis を追加
4. デプロイ手順をガイド`,

    'netlify': `このプロジェクト「${name}」(${fw}/${lang}) を Netlify にデプロイしたい。以下を実行して：
1. netlify.toml の作成
2. ビルド設定の確認
3. デプロイ手順をガイド`,

    'streamlit-cloud': `このプロジェクト「${name}」(${fw}/Python) を Streamlit Cloud にデプロイしたい。以下をやって：
1. requirements.txt の確認・整備
2. .streamlit/config.toml の作成
3. Streamlit Cloud へのデプロイ手順をガイド`,

    'docker': `このプロジェクト「${name}」(${fw}/${lang}) を Docker コンテナ化したい。以下を作成して：
1. Dockerfile（マルチステージビルド、最適化済み）
2. .dockerignore
3. docker-compose.yml（DB等が必要なら含める）
4. ビルドと実行コマンドを教えて`,

    // ── Desktop ──
    'electron-mac': `このプロジェクト「${name}」(${fw}/${lang}) を macOS ネイティブアプリ (.dmg) にしたい。以下を実行して：
1. electron-builder の設定を確認・追加（package.json の build セクション）
2. アプリアイコンの設定（icns）
3. entitlements.mac.plist の作成
4. npm run build:mac でビルドできるようにして
5. コード署名と公証 (notarize) の手順も教えて`,

    'electron-win': `このプロジェクト「${name}」(${fw}/${lang}) を Windows アプリ (.exe) にしたい。以下を実行して：
1. electron-builder の Windows 設定
2. NSIS インストーラの設定
3. アイコン(.ico)の設定
4. npm run build:win でビルドできるようにして`,

    'electron-linux': `このプロジェクト「${name}」(${fw}/${lang}) を Linux アプリ (.AppImage, .deb) にしたい。以下を実行して：
1. electron-builder の Linux 設定
2. デスクトップエントリの設定
3. npm run build:linux でビルドできるようにして`,

    'tauri': `このプロジェクト「${name}」(${fw}/${lang}) を Tauri でネイティブアプリ化したい。Electron より軽量なアプリを作りたい。以下を実行して：
1. Tauri CLI のインストール (cargo install tauri-cli)
2. tauri init でプロジェクト初期化
3. tauri.conf.json の設定
4. macOS / Windows / Linux 向けビルド手順`,

    // ── Mobile ──
    'capacitor-ios': `このプロジェクト「${name}」(${fw}/${lang}) を iOS アプリにしたい。Capacitor を使って。以下を実行して：
1. @capacitor/core と @capacitor/ios をインストール
2. capacitor.config.ts を作成
3. npx cap add ios で iOS プロジェクト作成
4. Info.plist の設定（権限等）
5. Xcode でビルド・シミュレータ実行する手順
6. App Store 提出の準備手順`,

    'capacitor-android': `このプロジェクト「${name}」(${fw}/${lang}) を Android アプリにしたい。Capacitor を使って。以下を実行して：
1. @capacitor/core と @capacitor/android をインストール
2. capacitor.config.ts を作成
3. npx cap add android で Android プロジェクト作成
4. Android Studio でビルド・エミュレータ実行する手順
5. Play Store 提出の準備`,

    'xcode-native': `このプロジェクトを Swift ネイティブ iOS/macOS アプリにしたい。以下をガイドして：
1. Xcode プロジェクトの構成を確認
2. SwiftUI or UIKit のどちらを使うか提案
3. ビルド設定の確認
4. シミュレータでのテスト手順
5. App Store Connect への提出手順`,

    'flutter': `このプロジェクトを Flutter アプリにしたい。以下を実行して：
1. Flutter プロジェクトの初期化 (flutter create)
2. pubspec.yaml の設定
3. iOS と Android 両方のビルド設定
4. 既存のロジックがあれば移植方法を提案
5. ビルドとテスト手順`,

    // ── Infrastructure ──
    'supabase': `このプロジェクト「${name}」に Supabase を導入したい。以下を実行して：
1. @supabase/supabase-js をインストール
2. Supabase クライアントの初期化コードを作成
3. 認証 (Auth) の設定
4. データベーステーブルのスキーマ提案
5. Row Level Security (RLS) ポリシーの設定
6. .env に必要な環境変数を設定`,

    'firebase': `このプロジェクト「${name}」に Firebase を導入したい。以下を実行して：
1. firebase パッケージのインストール
2. Firebase の初期化設定
3. Authentication / Firestore / Storage のどれが必要か提案
4. セキュリティルールの設定`,

    'stripe': `このプロジェクト「${name}」に Stripe 決済を導入したい。以下を実行して：
1. stripe パッケージのインストール
2. Stripe の初期化設定
3. 商品・価格の設定方法
4. Checkout Session or Payment Intent の実装
5. Webhook の設定
6. テストモードでの動作確認手順`,

    'auth': `このプロジェクト「${name}」に認証機能を追加したい。以下を提案して：
1. 最適な認証方法を提案 (NextAuth, Supabase Auth, Clerk, Auth0 等)
2. OAuth プロバイダー設定 (Google, GitHub 等)
3. セッション管理
4. 保護されたルート/ページの実装`,

    'ci-cd': `このプロジェクト「${name}」に CI/CD パイプラインを設定したい。以下を作成して：
1. .github/workflows/ci.yml（テスト + Lint）
2. .github/workflows/deploy.yml（自動デプロイ）
3. ブランチ保護ルールの提案
4. 環境変数の GitHub Secrets 設定手順`,

    'domain-ssl': `このプロジェクト「${name}」にカスタムドメインと SSL を設定したい。以下をガイドして：
1. ドメイン購入の推奨（Cloudflare, Namecheap 等）
2. DNS 設定（A/CNAME レコード）
3. SSL 証明書の設定（Let's Encrypt or Cloudflare）
4. デプロイ先への接続手順`,
  };

  const prompt = prompts[target];
  if (!prompt) return;

  // Ensure we're in claude mode for the current tab
  if (tab.session.mode !== 'claude') {
    // Switch to simple mode first so user can see the prompt being sent
    if (uiMode === 'builder') setUiMode('simple');
    switchSessionMode('claude');
    // Wait a bit for mode switch, then send
    setTimeout(() => {
      window.api.sendInput(activeId, prompt + '\r');
      logBuilderAction(target, prompt);
    }, 1500);
  } else {
    window.api.sendInput(activeId, prompt + '\r');
    logBuilderAction(target, prompt);
    if (uiMode === 'builder') {
      // Show terminal output alongside builder
      setStatus('busy', `Builder: ${target} を設定中...`);
    }
  }
}

function logBuilderAction(target, prompt) {
  const tab = tabs.get(activeId);
  if (tab) {
    window.api.logPrompt({
      sessionId: activeId,
      prompt: `[Builder:${target}] ${prompt.slice(0, 100)}...`,
      sessionName: tab.session.name || '',
      cwd: tab.session.cwd || '',
    });
  }
  window.api.saveSessions();
}

// ── Util ──
function esc(t) {
  const el = document.createElement('span');
  el.textContent = t;
  return el.innerHTML;
}
