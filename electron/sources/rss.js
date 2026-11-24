"use strict";

const Parser = require("rss-parser");
const { Source, stripTags, clip, fetchWithTimeout } = require("./base");

/**
 * RSS / Atom 订阅
 * 每个订阅地址在挂件里是一个"会话"，title 用 feed 自己的标题。
 * 首次拉取只建立基线，不计未读；之后新增条目才累加。
 */
class RssSource extends Source {
  constructor(id, cfg, emit) {
    super(id, cfg, emit);
    this.parser = new Parser({
      timeout: 15000,
      headers: { "User-Agent": "tg-hud/1.0 (+desktop widget)", Accept: "application/rss+xml, application/xml, text/xml, */*" },
      customFields: { item: [["content:encoded", "contentEncoded"], ["dc:creator", "creator"]] }
    });
    this.baseline = new Set(); // 已完成基线建立的 feed url
    this.seen = new Map();     // url -> Set(entryId)
    this.entries = new Map();  // url -> 最近条目数组
  }

  feeds() {
    const raw = this.cfg.feeds;
    if (Array.isArray(raw)) {
      return raw
        .map((f) => (typeof f === "string" ? { url: f } : f))
        .filter((f) => f && /^https?:\/\//i.test(f.url || ""));
    }
    if (typeof raw === "string") {
      return raw.split(/[\n,]/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)).map((url) => ({ url }));
    }
    return [];
  }

  async start() {
    const feeds = this.feeds();
    if (!feeds.length) {
      this.setStatus("off", "未添加订阅地址");
      return;
    }
    this.setStatus("connecting");
    await this.poll(true);
    if (this.status !== "off" && this.status !== "error") this.setStatus("online");
    this.every(Math.max(60, Number(this.cfg.interval) || 300) * 1000, () => this.poll(false));
  }

  async poll(first) {
    const feeds = this.feeds();
    let ok = 0;
    let fail = 0;

    for (const f of feeds) {
      try {
        const res = await fetchWithTimeout(f.url, { headers: this.parser.options.headers }, 15000);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const xml = await res.text();
        const feed = await this.parser.parseString(xml);
        ok++;

        const items = (feed.items || []).slice(0, 20);
        const key = f.url;
        const firstRun = !this.baseline.has(key);
        let seenSet = this.seen.get(key);
        if (!seenSet) {
          seenSet = new Set();
          this.seen.set(key, seenSet);
        }

        const fresh = [];
        for (const it of items) {
          const id = it.guid || it.id || it.link || it.title || "";
          if (!id) continue;
          if (!seenSet.has(id)) {
            seenSet.add(id);
            if (!firstRun) fresh.push(it);
          }
        }

        this.entries.set(key, items);
        this.baseline.add(key);

        const latest = items[0] || {};
        const host = (() => {
          try { return new URL(f.url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
        })();

        this.pushItem({
          key,
          title: f.name || feed.title || host || "订阅",
          subtitle: host,
          text: clip(stripTags(latest.title || latest.contentSnippet || ""), 90) || "暂无内容",
          date: latest.isoDate ? Date.parse(latest.isoDate) : latest.pubDate ? Date.parse(latest.pubDate) : Date.now(),
          unread: firstRun ? 0 : fresh.length,
          photo: null,
          link: latest.link || f.url,
          messages: items.slice(0, 3).map((it) => ({
            who: feed.title || "",
            text: clip(stripTags(it.title || it.contentSnippet || ""), 100),
            out: false,
            date: it.isoDate ? Date.parse(it.isoDate) : it.pubDate ? Date.parse(it.pubDate) : 0
          })),
          canReply: false
        });
      } catch (e) {
        fail++;
        if (first) this.lastError = (f.name || f.url) + ": " + (e.message || e);
      }
    }

    if (fail && !ok) this.setStatus("error", this.lastError || "全部订阅地址拉取失败");
    else if (fail) this.setStatus("online", "部分订阅失败：" + this.lastError);
  }
}

module.exports = { RssSource };
