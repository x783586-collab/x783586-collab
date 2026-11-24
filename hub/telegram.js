"use strict";

/**
 * Hub 端 Telegram 采集器（GramJS / MTProto）
 * ---------------------------------------------------------------
 * 与单端版不同：这里登录一次，session 存在 Hub；所有端共享同一账号视图。
 * 复用现有 main.js 的事件模型，但把状态写入统一 Store（通过 emit）。
 *
 * 登录走 HTTP 状态机：idle → wait-phone → wait-code → wait-password → ready|fail
 */

const path = require("path");
let TelegramClient, StringSession, Api, NewMessage, Raw;
try {
  const TG_DIR = path.join(__dirname, "../electron/node_modules/telegram");
  ({ TelegramClient, StringSession, Api } = require(TG_DIR));
  ({ NewMessage } = require(path.join(TG_DIR, "events/NewMessage")));
  ({ Raw } = require(path.join(TG_DIR, "events/Raw")));
} catch (e) {
  console.error("[tg] GramJS 未安装:", e.message);
}

const SID = "telegram";

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
    return "[媒体]";
  }
  return String(msg.message || msg.text || "").replace(/\s+/g, " ").slice(0, 160);
}

function shortName(title) {
  const s = String(title || "").trim();
  return s.length > 4 ? s.slice(0, 4) : s;
}

class TelegramCollector {
  constructor(emit, cfg) {
    this.emit = emit;
    this.cfg = cfg;          // { apiId, apiHash, session, proxy }
    this.client = null;
    this.chats = new Map();  // id -> {entity, pinned, title}
    this.step = "idle";
    this.error = "";
    this.phone = "";
    this.waiter = null;      // 等待用户输入的 Promise resolver
    this.stopped = false;
    this.reconnectTimer = null;
  }

  status(status, error) {
    this.emit({ kind: "status", sid: SID, status, error: error || "" });
  }

  authState() {
    return { step: this.step, phone: this.phone, error: this.error };
  }

  /** HTTP 端提交电话号码/验证码/密码，唤醒等待中的 start() */
  submit(value) {
    if (this.waiter) {
      const fn = this.waiter;
      this.waiter = null;
      fn(String(value || ""));
      return true;
    }
    return false;
  }

