const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  createSession: (opts) => ipcRenderer.invoke('create-session', opts || {}),
  switchMode: (sessionId, newMode) => ipcRenderer.invoke('switch-mode', { sessionId, newMode }),
  sendInput: (sessionId, input) => ipcRenderer.invoke('send-input', { sessionId, input }),
  resizeTerminal: (sessionId, cols, rows) => ipcRenderer.invoke('resize-terminal', { sessionId, cols, rows }),
  closeSession: (sessionId) => ipcRenderer.invoke('close-session', { sessionId }),
  checkClaudeCli: () => ipcRenderer.invoke('check-claude-cli'),
  installClaudeCli: () => ipcRenderer.invoke('install-claude-cli'),
  resolveCwd: (p) => ipcRenderer.invoke('resolve-cwd', p),
  saveSessions: () => ipcRenderer.invoke('save-sessions'),
  loadSessions: () => ipcRenderer.invoke('load-sessions'),
  loadPrefs: () => ipcRenderer.invoke('load-prefs'),
  savePrefs: (prefs) => ipcRenderer.invoke('save-prefs', prefs),
  loadBuffer: (sessionId) => ipcRenderer.invoke('load-buffer', { sessionId }),
  cleanupOldBuffers: (oldIds) => ipcRenderer.invoke('cleanup-old-buffers', { oldIds }),
  logPrompt: (data) => ipcRenderer.invoke('log-prompt', data),
  loadWorkLog: () => ipcRenderer.invoke('load-work-log'),
  clearWorkLog: () => ipcRenderer.invoke('clear-work-log'),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  openAppFolder: () => ipcRenderer.invoke('open-app-folder'),
  getAppDir: () => ipcRenderer.invoke('get-app-dir'),
  scanProject: (cwd) => ipcRenderer.invoke('scan-project', { cwd }),
  checkCrash: () => ipcRenderer.invoke('check-crash'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // Harness Engineering
  harnessReadClaudeMd: (cwd) => ipcRenderer.invoke('harness-read-claudemd', { cwd }),
  harnessWriteClaudeMd: (cwd, content) => ipcRenderer.invoke('harness-write-claudemd', { cwd, content }),
  harnessReadUserClaudeMd: () => ipcRenderer.invoke('harness-read-user-claudemd'),
  harnessWriteUserClaudeMd: (content) => ipcRenderer.invoke('harness-write-user-claudemd', { content }),
  harnessReadHooks: (cwd) => ipcRenderer.invoke('harness-read-hooks', { cwd }),
  harnessWriteHooks: (cwd, hooks) => ipcRenderer.invoke('harness-write-hooks', { cwd, hooks }),
  harnessReadMemory: () => ipcRenderer.invoke('harness-read-memory'),
  harnessReadMemoryContent: (file) => ipcRenderer.invoke('harness-read-memory-content', { file }),
  harnessWriteMemory: (file, content) => ipcRenderer.invoke('harness-write-memory', { file, content }),
  harnessDeleteMemory: (file) => ipcRenderer.invoke('harness-delete-memory', { file }),
  harnessLoadProjects: () => ipcRenderer.invoke('harness-load-projects'),
  harnessSaveProjects: (projects) => ipcRenderer.invoke('harness-save-projects', projects),
  harnessPickFolder: () => ipcRenderer.invoke('harness-pick-folder'),

  onSessionOutput: (id, cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on(`session-output-${id}`, h);
    return () => ipcRenderer.removeListener(`session-output-${id}`, h);
  },
  onSessionExit: (id, cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on(`session-exit-${id}`, h);
    return () => ipcRenderer.removeListener(`session-exit-${id}`, h);
  },
  onMenuAction: (cb) => {
    ipcRenderer.on('menu-action', (_e, action) => cb(action));
  },
  removeListeners: (id) => {
    ipcRenderer.removeAllListeners(`session-output-${id}`);
    ipcRenderer.removeAllListeners(`session-exit-${id}`);
  },
});
