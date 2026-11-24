"use strict";

const { Source, clip, stripTags, fetchWithTimeout } = require("./base");

/**
 * GitHub 通知
 * 按仓库聚合：一个仓库占一个"会话"，避免同一个仓库刷出十几条。
 */
class GitHubSource extends Source {
  constructor(id, cfg, emit) {
    super(id, cfg, emit);
    this.etag = "";
  }

  headers() {
    return {
      Authorization: "Bearer " + String(this.cfg.token || "").trim(),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tg-hud"
    };
  }

  async start() {
    if (!this.cfg.token) {
      this.setStatus("off", "未填写 Personal Access Token");
      return;
    }
    this.setStatus("connecting");
    await this.poll(true);
    this.every(Math.max(60, Number(this.cfg.interval) || 120) * 1000, () => this.poll(false));
  }

  async poll(first) {
    try {
      const h = this.headers();
      if (this.etag) h["If-None-Match"] = this.etag;
      const res = await fetchWithTimeout(
        "https://api.github.com/notifications?all=false&per_page=50",
        { headers: h },
        15000
      );
      if (res.status === 304) return;
      if (!res.ok) {
        if (res.status === 401) throw new Error("401 Token 无效或已过期");
        if (res.status === 403) throw new Error("403 触发速率限制或被拒绝");
        throw new Error("HTTP " + res.status);
      }
      this.etag = res.headers.get("etag") || "";
      const list = await res.json();

      const byRepo = new Map();
      for (const t of list) {
        const repo = (t.repository && t.repository.full_name) || "unknown";
        if (!byRepo.has(repo)) byRepo.set(repo, []);
        byRepo.get(repo).push(t);
      }

      for (const [repo, threads] of byRepo) {
        threads.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
        const latest = threads[0];
        const reasonMap = {
          mention: "@ 提到你",
          team_mention: "团队被 @",
          review_requested: "请求你审阅",
          assign: "指派给你",
          author: "你参与的讨论",
          comment: "新评论",
          ci_activity: "CI 结果",
          state_change: "状态变化",
          subscribed: "你订阅了",
          security_alert: "安全告警",
          manual: "手动订阅",
          push: "新提交",
          invitation: "邀请"
        };
        const reason = reasonMap[latest.reason] || latest.reason || "通知";

        this.pushItem({
          key: repo,
          title: repo,
          subtitle: "GitHub · " + reason,
          text: clip(stripTags(latest.subject && latest.subject.title), 90),
          date: Date.parse(latest.updated_at) || Date.now(),
          unread: threads.filter((t) => t.unread).length,
          photo: (latest.repository && latest.repository.owner && latest.repository.owner.avatar_url) || null,
          link: this.htmlUrl(latest.subject && (latest.subject.latest_comment_url || latest.subject.url)),
          messages: threads.slice(0, 3).map((t) => ({
            who: t.subject ? t.subject.type : "",
            text: clip(stripTags(t.subject && t.subject.title), 100),
            out: false,
            date: Date.parse(t.updated_at) || 0
          })),
          canReply: false,
          _threadIds: threads.map((t) => t.id)
        });
      }

      // 已经全部读掉的仓库要从挂件上撤掉
      for (const [repo] of this.repoCache || []) {
        if (!byRepo.has(repo)) this.dropItem(repo);
      }
      this.repoCache = new Map([...byRepo.keys()].map((k) => [k, 1]));

      this.setStatus("online");
    } catch (e) {
      this.setStatus("error", this.prettyErr(e));
    }
  }

  htmlUrl(apiUrl) {
    if (!apiUrl) return "https://github.com/notifications";
    return String(apiUrl).replace("https://api.github.com/repos/", "https://github.com/").replace("/pulls/", "/pull/");
  }

  prettyErr(e) {
    const m = String((e && e.message) || e || "");
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "连不上 api.github.com，可能需要代理";
    if (/timeout|aborted/i.test(m)) return "请求超时";
    return m.slice(0, 140);
  }

  async markRead(key) {
    const ids = this.threadIds && this.threadIds.get(key);
    if (!ids || !ids.length) return false;
    for (const id of ids) {
      try {
        await fetchWithTimeout("https://api.github.com/notifications/threads/" + id, {
          method: "PATCH",
          headers: this.headers()
        }, 10000);
      } catch (e) {}
    }
    return true;
  }
}

/**
 * GitLab 待办
 * 和 GitHub 一样按项目聚合，走 /api/v4/todos。
 */
class GitLabSource extends Source {
  constructor(id, cfg, emit) {
    super(id, cfg, emit);
  }

  base() {
    return String(this.cfg.baseUrl || "https://gitlab.com").replace(/\/+$/, "");
  }

  async start() {
    if (!this.cfg.token) {
      this.setStatus("off", "未填写 Private Token");
      return;
    }
    this.setStatus("connecting");
    await this.poll(true);
    this.every(Math.max(60, Number(this.cfg.interval) || 180) * 1000, () => this.poll(false));
  }

  async poll(first) {
    try {
      const res = await fetchWithTimeout(
        this.base() + "/api/v4/todos?state=pending&per_page=50",
        { headers: { "PRIVATE-TOKEN": String(this.cfg.token).trim() } },
        15000
      );
      if (!res.ok) {
        if (res.status === 401) throw new Error("401 Token 无效");
        throw new Error("HTTP " + res.status);
      }
      const list = await res.json();

      const byProject = new Map();
      for (const t of list) {
        const p = (t.project && t.project.path_with_namespace) || "unknown";
        if (!byProject.has(p)) byProject.set(p, []);
        byProject.get(p).push(t);
      }

      const seen = new Set();
      for (const [proj, todos] of byProject) {
        todos.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        const latest = todos[0];
        const actionMap = {
          assigned: "指派给你",
          mentioned: "提到你",
          build_failed: "构建失败",
          marked: "被标记",
          approval_required: "待审批",
          unmergeable: "无法合并",
          directly_addressed: "@ 你",
          review_requested: "请求审阅"
        };
        seen.add(proj);
        this.pushItem({
          key: proj,
          title: proj,
          subtitle: "GitLab · " + (actionMap[latest.action_name] || latest.action_name || "待办"),
          text: clip(stripTags(latest.target && latest.target.title), 90),
          date: Date.parse(latest.created_at) || Date.now(),
          unread: todos.length,
          photo: null,
          link: (latest.target && latest.target.web_url) || this.base(),
          messages: todos.slice(0, 3).map((t) => ({
            who: (t.target && t.target_type) || "",
            text: clip(stripTags(t.target && t.target.title), 100),
            out: false,
            date: Date.parse(t.created_at) || 0
          })),
          canReply: false
        });
      }

      for (const [proj] of this.projCache || []) {
        if (!seen.has(proj)) this.dropItem(proj);
      }
      this.projCache = new Map([...seen].map((k) => [k, 1]));

      this.setStatus("online");
    } catch (e) {
      this.setStatus("error", this.prettyErr(e));
    }
  }

  prettyErr(e) {
    const m = String((e && e.message) || e || "");
    if (/ENOTFOUND|getaddrinfo/i.test(m)) return "连不上 GitLab 服务器";
    if (/timeout|aborted/i.test(m)) return "请求超时";
    return m.slice(0, 140);
  }
}

module.exports = { GitHubSource, GitLabSource };
