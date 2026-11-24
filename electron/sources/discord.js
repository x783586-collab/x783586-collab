"use strict";

const WebSocket = require("ws");
const { Source, clip, stripTags, fetchWithTimeout } = require("./base");

/**
 * Discord
 * 走 Gateway（WebSocket）拿实时消息，频道名用 REST 补。
 * intents 需要 GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT，
 * 最后一项要在开发者后台手动打开，否则只能收到空内容。
 */
class DiscordSource extends Source {
  constructor(id, cfg, emit) {
    super(id, cfg, emit);
    this.ws = null;
    this.seq = null;
    this.hb = null;
    this.acked = true;
    this.retry = 3000;
    this.meId = "";
    this.channels = new Map();
    this.unread = new Map();
  }

  api(path) {
    return "https://discord.com/api/v10" + path;
  }

  headers() {
    return {
      Authorization: "Bot " + String(this.cfg.token || "").trim(),
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/tg-hud, 1.0)"
    };
  }

  async start() {
    if (!this.cfg.token) {
      this.setStatus("off", "未填写 Bot Token");
      return;
    }
    this.stopped = false;
    this.setStatus("connecting");
    await this.connect();
  }

  async connect() {
    if (this.stopped) return;
    try {
      const res = await fetchWithTimeout(this.api("/gateway"), { headers: this.headers() }, 15000);
      if (!res.ok) {
        if (res.status === 401) throw new Error("401 Bot Token 无效");
        throw new Error("HTTP " + res.status);
      }
      const { url } = await res.json();
      this.open(url + "/?v=10&encoding=json");
    } catch (e) {
      this.setStatus("error", this.prettyErr(e));
      this.scheduleReconnect();
    }
  }

  open(url) {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.retry = 3000;
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.s !== undefined && msg.s !== null) this.seq = msg.s;

      switch (msg.op) {
        case 10: // HELLO
          this.startHeartbeat(msg.d.heartbeat_interval);
          this.identify();
          break;
        case 11: // HEARTBEAT ACK
          this.acked = true;
          break;
        case 7: // RECONNECT
          try { ws.close(); } catch (e) {}
          break;
        case 9: // INVALID SESSION
          this.seq = null;
          setTimeout(() => this.connect(), 2000);
          break;
        case 0:
          this.dispatch(msg.t, msg.d);
          break;
      }
    });

    ws.on("close", () => {
      this.stopHeartbeat();
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on("error", () => {});
  }

  startHeartbeat(interval) {
    this.stopHeartbeat();
    this.acked = true;
    this.hb = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      if (!this.acked) {
        try { this.ws.terminate(); } catch (e) {}
        return;
      }
      this.acked = false;
      this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
    }, interval);
    if (typeof this.hb.unref === "function") this.hb.unref();
  }

  stopHeartbeat() {
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
  }

  identify() {
    this.ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: String(this.cfg.token).trim(),
          intents: (1 << 9) | (1 << 12) | (1 << 15), // GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
          properties: { os: process.platform, browser: "tg-hud", device: "tg-hud" }
        }
      })
    );
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const wait = this.retry;
    this.retry = Math.min(this.retry * 2, 60000);
    this.timeout(wait, () => this.connect());
  }

  async dispatch(type, d) {
    if (type === "READY") {
      this.meId = d.user && d.user.id;
      this.setStatus("online");
      return;
    }
    if (type !== "MESSAGE_CREATE") return;
    if (!d || !d.author || d.author.bot) return;
    if (d.author.id === this.meId) return;

    const channelId = d.channel_id;
    const info = await this.channelInfo(channelId);
    const title = info.name;
    const prev = this.unread.get(channelId) || 0;
    this.unread.set(channelId, prev + 1);

    this.pushItem({
      key: channelId,
      title,
      subtitle: info.subtitle,
      text: clip(stripTags(d.content || (d.attachments && d.attachments.length ? "[附件]" : "[非文本消息]")), 90),
      date: Date.parse(d.timestamp) || Date.now(),
      unread: this.unread.get(channelId),
      photo: info.avatar,
      link: "https://discord.com/channels/" + (d.guild_id || "@me") + "/" + channelId,
      messages: [
        {
          who: d.author.global_name || d.author.username,
          text: clip(stripTags(d.content || "[附件]"), 100),
          out: false,
          date: Date.parse(d.timestamp) || Date.now()
        }
      ],
      canReply: true
    });
  }

  async channelInfo(id) {
    if (this.channels.has(id)) return this.channels.get(id);
    let info = { name: "Discord 频道", subtitle: "Discord", avatar: null };
    try {
      const res = await fetchWithTimeout(this.api("/channels/" + id), { headers: this.headers() }, 10000);
      if (res.ok) {
        const c = await res.json();
        if (c.type === 1 || c.type === 3) {
          const r = (c.recipients && c.recipients[0]) || null;
          info = { name: r ? r.global_name || r.username : "私信", subtitle: "Discord 私信", avatar: r ? this.avatarUrl(r.id, r.avatar) : null };
        } else {
          info = {
            name: c.name || "Discord 频道",
            subtitle: "Discord · #" + (c.name || ""),
            avatar: c.guild_id ? null : null
          };
        }
      }
    } catch (e) {}
    this.channels.set(id, info);
    return info;
  }

  avatarUrl(id, hash) {
    if (!id || !hash) return null;
    return "https://cdn.discordapp.com/avatars/" + id + "/" + hash + ".png?size=64";
  }

  async send(channelId, text) {
    const res = await fetchWithTimeout(this.api("/channels/" + channelId + "/messages"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ content: text })
    }, 15000);
    if (!res.ok) return false;
    this.unread.set(channelId, 0);
    return true;
  }

  async markRead(channelId) {
    this.unread.set(channelId, 0);
    const info = await this.channelInfo(channelId);
    this.pushItem({
      key: channelId,
      title: info.name,
      subtitle: info.subtitle,
      text: "已标记为已读",
      date: Date.now(),
      unread: 0,
      photo: info.avatar,
      messages: [],
      canReply: true
    });
    return true;
  }

  prettyErr(e) {
    const m = String((e && e.message) || e || "");
    if (/401/i.test(m)) return "Bot Token 无效，去开发者后台重新复制";
    if (/ENOTFOUND|getaddrinfo/i.test(m)) return "连不上 discord.com，可能需要代理";
    if (/timeout|aborted/i.test(m)) return "连接超时";
    return m.slice(0, 140);
  }

  async stop() {
    this.stopped = true;
    this.stopHeartbeat();
    try { if (this.ws) this.ws.close(); } catch (e) {}
    this.ws = null;
    await super.stop();
  }
}

module.exports = { DiscordSource };
