"use strict";

const { Source, clip, fetchWithTimeout } = require("./base");

/**
 * SafeXTM
 * ---------------------------------------------------------------
 * Telegram 类应用（safextm.com），开放的是 Bot API（与 Telegram Bot API
 * 高度兼容）：同样的 getUpdates 长轮询、同样的 {ok, result} 响应。
 * 端点：https://api.safew.bot/bot<token>/methodName
 *
 * 能收：私聊发给机器人的消息、把机器人拉进去的群消息
 * 不能收：用户账号的完整会话（SafeXTM 未开放用户级客户端 API）
 * 能发：sendMessage 直接回复
 *
 * 配置：{ enabled, token }  token 从 SafeXTM 里找 @BotFather 发 /newbot 获得
 */
const API_BASE = "https://api.safew.bot/bot";

class SafeXSource extends Source {
  constructor(id, cfg, emit) {
    super(id, cfg, emit);
    this.offset = 0;
    this.unread = new Map();   // chatId -> 未读数
    this.names = new Map();    // chatId -> {title, subtitle, photo}
    this.botName = "";
    this.looping = false;
  }

  token() {
    return String(this.cfg.token || "").trim();
  }

  async api(method, body, longMs) {
    const res = await fetchWithTimeout(
      API_BASE + this.token() + "/" + method,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      },
      longMs || 15000
    );
    const data = await res.json().catch(() => null);
    if (!data) throw new Error("API 返回了无法解析的内容");
    if (!data.ok) {
      const code = data.error_code || res.status;
      if (code === 401) throw Object.assign(new Error("Token 无效或已被撤销"), { authFail: true });
      if (code === 429) throw Object.assign(new Error("请求过于频繁"), { rateLimit: true });
      throw new Error(data.description || ("HTTP " + code));
    }
    return data.result;
  }

  async start() {
    const t = this.token();
    if (!t) {
      this.setStatus("off", "未填写 Bot Token");
      return;
    }
    this.stopped = false;
    this.setStatus("connecting");

    // getMe 验证 token，顺便取 bot 名字做会话标题
    try {
      const me = await this.api("getMe");
      this.botName = me.username ? ("@" + me.username) : (me.first_name || "Bot");
      this.unread.clear();
      this.pushAll();
      this.setStatus("online");
      this.loopUpdates();
    } catch (e) {
      if (e.authFail) {
        this.setStatus("error", "Token 无效：确认是从 @BotFather /newbot 拿到的完整 Token");
      } else {
        this.setStatus("error", this.prettyErr(e));
        // 网络类错误留退避重试，401 不重试（填错了重连也没用）
        this.timeout(8000, () => { if (!this.stopped) this.start(); });
      }
    }
  }

  async loopUpdates() {
    if (this.looping || this.stopped) return;
    this.looping = true;
    while (!this.stopped) {
      try {
        const updates = await this.api(
          "getUpdates",
          { offset: this.offset, timeout: 25, limit: 50 },
          40000
        );
        if (this.stopped) break;
        for (const u of (updates || [])) {
          this.offset = Math.max(this.offset, (u.update_id || 0) + 1);
          this.handleUpdate(u);
        }
      } catch (e) {
        if (this.stopped) break;
        if (e.authFail) { this.setStatus("error", "Token 无效或已被撤销"); break; }
        this.setStatus("connecting", "网络波动，重连中…");
        await new Promise(r => setTimeout(r, 4000));
      }
    }
    this.looping = false;
  }

  handleUpdate(u) {
    const m = u.message || u.edited_message;
    if (!m || !m.chat) return;

    const chatId = String(m.chat.id);
    const isPrivate = m.chat.type === "private";

    let title;
    if (isPrivate) {
      title = [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ") ||
              m.chat.username || ("用户 " + chatId);
    } else {
      title = m.chat.title || m.chat.username || ("会话 " + chatId);
    }
    const subtitle = isPrivate
      ? (m.chat.username ? ("私聊 · " + this.botName) : "私聊 · " + this.botName)
      : (m.chat.type === "channel" ? "频道 · " + this.botName : (m.chat.type === "group" || m.chat.type === "supergroup") ? "群聊 · " + this.botName : this.botName);

    this.names.set(chatId, { title, subtitle });

    // 文本提取（与 Telegram 字段一致：text/caption，其余给占位）
    const text = m.text || m.caption || this.mediaPlaceholder(m);
    const who = !isPrivate && m.from ? (m.from.first_name || m.from.username || "") : "";
    const isFromBot = !!(m.from && m.from.is_bot) || !!m.via_bot;

    // 机器人自己发的消息不计未读、不弹提醒
    if (!isFromBot) {
      this.unread.set(chatId, (this.unread.get(chatId) || 0) + 1);
      const msgs = [{ who: who || title, text: clip(text, 80), out: false }];
      this.pushAll();
      this.emit({ kind: "bump", sid: this.id, key: chatId, text: clip(text, 160), messages: msgs[0] });
    }
  }

  mediaPlaceholder(m) {
    if (m.photo) return "[图片]";
    if (m.video) return "[视频]";
    if (m.voice) return "[语音]";
    if (m.audio) return "[音频]";
    if (m.document) return "[文件] " + clip((m.document.file_name || ""), 30);
    if (m.sticker) return "[表情]";
    if (m.location) return "[位置]";
    if (m.contact) return "[联系人]";
    return "[消息]";
  }

  pushAll() {
    for (const [chatId, n] of this.names) {
      this.pushItem({
        key: chatId,
        title: n.title,
        subtitle: n.subtitle,
        text: "",
        date: Date.now(),
        unread: this.unread.get(chatId) || 0,
        canReply: true,
        link: null
      });
    }
  }

  async markRead(key) {
    if (!this.unread.has(String(key))) return false;
    this.unread.set(String(key), 0);
    this.pushAll();
    return true;
  }

  async send(key, text) {
    await this.api("sendMessage", { chat_id: Number(key) || key, text }, 20000);
    return true;
  }

  prettyErr(e) {
    const m = String((e && e.message) || e);
    if (m.includes("ENOTFOUND") || m.includes("ETIMEDOUT") || m.includes("ECONNREFUSED")) {
      return "连不上 api.safew.bot，检查网络";
    }
    if (m.includes("abort")) return "请求超时";
    return m || "未知错误";
  }
}

module.exports = { SafeXSource };
