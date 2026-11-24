const { app, BrowserWindow, screen, ipcMain, shell, Menu,
        Notification, Tray, globalShortcut, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage, Raw } = require("telegram/events");
const { SourceManager, SOURCE_META, CTORS } = require("./sources");
const { fetchWithTimeout } = require("./sources/base");

/* ==========================================================
   配置
   ========================================================== */

let configPath = null;

const DEFAULT_SETTINGS = {
  watchMode: "all",            // all=全部会话  only=只盯选中的
  watchIds: [],                // 关注的会话 id
  dnd: { enabled: false, from: "22:00", to: "08:00" },
  muteUntil: 0,                // 一键免打扰的到期时间戳
  keywords: [],                // 关键词，命中则高亮+必提醒
  mentionOnly: false,          // 只提醒被 @ / 被回复 / 命中关键词
  autoReadBots: false,         // 机器人会话自动标已读
  notify: true,                // 系统通知
  badge: true,                 // Dock 未读角标
  sound: false,                // 通知声音
  side: "right",               // 贴边位置
  opacity: 62,                 // 平时不透明度
  clickThrough: true,          // 鼠标不在挂件上时点击穿透
  autoLaunch: false,           // 开机自启
  quickReplies: ["收到", "稍后回你", "好的"]
};

/* 各消息来源的默认配置。Telegram 走原有独立通道，其余由 SourceManager 管理 */
const DEFAULT_SOURCES = {
  telegram: { enabled: true },
  imap:     { enabled: false, interval: 180, accounts: [] },
  rss:      { enabled: false, interval: 300, feeds: [] },
  matrix:   { enabled: false, homeserver: "", token: "" },
  discord:  { enabled: false, token: "" },
  slack:    { enabled: false, appToken: "", botToken: "" },
  github:   { enabled: false, token: "", interval: 120 },
  gitlab:   { enabled: false, baseUrl: "https://gitlab.com", token: "", interval: 180 },
  safextm:  { enabled: false, token: "" },
  line:     { enabled: false, relay: "", relayToken: "", token: "" }
};

let config = {
  apiId: 0,
  apiHash: "",
  session: "",
  proxy: { enabled: false, type: "socks5", host: "", port: 0, secret: "" },
  sources: JSON.parse(JSON.stringify(DEFAULT_SOURCES)),
  settings: Object.assign({}, DEFAULT_SETTINGS)
};

function mergeSources(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SOURCES));
  for (const k of Object.keys(saved || {})) {
    if (!out[k]) continue; // 未知来源忽略，避免旧配置里的脏键带进来
    out[k] = Object.assign(out[k], saved[k]);
  }
  return out;
}

function loadConfig() {
  try {
    configPath = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const savedSettings = raw.settings || {};
      const savedSources = raw.sources || {};
      delete raw.settings;
      delete raw.sources;
      config = Object.assign(config, raw);
      config.proxy = Object.assign({ enabled:false, type:"socks5", host:"", port:0, secret:"" }, config.proxy, raw.proxy || {});
      config.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
      config.sources = mergeSources(savedSources);
      if (!Array.isArray(config.settings.watchIds)) config.settings.watchIds = [];
      if (!Array.isArray(config.settings.keywords)) config.settings.keywords = [];
      if (!Array.isArray(config.settings.quickReplies) || !config.settings.quickReplies.length)
        config.settings.quickReplies = ["收到", "稍后回你", "好的"];
    }
  } catch (e) {}
}

