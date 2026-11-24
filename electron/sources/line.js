"use strict";

const { Source, clip, fetchWithTimeout } = require("./base");

/**
 * LINE
 * ---------------------------------------------------------------
 * LINE 没有用户账号 API，也没有 Telegram 那样的 getUpdates 轮询，
 * 官方只提供 Messaging API：事件以 webhook（HTTPS POST）推送到一个
 * 公网地址。桌面电脑在 NAT 后面收不到推送，所以需要一个公网中转
 * （项目自带 tools/line-worker.js，可免费部署到 Cloudflare Workers）：
 *
 *   LINE 平台 --webhook--> 公网中转(暂存事件) <--轮询-- 挂件
 *   挂件 -----------------------------------------> api.line.me
 *                                                    (回复 / 拉名字)
 *
 * 能收：发给官方账号的私聊、它加入的群聊/多人聊天的消息
 * 不能收：用户账号和朋友之间的私聊（LINE 不对个人开放）
 * 能发：push 消息（消耗官方账号每月免费额度，约 200 条）
 *
 * 配置：{
 *   enabled,
 *   relay:      中转地址，如 https://xxx.workers.dev
 *   relayToken: 中转口令（与 Worker 里的 ACCESS_TOKEN 一致）
 *   token:      Channel access token（LINE Developers Console 签发）
 *   apiBase:    默认 https://api.line.me，测试时可指向 mock
 * }
 */
class LineSource extends Source {
  constructor(id, cfg, emit) {
    super(id, cfg, emit);
    this.chats = new Map();    // key -> {title, subtitle}
    this.unread = new Map();   // key -> 未读数
    this.names = new Map();    // userId -> displayName
    this.seen = new Set();     // 事件去重（LINE 可能重发 webhook）
    this.pending = new Set();  // 正在补拉名字的 id，防重复请求
    this.after = 0;            // 事件水位（timestamp ms）
    this.botName = "";
    this.polling = false;
  }

  apiBase() {
    return String(this.cfg.apiBase || "https://api.line.me").replace(/\/+$/, "");
  }

  relay() {
    return String(this.cfg.relay || "").trim().replace(/\/+$/, "");
  }

