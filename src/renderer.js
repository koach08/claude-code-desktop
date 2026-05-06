// ── State ──
const tabs = new Map();
let activeId = null;
let currentMode = 'claude'; // 'claude' | 'codex' | 'shell'
let uiMode = 'simple';      // 'simple' | 'advanced'
const history = [];
let histIdx = 0;
let appSettings = { fontSize: 14, autoSaveInterval: 10, doubleEnterDelay: 500 };
let claudeMdScope = 'project'; // 'project' | 'user'
let agentLayout = 'cols'; // 'cols' | 'rows' | 'grid'

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
    // Save new sessions immediately so new buffer files exist before deleting old ones
    await window.api.saveSessions();
    window.api.cleanupOldBuffers(oldIds);

    // Show restore notification
    const msg = crashed
      ? `${saved.length}個のセッションを復元しました (前回クラッシュ検出)`
      : `${saved.length}個のセッションを復元しました`;
    setStatus('ready', msg);
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
    const hasConvId = !!savedSession.conversationId;
    const session = await window.api.createSession({
      mode: savedSession.mode || 'claude',
      cwd: savedSession.cwd,
      name: savedSession.name,
      restoreFromId: savedSession.id,
      conversationId: savedSession.conversationId || null,
    });
    // Don't replay old buffer — it creates confusing overlap with new session output.
    // Instead show a clean restore marker with context about what was restored.
    const restoreInfo = {
      name: savedSession.name || 'Claude Code',
      cwd: savedSession.cwd || '~',
      conversationId: savedSession.conversationId || null,
      mode: savedSession.mode || 'claude',
    };
    addTab(session, null, restoreInfo);
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

  // Builder dev mode toggle (nocode / lowcode)
  document.querySelectorAll('.bdev-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bdev-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      builderDevMode = btn.dataset.devmode;
    });
  });

  // Builder prompt composer - send button
  document.getElementById('builder-send-btn').addEventListener('click', sendBuilderPrompt);

  // Builder prompt composer - keyboard shortcuts
  document.getElementById('builder-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendBuilderPrompt();
    }
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
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); navHist(-1); return; }
    if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); navHist(1); return; }

    // Enter = send, Shift+Enter = newline
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isComposing || e.isComposing) return;
      e.preventDefault();

      if (!ta.value.trim()) {
        // Empty: send Enter to PTY (for yes/no confirmations) with retry
        if (activeId) {
          (async () => {
            for (let i = 0; i < 3; i++) {
              const r = await window.api.sendInput(activeId, '\r');
              if (r && r.ok) break;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          })();
        }
      } else {
        send();
      }
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
      // Don't scroll here — xterm.js auto-scrolls on new output if already at bottom.
      // Forcing scrollToBottom() before PTY response arrives causes viewport jump.
      // Visual feedback
      b.classList.add('qbtn-pressed');
      setTimeout(() => { b.classList.remove('qbtn-pressed'); }, 400);
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

  // Agent mode controls
  document.querySelectorAll('.alayout-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      agentLayout = btn.dataset.layout;
      document.querySelectorAll('.alayout-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tc = document.getElementById('terminal-container');
      tc.classList.remove('layout-cols', 'layout-rows', 'layout-grid');
      tc.classList.add(`layout-${agentLayout}`);
      updateAgentGrid();
      setTimeout(() => refitAllTerminals(), 50);
    });
  });
  document.getElementById('agent-add-claude').addEventListener('click', async () => {
    await newTab('claude');
    if (uiMode === 'agent') {
      updateAgentGrid();
      updateAgentCount();
      setTimeout(() => refitAllTerminals(), 100);
    }
  });
  document.getElementById('agent-add-shell').addEventListener('click', async () => {
    await newTab('shell');
    if (uiMode === 'agent') {
      updateAgentGrid();
      updateAgentCount();
      setTimeout(() => refitAllTerminals(), 100);
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
      // Capture scroll state before async refit
      const wasAtBottom = t.term.buffer.active.viewportY >= t.term.buffer.active.baseY;
      const savedViewportY = t.term.buffer.active.viewportY;
      setTimeout(() => {
        try {
          t.fit.fit();
          const sid = getTabSessionId(t.tabEl);
          if (sid) window.api.resizeTerminal(sid, t.term.cols, t.term.rows);
          requestAnimationFrame(() => {
            if (wasAtBottom) {
              t.term.scrollToBottom();
            } else {
              t.term.scrollToLine(savedViewportY);
            }
          });
        } catch (_) {}
      }, 80);
    }
  });
  if (mode === 'agent') {
    // Set layout class on terminal container
    const tc = document.getElementById('terminal-container');
    tc.classList.remove('layout-cols', 'layout-rows', 'layout-grid');
    tc.classList.add(`layout-${agentLayout}`);
    // Ensure at least 2 sessions for agent mode
    if (tabs.size < 2) {
      newTab('claude').then(() => {
        updateAgentGrid();
        updateAgentCount();
        refitAllTerminals();
      });
    } else {
      updateAgentGrid();
      updateAgentCount();
      setTimeout(() => refitAllTerminals(), 100);
    }
    document.getElementById('prompt-input').focus();
  } else if (mode === 'chat') {
    initChatProviders();
    document.getElementById('chat-input').focus();
  } else if (mode === 'simple' || mode === 'builder' || mode === 'harness') {
    // Clear agent grid inline styles
    document.getElementById('terminal-container').style.gridTemplateRows = '';
    document.getElementById('prompt-input').focus();
    if (mode === 'builder') scanCurrentProject();
    if (mode === 'harness') refreshHarnessPanel();
  } else {
    document.getElementById('terminal-container').style.gridTemplateRows = '';
    const tab = tabs.get(activeId);
    if (tab) {
      tab.term.focus();
      tab.term.scrollToBottom();
    }
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
    detectActivity(d, result.newId);
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
  // Update pane header
  if (tab.paneHeader) {
    tab.paneHeader.querySelector('.ph-icon').textContent = icon;
    tab.paneHeader.querySelector('.ph-name').textContent = result.name;
  }

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

function addTab(session, replayBuffer, restoreInfo) {
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
  tabEl.innerHTML = `<span class="tab-icon">${icon}</span><span class="tname">${esc(session.name)}</span><span class="tab-badge"></span><span class="tclose">&times;</span>`;
  const tabsContainer = document.getElementById('tabs');
  tabsContainer.appendChild(tabEl);
  // Scroll tabs container so the new tab (and the "+" button) stays visible
  requestAnimationFrame(() => { tabsContainer.scrollLeft = tabsContainer.scrollWidth; });

  // Pane
  const pane = document.createElement('div');
  pane.className = 'pane';

  // Pane header (visible in agent mode)
  const paneHeader = document.createElement('div');
  paneHeader.className = 'pane-header';
  paneHeader.innerHTML = `<span class="ph-icon">${icon}</span><span class="ph-name">${esc(session.name)}</span><span class="ph-cwd">${esc(session.cwd || '')}</span><span class="ph-status"></span>`;
  pane.appendChild(paneHeader);
  paneHeader.addEventListener('click', () => {
    const sid = getTabSessionId(tabEl);
    if (sid) switchTab(sid);
  });

  document.getElementById('terminal-container').appendChild(pane);
  term.open(pane);

  const data = { term, fit, tabEl, pane, paneHeader, session, ended: false };
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

  // Show restore marker (clean, no stale buffer replay)
  if (restoreInfo) {
    const shortCwd = restoreInfo.cwd.replace(/^\/Users\/[^/]+/, '~');
    const convLabel = restoreInfo.conversationId
      ? `\x1b[2m会話ID: ${restoreInfo.conversationId.slice(0, 8)}...\x1b[0m`
      : '\x1b[2m新規セッション\x1b[0m';
    term.write(`\x1b[36m┌─ セッション復元 ─────────────────────┐\x1b[0m\r\n`);
    term.write(`\x1b[36m│\x1b[0m 📂 ${shortCwd}\r\n`);
    term.write(`\x1b[36m│\x1b[0m ${convLabel}\r\n`);
    term.write(`\x1b[36m└──────────────────────────────────────┘\x1b[0m\r\n\r\n`);
  } else if (replayBuffer) {
    term.write(replayBuffer);
  }

  // Live output
  window.api.onSessionOutput(session.id, (d) => {
    term.write(d);
    detectActivity(d, session.id);
  });
  window.api.onSessionExit(session.id, () => {
    term.write('\r\n\x1b[33m[終了]\x1b[0m\r\n');
    tabEl.classList.add('ended');
    data.ended = true;
    setStatus('ended', '終了しました — 新しいタブを開くか、モードを切替えてください');
    // Update pane header status
    const phStatus = paneHeader.querySelector('.ph-status');
    if (phStatus) { phStatus.className = 'ph-status ended'; }
    // Show yellow badge on non-active tab when session ends
    if (session.id !== activeId) {
      const badge = tabEl.querySelector('.tab-badge');
      if (badge) { badge.classList.add('visible'); badge.classList.remove('approval'); }
    }
  });

  // Resize observer with debounce to prevent layout thrashing
  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    if (uiMode !== 'agent' && !pane.classList.contains('active')) return;
    // Capture scroll state before debounce — it may change during the delay
    const snapViewportY = term.buffer.active.viewportY;
    const snapAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try {
        fit.fit();
        const sid = getTabSessionId(tabEl);
        if (sid) window.api.resizeTerminal(sid, term.cols, term.rows);
        // Restore scroll in next frame after reflow
        requestAnimationFrame(() => {
          if (snapAtBottom) {
            term.scrollToBottom();
          } else {
            term.scrollToLine(snapViewportY);
          }
        });
      } catch (_) {}
    }, 80);
  });
  ro.observe(pane);
  data.ro = ro;

  switchTab(session.id);
  setTimeout(() => {
    try {
      fit.fit();
      window.api.resizeTerminal(session.id, term.cols, term.rows);
    } catch (_) {}
  }, 100);

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
      // Clear badge when switching to this tab
      const badge = t.tabEl.querySelector('.tab-badge');
      if (badge) badge.classList.remove('visible', 'approval');
      const mode = t.session.mode || 'claude';
      document.querySelectorAll('.mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
      currentMode = mode;
      updateStatusMode(mode);
      document.getElementById('status-cwd').textContent = t.session.cwd || '';
      // Delayed fit to let layout settle, preserve scroll position
      const savedViewportY = t.term.buffer.active.viewportY;
      const wasAtBottom = t.term.buffer.active.viewportY >= t.term.buffer.active.baseY;
      setTimeout(() => {
        try {
          t.fit.fit();
          window.api.resizeTerminal(tid, t.term.cols, t.term.rows);
          // Restore scroll in next frame after fit reflow completes
          requestAnimationFrame(() => {
            if (wasAtBottom) {
              t.term.scrollToBottom();
            } else {
              t.term.scrollToLine(savedViewportY);
            }
          });
        } catch (_) {}
      }, 100);
    }
  });
  if (uiMode === 'simple' || uiMode === 'builder' || uiMode === 'harness' || uiMode === 'agent') {
    document.getElementById('prompt-input').focus();
    if (uiMode === 'harness') refreshHarnessPanel();
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
  if (uiMode === 'agent') {
    updateAgentGrid();
    updateAgentCount();
    setTimeout(() => refitAllTerminals(), 50);
  }
  saveTabState();
}