function saveConfig() {
  try {
    if (!configPath) configPath = path.join(app.getPath("userData"), "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch (e) {}
}

/* ==========================================================
   规则引擎：免打扰 / 关注名单 / 关键词
   ========================================================== */

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isDndNow() {
  const s = config.settings;
  if (s.muteUntil && Date.now() < s.muteUntil) return true;
  if (!s.dnd || !s.dnd.enabled) return false;
  const a = toMinutes(s.dnd.from), b = toMinutes(s.dnd.to);
  if (a == null || b == null) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

function isWatched(id) {
  return config.settings.watchMode !== "only" || config.settings.watchIds.includes(String(id));
}

function keywordHit(text) {
  const kws = (config.settings.keywords || []).map(k => String(k).trim()).filter(Boolean);
  if (!kws.length || !text) return false;
  const lower = String(text).toLowerCase();
  return kws.some(k => lower.includes(k.toLowerCase()));
}

// 消息是否值得提醒：被 @ / 回复我 / 命中关键词
function isMentionToMe(m) {
  try {
    if (m && m.replyTo) return true; // 回复链（简化判定：收到对既有消息的回复视为点名）
    const ents = (m && m.entities) || [];
    for (const e of ents) {
      if (e.className === "MessageEntityMention") {
        const text = String(m.message || "").substr(e.offset, e.length);
        if (meUsername && text.toLowerCase() === "@" + meUsername.toLowerCase()) return true;
      }
      if (e.className === "MessageEntityMentionName" && meId && String(e.userId) === String(meId)) return true;
    }
  } catch (e) {}
  return false;
}

let meId = 0;
let meUsername = "";

// 一条新消息最终是否触发提醒（通知/闪烁/亮起）
function shouldAlert(c, m) {
  const s = config.settings;
  if (!c || m && m.out) return false;
  if (isDndNow()) return keywordHit(m && m.message) || (s.mentionOnly && isMentionToMe(m)); // 免打扰下只有关键词/点名穿透
  if (s.mentionOnly) return isMentionToMe(m) || keywordHit(m && m.message);
  return true;
}

/* ==========================================================
   窗口
   ========================================================== */

let hudWin = null;
let loginWin = null;
let lineSetupWin = null;
let client = null;
let chats = [];
let status = "offline";
let accountName = "";
let pushTimer = null;
let cacheTimer = null;
let handlerAttached = false;
let cachePath = null;

/* 多来源管理器：Telegram 之外的一切都从这里进来 */
const feedBaseline = new Map();
const sourceMgr = new SourceManager((ev) => {
  if (ev.kind === "item" && ev.item) {
    const uid = ev.item.sid + ":" + ev.item.key;
    const prev = feedBaseline.get(uid);
    const now = ev.item.unread || 0;
    feedBaseline.set(uid, now);
    // 第一次见到的会话只建立基线，不算"新消息"，避免启动时满屏闪烁
    if (prev !== undefined && now > prev && !ev.item.error) {
      if (hudWin && !hudWin.isDestroyed()) {
        hudWin.webContents.send("tg:event", { type: "flash", uid });
      }
      notifyExternal(ev.item);
    }
  }
  pushState();
});

const HUD_W = 364;
const HUD_H = 660;

function createHud() {
  const { workArea } = screen.getPrimaryDisplay();
  hudWin = new BrowserWindow({
    width: HUD_W,
    height: Math.min(HUD_H, workArea.height - 40),
    x: workArea.x + workArea.width - HUD_W,
    y: workArea.y + Math.round((workArea.height - HUD_H) / 2),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  hudWin.setAlwaysOnTop(true, "floating");
  hudWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWin.loadFile(path.join(__dirname, "..", "index.html"), { query: { embed: "1" } });

  // 页面就绪后立刻把缓存推过去，实现"秒开"（真实数据随后覆盖）
  hudWin.webContents.on("did-finish-load", () => {
    if (!chats.length) return;
    setTimeout(() => {
      if (hudWin && !hudWin.isDestroyed()) {
        hudWin.webContents.send("tg:state", publicState());
      }
    }, 80);
  });

  if (process.env.TG_DEBUG) {
    hudWin.webContents.on("console-message", (_e, lvl, msg) => console.log("[hud]", msg));
    hudWin.webContents.on("render-process-gone", (_e, d) => console.log("[hud] gone:", d.reason));
  }
  if (process.env.TG_HUD_SHOT) {
    hudWin.webContents.on("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const has = await hudWin.webContents.executeJavaScript("!!window.tgApi");
          console.log("[hud] tgApi bridge:", has);
          const probe = await hudWin.webContents.executeJavaScript(
            "window.tgApi.getState().then(s=>({status:s.status,feeds:(s.feeds||[]).length,chats:(s.chats||[]).length,sources:s.sources}))"
          ).catch(e => ({ err: String(e) }));
          console.log("[hud] state:", JSON.stringify(probe));
          fs.writeFileSync(process.env.TG_HUD_SHOT, (await hudWin.capturePage()).toPNG());
        } catch (e) { console.log("[hud] shot err:", e.message); }
        app.quit();
      }, 3000);
    });
  }

  hudWin.on("closed", () => { hudWin = null; });
}

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.show();
    loginWin.focus();
    return;
  }
  loginWin = new BrowserWindow({
    width: 470,
    height: 660,
    minWidth: 430,
    minHeight: 460,
    resizable: true,
    minimizable: true,
    maximizable: false,
    title: "连接 Telegram",
    backgroundColor: "#0c0c10",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loginWin.loadFile(path.join(__dirname, "..", "login.html"));

  if (process.env.TG_DEBUG) {
    loginWin.webContents.on("console-message", (_e, lvl, msg) => console.log("[login]", msg));
    loginWin.webContents.on("render-process-gone", (_e, d) => console.log("[login] gone:", d.reason));
  }
  if (process.env.TG_SHOT) {
    setTimeout(async () => {
      try { fs.writeFileSync(process.env.TG_SHOT, (await loginWin.capturePage()).toPNG()); } catch (e) {}
      app.quit();
    }, 2200);
  }

  loginWin.on("closed", () => {
    loginWin = null;
    Object.keys(waiters).forEach(k => delete waiters[k]);
  });
}

/* LINE 配置向导窗口（line-setup.html），窗口高度随内容自适应 */
function openLineSetup() {
  if (lineSetupWin && !lineSetupWin.isDestroyed()) {
    lineSetupWin.show();
    lineSetupWin.focus();
    return;
  }
  lineSetupWin = new BrowserWindow({
    width: 500,
    height: 680,
    minWidth: 440,
    minHeight: 480,
    resizable: true,
    minimizable: true,
    maximizable: false,
    title: "接入 LINE",
    backgroundColor: "#0c0c10",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  lineSetupWin.loadFile(path.join(__dirname, "..", "line-setup.html"));

  if (process.env.TG_DEBUG) {
    lineSetupWin.webContents.on("console-message", (_e, lvl, msg) => console.log("[linesetup]", msg));
    lineSetupWin.webContents.on("render-process-gone", (_e, d) => console.log("[linesetup] gone:", d.reason));
  }
  if (process.env.LINE_SHOT) {
    lineSetupWin.webContents.on("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const has = await lineSetupWin.webContents.executeJavaScript("!!window.lineSetupApi");
          console.log("[linesetup] bridge:", has);
          fs.writeFileSync(process.env.LINE_SHOT, (await lineSetupWin.capturePage()).toPNG());
        } catch (e) { console.log("[linesetup] shot err:", e.message); }
        app.quit();
      }, 1800);
    });
  }

  lineSetupWin.on("closed", () => { lineSetupWin = null; });
}

/* ==========================================================
   状态推送
   ========================================================== */

function publicState() {
  const s = config.settings;
  const total = chats.reduce((n, c) => n + (c.unread || 0), 0);
  const feeds = sourceMgr.list();
  const feedUnread = feeds.reduce((n, f) => n + (f.unread || 0), 0);

  // 多源时：只要有一个来源在线，整体就算在线；还在连的路上就显示连接中
  let overall = status;
  if (overall !== "online" && sourceMgr.sources.size) {
    const st = sourceMgr.statusList();
    const vals = Object.keys(st).filter((k) => k !== "telegram").map((k) => st[k].status);
    if (vals.some((v) => v === "online")) overall = "online";
    else if (vals.some((v) => v === "connecting")) overall = "connecting";
  }
  if (overall === "offline" && feeds.length) overall = "online";

  return {
    status: overall,
    tgStatus: status,
    account: accountName,
    dnd: isDndNow(),
    totalUnread: total + feedUnread,
    settings: s,
    sources: sourceMgr.statusList(),
    feeds,
    chats: chats.map(c => ({
      sid: "telegram",
      key: String(c.id),
      uid: "telegram:" + c.id,
      id: c.id,
      title: c.title,
      username: c.username || "",
      unread: c.unread || 0,
      muted: !!c.muted,
      pinned: !!c.pinned,
      last: c.last || null,
      text: (c.last && c.last.text) || "",
      date: (c.last && c.last.date) || 0,
      messages: c.messages || [],
      photo: c.photo || null,
      watched: isWatched(c.id),
      hot: keywordHit(c.last && c.last.text),
      isBot: !!(c._entity && c._entity.bot),
      color: "#2aabee",
      sourceName: "Telegram",
      canReply: true,
      link: null
    }))
  };
}