  /** 调官方 Messaging API（统一带 Bearer 头） */
  async lineApi(path, opts) {
    const o = Object.assign({}, opts || {});
    o.headers = Object.assign(
      { "Authorization": "Bearer " + String(this.cfg.token || "").trim() },
      (opts && opts.headers) || {}
    );
    const res = await fetchWithTimeout(this.apiBase() + path, o, 15000);
    if (res.status === 401) {
      throw Object.assign(new Error("Channel Access Token 无效或已过期"), { authFail: true });
    }
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      try {
        const j = await res.json();
        if (j && j.message) msg = j.message;
      } catch (e) {}
      throw new Error(msg);
    }
    return res.json().catch(() => null);
  }

  async start() {
    const relay = this.relay();
    const token = String(this.cfg.token || "").trim();
    if (!relay || !/^https?:\/\//i.test(relay)) {
      this.setStatus("off", "未填写中转服务地址");
      return;
    }
    this.stopped = false;
    this.setStatus("connecting");

    if (token) {
      // 玩法 A（官方账号）：用 bot/info 验证 token，顺便拿官方账号名字
      try {
        const info = await this.lineApi("/v2/bot/info");
        this.botName = info && (info.displayName || info.basicId) || "LINE 官方账号";
      } catch (e) {
        if (e.authFail) {
          this.setStatus("error", "Token 无效：到 LINE Developers Console 的 Messaging API 标签页重新签发");
          return;
        }
        this.setStatus("error", this.prettyErr(e));
        this.timeout(10000, () => { if (!this.stopped) this.start(); });
        return;
      }
    } else {
      // 玩法 B（手机通知转发）：不需要官方账号，只靠中转
      this.botName = "手机转发";
    }
    this.chats.clear();
    this.pushAll();

    // 只收挂件启动之后发生的新消息，避免中转里 24 小时内的旧事件一开机全弹出来
    this.after = Date.now();
    this.setStatus("online");
    this.every(6000, () => this.poll());
  }

  /** 轮询中转，拉取新事件 */
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const url = this.relay() + "/pull?token=" +
        encodeURIComponent(String(this.cfg.relayToken || "")) +
        "&after=" + this.after;
      const res = await fetchWithTimeout(url, {}, 15000);
      if (this.stopped) return;
      if (res.status === 401 || res.status === 403) {
        this.setStatus("error", "中转口令不对：检查 Worker 里的 ACCESS_TOKEN 和挂件里的中转口令是否一致");
        return;
      }
      if (!res.ok) {
        this.setStatus("connecting", "中转异常（HTTP " + res.status + "），重试中…");
        return;
      }
      const data = await res.json().catch(() => null);
      if (this.status !== "online") this.setStatus("online");
      const events = Array.isArray(data)
        ? data
        : (data && Array.isArray(data.events) ? data.events : []);
      for (const ev of events) this.handleEvent(ev);
    } catch (e) {
      if (!this.stopped) this.setStatus("connecting", "连不上中转服务，重试中…");
    } finally {
      this.polling = false;
    }
  }

  /** 处理一条 LINE webhook 事件 */
  handleEvent(ev) {
    if (!ev || typeof ev !== "object") return;
    this.after = Math.max(this.after, ev.timestamp || 0);
    if (ev.type !== "message" || !ev.message || !ev.source) return;

    // 去重：LINE 建议按 webhookEventId 去重，旧平台事件退化为 messageId+时间戳
    const dedupe = ev.webhookEventId ||
      ((ev.message.id || "") + "@" + (ev.timestamp || 0));
    if (this.seen.has(dedupe)) return;
    this.seen.add(dedupe);
    if (this.seen.size > 600) {
      this.seen = new Set([...this.seen].slice(-300));
    }

    const src = ev.source;
    const isGroup = src.type === "group" || src.type === "room";
    const key = src.groupId || src.roomId || src.userId;
    if (!key) return;

    // 群聊会话名：异步补拉群摘要，先给占位保证立刻可见
    if (isGroup && !this.chats.has(key)) {
      this.chats.set(key, {
        title: src.type === "group" ? "LINE 群 " + shortId(key) : "多人聊天 " + shortId(key),
        subtitle: (src.type === "group" ? "群聊" : "多人聊天") + " · " + this.botName
      });
      this.fillChatName(key, src);
    }
    // 私聊会话名：手机转发的通知自带名字，官方账号消息用对方 profile
    if (!isGroup && !this.chats.has(key)) {
      this.chats.set(key, {
        title: ev.hudTitle || ("LINE 用户 " + shortId(key)),
        subtitle: ev.hudTitle ? ("手机转发 · " + this.botName) : ("私聊 · " + this.botName)
      });
      if (!ev.hudTitle) this.fillUserName(key, src.userId, null);
    }

    const text = this.msgText(ev.message);
    if (src.userId && !this.names.has(src.userId)) {
      this.fillUserName(null, src.userId, isGroup ? key : null);
    }
    const who = !isGroup ? "" : (this.names.get(src.userId) || "成员");
    const chat = this.chats.get(key);
    const title = chat ? chat.title : "LINE";

    this.unread.set(key, (this.unread.get(key) || 0) + 1);
    this.pushAll();
    this.emit({
      kind: "bump",
      sid: this.id,
      key,
      text: clip(text, 160),
      messages: { who: who || title, text: clip(text, 80), out: false }
    });
  }

  /** LINE 消息对象 -> 展示文本 */
  msgText(m) {
    if (m.type === "text") return m.text || "";
    if (m.type === "image") return "[图片]";
    if (m.type === "video") return "[视频]";
    if (m.type === "audio") return "[语音]";
    if (m.type === "file") return "[文件] " + clip(m.fileName || "", 30);
    if (m.type === "sticker") return "[表情]";
    if (m.type === "location") return "[位置] " + clip(m.title || "", 30);
    return "[" + (m.type || "消息") + "]";
  }

  /** 拉群名/多人聊天名（group/room 都有 summary 接口） */
  async fillChatName(key, src) {
    const tag = "chat:" + key;
    if (this.pending.has(tag)) return;
    this.pending.add(tag);
    try {
      const base = src.type === "group" ? "/v2/bot/group/" : "/v2/bot/room/";
      const s = await this.lineApi(base + key + "/summary");
      if (!this.stopped && s && s.groupName) {
        this.chats.set(key, {
          title: s.groupName,
          subtitle: (src.type === "group" ? "群聊" : "多人聊天") + " · " + this.botName
        });
        this.pushAll();
      }
    } catch (e) {
      // 拉不到就保留占位名（Bot 不在群里/权限不足都会失败）
    } finally {
      this.pending.delete(tag);
    }
  }

  /** 拉用户名：私聊用 profile，群成员用 group/room member 接口 */
  async fillUserName(chatKey, userId, groupKey) {
    if (!userId || this.pending.has("u:" + userId)) return;
    this.pending.add("u:" + userId);
    try {
      let path = null;
      if (groupKey && groupKey.startsWith("C")) path = "/v2/bot/group/" + groupKey + "/member/" + userId;
      else if (groupKey && groupKey.startsWith("R")) path = "/v2/bot/room/" + groupKey + "/member/" + userId;
      else path = "/v2/bot/profile/" + userId;
      const p = await this.lineApi(path);
      const name = p && (p.displayName || "");
      if (!this.stopped && name) {
        this.names.set(userId, name);
        // 私聊：用户名就是会话名
        if (!groupKey && this.chats.has(userId)) {
          this.chats.set(userId, { title: name, subtitle: "私聊 · " + this.botName });
          this.pushAll();
        }
      }
    } catch (e) {
      // 保留占位名
    } finally {
      this.pending.delete("u:" + userId);
    }
  }

  pushAll() {
    const canReply = !!String(this.cfg.token || "").trim(); // 玩法 B 没有官方账号，无法回复
    for (const [key, c] of this.chats) {
      this.pushItem({
        key,
        title: c.title,
        subtitle: c.subtitle,
        text: "",
        date: Date.now(),
        unread: this.unread.get(key) || 0,
        canReply,
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

  /** 回复走 push 消息（replyToken 一次性、官方文档未公开有效期，不可靠；push 稳定但计入每月额度） */
  async send(key, text) {
    if (!String(this.cfg.token || "").trim()) {
      throw new Error("没有配置官方账号（玩法 B 手机转发），无法在挂件里回复");
    }
    try {
      await this.lineApi("/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: key,
          messages: [{ type: "text", text: String(text).slice(0, 5000) }]
        })
      });
      return true;
    } catch (e) {
      const m = String(e && e.message || e);
      if (/429|limit|quota/i.test(m)) throw new Error("本月 push 额度已用完（LINE 免费额度约 200 条/月）");
      throw e;
    }
  }

  prettyErr(e) {
    const m = String((e && e.message) || e);
    if (m.includes("ENOTFOUND") || m.includes("ETIMEDOUT") || m.includes("ECONNREFUSED")) {
      return "连不上 api.line.me，检查网络或代理";
    }
    if (m.includes("abort")) return "请求超时";
    return m || "未知错误";
  }
}

/** 会话 key（U/C/R 开头的长 ID）截短，用于占位名 */
function shortId(s) {
  const t = String(s);
  return t.length > 8 ? t.slice(-6) : t;
}

module.exports = { LineSource };