// ── Input ──
async function send() {
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

  // Send with retry — PTY may not be ready on first attempt
  const input = text + '\r';
  let sent = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await window.api.sendInput(activeId, input);
    if (result && result.ok) { sent = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }

  if (!sent) {
    if (tab) tab.term.write('\r\n\x1b[31m[送信失敗] 再度お試しください\x1b[0m\r\n');
    return;
  }

  // Scroll terminal to bottom after sending
  if (tab) tab.term.scrollToBottom();

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

// ── Agent Mode Helpers ──
function refitAllTerminals() {
  tabs.forEach((t) => {
    try {
      t.fit.fit();
      const sid = getTabSessionId(t.tabEl);
      if (sid) window.api.resizeTerminal(sid, t.term.cols, t.term.rows);
    } catch (_) {}
  });
}

function updateAgentGrid() {
  const tc = document.getElementById('terminal-container');
  const paneCount = tc.querySelectorAll('.pane').length;
  const cols = agentLayout === 'rows' ? 1 : 2;
  const rows = Math.max(1, Math.ceil(paneCount / cols));
  tc.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
}

function updateAgentCount() {
  const el = document.getElementById('agent-count');
  if (el) el.textContent = `${tabs.size} Agents`;
}

// ── Activity Detection ──
let activityTimer = null;

function detectActivity(output, sessionId) {
  const isApproval = /\? ?\(y\/n\)|Allow|approve|permission/i.test(output);

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
      if (isApproval) {
        setStatus('waiting', msg);
      } else if (/\$\s*$|❯|>\s*$/m.test(output)) {
        setStatus('ready', msg);
      } else {
        setStatus('busy', msg);
      }
      break;
    }
  }

  // Update pane header status indicator (agent mode)
  if (sessionId) {
    const tab = tabs.get(sessionId);
    if (tab && tab.paneHeader) {
      const phStatus = tab.paneHeader.querySelector('.ph-status');
      if (phStatus) {
        phStatus.className = 'ph-status';
        if (isApproval) phStatus.classList.add('waiting');
        else if (/\$\s*$|❯|>\s*$/m.test(output)) { /* ready - default green */ }
        else phStatus.classList.add('busy');
      }
    }
  }

  // Show badge on non-active tabs: RED for approval, YELLOW only for completion
  const isCompleted = /✓|✔|Done|Complete|finished|completed|Task completed/i.test(output);
  if (sessionId && sessionId !== activeId) {
    const tab = tabs.get(sessionId);
    if (tab) {
      const badge = tab.tabEl.querySelector('.tab-badge');
      if (badge) {
        if (isApproval) {
          badge.classList.add('visible', 'approval');
        } else if (isCompleted) {
          badge.classList.add('visible');
          badge.classList.remove('approval');
        }
        // Regular activity (reading, writing, etc.) does NOT show a badge
      }
    }
  }

  // macOS notification for approval requests (works even when app is not focused)
  if (isApproval) {
    const tab = sessionId ? tabs.get(sessionId) : null;
    const tabName = tab ? (tab.session.name || 'Claude Code') : 'Claude Code';
    try {
      new Notification('Claude Code — 承認待ち', {
        body: `「${tabName}」で承認が必要です (Yes/No)`,
        silent: false,
      });
    } catch (_) {}
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
let builderDevMode = 'nocode'; // 'nocode' | 'lowcode'

function sendBuilderPrompt() {
  const textarea = document.getElementById('builder-prompt');
  const text = textarea.value.trim();
  if (!text || !activeId) return;

  const tab = tabs.get(activeId);
  if (!tab) return;

  const isNocode = builderDevMode === 'nocode';
  const modeLabel = isNocode ? 'ノーコード' : 'ローコード';
  const modeInstruction = isNocode
    ? `【${modeLabel}モード】ユーザーはコードを書きません。すべてのファイル作成・設定・コマンド実行をあなたが行ってください。進捗を日本語で報告しながら、確認が必要な箇所だけ質問してください。`
    : `【${modeLabel}モード】ステップバイステップで進めてください。各ステップで何をするか説明し、技術的な選択肢がある場合は選ばせてください。コードの重要な部分は解説してください。`;

  const prompt = `${modeInstruction}\n\n${text}`;

  if (tab.session.mode !== 'claude') {
    switchSessionMode('claude');
    setTimeout(() => {
      window.api.sendInput(activeId, prompt + '\r');
    }, 1500);
  } else {
    window.api.sendInput(activeId, prompt + '\r');
  }

  window.api.logPrompt({
    sessionId: activeId,
    prompt: `[Builder:custom] ${text.slice(0, 100)}...`,
    sessionName: tab.session.name || '',
    cwd: tab.session.cwd || '',
  });
  window.api.saveSessions();

  textarea.value = '';
  setStatus('busy', 'Builder: カスタムプロンプトを送信中...');
}

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
  const isNocode = builderDevMode === 'nocode';
  const modeLabel = isNocode ? 'ノーコード' : 'ローコード';
  const modeInstruction = isNocode
    ? `【${modeLabel}モード】ユーザーはコードを書きません。すべてのファイル作成・設定・コマンド実行をあなたが行ってください。進捗を日本語で報告しながら、確認が必要な箇所だけ質問してください。`
    : `【${modeLabel}モード】ステップバイステップで進めてください。各ステップで何をするか説明し、技術的な選択肢がある場合は選ばせてください。コードの重要な部分は解説してください。`;

  const prompts = {
    // ══════════════════════════════════════
    // ── Web アプリ作成 ──
    // ══════════════════════════════════════
    'build-saas': `${modeInstruction}

SaaS / 管理画面ダッシュボードを新規作成したい。以下の手順で進めて：
1. まずどんなSaaSか聞いて（対象ユーザー、主な機能、データの種類）
2. 技術スタック選定（Next.js + Supabase + Tailwind CSS を推奨、理由も説明）
3. プロジェクトのスキャフォールド作成
4. 認証（ログイン/サインアップ）の実装
5. ダッシュボード画面のレイアウト作成（サイドバー、統計カード、テーブル）
6. CRUD 機能の実装
7. レスポンシブ対応
8. デプロイ（Vercel推奨）まで完了させる

本番で使える品質で作って。テスト用のサンプルデータも用意して。`,

    'build-lp': `${modeInstruction}

ランディングページ（LP）を新規作成したい。以下の手順で進めて：
1. まずLPの目的を聞いて（商品/サービス紹介、メール登録、予約誘導など）
2. 構成提案（ヒーロー、特徴、料金、FAQ、CTA セクション）
3. Next.js or Astro + Tailwind CSS でプロジェクト作成
4. レスポンシブ対応のモダンなデザインで全セクション実装
5. アニメーション（スクロール連動、フェードイン）
6. コンタクトフォーム or メール登録フォームの実装
7. SEO対策（meta, OGP, structured data）
8. Core Web Vitals 最適化（画像最適化、フォント読み込み）
9. Vercel or Netlify にデプロイ

Bubble等のノーコードツールより高品質で高速なものを作って。`,

    'build-ec': `${modeInstruction}

ECサイト（オンラインショップ）を新規作成したい。以下の手順で進めて：
1. まず何を売るか聞いて（物販、デジタル商品、サブスク等）
2. 技術スタック選定（Next.js + Stripe + Supabase を推奨）
3. プロジェクトのスキャフォールド作成
4. 商品一覧ページ（カテゴリ、フィルタ、検索）
5. 商品詳細ページ（画像ギャラリー、説明、レビュー）
6. カート機能の実装
7. Stripe決済（Checkout Session）の実装
8. 注文管理・注文確認メール
9. 管理画面（商品追加/編集/削除、注文一覧）
10. レスポンシブ対応
11. デプロイまで完了

BASEやShopifyに頼らない、自分でコントロールできるECサイトを作って。`,

    'build-booking': `${modeInstruction}

予約システムを新規作成したい。以下の手順で進めて：
1. まず何の予約か聞いて（サロン、レッスン、会議室、レストラン等）
2. 技術スタック選定（Next.js + Supabase + Tailwind CSS を推奨）
3. プロジェクト作成
4. カレンダーUI（日/週/月表示、空き枠表示）
5. 予約フォーム（日時選択、顧客情報入力）
6. 予約確認メール送信
7. 管理画面（予約一覧、承認/拒否、枠の設定）
8. Google Calendar 連携（任意）
9. リマインダー通知
10. Stripe決済連携（前払い対応）
11. レスポンシブ対応・デプロイ

Coubic等の予約サービスに匹敵する品質で作って。`,

    'build-community': `${modeInstruction}

SNS / コミュニティサイトを新規作成したい。以下の手順で進めて：
1. まずどんなコミュニティか聞いて（趣味、学習、地域、専門分野等）
2. 技術スタック選定（Next.js + Supabase + Realtime を推奨）
3. プロジェクト作成
4. ユーザー認証（登録、ログイン、プロフィール）
5. 投稿機能（テキスト、画像、リンク共有）
6. コメント・いいね・フォロー機能
7. リアルタイムチャット or メッセージ機能
8. 通知システム
9. モデレーション機能（通報、ブロック）
10. レスポンシブ対応・デプロイ

Discordのサーバーやmixiのコミュニティに近い体験を独自で作って。`,

    'build-biztools': `${modeInstruction}

業務アプリ / 社内ツールを新規作成したい。以下の手順で進めて：
1. まずどんな業務か聞いて（タスク管理、在庫管理、顧客管理、ワークフロー等）
2. 技術スタック選定（Next.js + Supabase + Tailwind CSS を推奨）
3. プロジェクト作成
4. ユーザー認証・権限管理（管理者、一般ユーザー、閲覧のみ）
5. メインの業務画面（CRUD、フィルタ、検索、ソート）
6. ダッシュボード（集計、グラフ）
7. CSVインポート/エクスポート
8. メール通知・Slack連携（任意）
9. レスポンシブ対応・デプロイ

kintoneやNotionに頼らない、自社専用のツールを作って。`,

    'build-portfolio': `${modeInstruction}

ポートフォリオサイトを新規作成したい。以下の手順で進めて：
1. まず個人か企業か聞いて、見せたいコンテンツを確認
2. 技術スタック選定（Next.js or Astro + Tailwind CSS を推奨）
3. プロジェクト作成
4. ヒーローセクション（名前/ロゴ、キャッチコピー）
5. Works / プロジェクト一覧（フィルタ付き）
6. About セクション
7. スキル / サービス一覧
8. コンタクトフォーム
9. アニメーション（ページ遷移、スクロール連動）
10. SEO・OGP・ダークモード対応
11. デプロイまで完了

デザイナー品質のモダンなポートフォリオを作って。`,

    'build-blog': `${modeInstruction}

ブログ / メディアサイトを新規作成したい。以下の手順で進めて：
1. まずブログのテーマ・対象読者を聞く
2. 技術スタック選定（Next.js + MDX or Astro + Tailwind CSS を推奨）
3. プロジェクト作成
4. 記事一覧ページ（カテゴリ、タグ、ページネーション）
5. 記事詳細ページ（目次自動生成、コードブロック、画像最適化）
6. カテゴリ・タグページ
7. 検索機能
8. RSS フィード
9. SEO完全対応（meta, OGP, JSON-LD, sitemap.xml）
10. ダークモード対応
11. デプロイ + CMS連携（任意: Notion API or microCMS）

WordPressより速く、noteより自由なブログを作って。`,

    // ══════════════════════════════════════
    // ── ネイティブ / モバイルアプリ ──
    // ══════════════════════════════════════
    'build-ios': `${modeInstruction}

iOS アプリを新規作成して App Store に掲載できる状態まで持っていきたい。以下の手順で進めて：
1. まずどんなアプリか聞いて（機能、ターゲットユーザー）
2. 技術選定を提案（React Native / Capacitor + Next.js / SwiftUI のどれが最適か）
3. プロジェクトのスキャフォールド作成
4. メイン画面の実装（タブバー、ナビゲーション）
5. コア機能の実装
6. ローカルデータ保存 or API連携
7. プッシュ通知の設定（任意）
8. App Store 用のアセット準備（アイコン、スクリーンショット、説明文）
9. Xcode でのビルド・シミュレータテスト手順
10. App Store Connect への提出手順

Adaloで作れる範囲を超えた、ネイティブ品質のアプリを作って。Apple の審査に通るクオリティで。`,

    'build-android': `${modeInstruction}

Android アプリを新規作成して Google Play に掲載できる状態まで持っていきたい。以下の手順で進めて：
1. まずどんなアプリか聞いて（機能、ターゲットユーザー）
2. 技術選定を提案（React Native / Capacitor + Next.js / Kotlin のどれが最適か）
3. プロジェクトのスキャフォールド作成
4. メイン画面の実装
5. コア機能の実装
6. データ保存 or API連携
7. Play Store 用のアセット準備（アイコン、スクリーンショット、説明文）
8. Android Studio でのビルド・エミュレータテスト
9. Google Play Console への提出手順

Play Store の審査に通る品質で、パフォーマンスも最適化して。`,

    'build-cross': `${modeInstruction}

iOS + Android 両対応のクロスプラットフォームアプリを新規作成したい。以下の手順で進めて：
1. まずどんなアプリか聞いて（機能、ターゲットユーザー）
2. 技術選定（React Native / Expo を推奨、理由も説明。Capacitor + Next.js も選択肢として提示）
3. プロジェクトのスキャフォールド作成
4. 共通UIの実装（ナビゲーション、スクリーン）
5. プラットフォーム固有の対応（カメラ、通知等）
6. コア機能の実装
7. iOS / Android 両方でテスト
8. App Store / Play Store 両方への提出準備

1つのコードベースから両OSの高品質なアプリを作って。`,

    'build-pwa': `${modeInstruction}

PWA（Progressive Web App）を新規作成したい。インストール可能でオフライン対応のWebアプリ。以下の手順で進めて：
1. まずどんなアプリか聞いて
2. Next.js + next-pwa + Tailwind CSS でプロジェクト作成
3. manifest.json の設定（アイコン、テーマカラー、起動画面）
4. Service Worker の設定（キャッシュ戦略、オフライン対応）
5. メイン画面の実装
6. レスポンシブ対応（モバイルファースト）
7. インストールプロンプトの実装
8. Lighthouse で PWA スコア 100 を目指す
9. デプロイ

アプリストア不要でインストールできる、ネイティブアプリに近い体験を作って。`,

    // ══════════════════════════════════════
    // ── WordPress ──
    // ══════════════════════════════════════
    'build-wp-theme': `${modeInstruction}

WordPress のオリジナルテーマを新規作成したい。以下の手順で進めて：
1. まずサイトの目的を聞いて（コーポレート、ブログ、ポートフォリオ等）
2. テーマのディレクトリ構成を作成
3. style.css（テーマ情報ヘッダー）
4. functions.php（テーマサポート、カスタマイザー）
5. テンプレートファイル（header, footer, index, single, page, archive）
6. カスタム投稿タイプ・カスタムフィールド（必要に応じて）
7. レスポンシブ対応のモダンなデザイン
8. Gutenberg ブロック対応
9. カスタマイザーでの色・ロゴ変更対応
10. テーマの有効化・動作確認手順

既製テーマに頼らない、完全オリジナルのテーマを作って。`,

    'build-wp-plugin': `${modeInstruction}

WordPress のカスタムプラグインを新規作成したい。以下の手順で進めて：
1. まずプラグインの機能を聞いて
2. プラグインのディレクトリ構成を作成
3. メインプラグインファイル（ヘッダー、有効化/無効化フック）
4. 管理画面のメニュー・設定ページ
5. ショートコード or ブロック作成
6. データベーステーブル作成（必要に応じて）
7. REST API エンドポイント（必要に応じて）
8. セキュリティ対策（nonce, サニタイズ, capability check）
9. 国際化対応（翻訳可能に）
10. テスト・動作確認

WordPress.org に公開できる品質基準で作って。`,

    'build-wp-ec': `${modeInstruction}

WooCommerce を使った WordPress ECサイトを構築したい。以下の手順で進めて：
1. まず何を売るか聞いて
2. WooCommerce + 必要なプラグインの設定
3. 商品ページのカスタマイズ
4. 決済設定（Stripe推奨）
5. 配送設定
6. メールテンプレートのカスタマイズ
7. 管理画面の使い方ガイド
8. SEO設定
9. パフォーマンス最適化
10. セキュリティ設定

BASEやSTORESと同等以上の機能を、自前で管理できるECサイトとして構築して。`,

    // ══════════════════════════════════════
    // ── Web Deploy (既存) ──
    // ══════════════════════════════════════
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

// ══════════════════════════════════════════════════
// ── Harness Engineering ──
// ══════════════════════════════════════════════════

// Setup listeners on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  // Collapsible sections
  document.querySelectorAll('.harness-section-header').forEach(header => {
    header.addEventListener('click', () => {
      header.closest('.harness-section').classList.toggle('collapsed');
    });
  });

  // CLAUDE.md scope toggle
  document.querySelectorAll('.claudemd-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.claudemd-scope-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      claudeMdScope = btn.dataset.scope;
      loadClaudeMd();
    });
  });

  // CLAUDE.md create
  const createBtn = document.getElementById('claudemd-create-btn');
  if (createBtn) createBtn.addEventListener('click', async () => {
    const tab = tabs.get(activeId);
    const template = claudeMdScope === 'user'
      ? `# ユーザーグローバル指示書\n\n## 共通ルール\n\n- \n`
      : `# プロジェクト指示書\n\n- ビルド: npm run build\n- テスト: npm test\n- Lint: npm run lint\n\n## アーキテクチャ\n\n- フレームワーク: \n- データベース: \n\n## 規約\n\n- \n`;
    let result;
    if (claudeMdScope === 'user') {
      result = await window.api.harnessWriteUserClaudeMd(template);
    } else {
      if (!tab) return;
      result = await window.api.harnessWriteClaudeMd(tab.session.cwd, template);
    }
    if (result.success) loadClaudeMd();
  });

  // CLAUDE.md save
  const saveBtn = document.getElementById('claudemd-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const tab = tabs.get(activeId);
    const content = document.getElementById('claudemd-textarea').value;
    let result;
    if (claudeMdScope === 'user') {
      result = await window.api.harnessWriteUserClaudeMd(content);
    } else {
      if (!tab) return;
      result = await window.api.harnessWriteClaudeMd(tab.session.cwd, content);
    }
    const status = document.getElementById('claudemd-status');
    if (result.success) {
      status.textContent = '保存しました！';
      status.style.color = 'var(--green)';
    } else {
      status.textContent = result.error;
      status.style.color = 'var(--red)';
    }
    setTimeout(() => { status.textContent = ''; }, 3000);
  });

  // Hooks add
  const hooksBtn = document.getElementById('hooks-add-btn');
  if (hooksBtn) hooksBtn.addEventListener('click', addNewHook);

  // Projects add
  const projBtn = document.getElementById('projects-add-btn');
  if (projBtn) projBtn.addEventListener('click', async () => {
    const folder = await window.api.harnessPickFolder();
    if (!folder) return;
    const projects = await window.api.harnessLoadProjects();
    if (projects.find(p => p.path === folder)) return;
    const name = folder.split('/').pop() || folder;
    projects.push({ name, path: folder });
    await window.api.harnessSaveProjects(projects);
    loadProjects();
  });

  // Memory dialog
  setupMemoryDialog();
});