function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (hudWin && !hudWin.isDestroyed()) {
      hudWin.webContents.send("tg:state", publicState());
    }
    scheduleCache();
  }, 200);
}

/* ==========================================================
   冷启动缓存：学 TDLib 的做法——本地先有状态，网络后到
   ========================================================== */

function scheduleCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(writeCache, 1500);
}

function writeCache() {
  try {
    if (!cachePath) cachePath = path.join(app.getPath("userData"), "chats.json");
    const list = chats.slice(0, 30).map(c => ({
      id: c.id,
      title: c.title,
      username: c.username || "",
      unread: c.unread || 0,
      muted: !!c.muted,
      lastMsgId: c.lastMsgId || 0,
      last: c.last || null,
      // 头像超过 60KB 不入缓存，避免文件膨胀
      photo: c.photo && c.photo.length < 60000 ? c.photo : null,
      messages: (c.messages || []).slice(-3)
    }));
    fs.writeFileSync(cachePath, JSON.stringify({ t: Date.now(), chats: list }));
  } catch (e) {}
}

function readCache() {
  try {
    if (!cachePath) cachePath = path.join(app.getPath("userData"), "chats.json");
    if (!fs.existsSync(cachePath)) return false;
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!raw || !Array.isArray(raw.chats) || !raw.chats.length) return false;
    // 超过 7 天的缓存只当占位，仍然显示但马上会被真实数据覆盖
    chats = raw.chats.map(c => Object.assign({}, c, { _entity: null }));
    return true;
  } catch (e) {
    return false;
  }
}

function setStatus(s) {
  status = s;
  pushState();
}

/* ==========================================================
   Telegram
   ========================================================== */

const waiters = {};

// TDLib 式显式登录状态机：idle→connecting→wait-phone→wait-code→wait-password→ready|fail
// 登录窗口打开时先查一次状态，可从上一步中断处继续
let authState = { step: "idle", phone: "", error: "" };

function setAuthStep(step, extra) {
  authState = Object.assign({}, authState, { step, error: "" }, extra || {});
  try {
    if (loginWin && !loginWin.isDestroyed()) loginWin.webContents.send("login:state", authState);
  } catch (e) {}
}

function ask(kind) {
  setAuthStep(kind === "phone" ? "wait-phone" : kind === "code" ? "wait-code" : "wait-password");
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.webContents.send("login:need", kind);
  }
  return new Promise(res => { waiters[kind] = res; });
}

function loginError(msg) {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.webContents.send("login:error", msg);
  }
}

function loginDone(name) {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.webContents.send("login:done", name);
  }
}

function prettyErr(e) {
  const m = String((e && (e.errorMessage || e.message)) || e || "");
  if (m.includes("连接超时")) return "连不上 Telegram 的服务器。如果这个网络访问不了 Telegram，展开「网络设置」填一个 SOCKS5 代理再试。";
  if (m.includes("PHONE_CODE_INVALID")) return "验证码不对，请重新输入";
  if (m.includes("PHONE_CODE_EXPIRED")) return "验证码已过期，退回去重新发送";
  if (m.includes("PASSWORD_HASH_INVALID")) return "两步验证密码不对";
  if (m.includes("PHONE_NUMBER_INVALID")) return "手机号格式不对，记得带国家码，例如 +86 138...";
  if (m.includes("PHONE_NUMBER_BANNED")) return "这个号码已被 Telegram 限制";
  if (m.includes("FLOOD_WAIT")) return "操作太频繁，等几分钟再试";
  if (m.includes("API_ID_INVALID")) return "API ID 或 API Hash 不正确";
  if (m.includes("API_ID_PUBLISHED_FLOOD")) return "这个 API ID 被限制使用，请用自己申请的";
  if (m.includes("ENOTFOUND") || m.includes("ETIMEDOUT") || m.includes("ECONNREFUSED")) return "连不上 Telegram，检查网络或代理设置";
  if (m.includes("AUTH_KEY_UNREGISTERED")) return "登录状态已失效，需要重新登录";
  return m || "未知错误";
}

function withTimeout(p, ms, msg) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))
  ]);
}

function makeClient() {
  const opts = { connectionRetries: 3, retryDelay: 1200, autoReconnect: true, useWSS: false };
  const p = config.proxy;
  if (p && p.enabled && p.host) {
    if (p.type === "mtp") {
      // MTProxy：host:port + 32 位 hex secret
      opts.proxy = {
        ip: p.host,
        port: Number(p.port) || 443,
        MTProxy: true,
        secret: String(p.secret || "").trim(),
        timeout: 10
      };
    } else {
      // SOCKS5
      opts.proxy = {
        ip: p.host,
        port: Number(p.port) || 1080,
        socksType: 5,
        MTProxy: false,
        timeout: 10
      };
    }
  }
  return new TelegramClient(new StringSession(config.session || ""), config.apiId, config.apiHash, opts);
}

