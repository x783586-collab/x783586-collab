"use strict";

/**
 * Hub 端 SafeXTM 采集器（Bot API / getUpdates 单点消费）
 * ---------------------------------------------------------------
 * 关键：getUpdates 是破坏性消费（offset 前进就没了）。多端各自轮询会互相抢消息，
 * 因此只在 Hub 运行一个消费者，所有端读 Hub 的同一份状态 —— 这正是多端同步的重点。
 *
 * 端点：https://api.safew.bot/bot<token>/<method>
 */

const SID = "safextm";
const API_BASE = "https://api.safew.bot/bot";

async function api(token, method, body, longMs) {
  const res = await fetch(API_BASE + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(longMs || 20000)
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error("API 返回无法解析");
  if (!data.ok) {
    const code = data.error_code || res.status;
    if (code === 401) throw Object.assign(new Error("Token 无效"), { authFail: true });
    if (code === 409) throw Object.assign(new Error("Webhook 与长轮询冲突"), { conflict: true });
    throw new Error(data.description || ("HTTP " + code));
  }
  return data.result;
}

class SafeXTMCollector {
  constructor(emit, cfg) {
    this.emit = emit;
    this.cfg = cfg;      // { token }
    this.offset = 0;
    this.looping = false;
    this.stopped = false;
    this.names = new Map();
    this.botName = "";
    this.retryTimer = null;
  }

  status(status, error) {
    this.emit({ kind: "status", sid: SID, status, error: error || "" });
  }

  token() { return String(this.cfg.token || "").trim(); }

  async start() {
    if (!this.token()) { this.status("off", "未填写 Bot Token"); return; }
    this.stopped = false;
    this.status("connecting");
    try {
      const me = await api(this.token(), "getMe", {});
      this.botName = me.username ? "@" + me.username : (me.first_name || "Bot");
      this.status("online");
      this.loop();
    } catch (e) {
      this.status("error", String(e && e.message || e));
      if (!e.authFail) this.retryTimer = setTimeout(() => { if (!this.stopped) this.start(); }, 10000);
    }
  }

  async loop() {
    if (this.looping || this.stopped) return;
    this.looping = true;
    while (!this.stopped) {
      try {
        const updates = await api(this.token(), "getUpdates", {
          offset: this.offset, timeout: 25, limit: 50
        }, 30000);
        for (const u of updates) {
          this.offset = Math.max(this.offset, (u.update_id || 0) + 1);
          const m = u.message || u.channel_post || u.business_message;
          if (!m) continue;
          const chat = m.chat || {};
          const key = String(chat.id || "");
          if (!key) continue;
          const from = m.from || {};
          const who = from.first_name || from.username || (chat.title ? "成员" : "用户");
          const text = this.preview(m);
          const title = chat.title || [from.first_name, from.last_name].filter(Boolean).join(" ") || who;
          this.emit({
            kind: "message", sid: SID, key,
            msg: { who, text, out: false, date: (m.date || 0) * 1000 },
            meta: {
              title,
              subtitle: chat.type === "private" ? "私聊 · " + this.botName : (chat.type + " · " + this.botName),
              canReply: true, sourceName: "SafeXTM", color: "#34d399"
            }
          });
        }
      } catch (e) {
        if (e.authFail || e.conflict) { this.status("error", String(e.message)); break; }
        this.status("connecting", "重连中：" + String(e.message));
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    this.looping = false;
  }

  preview(m) {
    if (m.text) return String(m.text).slice(0, 160);
    if (m.caption) return "[媒体] " + String(m.caption).slice(0, 120);
    if (m.photo) return "[图片]";
    if (m.video) return "[视频]";
    if (m.voice) return "[语音]";
    if (m.document) return "[文件]";
    return "[消息]";
  }

  async send(key, text) {
    try {
      await api(this.token(), "sendMessage", {
        chat_id: key, text: String(text).slice(0, 4000)
      });
      return true;
    } catch (e) { return false; }
  }

  async markRead() { return true; } // Bot API 无可标记的已读回执

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }
}

module.exports = { SafeXTMCollector };
