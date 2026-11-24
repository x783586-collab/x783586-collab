"use strict";

const { RssSource } = require("./rss");
const { ImapSource } = require("./imap");
const { MatrixSource } = require("./matrix");
const { GitHubSource, GitLabSource } = require("./github");
const { DiscordSource } = require("./discord");
const { SlackSource } = require("./slack");
const { SafeXSource } = require("./safextm");
const { LineSource } = require("./line");
const { SOURCE_META } = require("./base");

const CTORS = {
  rss: RssSource,
  imap: ImapSource,
  matrix: MatrixSource,
  github: GitHubSource,
  gitlab: GitLabSource,
  discord: DiscordSource,
  slack: SlackSource,
  safextm: SafeXSource,
  line: LineSource
};

/**
 * 来源管理器
 * -----------------
 * 负责按配置启停各个来源，并把它们的事件收敛成一份统一状态。
 * 关键点：
 *  - 单个来源崩了不影响其他来源（每个 start 都包在 try 里）
 *  - 配置变了只重启变化的来源，不整体重连
 *  - 所有会话按 `${sid}:${key}` 缓存，方便渲染层按来源分组
 */
class SourceManager {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.sources = new Map();  // sid -> Source 实例
    this.items = new Map();    // "sid:key" -> item
    this.statuses = new Map(); // sid -> {status, error}
    this.cfgJson = new Map();  // sid -> 上次启动时的配置 JSON
  }

  emit(ev) {
    if (ev.kind === "status") {
      this.statuses.set(ev.sid, { status: ev.status, error: ev.error || "" });
      this.onEvent(ev);
      return;
    }
    if (ev.kind === "drop") {
      this.items.delete(ev.sid + ":" + ev.key);
      this.onEvent(ev);
      return;
    }
    if (ev.kind === "bump") {
      const k = ev.sid + ":" + ev.key;
      const it = this.items.get(k);
      if (it) {
        it.text = ev.text;
        it.date = Date.now();
        it.unread = (it.unread || 0) + 1;
        it.messages = (it.messages || []).concat(ev.messages ? [ev.messages] : []).slice(-4);
      }
      this.onEvent(Object.assign({ kind: "item" }, { item: it || null, sid: ev.sid }));
      return;
    }
    if (ev.kind === "item" && ev.item) {
      const k = ev.item.sid + ":" + ev.item.key;
      const prev = this.items.get(k);
      // 未读数由来源自己维护，但如果来源没给（第一次出现）就用 0
      const merged = Object.assign({}, prev || {}, ev.item);
      if (prev && typeof ev.item.unread === "number" && ev.item.unread === 0 && prev.unread > ev.item.unread) {
        merged.unread = ev.item.unread;
      }
      this.items.set(k, merged);
      this.onEvent({ kind: "item", item: merged });
    }
  }

  /** 按配置全量同步：新增的启动、删除的停止、配置变了的重启 */
  async apply(sourcesCfg) {
    const cfg = sourcesCfg || {};
    const wanted = new Set();

    for (const sid of Object.keys(cfg)) {
      const c = cfg[sid];
      if (!c || !c.enabled) continue;
      if (!CTORS[sid]) continue;
      wanted.add(sid);

      const json = JSON.stringify(c);
      const exists = this.sources.has(sid);
      if (exists && this.cfgJson.get(sid) === json) continue;

      if (exists) await this.stopOne(sid);

      const src = new CTORS[sid](sid, c, (ev) => this.emit(ev));
      this.sources.set(sid, src);
      this.cfgJson.set(sid, json);
      try {
        await src.start();
      } catch (e) {
        this.statuses.set(sid, { status: "error", error: String(e && e.message || e) });
        this.onEvent({ kind: "status", sid, status: "error", error: String(e && e.message || e) });
      }
    }

    for (const sid of [...this.sources.keys()]) {
      if (!wanted.has(sid)) await this.stopOne(sid);
    }
  }

  async stopOne(sid) {
    const src = this.sources.get(sid);
    this.sources.delete(sid);
    this.cfgJson.delete(sid);
    if (src) {
      try { await src.stop(); } catch (e) {}
    }
    for (const k of [...this.items.keys()]) {
      if (k.startsWith(sid + ":")) this.items.delete(k);
    }
  }

  async restart(sid) {
    const c = this.cfgJson.get(sid);
    if (!c) return;
    await this.stopOne(sid);
    const cfg = JSON.parse(c);
    if (!CTORS[sid]) return;
    const src = new CTORS[sid](sid, cfg, (ev) => this.emit(ev));
    this.sources.set(sid, src);
    this.cfgJson.set(sid, c);
    try { await src.start(); } catch (e) {}
  }

  async stopAll() {
    for (const sid of [...this.sources.keys()]) await this.stopOne(sid);
  }

  list() {
    return [...this.items.values()].map((it) => ({
      sid: it.sid,
      key: it.key,
      title: it.title,
      subtitle: it.subtitle || "",
      text: it.text || "",
      date: it.date || 0,
      unread: it.unread || 0,
      muted: !!it.muted,
      photo: it.photo || null,
      color: it.color || "#888888",
      sourceName: it.sourceName || "",
      link: it.link || null,
      messages: it.messages || [],
      canReply: !!it.canReply,
      highlight: !!it.highlight,
      error: !!it.error
    }));
  }

  statusList() {
    const out = {};
    for (const sid of Object.keys(SOURCE_META)) {
      const known = CTORS[sid] ? true : false;
      const st = this.statuses.get(sid) || { status: known ? "idle" : "unsupported", error: "" };
      out[sid] = st;
    }
    return out;
  }

  has(sid) {
    return this.sources.has(sid);
  }

  async markRead(sid, key) {
    const src = this.sources.get(sid);
    if (!src) return false;
    try { return await src.markRead(key); } catch (e) { return false; }
  }

  async send(sid, key, text) {
    const src = this.sources.get(sid);
    if (!src) return false;
    try { return await src.send(key, text); } catch (e) { return false; }
  }
}

module.exports = { SourceManager, SOURCE_META, CTORS };
