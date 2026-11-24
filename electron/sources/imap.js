"use strict";

const { ImapFlow } = require("imapflow");
const { Source, clip, stripTags } = require("./base");

/**
 * 邮件（IMAP）
 * 一个邮箱账号在挂件里是一个"会话"：显示未读数 + 最新一封的主题。
 * 用轮询而不是常驻 IDLE——IDLE 需要长期持锁，网络抖动时容易卡死，
 * 邮件本身对秒级延迟也不敏感。
 */
class ImapSource extends Source {
  constructor(id, cfg, emit) {
    super(id, cfg, emit);
    this.clients = new Map(); // account.key -> ImapFlow
  }

  accounts() {
    const raw = this.cfg.accounts;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((a) => a && a.host && a.user && a.pass)
      .map((a) => ({
        name: a.name || a.user,
        host: a.host,
        port: Number(a.port) || (a.secure === false ? 143 : 993),
        secure: a.secure !== false,
        user: a.user,
        pass: a.pass,
        mailbox: a.mailbox || "INBOX"
      }));
  }

  async start() {
    const list = this.accounts();
    if (!list.length) {
      this.setStatus("off", "未添加邮箱账号");
      return;
    }
    this.setStatus("connecting");
    await this.poll(true);
    const okCount = list.filter((a) => this.clients.has(a.user)).length;
    if (okCount) this.setStatus("online", this.lastError);
    this.every(Math.max(60, Number(this.cfg.interval) || 180) * 1000, () => this.poll(false));
  }

  async connect(acc) {
    const client = new ImapFlow({
      host: acc.host,
      port: acc.port,
      secure: acc.secure,
      auth: { user: acc.user, pass: acc.pass },
      logger: false,
      greetingTimeout: 15000,
      socketTimeout: 90000,
      tls: { rejectUnauthorized: false }
    });
    client.on("error", () => {});
    await client.connect();
    return client;
  }

  async poll(first) {
    const list = this.accounts();
    let fail = 0;

    for (const acc of list) {
      let client = this.clients.get(acc.user);
      try {
        if (!client || !client.usable) {
          if (client) { try { await client.logout(); } catch (e) {} }
          client = await this.connect(acc);
          this.clients.set(acc.user, client);
        }

        const lock = await client.getMailboxLock(acc.mailbox);
        let exists = 0;
        let unseen = 0;
        const recent = [];
        try {
          exists = client.mailbox.exists || 0;
          const start = Math.max(1, exists - 11);
          if (exists > 0) {
            for await (const msg of client.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) {
              const env = msg.envelope || {};
              const from = (env.from && env.from[0]) || {};
              const seen = msg.flags && msg.flags.has("\\Seen");
              if (!seen) unseen++;
              recent.push({
                uid: msg.uid,
                subject: env.subject || "(无主题)",
                from: from.name || from.address || "未知发件人",
                address: from.address || "",
                date: env.date ? new Date(env.date).getTime() : 0,
                seen: !!seen
              });
            }
          }
        } finally {
          lock.release();
        }

        recent.sort((a, b) => b.date - a.date);
        const latest = recent[0];
        if (!latest) {
          this.pushItem({
            key: acc.user,
            title: acc.name,
            subtitle: acc.user,
            text: "收件箱是空的",
            date: Date.now(),
            unread: 0,
            photo: null,
            link: null,
            messages: [],
            canReply: false
          });
          continue;
        }

        this.pushItem({
          key: acc.user,
          title: acc.name,
          subtitle: acc.user,
          text: clip(stripTags(latest.subject), 90),
          date: latest.date || Date.now(),
          unread: unseen,
          photo: null,
          link: null,
          messages: recent.slice(0, 3).map((m) => ({
            who: m.from,
            text: clip(m.subject, 100),
            out: false,
            date: m.date
          })),
          canReply: false
        });
      } catch (e) {
        fail++;
        this.clients.delete(acc.user);
        this.lastError = acc.name + "：" + this.prettyErr(e);
        if (first) {
          this.emit({
            kind: "item",
            item: {
              sid: this.id,
              color: this.meta().color,
              sourceName: this.meta().name,
              key: acc.user,
              title: acc.name,
              subtitle: "连接失败",
              text: this.prettyErr(e),
              date: Date.now(),
              unread: 0,
              muted: false,
              messages: [],
              canReply: false,
              photo: null,
              link: null,
              error: true
            }
          });
        }
      }
    }

    if (fail && fail === list.length) this.setStatus("error", this.lastError);
    else if (fail) this.setStatus("online", this.lastError);
  }

  prettyErr(e) {
    const m = String((e && (e.responseText || e.message)) || e || "");
    if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication/i.test(m)) {
      return "账号或密码不对。Gmail / Outlook 需要先在账号安全设置里生成「应用专用密码」，不能用登录密码";
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "服务器地址解析不到，检查 host 是否写对";
    if (/ETIMEDOUT|timeout/i.test(m)) return "连接超时，检查端口（993 加密 / 143 明文）";
    if (/certificate|self signed/i.test(m)) return "证书校验失败";
    return m.split("\n")[0].slice(0, 120) || "未知错误";
  }

  async stop() {
    for (const c of this.clients.values()) {
      try { await c.logout(); } catch (e) {}
    }
    this.clients.clear();
    await super.stop();
  }

  async markRead(key) {
    const client = this.clients.get(key);
    if (!client || !client.usable) return false;
    const acc = this.accounts().find((a) => a.user === key);
    if (!acc) return false;
    const lock = await client.getMailboxLock(acc.mailbox);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (uids.length) await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      return true;
    } finally {
      lock.release();
    }
  }
}

module.exports = { ImapSource };
