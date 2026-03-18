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
  removeListeners: (id) => {
    ipcRenderer.removeAllListeners(`session-output-${id}`);
    ipcRenderer.removeAllListeners(`session-exit-${id}`);
  },
});