async function connectWithLogin() {
  authState = { step: "idle", phone: "", error: "" };
  try {
    setStatus("connecting");
    setAuthStep("connecting");
    client = makeClient();

    await withTimeout(client.connect(), 30000, "连接超时，检查网络或代理");

    const authorized = await client.checkAuthorization();
    if (!authorized) {
      await client.start({
        phoneNumber: async () => {
          const p = await ask("phone");
          authState.phone = p;
          setAuthStep("wait-code", { phone: p });
          return p;
        },
        phoneCode: async () => {
          const c = await ask("code");
          setAuthStep("verifying");
          return c;
        },
        password: async () => {
          const p = await ask("password");
          setAuthStep("verifying");
          return p;
        },
        onError: (e) => {
          setAuthStep(authState.step, { error: prettyErr(e) });
          loginError(prettyErr(e));
        }
      });
    }

    setAuthStep("saving");
    config.session = client.session.save();
    saveConfig();

    await afterLogin();
  } catch (e) {
    setStatus("error");
    setAuthStep("fail", { error: prettyErr(e) });
    loginError(prettyErr(e));
    try { if (client) await client.destroy(); } catch (_) {}
    client = null;
  }
}

async function afterLogin() {
  setAuthStep("ready");
  try {
    const me = await client.getMe();
    accountName = [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "已登录";
    meId = me.id || 0;
    meUsername = me.username || "";
  } catch (e) {
    accountName = "已登录";
  }

  if (!handlerAttached) {
    handlerAttached = true;
    client.addEventHandler(onNewMessage, new NewMessage({}));
    // 只订阅需要的原始更新，避免每秒几十条无关事件
    client.addEventHandler(onRawUpdate, new Raw({
      types: [
        Api.UpdateReadHistoryInbox,
        Api.UpdateReadChannelInbox,
        Api.UpdateReadHistoryOutbox,
        Api.UpdateReadChannelOutbox,
        Api.UpdateEditMessage,
        Api.UpdateEditChannelMessage,
        Api.UpdateDeleteMessages,
        Api.UpdateDeleteChannelMessages
      ]
    }));
  }

  await loadDialogs();
  setStatus("online");
  loginDone(accountName);
}

function peerTitle(d) {
  return d.title || d.name || (d.entity && d.entity.username) || String(d.id);
}

function isMuted(d) {
  try {
    const ns = d.dialog && d.dialog.notifySettings;
    if (!ns) return false;
    const until = Number(ns.muteUntil || 0);
    return until > Math.floor(Date.now() / 1000);
  } catch (e) {
    return false;
  }
}

function previewText(msg) {
  if (!msg) return "";
  const media = msg.media;
  if (media) {
    const cn = media.className || "";
    if (cn.includes("Photo")) return "[图片]";
    if (cn.includes("Document")) return "[文件]";
    if (cn.includes("Geo")) return "[位置]";
    if (cn.includes("Contact")) return "[联系人]";
    if (cn.includes("Poll")) return "[投票]";
    if (cn.includes("WebPage")) return msg.message || "[链接]";
    return "[媒体]";
  }
  const t = msg.message || msg.text || "";
  return String(t).replace(/\s+/g, " ").slice(0, 160);
}

async function loadDialogs() {
  const dialogs = await client.getDialogs({ limit: 30 });

  // 服务器返回顺序即官方客户端顺序（置顶在前），保留为数组原序
  chats = dialogs.filter(d => d && d.entity).map(d => {
    const msg = d.message;
    const title = peerTitle(d);
    return {
      id: String(d.id),
      title,
      username: (d.entity && d.entity.username) || "",
      unread: d.unreadCount || 0,
      muted: isMuted(d),
      pinned: !!(d.dialog && d.dialog.pinned),
      lastMsgId: msg ? msg.id : 0,
      last: msg ? { text: previewText(msg), date: (msg.date || 0) * 1000, out: !!msg.out } : null,
      messages: msg ? [{ who: msg.out ? "你" : shortName(title), text: previewText(msg), out: !!msg.out }] : [],
      photo: null,
      _entity: d.entity
    };
  });

  pushState();
  hydrateAvatars();
}

function shortName(title) {
  const s = String(title || "").trim();
  if (!s) return "";
  return s.length > 4 ? s.slice(0, 4) : s;
}

let avatarRunning = false;
async function hydrateAvatars() {
  if (avatarRunning) return;
  avatarRunning = true;
  for (const c of chats) {
    if (!c._entity || c.photo) continue;
    try {
      const buf = await client.downloadProfilePhoto(c._entity, { isBig: false });
      if (buf && buf.length) {
        c.photo = "data:image/jpeg;base64," + Buffer.from(buf).toString("base64");
        pushState();
      }
    } catch (e) {}
  }
  avatarRunning = false;
}

async function onNewMessage(event) {
  const m = event.message;
  if (!m || !m.chatId) return;

  const id = String(m.chatId);
  let c = chats.find(x => x.id === id);

  if (!c) {
    try { await loadDialogs(); } catch (e) {}
    c = chats.find(x => x.id === id);
    if (!c) return;
  }

  const text = previewText(m);
  c.last = { text, date: (m.date || 0) * 1000, out: !!m.out };
  c.lastMsgId = m.id;
  c.messages = (c.messages || []).concat([{ who: m.out ? "你" : shortName(c.title), text, out: !!m.out }]).slice(-6);

  if (!m.out) c.unread = (c.unread || 0) + 1;

  // TDLib 式顺序：置顶会话永远在前；新消息的会话提到置顶区之后的第一个非置顶位
  const rest = chats.filter(x => x !== c);
  const pinCount = rest.findIndex(x => !x.pinned);
  const at = pinCount < 0 ? rest.length : pinCount;
  chats = rest.slice(0, at).concat([c], rest.slice(at));
  pushState();

  if (m.out) return;

  // 规则：不在关注名单的会话不打扰
  if (!isWatched(id)) return;

  // 规则：机器人会话自动已读
  if (config.settings.autoReadBots && c._entity && c._entity.bot) {
    try { await markRead(id); } catch (e) {}
    return;
  }

  // 规则：免打扰 / 仅点名 / 关键词，决定是否提醒
  if (!shouldAlert(c, m)) return;

  if (hudWin && !hudWin.isDestroyed()) {
    hudWin.webContents.send("tg:event", { type: "flash", chatId: id });
  }

  // 系统通知
  if (config.settings.notify && Notification.isSupported()) {
    const title = (c.title || "Telegram") + (c.unread > 1 ? "（" + c.unread + "）" : "");
    try {
      const n = new Notification({
        title,
        body: text || "新消息",
        silent: !config.settings.sound,
        timeoutType: "default"
      });
      n.on("click", () => openChatById(id));
      n.show();
    } catch (e) {}
  }

  updateBadge();
}

/* ---------- 非 Telegram 来源的系统通知 ---------- */
function notifyExternal(item) {
  updateBadge();
  if (!config.settings.notify || !Notification.isSupported()) return;
  if (isDndNow()) return;
  if ((config.settings.muteUntil || 0) > Date.now()) return;
  // 「只提醒被点名」对外部来源的近似：没被打上高亮标记就不弹
  if (config.settings.mentionOnly && !item.highlight) return;

  const prefix = item.sourceName ? item.sourceName + " · " : "";
  try {
    const n = new Notification({
      title: prefix + (item.title || "新消息"),
      body: item.text || "新消息",
      silent: !config.settings.sound,
      timeoutType: "default"
    });
    n.on("click", () => {
      if (item.link) {
        shell.openExternal(item.link).catch(() => {});
      } else if (hudWin && !hudWin.isDestroyed()) {
        hudWin.showInactive();
      }
    });
    n.show();
  } catch (e) {}
}

/* ---------- 未读角标 ---------- */
function updateBadge() {
  if (!config.settings.badge) { app.setBadgeCount && app.setBadgeCount(0); return; }
  const tgTotal = chats.reduce((n, c) => n + (c.unread || 0), 0);
  const feedTotal = sourceMgr.list().reduce((n, f) => n + (f.unread || 0), 0);
  try { if (app.setBadgeCount) app.setBadgeCount(tgTotal + feedTotal); } catch (e) {}
}

/* ==========================================================
   原始更新：以服务器为准校正本地状态
   （TDLib 的核心思路——不要自己累加未读，等服务器告诉你）
   ========================================================== */

function peerIdVariants(peer) {
  const out = [];
  if (!peer) return out;
  if (peer.userId != null) out.push(String(peer.userId));
  if (peer.chatId != null) out.push(String(peer.chatId));
  if (peer.channelId != null) {
    out.push(String(peer.channelId));
    out.push(String(-1000000000000 - Number(peer.channelId)));
  }
  return out;
}

function chatByAnyId(ids) {
  const set = new Set(ids.map(String));
  return chats.find(c => set.has(String(c.id)) || (c._entity && set.has(String(c._entity.id))));
}

function onRawUpdate(update) {
  if (!update) return;
  const cn = update.className;

  try {
    // 在别的设备上读了消息 → 未读清零或递减
    if (cn === "UpdateReadHistoryInbox" || cn === "UpdateReadChannelInbox") {
      const c = chatByAnyId(peerIdVariants(update.peer).concat(String(update.channelId || "")));
      if (c && typeof update.stillUnread === "number") {
        c.unread = Math.max(0, update.stillUnread);
        pushState();
        updateBadge();
      }
      return;
    }

    // 对方读了我发的消息
    if (cn === "UpdateReadHistoryOutbox" || cn === "UpdateReadChannelOutbox") {
      const c = chatByAnyId(peerIdVariants(update.peer).concat(String(update.channelId || "")));
      if (c) c.readOut = Math.max(c.readOut || 0, update.maxId || 0);
      return;
    }

    // 消息被编辑 → 更新摘要
    if (cn === "UpdateEditMessage" || cn === "UpdateEditChannelMessage") {
      const m = update.message;
      if (!m || !m.chatId) return;
      const c = chatByAnyId([String(m.chatId)]);
      if (c && m.id === c.lastMsgId) {
        c.last = { text: previewText(m), date: (m.date || 0) * 1000, out: !!m.out };
        const last = (c.messages || [])[c.messages.length - 1];
        if (last) last.text = previewText(m);
        pushState();
      }
      return;
    }

    // 消息被删除 → 如果删的是最后一条，重新拉一次会话列表
    if (cn === "UpdateDeleteMessages" || cn === "UpdateDeleteChannelMessages") {
      const ids = update.messages || [];
      if (chats.some(c => ids.includes(c.lastMsgId))) {
        loadDialogs().catch(() => {});
      }
      return;
    }

    // 会话被对方清空
    if (cn === "UpdateChannelTooLong" || cn === "UpdateNotifySettings") {
      return;
    }
  } catch (e) {}
}

/* ==========================================================
   IPC
   ========================================================== */

ipcMain.handle("tg:get-state", () => publicState());

async function openChatById(id) {
  const c = chats.find(x => x.id === String(id));
  let url;
  if (c && c.username) url = "https://t.me/" + c.username;
  else url = "tg://openmessage?chat_id=" + id + (c && c.lastMsgId ? "&message_id=" + c.lastMsgId : "");

  try { await shell.openExternal(url); } catch (e) {}

  if (c) { c.unread = 0; pushState(); updateBadge(); }
  return true;
}

ipcMain.handle("tg:open", (_e, id) => openChatById(id));

ipcMain.on("tg:login", () => openLogin());

/* ---------- 挂件内动作：回复 / 表情 / 已读 ---------- */

async function findPeer(id) {
  const c = chats.find(x => x.id === String(id));
  return c && c._entity ? c._entity : null;
}

ipcMain.handle("tg:send", async (_e, { id, text }) => {
  if (!client) throw new Error("未连接");
  const entity = await findPeer(id);
  if (!entity) throw new Error("找不到会话");
  const t = String(text || "").trim();
  if (!t) throw new Error("内容为空");
  const msg = await client.sendMessage(entity, { message: t });
  // 本地立即回显
  const c = chats.find(x => x.id === String(id));
  if (c) {
    c.last = { text: t, date: Date.now(), out: true };
    c.messages = (c.messages || []).concat([{ who: "你", text: t, out: true }]).slice(-6);
    pushState();
  }
  return { ok: true, id: msg.id };
});

ipcMain.handle("tg:react", async (_e, { id, emoji }) => {
  if (!client) throw new Error("未连接");
  const c = chats.find(x => x.id === String(id));
  if (!c || !c._entity) throw new Error("找不到会话");
  const msgId = c.lastMsgId || (c.last && c.last.msgId) || 0;
  if (!msgId) throw new Error("暂无可回应的消息");
  const peer = await client.getInputEntity(c._entity);
  await client.invoke(new Api.messages.SendReaction({
    peer, msgId, reaction: [new Api.ReactionEmoji({ emoticon: String(emoji) })]
  }));
  return { ok: true };
});

async function markRead(id) {
  if (!client) throw new Error("未连接");
  const c = chats.find(x => x.id === String(id));
  if (!c || !c._entity) throw new Error("找不到会话");
  const peer = await client.getInputEntity(c._entity);
  await client.invoke(new Api.messages.ReadHistory({ peer, maxId: c.lastMsgId || 0 }));
  c.unread = 0;
  pushState();
  updateBadge();
}

ipcMain.handle("tg:read", (_e, id) => markRead(id));

/* ---------- 多来源：读取 / 回复 / 打开 ---------- */

ipcMain.handle("tg:feed-read", async (_e, { sid, key }) => {
  if (sid === "telegram") {
    try { await markRead(key); return true; } catch (e) { return false; }
  }
  const ok = await sourceMgr.markRead(sid, key);
  if (ok) { pushState(); updateBadge(); }
  return ok;
});

ipcMain.handle("tg:feed-send", async (_e, { sid, key, text }) => {
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "内容为空" };
  if (sid === "telegram") {
    if (!client) return { ok: false, error: "Telegram 未连接" };
    const entity = await findPeer(key);
    if (!entity) return { ok: false, error: "找不到会话" };
    await client.sendMessage(entity, { message: t });
    return { ok: true };
  }
  const ok = await sourceMgr.send(sid, key, t);
  if (ok) pushState();
  return { ok, error: ok ? "" : "该来源暂不支持发送，或发送失败" };
});