function refreshHarnessPanel() {
  if (uiMode !== 'harness') return;
  loadClaudeMd();
  loadHooks();
  loadMemory();
  loadProjects();
}

async function loadClaudeMd() {
  const tab = tabs.get(activeId);
  let result;
  if (claudeMdScope === 'user') {
    result = await window.api.harnessReadUserClaudeMd();
  } else {
    if (!tab) return;
    result = await window.api.harnessReadClaudeMd(tab.session.cwd);
  }
  const emptyEl = document.getElementById('claudemd-empty');
  const editorEl = document.getElementById('claudemd-editor');
  const badge = document.getElementById('claudemd-badge');
  const emptyText = emptyEl.querySelector('p');
  if (emptyText) {
    emptyText.textContent = claudeMdScope === 'user'
      ? 'ユーザーグローバル CLAUDE.md がありません。'
      : 'このプロジェクトに CLAUDE.md がありません。';
  }

  if (result.exists) {
    emptyEl.classList.add('hidden');
    editorEl.classList.remove('hidden');
    document.getElementById('claudemd-textarea').value = result.content;
    badge.textContent = '✓';
  } else {
    emptyEl.classList.remove('hidden');
    editorEl.classList.add('hidden');
    badge.textContent = '';
  }
}

async function loadHooks() {
  const tab = tabs.get(activeId);
  if (!tab) return;
  const result = await window.api.harnessReadHooks(tab.session.cwd);
  const emptyEl = document.getElementById('hooks-empty');
  const listEl = document.getElementById('hooks-list');
  const badge = document.getElementById('hooks-badge');

  listEl.innerHTML = '';
  const allHooks = { ...(result.user || {}), ...(result.project || {}) };
  const events = Object.keys(allHooks);

  if (events.length === 0) {
    emptyEl.classList.remove('hidden');
    badge.textContent = '';
    return;
  }

  emptyEl.classList.add('hidden');
  let count = 0;
  for (const event of events) {
    const hooks = allHooks[event];
    if (!Array.isArray(hooks)) continue;
    for (let hi = 0; hi < hooks.length; hi++) {
      const hook = hooks[hi];
      count++;
      const item = document.createElement('div');
      item.className = 'hook-item';
      item.innerHTML = `
        <div class="hook-item-header">
          <span class="hook-event">${esc(event)}</span>
          <button class="hook-delete">&times;</button>
        </div>
        <div class="hook-detail">${hook.matcher ? `<span>${esc(hook.matcher)}</span> → ` : ''}${esc(hook.command || '')}</div>
      `;
      item.querySelector('.hook-delete').addEventListener('click', async () => {
        const current = await window.api.harnessReadHooks(tab.session.cwd);
        const projectHooks = current.project || {};
        if (projectHooks[event] && Array.isArray(projectHooks[event])) {
          projectHooks[event].splice(hi, 1);
          if (projectHooks[event].length === 0) delete projectHooks[event];
        }
        await window.api.harnessWriteHooks(tab.session.cwd, projectHooks);
        loadHooks();
      });
      listEl.appendChild(item);
    }
  }
  badge.textContent = count.toString();
}

