/* tg-hub 共享客户端核心 —— 桌面悬浮窗与手机 PWA 共用
 * 只认 Hub 的权威状态：拉全量 + SSE 增量，所有已读/回复经 Hub 回写。
 */
(function () {
  "use strict";

  const SOURCE_META = {
    telegram: { name: "Telegram", color: "#2aabee", short: "TG" },
    safextm: { name: "SafeXTM", color: "#34d399", short: "SX" },
    line: { name: "LINE", color: "#06c755", short: "LN" }
  };
  const SOURCE_ORDER = ["telegram", "safextm", "line"];

  const S = {
    hub: "",
    token: "",
    state: { rev: 0, items: {}, sources: {}, me: {} },
    es: null,
    selected: null,       // "sid:key"
    connected: false,
    filterSid: "",        // 来源筛选
    q: "",                // 搜索
    replyDraft: {}
  };

  /* ---------- 配置 ---------- */
  function loadCfg() {
    const params = new URLSearchParams(location.search);
    const saved = safeJSON(localStorage.getItem("tghub.cfg") || "{}");
    S.hub = params.get("hub") || saved.hub || "";
    S.token = params.get("token") || saved.token || "";
    S.hub = String(S.hub || "").replace(/\/+$/, "");
  }
  function saveCfg() {
    localStorage.setItem("tghub.cfg", JSON.stringify({ hub: S.hub, token: S.token }));
    // 桌面壳持久化到本地文件（手机浏览器忽略）
    if (window.desktop && window.desktop.saveConfig) window.desktop.saveConfig({ hub: S.hub, token: S.token });
  }
  function safeJSON(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
  function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ "X-Hub-Token": S.token }, opts.headers || {});
    let body;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    return fetch(S.hub + path, Object.assign({}, opts, { headers, body }))
      .then((r) => r.json().catch(() => ({})));
  }

  /* ---------- 连接 ---------- */
  async function connect() {
    if (!S.hub || !S.token) { showSetup(!S.hub ? "请填写 Hub 地址" : "请填写连接口令"); return; }
    setConn("connecting");
    try {
      const ping = await fetch(S.hub + "/api/ping", { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
      if (!ping.ok) throw new Error("Hub 无响应");
      await pull();
      openStream();
      setConn("online");
      hideSetup();
    } catch (e) {
      setConn("off");
      showSetup("连不上 Hub：" + String(e.message || e));
    }
  }

  async function pull() {
    const since = S.state.rev || 0;
    const data = await api("/api/state?since=" + since);
    if (!data.unchanged) S.state = data;
    render();
  }

  function openStream() {
    if (S.es) S.es.close();
    const url = S.hub + "/api/stream?token=" + encodeURIComponent(S.token);
    try {
      const es = new EventSource(url);
      S.es = es;
      es.addEventListener("state", () => { pull().catch(() => {}); });
      es.addEventListener("hello", () => { setConn("online"); });
      es.onerror = () => { setConn("reconnecting"); };
    } catch (e) {
      // 某些环境无 EventSource，退化为轮询
      setInterval(() => pull().catch(() => {}), 4000);
    }
  }

  /* ---------- 动作（经 Hub 回写，多端同步） ---------- */
  async function markRead(sid, key) {
    const it = S.state.items[sid + ":" + key];
    if (!it || !it.unread) return;
    // 乐观更新，SSE 回来会校正
    it.unread = 0; render();
    try { await api("/api/read", { method: "POST", json: { sid, key } }); } catch (e) {}
  }
  async function reply(sid, key, text) {
    text = String(text || "").trim();
    if (!text) return;
    const r = await api("/api/reply", { method: "POST", json: { sid, key, text } });
    if (r.ok) {
      S.replyDraft[sid + ":" + key] = "";
      await pull();
    } else {
      toast("回复失败：" + (r.error || "未知错误"));
    }
  }

  /* ---------- 渲染 ---------- */
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  function sortedItems() {
    let arr = Object.values(S.state.items || {});
    if (S.filterSid) arr = arr.filter((i) => i.sid === S.filterSid);
    if (S.q) {
      const q = S.q.toLowerCase();
      arr = arr.filter((i) => (i.title || "").toLowerCase().includes(q) || (i.text || "").toLowerCase().includes(q));
    }
    arr.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.date || 0) - (a.date || 0);
    });
    return arr;
  }

  function render() {
    renderSources();
    renderList();
    renderDetail();
    renderMe();
  }

  function renderSources() {
    const box = $("#sources");
    if (!box) return;
    box.innerHTML = SOURCE_ORDER.map((sid) => {
      const m = SOURCE_META[sid];
      const st = S.state.sources[sid] || { status: "idle" };
      const dot = st.status === "online" ? "●" : st.status === "error" ? "▲" : "○";
      const cls = st.status === "online" ? "on" : st.status === "error" ? "err" : "";
      const active = S.filterSid === sid ? " active" : "";
      return '<button class="src ' + cls + active + '" data-sid="' + sid + '" title="' + esc(st.error || m.name) + '">' +
        '<span class="dot">' + dot + '</span>' + esc(m.short) + '</button>';
    }).join("");
    $$(".src", box).forEach((b) => b.onclick = () => {
      S.filterSid = S.filterSid === b.dataset.sid ? "" : b.dataset.sid;
      render();
    });
  }

  function renderList() {
    const box = $("#list");
    if (!box) return;
    const arr = sortedItems();
    if (!arr.length) {
      box.innerHTML = '<div class="empty">' + (!S.connected ? "未连接 Hub" : "暂无消息") + "</div>";
      return;
    }
    box.innerHTML = arr.map((it) => {
      const m = SOURCE_META[it.sid] || { short: "?", color: "#888" };
      const k = it.sid + ":" + it.key;
      const sel = S.selected === k ? " selected" : "";
      const unread = it.unread ? '<span class="badge">' + it.unread + "</span>" : "";
      const pin = it.pinned ? '<span class="pin">置顶</span>' : "";
      const av = it.photo
        ? '<img class="avatar" src="' + esc(it.photo) + '" alt="">'
        : '<span class="avatar ph" style="background:' + m.color + '">' + esc(m.short) + "</span>";
      return '<div class="row' + sel + '" data-k="' + esc(k) + '">' +
        av +
        '<div class="row-main"><div class="row-top"><span class="title">' + esc(it.title || "未命名") + "</span>" + pin +
        '<span class="time">' + fmtTime(it.date) + "</span></div>" +
        '<div class="row-bot"><span class="preview">' + esc(it.text || "") + "</span>" + unread + "</div></div></div>";
    }).join("");
    $$(".row", box).forEach((el) => {
      el.onclick = () => {
        const k = el.dataset.k;
        S.selected = k;
        const it = S.state.items[k];
        if (it) markRead(it.sid, it.key);
        render();
      };
    });
  }

  function renderDetail() {
    const box = $("#detail");
    if (!box) return;
    const it = S.selected ? S.state.items[S.selected] : null;
    if (!it) {
      box.innerHTML = '<div class="detail-empty">选择一个会话查看详情</div>';
      return;
    }
    const m = SOURCE_META[it.sid] || { name: it.sid };
    const msgs = (it.messages || []).map((msg) =>
      '<div class="msg ' + (msg.out ? "out" : "in") + '"><div class="bubble">' + esc(msg.text || "") + '</div><div class="who">' + esc(msg.who || "") + " · " + fmtTime(msg.date) + "</div></div>"
    ).join("");
    const canReply = !!it.canReply;
    const draft = S.replyDraft[S.selected] || "";
    box.innerHTML =
      '<div class="detail-head"><span class="src-tag" style="background:' + m.color + '">' + esc(m.name) + "</span>" +
      '<span class="detail-title">' + esc(it.title || "") + '</span>' +
      (it.link ? '<a class="open" href="' + esc(it.link) + '" target="_blank" rel="noopener">打开 ↗</a>' : "") + "</div>" +
      '<div class="msgs">' + (msgs || '<div class="empty">暂无消息内容</div>') + "</div>" +
      (canReply
        ? '<div class="reply"><input id="replyInput" placeholder="回复 ' + esc(it.title || "") + '…" value="' + esc(draft) + '"><button id="replyBtn">发送</button></div>'
        : '<div class="no-reply">此来源不支持回复（手机转发模式）</div>');
    const input = $("#replyInput", box);
    const btn = $("#replyBtn", box);
    if (input && btn) {
      input.oninput = () => { S.replyDraft[S.selected] = input.value; };
      const doSend = () => { reply(it.sid, it.key, input.value); };
      btn.onclick = doSend;
      input.onkeydown = (e) => { if (e.key === "Enter") doSend(); };
    }
  }

  function renderMe() {
    const el = $("#me");
    if (el) el.textContent = S.state.me && S.state.me.name ? S.state.me.name : "已连接";
  }

  function fmtTime(ms) {
    if (!ms) return "";
    const d = new Date(ms), now = new Date();
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (d.toDateString() === now.toDateString()) return hm;
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  function setConn(s) {
    S.connected = (s === "online");
    const el = $("#conn");
    if (el) { el.className = "conn " + s; el.title = s; el.textContent = s === "online" ? "已连接" : s; }
    const dot = $("#connDot");
    if (dot) dot.className = "conn-dot " + s;
  }

  function showSetup(msg) {
    const box = $("#setup");
    if (!box) return;
    box.style.display = "flex";
    if (msg) $("#setupMsg").textContent = msg;
    const h = $("#cfgHub"), t = $("#cfgToken");
    if (h && !h.value) h.value = S.hub;
    if (t && !t.value) t.value = S.token;
  }
  function hideSetup() { const box = $("#setup"); if (box) box.style.display = "none"; }

  function toast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg; el.style.display = "block";
    setTimeout(() => { el.style.display = "none"; }, 2600);
  }

  /* ---------- 设置面板 ---------- */
  function bindSetup() {
    const save = $("#cfgSave");
    if (save) save.onclick = () => {
      S.hub = String($("#cfgHub").value || "").trim().replace(/\/+$/, "");
      S.token = String($("#cfgToken").value || "").trim();
      saveCfg();
      connect();
    };
    const reset = $("#cfgReset");
    if (reset) reset.onclick = () => { localStorage.removeItem("tghub.cfg"); location.reload(); };
    const search = $("#search");
    if (search) search.oninput = () => { S.q = search.value.trim(); renderList(); };
  }

  /* ---------- 启动 ---------- */
  function init() {
    loadCfg();
    bindSetup();
    render();
    // 桌面壳：主进程推送本地保存的配置，收到后覆盖并连接
    if (window.desktop && window.desktop.onConfig) {
      window.desktop.onConfig((cfg) => {
        if (cfg && cfg.hub) {
          S.hub = String(cfg.hub).replace(/\/+$/, "");
          S.token = cfg.token || "";
          localStorage.setItem("tghub.cfg", JSON.stringify({ hub: S.hub, token: S.token }));
          hideSetup();
          connect();
        }
      });
    }
    connect();
    // 供外部（桌面端设置）触发重连
    window.TGHub = {
      reconnect: connect,
      getCfg: () => ({ hub: S.hub, token: S.token }),
      setCfg: (c) => {
        S.hub = String(c.hub || "").replace(/\/+$/, "");
        S.token = c.token || "";
        saveCfg(); connect();
      },
      state: () => S.state
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
