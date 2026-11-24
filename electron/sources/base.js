"use strict";

/**
 * 统一消息模型
 * ---------------------------------------------------------------
 * 每个来源（Telegram / 邮件 / RSS / Matrix / Discord / Slack / GitHub）
 * 都把自己的数据翻译成下面这个形状，渲染层只认这一种结构。
 *
 * item = {
 *   sid      来源 id，例如 "imap"
 *   key      来源内唯一会话键，例如邮箱地址、频道 id、feed url
 *   title    会话名
 *   subtitle 副标题（邮箱地址 / 仓库名 / 频道所属服务器）
 *   text     最新一条内容摘要
 *   date     ms 时间戳
 *   unread   未读数
 *   muted    是否静音
 *   photo    头像 URL，可为空
 *   link     点击后打开的外部地址，可为空
 *   messages 最近几条 [{who, text, out, date}]
 *   canReply 是否支持挂件内回复
 * }
 */

const SOURCE_META = {
  telegram: { name: "Telegram", color: "#2aabee", short: "TG" },
  imap:     { name: "邮件",      color: "#f59e0b", short: "邮件" },
  rss:      { name: "RSS",       color: "#22c55e", short: "RSS" },
  matrix:   { name: "Matrix",    color: "#0dbd8b", short: "MX" },
  discord:  { name: "Discord",   color: "#5865f2", short: "DC" },
  slack:    { name: "Slack",     color: "#e01e5a", short: "SL" },
  feishu:   { name: "飞书",      color: "#3370ff", short: "飞" },
  github:   { name: "GitHub",    color: "#a371f7", short: "GH" },
  gitlab:   { name: "GitLab",    color: "#fc6d26", short: "GL" },
  safextm:  { name: "SafeXTM",   color: "#34d399", short: "SX" },
  line:     { name: "LINE",      color: "#06c755", short: "LN" }
};

class Source {
  /**
   * @param {string} id    来源 id，与 SOURCE_META 的键一致
   * @param {object} cfg   该来源的配置
   * @param {function} emit 事件回调，收到 {kind:"item"|"status"|"drop", ...}
   */
  constructor(id, cfg, emit) {
    this.id = id;
    this.cfg = cfg || {};
    this.emit = emit;
    this.status = "idle";
    this.lastError = "";
    this.timers = new Set();
    this.stopped = false;
  }

  meta() {
    return SOURCE_META[this.id] || { name: this.id, color: "#888888", short: "?" };
  }

  setStatus(status, error) {
    this.status = status;
    this.lastError = error || "";
    this.emit({ kind: "status", sid: this.id, status, error: this.lastError });
  }

  /** 会话数据变化 */
  pushItem(item) {
    if (this.stopped) return;
    const m = this.meta();
    const out = Object.assign(
      {
        sid: this.id,
        color: m.color,
        sourceName: m.name,
        unread: 0,
        muted: false,
        canReply: false
      },
      item
    );
    // 来源没显式给 messages 时不要输出空数组，否则 SourceManager
    // 的 Object.assign 合并会把 bump 攒下的最近消息清掉
    if (!("messages" in item)) delete out.messages;
    this.emit({ kind: "item", item: out });
  }

  /** 移除一个会话 */
  dropItem(key) {
    this.emit({ kind: "drop", sid: this.id, key });
  }

  /** 新增一条消息时调用，负责累加未读并推进时间 */
  bump(key, text, messages) {
    this.emit({ kind: "bump", sid: this.id, key, text, messages });
  }

  every(ms, fn) {
    const t = setInterval(() => {
      if (!this.stopped) Promise.resolve(fn()).catch(() => {});
    }, ms);
    this.timers.add(t);
    return t;
  }

  timeout(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) Promise.resolve(fn()).catch(() => {});
    }, ms);
    this.timers.add(t);
    return t;
  }

  clearTimers() {
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    this.timers.clear();
  }

  async start() {}
  async stop() {
    this.stopped = true;
    this.clearTimers();
  }

  /** 默认不支持的操作会走这里，避免子类忘了实现而抛错 */
  async markRead() { return false; }
  async send() { return false; }
  async open() { return false; }
}

/* ---------- 小工具，各适配器共用 ---------- */

function stripTags(s) {
  return String(s || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
}

function hashKey(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** 带超时的 fetch，避免某个源卡死拖住整体 */
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 15000);
  try {
    return await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
  } finally {
    clearTimeout(t);
  }
}

module.exports = { Source, SOURCE_META, stripTags, clip, hashKey, fetchWithTimeout };