async function addNewHook() {
  const tab = tabs.get(activeId);
  if (!tab) return;
  const listEl = document.getElementById('hooks-list');
  const form = document.createElement('div');
  form.className = 'hook-item';
  form.style.borderColor = 'var(--accent)';
  form.innerHTML = `
    <select class="hook-event-select" style="width:100%;background:var(--bg1);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px;margin-bottom:4px;font-size:11px;">
      <option value="PreToolUse">PreToolUse</option>
      <option value="PostToolUse">PostToolUse</option>
      <option value="Notification">Notification</option>
      <option value="Stop">Stop</option>
    </select>
    <input class="hook-matcher-input" placeholder="Matcher (例: Edit|Write)" style="width:100%;background:var(--bg1);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px;margin-bottom:4px;font-size:11px;font-family:Menlo,monospace;">
    <input class="hook-command-input" placeholder="コマンド (例: npx eslint --fix)" style="width:100%;background:var(--bg1);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px;margin-bottom:4px;font-size:11px;font-family:Menlo,monospace;">
    <div style="display:flex;gap:4px;">
      <button class="harness-btn primary hook-save-new" style="margin:0;flex:1;">保存</button>
      <button class="harness-btn hook-cancel-new" style="margin:0;flex:1;">キャンセル</button>
    </div>
  `;
  listEl.appendChild(form);

  form.querySelector('.hook-cancel-new').addEventListener('click', () => form.remove());
  form.querySelector('.hook-save-new').addEventListener('click', async () => {
    const event = form.querySelector('.hook-event-select').value;
    const matcher = form.querySelector('.hook-matcher-input').value.trim();
    const command = form.querySelector('.hook-command-input').value.trim();
    const cmdInput = form.querySelector('.hook-command-input');
    if (!command) {
      cmdInput.style.borderColor = 'var(--red)';
      cmdInput.placeholder = 'コマンドは必須です';
      cmdInput.focus();
      return;
    }

    const result = await window.api.harnessReadHooks(tab.session.cwd);
    const hooks = result.project || {};
    if (!hooks[event]) hooks[event] = [];
    const entry = { command };
    if (matcher) entry.matcher = matcher;
    hooks[event].push(entry);
    await window.api.harnessWriteHooks(tab.session.cwd, hooks);
    form.remove();
    loadHooks();
  });
}

