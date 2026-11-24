"use strict";

/**
 * Hub 端 LINE 采集器
 * ---------------------------------------------------------------
 * LINE 只有 webhook 推送（无 getUpdates），所以 Hub 直接暴露 webhook 端点：
 *   POST /hook/line       官方 Messaging API webhook（HMAC-SHA256 验签）
 *   POST /hook/line/notify 玩法B手机通知转发（token 校验）
 * 多端各自无法收 LINE 推送，统一由 Hub 接住再分发给所有端 —— 这也是多端同步的关键。
 *
 * 回复走 push（计入额度）或 reply（凭 replyToken，不计额度但时效短）。
 */

const crypto = require("crypto");
const SID = "line";
const API_BASE = "https://api.line.me";

class LineCollector {
  constructor(emit, cfg) {
    this.emit = emit;
    this.cfg = cfg;      // { token, secret, relayToken }
    this.stopped = false;
    this.names = new Map();
    this.botName = "LINE 官方账号";
  }

  status(status, error) {
    this.emit({ kind: "status", sid: SID, status, error: error || "" });
  }

  token() { return String(this.cfg.token || "").trim(); }
  secret() { return String(this.cfg.secret || "").trim(); }
  relayToken() { return String(this.cfg.relayToken || "").trim(); }

  /** 启动时用 /v2/bot/info 验证 token（玩法A）；无 token 则纯转发模式（玩法B） */
  async start() {
    if (this.token()) {
      try {
        const res = await fetch(API_BASE + "/v2/bot/info", {
          headers: { Authorization: "Bearer " + this.token() },
          signal: AbortSignal.timeout(12000)
        });
        if (res.status === 401) throw new Error("Token 无效");
        const info = await res.json().catch(() => null);
        this.botName = (info && (info.displayName || info.basicId)) || "LINE 官方账号";
        this.status("online");
      } catch (e) {
        this.status("error", String(e && e.message || e));
      }
    } else if (this.relayToken()) {
      this.botName = "手机转发";
      this.status("online");
    } else {
      this.status("off", "未配置 Token 或中转口令");
    }
  }

  /** 验证官方 webhook 签名 */
  verify(rawBody, signature) {
    const secret = this.secret();
    if (!secret || !signature) return false;
    const mac = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    try {
      return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(String(signature)));
    } catch (e) { return false; }
  }

  /** 处理 webhook event object（已验签） */
  handleEvents(payload) {
    const events = payload && Array.isArray(payload.events) ? payload.events : [];
    for (const ev of events) {
      if (!ev || ev.type !== "message" || !ev.message) continue;
      const src = ev.source || {};
      const msg = ev.message;
      let key, title, subtitle;
      if (src.type === "group") {
        key = "G:" + src.groupId;
        title = "LINE 群聊";
        subtitle = "群 · " + this.botName;
        if (src.userId) this.fillGroupName(src.groupId, key);
      } else if (src.type === "room") {
        key = "R:" + src.roomId;
        title = "LINE 多人聊天";
        subtitle = "群 · " + this.botName;
      } else {
        key = "U:" + (src.userId || "unknown");
        title = (ev.hudTitle) || this.names.get(key) || "LINE 用户";
        subtitle = ev.hudTitle ? ("手机转发 · " + this.botName) : ("私聊 · " + this.botName);
        if (!ev.hudTitle && src.userId) this.fillUserName(src.userId, key);
      }
      const text = this.preview(msg);
      this.emit({
        kind: "message", sid: SID, key,
        msg: { who: ev.hudTitle || this.names.get(key) || "成员", text, out: false, date: ev.timestamp || Date.now() },
        meta: { title, subtitle, canReply: !!this.token(), sourceName: "LINE", color: "#06c755", replyToken: ev.replyToken }
      });
    }
  }

  preview(m) {
    if (m.type === "text") return String(m.text || "").slice(0, 160);
    return "[" + (m.type || "媒体") + "]";
  }

  async api(path, body, bearer) {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (bearer || this.token()) },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(12000)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && data.length)) throw new Error((data && data[0] && data[0].message) || ("HTTP " + res.status));
    return data;
  }

  async fillUserName(userId, key) {
    if (!this.token() || this.names.has(key)) return;
    try {
      const res = await fetch(API_BASE + "/v2/bot/profile/" + encodeURIComponent(userId), {
        headers: { Authorization: "Bearer " + this.token() }, signal: AbortSignal.timeout(10000)
      });
      const p = await res.json().catch(() => null);
      if (p && p.displayName) {
        this.names.set(key, p.displayName);
        this.emit({ kind: "item-patch", sid: SID, key, patch: { title: p.displayName } });
      }
    } catch (e) {}
  }

  async fillGroupName(groupId, key) {
    if (!this.token()) return;
    try {
      const res = await fetch(API_BASE + "/v2/bot/group/" + encodeURIComponent(groupId) + "/summary", {
        headers: { Authorization: "Bearer " + this.token() }, signal: AbortSignal.timeout(10000)
      });
      const s = await res.json().catch(() => null);
      if (s && s.groupName) {
        this.emit({ kind: "item-patch", sid: SID, key, patch: { title: s.groupName } });
      }
    } catch (e) {}
  }

  async send(key, text) {
    if (!this.token()) return false;
    const to = key.startsWith("U:") ? key.slice(2) : key.slice(2);
    try {
      // 用 push（稳定，不计 replyToken 时效；计入每月额度）
      await this.api("/v2/bot/message/push", { to, messages: [{ type: "text", text: String(text).slice(0, 5000) }] });
      return true;
    } catch (e) { return false; }
  }

  async markRead() { return true; }

  stop() { this.stopped = true; }
}

module.exports = { LineCollector };
