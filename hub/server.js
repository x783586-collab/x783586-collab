"use strict";

/**
 * tg-hub —— 三平台多端同步中心服务
 * ---------------------------------------------------------------
 * 职责：
 *   1. 单点采集 Telegram / SafeXTM / LINE（避免 getUpdates/webhook 多端冲突）
 *   2. 持有权威状态（Store），对外 REST + SSE 供桌面/手机多端读写
 *   3. 已读/回复经 Hub 回写平台，再广播给所有端 —— 多端一致的核心
 *
 * 启动：node server.js [--port 8787] [--config ./config.json]
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { Store } = require("./store");
const { TelegramCollector } = require("./telegram");
const { SafeXTMCollector } = require("./safextm");
const { LineCollector } = require("./line");

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const PORT = Number(arg("--port", process.env.HUB_PORT || 8787));
const CONFIG_FILE = path.resolve(arg("--config", process.env.HUB_CONFIG || path.join(__dirname, "config.json")));
const STATE_FILE = path.resolve(arg("--state", process.env.HUB_STATE || path.join(__dirname, "state.json")));

/* ---------- 配置（凭证只存 Hub，不下发到各端） ---------- */
const DEFAULT_CONFIG = {
  hubToken: "change-me",                 // 各端连接口令
  telegram: { apiId: 0, apiHash: "", session: "", proxy: { enabled: false, type: "socks5", host: "", port: 0, secret: "" } },
  safextm: { token: "" },
  line: { token: "", secret: "", relayToken: "" }
};

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return {
      hubToken: saved.hubToken || DEFAULT_CONFIG.hubToken,
      telegram: Object.assign({}, DEFAULT_CONFIG.telegram, saved.telegram || {}, {
        proxy: Object.assign({}, DEFAULT_CONFIG.telegram.proxy, (saved.telegram || {}).proxy || {})
      }),
      safextm: Object.assign({}, DEFAULT_CONFIG.safextm, saved.safextm || {}),
      line: Object.assign({}, DEFAULT_CONFIG.line, saved.line || {})
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
const store = new Store(STATE_FILE);

/* ---------- 采集器 ---------- */
let tg, sx, ln;

function onCollectorEvent(ev) {
  switch (ev.kind) {
    case "status":
      store.setSource(ev.sid, ev.status, ev.error);
      break;
    case "me":
      store.setMe(ev.name);
      break;
    case "session":
      config.telegram.session = ev.session;
      saveConfig(config);
      break;
    case "item":
      store.applyItem(ev.item);
      break;
    case "items-reset":
      // 全量替换某来源：先移除旧的，再逐条写入（只在最后一次广播）
      for (const k of Object.keys(store.items)) {
        if (store.items[k].sid === ev.sid) delete store.items[k];
      }
      for (const it of ev.items || []) {
        store.applyItem(it);
      }
      store.setSource(ev.sid, "online");
      break;
    case "item-patch": {
      const it = store.get(ev.sid, ev.key);
      if (it) store.applyItem(Object.assign({}, it, ev.patch));
      break;
    }
    case "message":
      store.pushMessage(ev.sid, ev.key, ev.msg, ev.meta || {});
      break;
    case "read-external":
      store.markRead(ev.sid, ev.key);
      break;
    case "drop":
      store.drop(ev.sid, ev.key);
      break;
  }
}

function startCollectors() {
  stopCollectors();
  tg = new TelegramCollector(onCollectorEvent, config.telegram);
  sx = new SafeXTMCollector(onCollectorEvent, config.safextm);
  ln = new LineCollector(onCollectorEvent, config.line);
  tg.start();
  sx.start();
  ln.start();
}
function stopCollectors() {
  if (tg) tg.stop();
  if (sx) sx.stop();
  if (ln) ln.stop();
}

/* ---------- HTTP 工具 ---------- */
function sendJSON(res, code, data, extraHeaders) {
  const body = JSON.stringify(data);
  res.writeHead(code, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Hub-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  }, extraHeaders || {}));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > (limit || 2 * 1024 * 1024)) { reject(new Error("请求体过大")); req.destroy(); }
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}
function authorized(req, url) {
  const h = (req.headers["x-hub-token"] || req.headers.authorization || "");
  const token = String(h).replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
  return token === String(config.hubToken);
}

/* ---------- SSE 多端推送 ---------- */
const sseClients = new Set();
store.subscribe((evt) => {
  const line = "event: state\ndata: " + JSON.stringify({ rev: evt.rev, kind: evt.kind }) + "\n\n";
  for (const res of sseClients) {
    try { res.write(line); } catch (e) { sseClients.delete(res); }
  }
});

