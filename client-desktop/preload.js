"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  saveConfig: (c) => ipcRenderer.send("hub:save-config", c || {}),
  openExternal: (url) => ipcRenderer.send("hub:open-external", url),
  quit: () => ipcRenderer.send("hub:quit"),
  openDetail: () => ipcRenderer.send("hub:open-detail"),
  resizeRail: (n) => ipcRenderer.send("hub:resize-rail", n),
  onConfig: (cb) => ipcRenderer.on("hub:config", (_e, cfg) => cb(cfg || {})),
  onSysInfo: (cb) => ipcRenderer.on("hub:sysinfo", (_e, d) => cb(d))
});

// 独立设置窗专用接口：本地配置读写 + Hub API 代理（Invoke 拿返回值）
contextBridge.exposeInMainWorld("settingsApi", {
  getConfig: () => ipcRenderer.invoke("settings:get-config"),
  saveConfig: (c) => ipcRenderer.invoke("settings:save-config", c || {}),
  api: (method, path, body) => ipcRenderer.invoke("settings:api", { method: method, path: path, body: body }),
  openExternal: (url) => ipcRenderer.send("hub:open-external", url),
  openGuide: () => ipcRenderer.send("settings:open-guide"),
  close: () => ipcRenderer.send("settings:close")
});
