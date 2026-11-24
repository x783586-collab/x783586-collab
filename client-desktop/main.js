"use strict";
/* tg-hub 桌面 HUD：平时只显示 CPU/网速，来通知才显示对应应用图标。
 * 点图标打开详细窗口。凭证存本地，消息全在 Hub。
 */
const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const path = require("path");
const fs = require("fs");
const sysmon = require("./sysmon");

const SETTINGS_MODE = process.argv.includes("--settings");

const CFG_FILE = path.join(app.getPath("userData"), "hub-client.json");
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch (e) { return { hub: "", token: "" }; }
}
function saveCfg(c) { fs.writeFileSync(CFG_FILE, JSON.stringify(c)); }

let railWin = null;
let detailWin = null;
let sysTimer = null;

// 宽度构成：状态点(5)+间距 + CPU块 + 分隔 + 网速块 + 齿轮 + 内边距 ≈ 176；每个图标 +37
const BASE_W = 176;
function railWidth(n) {
  if (n < 0) return 336;           // 设置面板
  return BASE_W + Math.max(0, n) * 37;
}
function edgePos(width) {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(wa.x + wa.width - width - 6),
    y: Math.round(wa.y + (wa.height - 46) / 2)
  };
}
function resizeRail(n) {
  if (!railWin || railWin.isDestroyed()) return;
  const w = railWidth(n), h = n < 0 ? 246 : 46;
  const p = edgePos(w);
  railWin.setBounds({ x: p.x, y: p.y, width: w, height: h }, true);
}

function createRail() {
  const saved = loadCfg();
  const p = edgePos(BASE_W);
  railWin = new BrowserWindow({
    width: BASE_W, height: 46, x: p.x, y: p.y,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false
    }
  });
  railWin.loadFile(path.join(__dirname, "../client/rail.html"));
  railWin.webContents.on("did-finish-load", () => {
    if (process.env.HUB_TRACE) console.log("[hub] rail loaded");
    railWin.webContents.send("hub:config", saved);
    if (process.env.HUB_SHOT) shoot(railWin, process.env.HUB_SHOT);
  });
  railWin.on("closed", () => { railWin = null; });

  // 每 1.5 秒采样系统信息推给渲染层
  if (sysTimer) clearInterval(sysTimer);
  const push = () => {
    if (railWin && !railWin.isDestroyed()) railWin.webContents.send("hub:sysinfo", sysmon.sample());
  };
  push();
  sysTimer = setInterval(push, 1500);
}

function openDetail() {
  if (detailWin && !detailWin.isDestroyed()) { detailWin.focus(); return; }
  const saved = loadCfg();
  const wa = screen.getPrimaryDisplay().workArea;
  const W = Math.min(760, wa.width - 80), H = Math.min(600, wa.height - 80);
  detailWin = new BrowserWindow({
    width: W, height: H,
    x: Math.round(wa.x + (wa.width - W) / 2),
    y: Math.round(wa.y + (wa.height - H) / 2),
    frame: false, transparent: true, alwaysOnTop: true, resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false
    }
  });
  detailWin.loadFile(path.join(__dirname, "../client/index.html"));
  detailWin.webContents.on("did-finish-load", () => {
    detailWin.webContents.send("hub:config", saved);
    if (process.env.HUB_SHOT_DETAIL) shoot(detailWin, process.env.HUB_SHOT_DETAIL);
  });
  detailWin.on("closed", () => { detailWin = null; });
}

function shoot(win, file) {
  setTimeout(async () => {
    try {
      const img = await win.capturePage();
      fs.writeFileSync(file, img.toPNG());
      if (process.env.HUB_TRACE) console.log("[hub] shot saved", file);
    } catch (e) {
      if (process.env.HUB_TRACE) console.log("[hub] shot fail", e.message);
    }
    app.quit();
  }, 3000);
}

/* ---------- 独立设置窗 ---------- */
let settingsWin = null;

function createSettings() {
  const wa = screen.getPrimaryDisplay().workArea;
  const W = Math.min(900, wa.width - 80), H = Math.min(680, wa.height - 80);
  settingsWin = new BrowserWindow({
    width: W, height: H,
    x: Math.round(wa.x + (wa.width - W) / 2),
    y: Math.round(wa.y + (wa.height - H) / 2),
    minWidth: 640, minHeight: 480,
    title: "tg-hub 设置中心",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false
    }
  });
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.on("closed", () => { settingsWin = null; if (process.platform !== "darwin") app.quit(); });
  if (process.env.HUB_SHOT_SETTINGS) shoot(settingsWin, process.env.HUB_SHOT_SETTINGS);
}

// 用 Node http/https 代理 Hub 请求，绕开 file:// 页面跨域；返回 {ok,status,data}
function proxyApi(cfg, method, apiPath, body) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(String(apiPath), String(cfg.hub || "").replace(/\/+$/, "") + "/"); }
    catch (e) { return resolve({ ok: false, status: 0, data: { error: "bad url" } }); }
    const lib = url.protocol === "https:" ? https : http;
    const payload = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const headers = { "X-Hub-Token": String(cfg.token || ""), "Accept": "application/json" };
    if (payload) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(payload); }
    const req = lib.request({
      hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search, method: method || "GET", headers,
      timeout: 12000
    }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        let data; try { data = JSON.parse(buf); } catch (e) { data = { raw: buf }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: data });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", (e) => resolve({ ok: false, status: 0, data: { error: String(e.message || e) } }));
    if (payload) req.write(payload);
    req.end();
  });
}

ipcMain.handle("settings:get-config", () => loadCfg());
ipcMain.handle("settings:save-config", (_e, c) => { saveCfg(c); return true; });
ipcMain.handle("settings:api", async (_e, a) => {
  const cfg = loadCfg();
  const r = await proxyApi(cfg, a && a.method, a && a.path, a && a.body);
  return r;
});
ipcMain.on("settings:open-guide", () => {
  shell.openExternal("file://" + path.join(__dirname, "../line-setup.html")).catch(() => {});
});
ipcMain.on("settings:close", () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });

ipcMain.on("hub:save-config", (_e, c) => { saveCfg(c); });
ipcMain.on("hub:open-external", (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
});
ipcMain.on("hub:quit", () => app.quit());
ipcMain.on("hub:open-detail", () => openDetail());
ipcMain.on("hub:resize-rail", (_e, n) => resizeRail(Number(n)));

app.whenReady().then(() => {
  if (SETTINGS_MODE) {
    // 设置窗正常显示在任务栏，不隐藏 dock
    createSettings();
    return;
  }
  if (process.platform === "darwin" && app.dock) { try { app.dock.hide(); } catch (e) {} }
  createRail();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