/* ---------- 路由 ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (req.method === "OPTIONS") return sendJSON(res, 204, {});

  // 健康检查（无需鉴权）
  if (p === "/api/ping") return sendJSON(res, 200, { ok: true, rev: store.rev, time: Date.now() });

  // LINE webhook（用频道 secret 验签，不用 hubToken）
  if (p === "/hook/line" && req.method === "POST") {
    const raw = await readBody(req);
    const sig = req.headers["x-line-signature"] || "";
    if (!ln || !ln.verify(raw, sig)) return sendJSON(res, 401, { ok: false, error: "bad signature" });
    try { ln.handleEvents(JSON.parse(raw)); } catch (e) {}
    return sendJSON(res, 200, { ok: true });
  }
  // LINE 手机转发（玩法B，用 relayToken 校验）
  if (p === "/hook/line/notify" && req.method === "POST") {
    const token = url.searchParams.get("token") || "";
    if (!config.line.relayToken || token !== config.line.relayToken) return sendJSON(res, 401, { ok: false, error: "bad token" });
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (e) {}
    const user = String(body.user || body.hudTitle || "LINE 通知").slice(0, 60);
    const text = String(body.text || body.message || "").slice(0, 800);
    if (text) {
      ln.emit({
        kind: "message", sid: SID_LINE, key: "U:" + hashStr(user),
        msg: { who: user, text, out: false, date: Date.now() },
        meta: { title: user, subtitle: "手机转发 · 手机通知", canReply: false, sourceName: "LINE", color: "#06c755", hudTitle: user }
      });
    }
    return sendJSON(res, 200, { ok: true });
  }

  // 以下都需要 hubToken
  if (!authorized(req, url)) return sendJSON(res, 401, { ok: false, error: "unauthorized" });

  // 全量状态（带 rev，端可用 since 判断无变化）
  if (p === "/api/state" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    const snap = store.snapshot();
    if (since && since === snap.rev) return sendJSON(res, 200, { rev: snap.rev, unchanged: true });
    return sendJSON(res, 200, snap);
  }

  // 增量状态：只回传 rev > since 的变更（简化版：全量 items + rev，端自行比对）
  if (p === "/api/changes" && req.method === "GET") {
    return sendJSON(res, 200, store.snapshot());
  }

  // SSE 实时推送
  if (p === "/api/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write("event: hello\ndata: " + JSON.stringify({ rev: store.rev }) + "\n\n");
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  // 标记已读（任一端调用 → Hub 回写平台 → 广播）
  if (p === "/api/read" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const sid = String(b.sid || ""), key = String(b.key || "");
    let ok = false;
    if (sid === "telegram" && tg) ok = await tg.markRead(key);
    else if (sid === "safextm" && sx) ok = await sx.markRead(key);
    else if (sid === "line" && ln) ok = await ln.markRead(key);
    store.markRead(sid, key);
    return sendJSON(res, 200, { ok: true, remote: ok, rev: store.rev });
  }

  // 回复（任一端调用 → Hub 回写平台 → 追加消息 → 广播）
  if (p === "/api/reply" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const sid = String(b.sid || ""), key = String(b.key || ""), text = String(b.text || "");
    if (!text || !sid) return sendJSON(res, 400, { ok: false, error: "missing text/sid" });
    let ok = false;
    if (sid === "telegram" && tg) ok = await tg.send(key, text);
    else if (sid === "safextm" && sx) ok = await sx.send(key, text);
    else if (sid === "line" && ln) ok = await ln.send(key, text);
    if (ok) store.addOutgoing(sid, key, text);
    return sendJSON(res, 200, { ok, rev: store.rev });
  }

  // 统计
  if (p === "/api/totals" && req.method === "GET") return sendJSON(res, 200, store.totals());

  // Telegram 登录状态机（各端都可驱动，手机端可显示"请在桌面完成登录"）
  if (p === "/api/tg/auth" && req.method === "GET") {
    return sendJSON(res, 200, tg ? tg.authState() : { step: "off" });
  }
  if (p === "/api/tg/submit" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const ok = tg ? tg.submit(b.value) : false;
    return sendJSON(res, 200, { ok });
  }
  if (p === "/api/tg/reconnect" && req.method === "POST") {
    if (tg) tg.start();
    return sendJSON(res, 200, { ok: true });
  }

  // 配置：只返回脱敏信息（凭证不下发），保存时合并
  if (p === "/api/config" && req.method === "GET") {
    return sendJSON(res, 200, {
      telegram: { configured: !!(config.telegram.apiId && config.telegram.apiHash), loggedIn: !!config.telegram.session },
      safextm: { configured: !!config.safextm.token },
      line: { configured: !!(config.line.token || config.line.relayToken) }
    });
  }
  // 完整配置（含明文凭证）：仅供本地桌面设置窗回填表单，需 hubToken 鉴权。
  // 普通展示端（HUD/PWA）不要调用这个端点；生产公网部署建议反代层限制到本机。
  if (p === "/api/config/full" && req.method === "GET") {
    return sendJSON(res, 200, JSON.parse(JSON.stringify(config)));
  }
  if (p === "/api/config" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)) || "{}");
    if (b.hubToken) config.hubToken = String(b.hubToken);
    if (b.telegram) {
      const t = b.telegram;
      if (t.apiId !== undefined) config.telegram.apiId = Number(t.apiId) || 0;
      if (t.apiHash !== undefined) config.telegram.apiHash = String(t.apiHash);
      if (t.proxy) config.telegram.proxy = Object.assign({}, config.telegram.proxy, t.proxy);
    }
    if (b.safextm && b.safextm.token !== undefined) config.safextm.token = String(b.safextm.token);
    if (b.line) {
      if (b.line.token !== undefined) config.line.token = String(b.line.token);
      if (b.line.secret !== undefined) config.line.secret = String(b.line.secret);
      if (b.line.relayToken !== undefined) config.line.relayToken = String(b.line.relayToken);
    }
    saveConfig(config);
    startCollectors();
    return sendJSON(res, 200, { ok: true });
  }

  // 打开外部链接（桌面端用，手机端直接 window.open）
  if (p === "/api/reconnect" && req.method === "POST") {
    startCollectors();
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { ok: false, error: "not found" });
}

const SID_LINE = "line";
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/* ---------- 启动 ---------- */
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { sendJSON(res, 500, { ok: false, error: String(e && e.message || e) }); } catch (_) {}
  });
});

server.listen(PORT, () => {
  console.log("[hub] tg-hub listening on http://0.0.0.0:" + PORT);
  console.log("[hub] config: " + CONFIG_FILE);
  console.log("[hub] state:  " + STATE_FILE);
  startCollectors();
});

process.on("SIGINT", () => { stopCollectors(); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { stopCollectors(); server.close(() => process.exit(0)); });

module.exports = { server, store, onCollectorEvent };