ipcMain.handle("tg:feed-open", async (_e, { sid, key }) => {
  if (sid === "telegram") return openChatById(key);
  const item = sourceMgr.list().find((f) => f.sid === sid && f.key === String(key));
  if (item && item.link) {
    try { await shell.openExternal(item.link); } catch (e) {}
  }
  await sourceMgr.markRead(sid, key);
  pushState();
  return true;
});

/* ---------- 多来源：配置 ---------- */

ipcMain.handle("tg:sources-get", () => config.sources);

ipcMain.handle("tg:sources-set", async (_e, patch) => {
  const next = Object.assign({}, config.sources, patch || {});
  config.sources = mergeSources(next);
  saveConfig();
  await sourceMgr.apply(config.sources);
  pushState();
  updateBadge();
  return config.sources;
});

ipcMain.handle("tg:sources-restart", async (_e, sid) => {
  await sourceMgr.restart(sid);
  pushState();
  return true;
});

/** 试连：临时建一个实例，跑几秒看能不能拿到 online，然后销毁 */
ipcMain.handle("tg:sources-test", async (_e, { sid, cfg }) => {
  if (!CTORS[sid]) return { ok: false, error: "该来源暂不支持接收消息" };
  let lastStatus = "idle";
  let lastErr = "";
  const src = new CTORS[sid](sid, cfg, (ev) => {
    if (ev.kind === "status") { lastStatus = ev.status; lastErr = ev.error || ""; }
  });
  try {
    await src.start();
    await new Promise((r) => setTimeout(r, 2200));
    return { ok: lastStatus === "online", status: lastStatus, error: lastErr };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { await src.stop(); } catch (e) {}
  }
});

