"use strict";

const WebSocket = require("ws");
const { Source, clip, stripTags, fetchWithTimeout } = require("./base");

/**
 * Slack
 * 用 Socket Mode：只需要 App-Level Token（xapp-）就能实时收消息，
 * 不用配公网回调地址。Bot Token（xoxb-）用来取频道名和发消息。
 */
class SlackSource extends Source {
  constructor(id, cfg, emit) {
    super(id, cfg, emit);
    this.ws = null;
    this.retry = 3000;
    this.channels = new Map();
    this.users = new Map();
    this.unread = new Map();
    this.pingTimer = null;
  }

  appToken() {
    return String(this.cfg.appToken || "").trim();
  }
  botToken() {
    return String(this.cfg.botToken || "").trim();
  }

  async slackApi(method, params, useBot) {
    const token = useBot && this.botToken() ? this.botToken() : this.appToken();
    const res = await fetchWithTimeout(
      "https://slack.com/api/" + method,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(params || {})
      },
      15000
    );
    return res.json();
  }

  async start() {
    if (!this.appToken()) {
      this.setStatus("off", "未填写 App-Level Token（xapp- 开头）");
      return;
    }
    this.stopped = false;
    this.setStatus("connecting");
    await this.open();
  }

  async open() {
    if (this.stopped) return;
    try {
      const data = await this.slackApi("apps.connections.open", {});
      if (!data.ok) {
        throw new Error(data.error === "invalid_auth" ? "401 Token 无效" : data.error || "握手失败");
      }
      this.openWs(data.url);
    } catch (e) {
      this.setStatus("error", this.prettyErr(e));
      this.scheduleReconnect();
    }
  }

  openWs(url) {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.retry = 3000;
      this.setStatus("online");
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

      if (msg.type === "hello") return;

      if (msg.type === "disconnect") {
        try { ws.close(); } catch (e) {}
        setTimeout(() => this.open(), 1500);
        return;
      }

      if (msg.envelope_id) {
        try { ws.send(JSON.stringify({ envelope_id: msg.envelope_id })); } catch (e) {}
      }

      if (msg.type === "events_api" && msg.payload && msg.payload.event) {
        this.onEvent(msg.payload.event);
      }
    });

    ws.on("close", () => {
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on("error", () => {});
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const wait = this.retry;
    this.retry = Math.min(this.retry * 2, 60000);
    this.timeout(wait, () => this.open());
  }

  async onEvent(ev) {
    if (!ev || ev.type !== "message") return;
    if (ev.subtype) return;          // 编辑、加入、机器人消息等先跳过
    if (ev.bot_id) return;
    if (!ev.channel || !ev.text) return;

    const info = await this.channelInfo(ev.channel);
    const who = await this.userName(ev.user);

    const prev = this.unread.get(ev.channel) || 0;
    this.unread.set(ev.channel, prev + 1);

    const ts = ev.ts ? Math.round(parseFloat(ev.ts) * 1000) : Date.now();

    this.pushItem({
      key: ev.channel,
      title: info.name,
      subtitle: info.subtitle,
      text: clip(stripTags(ev.text), 90),
      date: ts,
      unread: this.unread.get(ev.channel),
      photo: info.avatar,
      link: info.link || null,
      messages: [{ who, text: clip(stripTags(ev.text), 100), out: false, date: ts }],
      canReply: true
    });
  }

  async channelInfo(id) {
    if (this.channels.has(id)) return this.channels.get(id);
    let info = { name: "Slack 频道", subtitle: "Slack", avatar: null, link: null };
    try {
      const data = await this.slackApi("conversations.info", { channel: id }, true);
      if (data.ok && data.channel) {
        const c = data.channel;
        const isIM = c.is_im || c.is_mpim;
        info = {
          name: isIM ? await this.userName(c.user) : c.name_normalized || c.name || "频道",
          subtitle: isIM ? "Slack 私信" : "Slack · #" + (c.name || ""),
          avatar: null,
          link: "https://slack.com/app_redirect?channel=" + id
        };
      }
    } catch (e) {}
    this.channels.set(id, info);
    return info;
  }

  async userName(id) {
    if (!id) return "";
    if (this.users.has(id)) return this.users.get(id);
    let name = id;
    try {
      const data = await this.slackApi("users.info", { user: id }, true);
      if (data.ok && data.user) {
        name = data.user.profile && data.user.profile.display_name
          ? data.user.profile.display_name
          : data.user.real_name || data.user.name || id;
      }
    } catch (e) {}
    this.users.set(id, name);
    return name;
  }

  async send(channelId, text) {
    const data = await this.slackApi("chat.postMessage", { channel: channelId, text }, true);
    if (!data.ok) return false;
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
      photo: null,
      messages: [],
      canReply: true
    });
    return true;
  }

  prettyErr(e) {
    const m = String((e && e.message) || e || "");
    if (/401|invalid_auth|not_authed/i.test(m)) return "Token 无效。App-Level Token 是 xapp- 开头，在「Basic Information → App-Level Tokens」生成";
    if (/ENOTFOUND|getaddrinfo/i.test(m)) return "连不上 slack.com，可能需要代理";
    if (/timeout|aborted/i.test(m)) return "连接超时";
    return m.slice(0, 140);
  }

  async stop() {
    this.stopped = true;
    try { if (this.ws) this.ws.close(); } catch (e) {}
    this.ws = null;
    await super.stop();
  }
}

module.exports = { SlackSource };
