"use strict";

/**
 * Hub 权威状态存储 —— 多端同步的核心
 * ---------------------------------------------------------------
 * 只有 Hub 持有这个 Store，所有端（桌面/手机）读它、通过它回写。
 * 每次变更 rev++，并通过 subscribe 通知所有连接端（SSE）。
 *
 * 统一 item 模型（与 tg-hud 渲染层一致）：
 * {
 *   sid, key, title, subtitle, text, date, unread, muted, photo, link,
 *   messages: [{who,text,out,date}], canReply, pinned, sourceName, color
 * }
 */

const fs = require("fs");
const path = require("path");

class Store {
  constructor(file) {
    this.file = file || path.join(__dirname, "state.json");
    this.rev = 0;
    this.items = Object.create(null);   // "sid:key" -> item
    this.sources = Object.create(null); // sid -> {status,error,name}
    this.me = { name: "" };
    this.listeners = new Set();
    this._saveTimer = null;
    this._dirty = false;
    this.load();
  }

  /* ---------- 持久化 ---------- */
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.rev = Number(raw.rev) || 0;
      this.items = raw.items && typeof raw.items === "object" ? raw.items : Object.create(null);
      this.sources = raw.sources && typeof raw.sources === "object" ? raw.sources : Object.create(null);
      this.me = raw.me || { name: "" };
    } catch (e) {
      // 首次运行或文件损坏，从空状态开始
    }
  }

  save() {
    try {
      const data = { rev: this.rev, items: this.items, sources: this.sources, me: this.me, savedAt: Date.now() };
      fs.writeFileSync(this.file, JSON.stringify(data));
      this._dirty = false;
    } catch (e) {
      console.error("[store] save failed:", e.message);
    }
  }

  _changed(kind, detail) {
    this.rev++;
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 800);
    const evt = { rev: this.rev, kind, detail, state: this.snapshot() };
    for (const fn of this.listeners) {
      try { fn(evt); } catch (e) {}
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /* ---------- 读取 ---------- */
  snapshot() {
    return {
      rev: this.rev,
      items: this.items,
      sources: this.sources,
      me: this.me,
      updatedAt: Date.now()
    };
  }

  list() {
    return Object.keys(this.items)
      .map((k) => this.items[k])
      .sort((a, b) => {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
        return (b.date || 0) - (a.date || 0);
      });
  }

  get(sid, key) {
    return this.items[this.k(sid, key)] || null;
  }

  k(sid, key) {
    return String(sid) + ":" + String(key);
  }

  /* ---------- 写入（采集器调用） ---------- */
  setSource(sid, status, error, name) {
    const prev = this.sources[sid] || {};
    const next = Object.assign({}, prev, { status, error: error || "", name: name || prev.name || sid });
    if (prev.status === next.status && prev.error === next.error) return;
    this.sources[sid] = next;
    this._changed("source", { sid, status, error });
  }

  setMe(name) {
    if (this.me.name === name) return;
    this.me = { name: name || "" };
    this._changed("me", { name });
  }

  /** 采集器推入/更新会话。messages 由 Hub 保留历史，避免采集器覆盖。 */
  applyItem(item) {
    if (!item || !item.sid || item.key === undefined || item.key === null) return;
    const k = this.k(item.sid, item.key);
    const prev = this.items[k];
    const next = Object.assign(
      {
        sid: item.sid,
        key: String(item.key),
        title: "",
        subtitle: "",
        text: "",
        date: 0,
        unread: 0,
        muted: false,
        pinned: false,
        photo: null,
        link: null,
        messages: [],
        canReply: false,
        sourceName: item.sid,
        color: "#888888"
      },
      prev || {},
      item,
      { key: String(item.key), sid: item.sid }
    );
    // 采集器若没带 messages，保留历史；带了则以采集器为准（如首次拉取）
    if (!Array.isArray(item.messages) && prev && Array.isArray(prev.messages)) {
      next.messages = prev.messages;
    }
    if (!Array.isArray(next.messages)) next.messages = [];
    this.items[k] = next;
    this._changed("item", { sid: item.sid, key: next.key });
  }

  /** 采集器新增一条消息（单条，不覆盖历史） */
  pushMessage(sid, key, msg, opts) {
    const o = opts || {};
    const k = this.k(sid, key);
    const prev = this.items[k] || {
      sid, key: String(key), title: o.title || "", subtitle: o.subtitle || "",
      text: "", date: 0, unread: 0, muted: false, pinned: false, photo: null,
      link: null, messages: [], canReply: !!o.canReply,
      sourceName: o.sourceName || sid, color: o.color || "#888888"
    };
    const next = Object.assign({}, prev);
    next.messages = (prev.messages || []).concat([msg]).slice(-8);
    next.text = msg.text || next.text;
    next.date = msg.date || Date.now();
    if (!msg.out) next.unread = (prev.unread || 0) + 1;
    if (o.title) next.title = o.title;
    if (o.subtitle) next.subtitle = o.subtitle;
    this.items[k] = next;
    this._changed("message", { sid, key: next.key, out: !!msg.out });
  }

  /** 移除会话 */
  drop(sid, key) {
    const k = this.k(sid, key);
    if (!this.items[k]) return;
    delete this.items[k];
    this._changed("drop", { sid, key: String(key) });
  }

  /* ---------- 回写（任一端调用，Hub 执行后广播） ---------- */
  markRead(sid, key) {
    const k = this.k(sid, key);
    const item = this.items[k];
    if (!item || !item.unread) return false;
    const next = Object.assign({}, item, { unread: 0 });
    this.items[k] = next;
    this._changed("read", { sid, key: String(key) });
    return true;
  }

  addOutgoing(sid, key, text) {
    const k = this.k(sid, key);
    const item = this.items[k];
    if (!item) return false;
    const next = Object.assign({}, item, {
      text: String(text),
      date: Date.now(),
      messages: (item.messages || []).concat([
        { who: "你", text: String(text), out: true, date: Date.now() }
      ]).slice(-8)
    });
    this.items[k] = next;
    this._changed("sent", { sid, key: String(key) });
    return true;
  }

  totals() {
    const bySource = {};
    for (const it of Object.values(this.items)) {
      bySource[it.sid] = (bySource[it.sid] || 0) + (it.unread || 0);
    }
    return { bySource, total: Object.values(bySource).reduce((a, b) => a + b, 0) };
  }
}

module.exports = { Store };