async function loadMemory() {
  const memories = await window.api.harnessReadMemory();
  const emptyEl = document.getElementById('memory-empty');
  const listEl = document.getElementById('memory-list');
  const badge = document.getElementById('memory-badge');

  listEl.innerHTML = '';
  if (memories.length === 0) {
    emptyEl.classList.remove('hidden');
    badge.textContent = '';
    return;
  }

  emptyEl.classList.add('hidden');
  badge.textContent = memories.length.toString();

  const typeIcons = { user: '👤', feedback: '💬', project: '📁', reference: '🔗' };
  for (const mem of memories) {
    const item = document.createElement('div');
    item.className = 'memory-item';
    item.innerHTML = `
      <span class="memory-icon">${typeIcons[mem.type] || '📝'}</span>
      <div class="memory-info">
        <div class="memory-name">${esc(mem.name)}</div>
        <div class="memory-type">${esc(mem.type)} — ${esc(mem.description)}</div>
      </div>
    `;
    item.addEventListener('click', () => openMemoryDialog(mem));
    listEl.appendChild(item);
  }
}

async function openMemoryDialog(mem) {
  const dialog = document.getElementById('memory-dialog');
  const title = document.getElementById('memory-dialog-title');
  const typeTag = document.getElementById('memory-dialog-type');
  const desc = document.getElementById('memory-dialog-desc');
  const textarea = document.getElementById('memory-dialog-textarea');
  const status = document.getElementById('memory-dialog-status');

  title.textContent = mem.name;
  typeTag.textContent = mem.type;
  desc.textContent = mem.description;
  status.textContent = '';

  const result = await window.api.harnessReadMemoryContent(mem.file);
  textarea.value = result.content || '';
  dialog.dataset.file = mem.file;
  dialog.classList.remove('hidden');
}