/* ---------- 设置 ---------- */

ipcMain.handle("tg:get-settings", () => config.settings);

ipcMain.handle("tg:set-settings", (_e, patch) => {
  const prev = JSON.stringify({ autoLaunch: config.settings.autoLaunch, side: config.settings.side });
  config.settings = Object.assign({}, config.settings, patch || {});
  if (patch && patch.dnd) {
    config.settings.dnd = Object.assign({}, DEFAULT_SETTINGS.dnd, config.settings.dnd, patch.dnd);
  }
  saveConfig();
  applySettings(prev);
  pushState();
  return config.settings;
});

// 应用需要主进程执行的外观/系统设置
function applySettings(prevJson) {
  const s = config.settings;
  let prev = {};
  try { prev = JSON.parse(prevJson || "{}"); } catch (e) {}
  // 开机自启
  if (prev.autoLaunch !== s.autoLaunch) {
    try { app.setLoginItemSettings({ openAtLogin: !!s.autoLaunch }); } catch (e) {}
  }
  // 贴边换位
  if (prev.side && prev.side !== s.side && hudWin && !hudWin.isDestroyed()) {
    try {
      const b = hudWin.getBounds();
      const { workArea } = screen.getPrimaryDisplay();
      const x = s.side === "left" ? workArea.x : workArea.x + workArea.width - b.width;
      hudWin.setBounds({ x, y: b.y, width: b.width, height: b.height });
    } catch (e) {}
  }
  // 透明度 / 贴边由渲染层应用；角标立即刷新
  updateBadge();
}

ipcMain.handle("tg:export", () => JSON.stringify(config, null, 2));
ipcMain.handle("tg:import", (_e, json) => {
  const raw = JSON.parse(String(json || "{}"));
  const savedSettings = raw.settings || {};
  delete raw.settings;
  config = Object.assign(config, raw);
  config.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
  saveConfig();
  pushState();
  return config.settings;
});

ipcMain.on("tg:mode", (_e, m) => {
  if (!hudWin || hudWin.isDestroyed()) return;
  // 展开成列表时窗口需要更宽一点，卡片区域仍在
  hudWin.setBounds(Object.assign({}, hudWin.getBounds(), { width: HUD_W }));
});