  ask(step, hint) {
    this.step = step;
    if (hint !== undefined) this.phone = String(hint);
    this.error = "";
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  makeClient() {
    const opts = { connectionRetries: 5 };
    const p = this.cfg.proxy;
    if (p && p.enabled && p.host && p.port) {
      opts.proxy = p.type === "http"
        ? { ip: p.host, port: Number(p.port), username: p.secret || "", password: "" }
        : { ip: p.host, port: Number(p.port), secret: p.secret || "" };
    }
    return new TelegramClient(new StringSession(this.cfg.session || ""), Number(this.cfg.apiId), this.cfg.apiHash, opts);
  }

  async start() {
    if (!TelegramClient || !this.cfg.apiId || !this.cfg.apiHash) {
      this.status("error", "未配置 apiId/apiHash");
      return;
    }
    this.stopped = false;
    this.step = "connecting";
    this.status("connecting");
    try {
      this.client = this.makeClient();
      await this.client.connect();
      const ok = await this.client.checkAuthorization();
      if (!ok) {
        await this.client.start({
          phoneNumber: async () => this.ask("wait-phone"),
          phoneCode: async () => this.ask("wait-code"),
          password: async () => this.ask("wait-password"),
          onError: (e) => {
            this.error = String(e && e.message || e);
            if (this.waiter) { const fn = this.waiter; this.waiter = null; fn("__CANCEL__"); }
          }
        });
      }
      // 登录成功，回写 session（回调让 Hub 持久化）
      this.cfg.session = this.client.session.save();
      if (this.emit) this.emit({ kind: "session", sid: SID, session: this.cfg.session });

      const me = await this.client.getMe();
      this.emit({ kind: "me", name: [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "我" });

      this.client.addEventHandler((e) => this.onNewMessage(e), new NewMessage({}));
      this.client.addEventHandler((e) => this.onRaw(e), new Raw({
        types: ["UpdateReadHistoryInbox", "UpdateReadChannelInbox", "UpdateEditMessage", "UpdateDeleteMessages"]
          .map((n) => Api[n]).filter(Boolean)
      }));

      this.step = "ready";
      await this.loadDialogs();
      this.status("online");
    } catch (e) {
      const msg = String(e && e.message || e);
      if (msg === "__CANCEL__") {
        this.step = "fail";
        this.status("error", this.error || "登录失败");
        return;
      }
      this.step = "fail";
      this.error = msg;
      this.status("error", msg);
      // 网络类错误退避重连；登录信息缺失不重连
      if (!/apiId|apiHash|password|code|phone/i.test(msg)) {
        this.reconnectTimer = setTimeout(() => { if (!this.stopped) this.start(); }, 10000);
      }
    }
  }

  async loadDialogs() {
    const dialogs = await this.client.getDialogs({ limit: 40 });
    this.chats.clear();
    const items = [];
    for (const d of dialogs) {
      if (!d || !d.entity) continue;
      const title = d.title || d.name || (d.entity && d.entity.username) || String(d.id);
      const id = String(d.id);
      const msg = d.message;
      this.chats.set(id, { entity: d.entity, pinned: !!(d.dialog && d.dialog.pinned), title });
      items.push({
        sid: SID,
        key: id,
        title,
        subtitle: title,
        text: msg ? previewText(msg) : "",
        date: msg ? (msg.date || 0) * 1000 : 0,
        unread: d.unreadCount || 0,
        muted: false,
        pinned: !!(d.dialog && d.dialog.pinned),
        messages: msg ? [{ who: msg.out ? "你" : shortName(title), text: previewText(msg), out: !!msg.out }] : [],
        canReply: true,
        sourceName: "Telegram",
        color: "#2aabee"
      });
    }
    this.emit({ kind: "items-reset", sid: SID, items });
    this.hydrateAvatars();
  }

  async hydrateAvatars() {
    for (const [id, c] of this.chats) {
      if (!c.entity || c.avatarDone) continue;
      c.avatarDone = true;
      try {
        const buf = await this.client.downloadProfilePhoto(c.entity, { isBig: false });
        if (buf && buf.length) {
          this.emit({
            kind: "item-patch", sid: SID, key: id,
            patch: { photo: "data:image/jpeg;base64," + Buffer.from(buf).toString("base64") }
          });
        }
      } catch (e) {}
    }
  }

  async onNewMessage(event) {
    const m = event.message;
    if (!m || !m.chatId) return;
    const id = String(m.chatId);
    const c = this.chats.get(id);
    if (!c) { try { await this.loadDialogs(); } catch (e) {} return; }
    const text = previewText(m);
    this.emit({
      kind: "message", sid: SID, key: id,
      msg: { who: m.out ? "你" : shortName(c.title), text, out: !!m.out, date: (m.date || 0) * 1000, id: m.id },
      meta: { title: c.title, subtitle: c.title, pinned: c.pinned, canReply: true, sourceName: "Telegram", color: "#2aabee" }
    });
  }

  async onRaw(event) {
    // 已读回执：服务器权威校正，避免多端状态漂移
    try {
      const e = event;
      let id = null;
      if (e.chat && e.chat.id !== undefined) id = String(e.chat.id);
      else if (e.peer && e.peer.channelId) id = String(e.peer.channelId);
      if (id && this.chats.has(id)) {
        this.emit({ kind: "read-external", sid: SID, key: id });
      }
    } catch (err) {}
  }

  async markRead(key) {
    const c = this.chats.get(String(key));
    if (!c || !this.client) return false;
    try {
      await this.client.invoke(new Api.messages.ReadHistory({ peer: c.entity, maxId: 0 }));
      return true;
    } catch (e) { return false; }
  }

  async send(key, text) {
    const c = this.chats.get(String(key));
    if (!c || !this.client) return false;
    try {
      await this.client.sendMessage(c.entity, { message: String(text).slice(0, 4000) });
      return true;
    } catch (e) { return false; }
  }

  openLink(key) {
    const c = this.chats.get(String(key));
    if (c && c.entity && c.entity.username) return "https://t.me/" + c.entity.username;
    return "tg://openmessage?user_id=" + key;
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.client) { try { this.client.destroy(); } catch (e) {} this.client = null; }
  }
}

module.exports = { TelegramCollector };