function setupMemoryDialog() {
  const dialog = document.getElementById('memory-dialog');
  const closeBtn = document.getElementById('memory-dialog-close');
  const saveBtn = document.getElementById('memory-dialog-save');
  const deleteBtn = document.getElementById('memory-dialog-delete');
  const status = document.getElementById('memory-dialog-status');

  closeBtn.addEventListener('click', () => dialog.classList.add('hidden'));
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.classList.add('hidden');
  });

  saveBtn.addEventListener('click', async () => {
    const file = dialog.dataset.file;
    const content = document.getElementById('memory-dialog-textarea').value;
    const result = await window.api.harnessWriteMemory(file, content);
    if (result.success) {
      status.textContent = '保存しました';
      status.style.color = 'var(--green)';
      setTimeout(() => { status.textContent = ''; }, 2000);
      loadMemory();
    } else {
      status.textContent = result.error;
      status.style.color = 'var(--red)';
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const file = dialog.dataset.file;
    if (!confirm(`「${file}」を削除しますか？`)) return;
    const result = await window.api.harnessDeleteMemory(file);
    if (result.success) {
      dialog.classList.add('hidden');
      loadMemory();
    } else {
      status.textContent = result.error;
      status.style.color = 'var(--red)';
    }
  });
}

async function loadProjects() {
  const projects = await window.api.harnessLoadProjects();
  const emptyEl = document.getElementById('projects-empty');
  const listEl = document.getElementById('projects-list');
  const badge = document.getElementById('projects-badge');

  listEl.innerHTML = '';
  if (projects.length === 0) {
    emptyEl.classList.remove('hidden');
    badge.textContent = '';
    return;
  }

  emptyEl.classList.add('hidden');
  badge.textContent = projects.length.toString();

  const tab = tabs.get(activeId);
  const currentCwd = tab ? tab.session.cwd : '';

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const isActive = currentCwd === p.path;
    const item = document.createElement('div');
    item.className = `project-item${isActive ? ' active' : ''}`;
    item.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div class="project-name">${esc(p.name)}</div>
        <div class="project-path">${esc(p.path)}</div>
      </div>
      <button class="project-remove" data-idx="${i}">&times;</button>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.project-remove')) return;
      newTab(currentMode, p.path);
    });
    item.querySelector('.project-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      projects.splice(i, 1);
      await window.api.harnessSaveProjects(projects);
      loadProjects();
    });
    listEl.appendChild(item);
  }
}