ipcMain.on("tg:ignore", (_e, ignore) => {
  if (!hudWin || hudWin.isDestroyed()) return;
  hudWin.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.on("tg:menu", () => {
  if (!hudWin || hudWin.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: "打开 Telegram 登录", click: () => openLogin() },
    { label: "重新连接", click: () => { handlerAttached = false; connectWithLogin(); } },
    { type: "separator" },
    { label: "退出挂件", click: () => app.quit() }
  ]);
  menu.popup({ window: hudWin });
});

/* ---------- 登录窗口 ---------- */

ipcMain.on("login:start", async (_e, p) => {
  config.apiId = Number(p.apiId) || 0;
  config.apiHash = String(p.apiHash || "").trim();
  config.session = "";
  if (p.proxy) {
    config.proxy = Object.assign(
      { enabled: false, type: "socks5", host: "", port: 0, secret: "" }, p.proxy);
  }
  saveConfig();
  await connectWithLogin();
});

ipcMain.on("login:submit", (_e, payload) => {
  const w = waiters[payload.kind];
  if (w) {
    delete waiters[payload.kind];
    w(payload.value);
  }
});

ipcMain.handle("login:get-state", () => authState);

ipcMain.on("login:close", () => {
  if (loginWin && !loginWin.isDestroyed()) loginWin.close();
});

ipcMain.on("login:open", (_e, url) => {
  shell.openExternal(url).catch(() => {});
});

// 向导里的说明面板展开/收起时，让窗口跟着变高变矮（保持垂直居中）
ipcMain.on("login:resize", (_e, target) => {
  if (!loginWin || loginWin.isDestroyed()) return;
  const h = Math.round(Number(target) || 0);
  if (h < 320) return;
  const b = loginWin.getBounds();
  const maxH = Math.round((screen.getDisplayMatching(b).workAreaSize.height || 900) - 80);
  const nextH = Math.min(Math.max(h, 420), maxH);
  if (Math.abs(nextH - b.height) < 4) return;
  const y = Math.round(b.y + (b.height - nextH) / 2);
  loginWin.setBounds({ x: b.x, y, width: b.width, height: nextH }, true);
});

/* ==========================================================
   LINE 配置向导
   ========================================================== */

ipcMain.on("tg:line-setup", () => openLineSetup());

ipcMain.on("line-setup:close", () => {
  if (lineSetupWin && !lineSetupWin.isDestroyed()) lineSetupWin.close();
});

ipcMain.on("line-setup:resize", (_e, target) => {
  if (!lineSetupWin || lineSetupWin.isDestroyed()) return;
  const h = Math.round(Number(target) || 0);
  if (h < 380) return;
  const b = lineSetupWin.getBounds();
  const maxH = Math.round((screen.getDisplayMatching(b).workAreaSize.height || 900) - 80);
  const nextH = Math.min(Math.max(h, 480), maxH);
  if (Math.abs(nextH - b.height) < 4) return;
  const y = Math.round(b.y + (b.height - nextH) / 2);
  lineSetupWin.setBounds({ x: b.x, y, width: b.width, height: nextH }, true);
});

ipcMain.handle("linesetup:get-cfg", () => {
  const c = config.sources && config.sources.line || {};
  return {
    enabled: !!c.enabled,
    relay: c.relay || "",
    relayToken: c.relayToken || "",
    token: c.token || ""
  };
});

ipcMain.handle("linesetup:save", async (_e, cfg) => {
  try {
    cfg = cfg || {};
    config.sources.line = Object.assign(
      { enabled: false, relay: "", relayToken: "", token: "" },
      config.sources.line || {},
      {
        enabled: !!cfg.enabled,
        relay: String(cfg.relay || "").trim().replace(/\/+$/, ""),
        relayToken: String(cfg.relayToken || "").trim(),
        token: String(cfg.token || "").trim()
      }
    );
    saveConfig();
    await sourceMgr.apply(config.sources).catch(() => {});
    pushState();
    return true;
  } catch (e) {
    return false;
  }
});

/** 测中转：GET {url}/pull?token=xxx —— 200 通、401 口令错、其他按错误处理 */
ipcMain.handle("linesetup:test-relay", async (_e, url, token) => {
  const u = String(url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) return { ok: false, msg: "地址要以 https:// 开头" };
  try {
    const res = await fetchWithTimeout(
      u + "/pull?token=" + encodeURIComponent(String(token || "")),
      {}, 12000
    );
    if (res.status === 200) return { ok: true, msg: "中转可达，口令正确" };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, msg: "地址是对的，但口令不对——Worker 代码里的 ACCESS_TOKEN 要和这里的中转口令一模一样" };
    }
    return { ok: false, msg: "地址能连上但返回异常（HTTP " + res.status + "）——确认部署的是 tools/line-worker.js 的完整代码" };
  } catch (e) {
    const m = String(e && e.message || e);
    if (/abort/i.test(m)) return { ok: false, msg: "请求超时——地址可能没部署好，检查 Workers 页面有没有 Deploy 成功" };
    return { ok: false, msg: "连不上这个地址（" + (m.split("\n")[0] || "网络错误") + "）——检查地址拼写和 KV 绑定" };
  }
});

/** 测官方账号 Token：GET /v2/bot/info */
ipcMain.handle("linesetup:test-token", async (_e, token) => {
  const t = String(token || "").trim();
  if (!t) return { ok: false, msg: "先填 Token" };
  try {
    const res = await fetchWithTimeout("https://api.line.me/v2/bot/info", {
      headers: { "Authorization": "Bearer " + t }
    }, 12000);
    if (res.status === 200) {
      const j = await res.json().catch(() => null);
      const name = j && j.displayName || "";
      const id = j && j.basicId || "";
      return { ok: true, msg: "验证通过：官方账号 " + name + (id ? "（" + id + "）" : "") };
    }
    if (res.status === 401) return { ok: false, msg: "Token 无效或已过期——回 Messaging API 页面重新 Issue 一个（选长期）" };
    return { ok: false, msg: "LINE 返回异常（HTTP " + res.status + "）" };
  } catch (e) {
    const m = String(e && e.message || e);
    if (/abort/i.test(m)) return { ok: false, msg: "请求超时，检查网络或代理" };
    return { ok: false, msg: "连不上 api.line.me，检查网络或代理" };
  }
});

