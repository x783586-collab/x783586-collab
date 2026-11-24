const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tgApi", {
  getState: () => ipcRenderer.invoke("tg:get-state"),
  onState: (cb) => ipcRenderer.on("tg:state", (_e, s) => cb(s)),
  onEvent: (cb) => ipcRenderer.on("tg:event", (_e, ev) => cb(ev)),
  openChat: (id) => ipcRenderer.invoke("tg:open", id),
  login: () => ipcRenderer.send("tg:login"),
  showLogin: () => ipcRenderer.send("tg:login"),
  showLineSetup: () => ipcRenderer.send("tg:line-setup"),
  setMode: (m) => ipcRenderer.send("tg:mode", m),
  setIgnore: (v) => ipcRenderer.send("tg:ignore", !!v),
  menu: () => ipcRenderer.send("tg:menu"),
  // 挂件内动作
  send: (id, text) => ipcRenderer.invoke("tg:send", { id, text }),
  react: (id, emoji) => ipcRenderer.invoke("tg:react", { id, emoji }),
  read: (id) => ipcRenderer.invoke("tg:read", id),
  // 设置
  getSettings: () => ipcRenderer.invoke("tg:get-settings"),
  setSettings: (patch) => ipcRenderer.invoke("tg:set-settings", patch),
  exportCfg: () => ipcRenderer.invoke("tg:export"),
  importCfg: (json) => ipcRenderer.invoke("tg:import", json),
  // 多来源
  getSources: () => ipcRenderer.invoke("tg:sources-get"),
  setSources: (patch) => ipcRenderer.invoke("tg:sources-set", patch),
  restartSource: (sid) => ipcRenderer.invoke("tg:sources-restart", sid),
  testSource: (sid, cfg) => ipcRenderer.invoke("tg:sources-test", { sid, cfg }),
  feedRead: (sid, key) => ipcRenderer.invoke("tg:feed-read", { sid, key }),
  feedSend: (sid, key, text) => ipcRenderer.invoke("tg:feed-send", { sid, key, text }),
  feedOpen: (sid, key) => ipcRenderer.invoke("tg:feed-open", { sid, key })
});

contextBridge.exposeInMainWorld("loginApi", {
  start: (p) => ipcRenderer.send("login:start", p),
  submit: (kind, value) => ipcRenderer.send("login:submit", { kind, value }),
  getAuthState: () => ipcRenderer.invoke("login:get-state"),
  onState: (cb) => ipcRenderer.on("login:state", (_e, s) => cb(s)),
  onNeed: (cb) => ipcRenderer.on("login:need", (_e, k) => cb(k)),
  onError: (cb) => ipcRenderer.on("login:error", (_e, m) => cb(m)),
  onDone: (cb) => ipcRenderer.on("login:done", (_e, n) => cb(n)),
  close: () => ipcRenderer.send("login:close"),
  resize: (h) => ipcRenderer.send("login:resize", h),
  openExternal: (url) => ipcRenderer.send("login:open", url)
});

/* LINE 配置向导（独立窗口 line-setup.html） */
contextBridge.exposeInMainWorld("lineSetupApi", {
  open: () => ipcRenderer.send("tg:line-setup"),
  getCfg: () => ipcRenderer.invoke("linesetup:get-cfg"),
  save: (cfg) => ipcRenderer.invoke("linesetup:save", cfg),
  testRelay: (url, token) => ipcRenderer.invoke("linesetup:test-relay", url, token),
  testToken: (token) => ipcRenderer.invoke("linesetup:test-token", token),
  setWebhook: (token, url) => ipcRenderer.invoke("linesetup:set-webhook", token, url),
  resize: (h) => ipcRenderer.send("line-setup:resize", h),
  close: () => ipcRenderer.send("line-setup:close"),
  openExternal: (url) => ipcRenderer.send("login:open", url)
});