// ══════════════════════════════════════════════════
// ── AI Hub Chat ──
// ══════════════════════════════════════════════════

let chatMessages = [];
let chatProvider = 'openai';
let chatModel = '';
let chatProviders = {};
let chatStreaming = false;
let chatCleanupChunk = null;
let chatCleanupDone = null;
let chatCleanupError = null;

document.addEventListener('DOMContentLoaded', () => {
  // Engine buttons
  document.querySelectorAll('.chat-engine-btn').forEach(btn => {
    btn.addEventListener('click', () => switchChatEngine(btn.dataset.provider));
  });

  // Model select
  document.getElementById('chat-model-select').addEventListener('change', (e) => {
    chatModel = e.target.value;
  });

  // Send
  document.getElementById('chat-send-btn').addEventListener('click', sendChatMessage);
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Auto-resize + Smart Route suggestion
  let routeDebounce = null;
  document.getElementById('chat-input').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';

    // Debounced route suggestion
    clearTimeout(routeDebounce);
    const text = e.target.value.trim();
    if (text.length > 5) {
      routeDebounce = setTimeout(async () => {
        const suggestion = await window.api.hubSuggestRoute(text);
        const statusEl = document.getElementById('chat-status');
        if (suggestion && suggestion.provider !== chatProvider) {
          statusEl.innerHTML = `<span style="color:var(--yellow)">Smart Router: ${suggestion.reason} → </span><span style="color:var(--accent);cursor:pointer;text-decoration:underline;" id="route-accept">${suggestion.provider.toUpperCase()} に切替</span>`;
          document.getElementById('route-accept')?.addEventListener('click', () => {
            switchChatEngine(suggestion.provider);
            statusEl.textContent = '';
          });
        } else {
          statusEl.textContent = '';
        }
      }, 300);
    }
  });

  // Clear
  document.getElementById('chat-clear-btn').addEventListener('click', () => {
    chatMessages = [];
    renderChatMessages();
  });

  // Config dialog
  document.getElementById('chat-config-btn').addEventListener('click', openChatConfig);
  document.getElementById('chat-config-close').addEventListener('click', () => {
    document.getElementById('chat-config-dialog').classList.add('hidden');
  });
  document.getElementById('chat-config-dialog').addEventListener('click', (e) => {
    if (e.target.id === 'chat-config-dialog') e.target.classList.add('hidden');
  });
  document.getElementById('hub-config-save').addEventListener('click', saveChatConfig);
  document.getElementById('hub-config-test').addEventListener('click', testChatConnection);

  // SSE listeners
  chatCleanupChunk = window.api.onHubChunk(onChatChunk);
  chatCleanupDone = window.api.onHubDone(onChatDone);
  chatCleanupError = window.api.onHubError(onChatError);

  // Show welcome
  renderChatMessages();
});

async function initChatProviders() {
  const result = await window.api.hubProviders();
  if (result && !result.error) {
    chatProviders = result;
    // Mark unavailable engines
    document.querySelectorAll('.chat-engine-btn').forEach(btn => {
      const p = chatProviders[btn.dataset.provider];
      if (p && !p.available) btn.classList.add('unavailable');
      else btn.classList.remove('unavailable');
    });
    updateChatModelSelect();
  }
}

function switchChatEngine(provider) {
  chatProvider = provider;
  document.querySelectorAll('.chat-engine-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.provider === provider);
  });
  updateChatModelSelect();
  document.getElementById('chat-input').focus();
}

function updateChatModelSelect() {
  const sel = document.getElementById('chat-model-select');
  sel.innerHTML = '';
  const p = chatProviders[chatProvider];
  if (p && p.models) {
    for (const m of p.models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === p.defaultModel) opt.selected = true;
      sel.appendChild(opt);
    }
    chatModel = sel.value;
  }
}

function renderChatMessages() {
  const container = document.getElementById('chat-messages');

  if (chatMessages.length === 0) {
    container.innerHTML = `
      <div class="chat-welcome">
        <h2>Koach AI Hub</h2>
        <p>5つのAIエンジンを切り替えながら、何でも聞ける。コード、研究、子育て、大学事務、なんでも。</p>
        <div class="engine-pills">
          <span class="engine-pill">Claude</span>
          <span class="engine-pill">GPT</span>
          <span class="engine-pill">Perplexity</span>
          <span class="engine-pill">Groq</span>
          <span class="engine-pill">Venice.ai</span>
          <span class="engine-pill">Gemini</span>
        </div>
      </div>`;
    return;
  }

  container.innerHTML = '';
  const avatarLetters = { openai: 'G', claude: 'C', venice: 'V', gemini: 'G', perplexity: 'P', groq: 'Q' };

  for (const msg of chatMessages) {
    if (msg.error) {
      const errDiv = document.createElement('div');
      errDiv.className = 'chat-msg error';
      errDiv.textContent = msg.content || 'Error';
      container.appendChild(errDiv);
      continue;
    }

    const row = document.createElement('div');
    row.className = `chat-msg ${msg.role}`;
    if (msg.streaming) row.classList.add('streaming');
    if (msg.engine) row.dataset.engine = msg.engine;

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    if (msg.role === 'user') {
      avatar.textContent = 'K';
    } else {
      avatar.textContent = avatarLetters[msg.engine] || 'AI';
    }
    row.appendChild(avatar);

    // Body
    const body = document.createElement('div');
    body.className = 'msg-body';

    const label = document.createElement('div');
    label.className = 'msg-provider';
    label.textContent = msg.role === 'user' ? 'You' : (msg.provider || 'AI');
    body.appendChild(label);

    const content = document.createElement('div');
    content.className = 'msg-content';
    content.textContent = msg.content || '';
    body.appendChild(content);

    row.appendChild(body);
    container.appendChild(row);
  }
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || chatStreaming) return;

  // Add user message
  chatMessages.push({ role: 'user', content: text });

  // Add placeholder for assistant
  const providerNames = { openai: 'GPT', claude: 'Claude', venice: 'Venice.ai', gemini: 'Gemini', perplexity: 'Perplexity', groq: 'Groq' };
  chatMessages.push({
    role: 'assistant',
    content: '',
    provider: providerNames[chatProvider] || chatProvider,
    engine: chatProvider,
    streaming: true,
  });
  renderChatMessages();

  input.value = '';
  input.style.height = 'auto';
  chatStreaming = true;
  document.getElementById('chat-send-btn').disabled = true;
  document.getElementById('chat-status').textContent = `${providerNames[chatProvider] || chatProvider} (${chatModel}) で生成中...`;

  // Build messages for API (exclude metadata)
  const apiMessages = chatMessages
    .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.streaming))
    .map(m => ({ role: m.role, content: m.content }));
  // Add current user message
  if (apiMessages[apiMessages.length - 1]?.role !== 'user') {
    apiMessages.push({ role: 'user', content: text });
  }

  window.api.hubChat({
    provider: chatProvider,
    model: chatModel,
    messages: apiMessages,
  });
}