/** 自动设置 Webhook URL（PUT /v2/bot/channel/webhook/endpoint），省去手动填 */
ipcMain.handle("linesetup:set-webhook", async (_e, token, relayUrl) => {
  const t = String(token || "").trim();
  const u = String(relayUrl || "").trim().replace(/\/+$/, "");
  if (!t) return { ok: false, msg: "Token 还没填" };
  if (!u) return { ok: false, msg: "Worker 地址还没填" };
  try {
    const res = await fetchWithTimeout("https://api.line.me/v2/bot/channel/webhook/endpoint", {
      method: "PUT",
      headers: { "Authorization": "Bearer " + t, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: u + "/webhook" })
    }, 12000);
    if (res.status === 200) {
      return { ok: true, msg: "已自动把 Webhook URL 设为 " + u + "/webhook —— 剩下只需去控制台打开 Use webhook 开关" };
    }
    if (res.status === 401) return { ok: false, msg: "Token 失效，重新签发后再试" };
    return { ok: false, msg: "设置失败（HTTP " + res.status + "）——也可以手动到控制台把 Webhook URL 填成 " + u + "/webhook" };
  } catch (e) {
    return { ok: false, msg: "网络错误，检查网络或代理后重试；也可以手动到控制台填 Webhook URL" };
  }
});

/* ==========================================================
   托盘 + 全局快捷键
   ========================================================== */

// 单实例：重复启动时唤出已有挂件
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on("second-instance", () => toggleHud());

const TRAY_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAyUlEQVR4nO1WwRGDMAyjHAuUMeg6dMp2nTIGjED/YEuWCQ+O6JnYkhL74jRNxd3xyCQNn3n19qZ3L3FKwUg4ayQUpAirRtozxSP50MBR8QiPa6CUOOPrsoS/8blbe30Xmce8AXZ6SxytI17ahKoI26cG0Omj5Chuyx++AfVk0Xi5BKVRDVzHgPrIRON3BtD0ipKiuC2/XAJmQr0p0wCb4Z4IE7d408MoM3gsuCVQ/3YMHh/sgVImEA9twqMmWP41fsWKkdK9U3E6/qpVWPjnnb6IAAAAAElFTkSuQmCC";

let tray = null;

function trayMenu() {
  const dndOn = isDndNow();
  const muted = config.settings.muteUntil && Date.now() < config.settings.muteUntil;
  return Menu.buildFromTemplate([
    { label: "显示 / 隐藏挂件", click: () => toggleHud() },
    { label: muted ? "取消一键静音" : "静音 1 小时", click: () => toggleMuteHour() },
    { label: "打开 Telegram 登录", click: () => openLogin() },
    { label: "重新连接", click: () => { handlerAttached = false; connectWithLogin(); } },
    { type: "separator" },
    { label: "退出挂件", click: () => app.quit() }
  ]);
}

function createTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromDataURL(TRAY_ICON);
    tray = new Tray(img);
    tray.setToolTip("Telegram HUD");
    tray.setContextMenu(trayMenu());
    tray.on("click", () => toggleHud());
  } catch (e) {}
}

function toggleHud() {
  if (!hudWin || hudWin.isDestroyed()) return;
  if (hudWin.isVisible()) hudWin.hide();
  else hudWin.show();
}

function toggleMuteHour() {
  if (config.settings.muteUntil && Date.now() < config.settings.muteUntil) {
    config.settings.muteUntil = 0;
  } else {
    config.settings.muteUntil = Date.now() + 3600e3;
  }
  saveConfig();
  if (tray) tray.setContextMenu(trayMenu());
  pushState();
}

function registerShortcuts() {
  try {
    globalShortcut.register("CommandOrControl+Shift+T", () => toggleHud());
    globalShortcut.register("CommandOrControl+Shift+D", () => toggleMuteHour());
  } catch (e) {}
}

/* ==========================================================
   启动
   ========================================================== */

const bootTrace = (m) => { if (process.env.TG_BOOT_TRACE) console.log("[boot]", m); };

app.whenReady().then(async () => {
  bootTrace("ready");
  loadConfig();
  bootTrace("config loaded");
  if (process.platform === "darwin" && app.dock) {
    try { app.dock.hide(); } catch (e) {}
  }

  createHud();
  bootTrace("hud created");
  // e2e/截图：自动打开 LINE 配置向导窗口
  if (process.env.LINE_SHOT) setTimeout(() => openLineSetup(), 200);
  createTray();
  bootTrace("tray created");
  registerShortcuts();
  bootTrace("shortcuts registered");
  applySettings("{}");
  bootTrace("settings applied");

  // 先把上次的会话读到内存（TDLib 式冷启动），窗口就绪即渲染，网络连上后覆盖
  readCache();
  bootTrace("cache read");

  // 外部来源独立于 Telegram 启动：只订阅 RSS 的人不该被登录框拦住
  sourceMgr.apply(config.sources).catch(() => {});
  bootTrace("sources applied");

  const hasExternal = Object.keys(config.sources).some(
    (k) => k !== "telegram" && config.sources[k] && config.sources[k].enabled
  );

  if (!config.apiId || !config.apiHash) {
    if (!hasExternal) setTimeout(() => openLogin(), 600);
    setStatus("auth-needed");
    bootTrace("auth-needed, done");
    return;
  }

  bootTrace("connecting telegram");
  setStatus("connecting");
  await connectWithLogin();
});

let quitting = false;
app.on("will-quit", (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  try { globalShortcut.unregisterAll(); } catch (err) {}
  // 给各来源 1.5 秒收尾（断开 WebSocket / 登出 IMAP），超时直接退
  Promise.race([
    sourceMgr.stopAll(),
    new Promise((r) => setTimeout(r, 1500))
  ]).finally(() => app.exit(0));
});

app.on("window-all-closed", () => app.quit());
