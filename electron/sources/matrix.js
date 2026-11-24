"use strict";

const { Source, clip, stripTags, fetchWithTimeout } = require("./base");

/**
 * Matrix（Element 等客户端背后的协议）
 * 用 /sync 长轮询，只要 homeserver 地址和 access token，不需要建应用。
 * 房间名从 m.room.name 里取，私聊没有名字就用对方显示名。
 */
class MatrixSource extends Source {
  constructor(id, cfg, emit) {
    super(id, cfg, emit);
    this.since = null;
    this.rooms = new Map(); // roomId -> {name, avatar}
    this.abort = null;
    this.retry = 3000;
  }

  base() {
    return String(this.cfg.homeserver || "").replace(/\/+$/, "");
  }

  headers() {
    return { Authorization: "Bearer " + String(this.cfg.token || "").trim() };
  }

  async start() {
    if (!this.base() || !this.cfg.token) {
      this.setStatus("off", "未填写 homeserver 或 access token");
      return;
    }
    this.setStatus("connecting");
    try {
      await this.syncOnce(true);
      this.setStatus("online");
      this.loop();
    } catch (e) {
      this.setStatus("error", this.prettyErr(e));
    }
  }

  async loop() {
    while (!this.stopped) {
      try {
        await this.syncOnce(false);
        this.retry = 3000;
        if (this.status !== "online") this.setStatus("online");
      } catch (e) {
        if (this.stopped) break;
        const msg = this.prettyErr(e);
        this.setStatus("error", msg);
        await new Promise((r) => setTimeout(r, this.retry));
        this.retry = Math.min(this.retry * 2, 60000);
      }
    }
  }

  async syncOnce(first) {
    this.abort = new AbortController();
    const qs = new URLSearchParams({ timeout: first ? "0" : "30000" });
    if (this.since) qs.set("since", this.since);
    const url = this.base() + "/_matrix/client/v3/sync?" + qs.toString();

    const res = await fetchWithTimeout(
      url,
      { headers: this.headers(), signal: this.abort.signal },
      first ? 20000 : 45000
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("HTTP " + res.status + " " + body.slice(0, 120));
    }
    const data = await res.json();
    this.since = data.next_batch;

    const joined = (data.rooms && data.rooms.join) || {};
    let changed = false;

    for (const roomId of Object.keys(joined)) {
      const room = joined[roomId];
      const state = room.state && room.state.events ? room.state.events : [];
      const timeline = room.timeline && room.timeline.events ? room.timeline.events : [];
      let meta = this.rooms.get(roomId) || { name: "", avatar: null };

      for (const ev of state) {
        if (ev.type === "m.room.name" && ev.content && ev.content.name) meta.name = ev.content.name;
        if (ev.type === "m.room.canonical_alias" && !meta.name && ev.content && ev.content.alias) {
          meta.name = String(ev.content.alias).replace(/^#/, "").split(":")[0];
        }
        if (ev.type === "m.room.avatar" && ev.content && ev.content.url) {
          meta.avatar = this.mxcToHttp(ev.content.url);
        }
      }

      const msgs = timeline.filter((ev) => ev.type === "m.room.message" && ev.content);
      for (const m of msgs) {
        if (!meta.name && m.sender) meta.name = this.shortSender(m.sender);
        changed = true;
      }

      if (!meta.name) meta.name = this.shortSender(roomId);
      this.rooms.set(roomId, meta);
      if (!changed && first) continue;

      const notify = (room.unread_notifications && room.unread_notifications.notification_count) || 0;
      const highlight = (room.unread_notifications && room.unread_notifications.highlight_count) || 0;
      const last = msgs.length ? msgs[msgs.length - 1] : null;

      const recent = msgs.slice(-3).map((m) => ({
        who: m.sender ? this.shortSender(m.sender) : "",
        text: clip(stripTags((m.content && (m.content.body || m.content.topic)) || ""), 100),
        out: false,
        date: m.origin_server_ts || 0
      }));

      this.pushItem({
        key: roomId,
        title: meta.name || "Matrix 房间",
        subtitle: this.base().replace(/^https?:\/\//, ""),
        text: last
          ? clip(stripTags(last.content.body || "[非文本消息]"), 90)
          : "暂无新消息",
        date: last ? last.origin_server_ts : Date.now(),
        unread: notify,
        muted: false,
        photo: meta.avatar,
        link: null,
        messages: recent.length ? recent : [],
        canReply: true,
        highlight: highlight > 0
      });

      if (first) continue;
      if (msgs.length) {
        const newest = msgs[msgs.length - 1];
        const who = newest.sender ? this.shortSender(newest.sender) : "";
        this.bump(roomId, clip(stripTags(newest.content.body || "[非文本消息]"), 90), {
          who,
          text: clip(stripTags(newest.content.body || ""), 100),
          out: false,
          date: newest.origin_server_ts || 0
        });
      }
    }
  }

  mxcToHttp(url) {
    if (!url || !url.startsWith("mxc://")) return null;
    const rest = url.slice(6);
    const [server, mediaId] = rest.split("/");
    return this.base() + "/_matrix/media/v3/thumbnail/" + server + "/" + mediaId + "?width=64&height=64&method=crop";
  }

  shortSender(id) {
    const m = String(id || "").match(/^@([^:]+):/);
    return m ? m[1] : String(id || "").slice(0, 20);
  }

  prettyErr(e) {
    const m = String((e && e.message) || e || "");
    if (/401|M_UNKNOWN_TOKEN|M_MISSING_TOKEN/i.test(m)) return "access token 无效或已过期，请重新在 Element 里获取";
    if (/ENOTFOUND|getaddrinfo/i.test(m)) return "homeserver 地址解析不到，注意要写完整（含 https://）";
    if (/aborted|AbortError/i.test(m)) return "请求超时";
    return m.slice(0, 140);
  }

  async send(key, text) {
    const url =
      this.base() +
      "/_matrix/client/v3/rooms/" +
      encodeURIComponent(key) +
      "/send/m.room.message/" +
      Date.now();
    const res = await fetchWithTimeout(
      url,
      {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, this.headers()),
        body: JSON.stringify({ msgtype: "m.text", body: text })
      },
      15000
    );
    if (!res.ok) return false;
    this.pushBumpLater(key, text);
    return true;
  }

  pushBumpLater(key, text) {
    const meta = this.rooms.get(key) || { name: "Matrix" };
    this.pushItem({
      key,
      title: meta.name,
      subtitle: this.base().replace(/^https?:\/\//, ""),
      text,
      date: Date.now(),
      unread: 0,
      photo: meta.avatar,
      messages: [{ who: "你", text, out: true, date: Date.now() }],
      canReply: true
    });
  }

  async stop() {
    if (this.abort) {
      try { this.abort.abort(); } catch (e) {}
    }
    await super.stop();
  }
}

module.exports = { MatrixSource };