function onChatChunk({ content }) {
  const last = chatMessages[chatMessages.length - 1];
  if (last && last.role === 'assistant' && last.streaming) {
    last.content += content;
    // Update the last message element directly (avoid full re-render)
    const container = document.getElementById('chat-messages');
    const lastEl = container.lastElementChild;
    if (lastEl) {
      const contentEl = lastEl.querySelector('.msg-content');
      if (contentEl) contentEl.textContent = last.content;
      container.scrollTop = container.scrollHeight;
    }
  }
}

function onChatDone() {
  const last = chatMessages[chatMessages.length - 1];
  if (last && last.streaming) {
    last.streaming = false;
  }
  chatStreaming = false;
  document.getElementById('chat-send-btn').disabled = false;
  document.getElementById('chat-status').textContent = '';
  renderChatMessages();
  document.getElementById('chat-input').focus();
}

function onChatError({ error }) {
  const last = chatMessages[chatMessages.length - 1];
  if (last && last.streaming) {
    last.streaming = false;
    if (!last.content) {
      // Replace empty assistant message with error
      chatMessages.pop();
      chatMessages.push({ role: 'error', content: error, error: true });
    }
  }
  chatStreaming = false;
  document.getElementById('chat-send-btn').disabled = false;
  document.getElementById('chat-status').textContent = '';
  renderChatMessages();
}

async function openChatConfig() {
  const cfg = await window.api.hubLoadConfig();
  document.getElementById('hub-api-url').value = cfg.apiUrl || 'http://localhost:3900';
  document.getElementById('hub-api-secret').value = cfg.apiSecret || '';
  document.getElementById('hub-default-provider').value = cfg.defaultProvider || 'openai';
  document.getElementById('hub-config-status').textContent = '';
  document.getElementById('chat-config-dialog').classList.remove('hidden');
}

async function saveChatConfig() {
  const cfg = {
    apiUrl: document.getElementById('hub-api-url').value.trim().replace(/\/$/, ''),
    apiSecret: document.getElementById('hub-api-secret').value,
    defaultProvider: document.getElementById('hub-default-provider').value,
  };
  const result = await window.api.hubSaveConfig(cfg);
  const status = document.getElementById('hub-config-status');
  if (result.success) {
    status.textContent = '保存しました';
    status.style.color = 'var(--green)';
    // Refresh providers
    await initChatProviders();
    switchChatEngine(cfg.defaultProvider);
  } else {
    status.textContent = result.error;
    status.style.color = 'var(--red)';
  }
}

async function testChatConnection() {
  const status = document.getElementById('hub-config-status');
  status.textContent = '接続テスト中...';
  status.style.color = 'var(--yellow)';

  // Temporarily save and test
  await saveChatConfig();
  const providers = await window.api.hubProviders();
  if (providers.error) {
    status.textContent = `接続失敗: ${providers.error}`;
    status.style.color = 'var(--red)';
  } else {
    const available = Object.entries(providers)
      .filter(([, v]) => v.available)
      .map(([, v]) => v.name);
    status.textContent = `接続OK! 利用可能: ${available.length > 0 ? available.join(', ') : '(APIキー未設定)'}`;
    status.style.color = 'var(--green)';
  }
}

// ══════════════════════════════════════════════════
// ── Voice Input (Whisper) ──
// ══════════════════════════════════════════════════

let voiceRecorder = null;
let voiceChunks = [];
let voiceTargetInput = null; // which textarea to fill

function setupVoiceButton(btnId, targetInputId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (voiceRecorder && voiceRecorder.state === 'recording') {
      stopVoiceRecording(btn, targetInputId);
    } else {
      startVoiceRecording(btn, targetInputId);
    }
  });
}

async function startVoiceRecording(btn, targetInputId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks = [];
    voiceTargetInput = targetInputId;

    voiceRecorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm',
    });

    voiceRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceChunks.push(e.data);
    };

    voiceRecorder.onstop = async () => {
      // Stop all tracks
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording');
      btn.classList.add('transcribing');
      btn.textContent = '...';

      const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType });
      const arrayBuffer = await blob.arrayBuffer();

      try {
        const result = await window.api.hubTranscribe({
          audioBuffer: Array.from(new Uint8Array(arrayBuffer)),
          mimeType: voiceRecorder.mimeType,
        });

        if (result.text) {
          const input = document.getElementById(voiceTargetInput);
          if (input) {
            // Append to existing text
            const existing = input.value;
            input.value = existing ? existing + ' ' + result.text : result.text;
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 200) + 'px';
            input.focus();
          }
        } else if (result.error) {
          console.error('Transcription error:', result.error);
        }
      } catch (e) {
        console.error('Transcription failed:', e);
      }

      btn.classList.remove('transcribing');
      btn.textContent = '\u{1F3A4}';
    };

    voiceRecorder.start();
    btn.classList.add('recording');
    btn.textContent = '\u{23F9}';
  } catch (e) {
    console.error('Microphone access denied:', e);
  }
}

function stopVoiceRecording(btn, targetInputId) {
  if (voiceRecorder && voiceRecorder.state === 'recording') {
    voiceRecorder.stop();
  }
}

// Initialize voice buttons when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  setupVoiceButton('chat-mic-btn', 'chat-input');
  setupVoiceButton('terminal-mic-btn', 'prompt-input');
});

// ── Util ──
function esc(t) {
  const el = document.createElement('span');
  el.textContent = t;
  return el.innerHTML;
}
