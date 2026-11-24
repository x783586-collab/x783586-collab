/**
 * tg-hud LINE 中转（Cloudflare Workers 参考实现）
 * ================================================================
 *
 * 为什么需要它：LINE 官方只提供 webhook 推送（POST 到一个公网 HTTPS
 * 地址），没有 Telegram 那样的轮询接口。家里的电脑没有公网地址，
 * 所以需要这一层公网中转：
 *
 *   LINE 平台 --webhook--> 本 Worker（暂存事件）
 *   tg-hud 挂件 --每 6 秒轮询--> 本 Worker 的 /pull
 *
 * 事件只存在你自己的 Cloudflare KV 里，挂件取走后按时间戳水位
 * 过滤，Worker 不做任何额外转发，代码全部在你眼前。
 *
 * ---------------------------------------------------------------
 * 部署步骤（免费，约 5 分钟）：
 *
 * 1. 注册/登录 https://dash.cloudflare.com → 左侧 Workers & Pages
 *    → Create Worker → 随便起个名（如 line-hud）→ Deploy
 * 2. 点 Edit code，把本文件内容全部粘贴进去，改掉下面两个常量：
 *      ACCESS_TOKEN = 自定义一串口令（挂件里"中转口令"填它）
 *      SECRET       = Channel secret（LINE 控制台 Messaging API
 *                     标签页底部可查）
 *    再点 Deploy。
 * 3. 给 Worker 绑 KV：Worker 页面 → Settings → Bindings →
 *    Variables & Secrets / KV Namespace → Add binding：
 *      类型 KV Namespace，变量名填 LH_KV，Namespace 新建一个
 *      （如 line-hud）即可。
 * 4. LINE Developers Console（developers.line.biz）打开你的
 *    channel → Messaging API 标签页：
 *      - Webhook URL 填  https://你的worker名.你的子域.workers.dev/webhook
 *      - 打开 Use webhook 开关
 *      - 点 Verify，显示 Success 即通
 * 5. tg-hud 挂件 → 设置 → LINE → 配置：
 *      中转服务地址 = https://你的worker...workers.dev
 *      中转口令     = 第 2 步的 ACCESS_TOKEN
 *      Channel Access Token = LINE 控制台签发的长 token
 *
 * 说明：也可以部署到任何能跑 JavaScript 的平台（Vercel 函数、
 * 自己的 VPS + caddy 等），只要实现 /webhook 和 /pull 两个行为。
 * 中国大陆直连 *.workers.dev 可能不稳定，可用自有域名绑定 Worker。
 */

// ★★★ 两个必改的常量 ★★★
const ACCESS_TOKEN = "change-me-to-a-long-random-string"; // 挂件"中转口令"
const SECRET = "replace-with-your-channel-secret";        // 验签用

// 事件在 KV 里最多保留多久（挂件只拉启动后的新事件，这里兜底清理）
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 2000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }
    if (url.pathname === "/notify") {
      return handleNotify(url, request, env);
    }
    if (url.pathname === "/pull" && request.method === "GET") {
      return handlePull(url, env);
    }
    return new Response("tg-hud LINE relay. OK\n", { status: 200 });
  }
};

/**
 * 手机通知转发（玩法 B，不需要 LINE 官方账号）
 * --------------------------------------------------
 * 用 Android 手机的自动化 App（如 MacroDroid）监听 LINE 通知，
 * 把每条通知 POST 到这里，挂件照样能收——这样连官方账号都不用建，
 * 而且收的是手机上真实收到的全部 LINE 消息（私聊、群、频道都有）。
 *
 *   POST /notify?token=你的口令
 *   Content-Type: application/json
 *   {"user": "发信人或群名", "text": "通知内容"}
 *
 * MacroDroid 里：添加宏 → 触发器「通知 → 收到通知 → 选 LINE」
 * → 动作「HTTP 请求」→ URL 填 https://你的worker.../notify?token=口令
 * → POST，Body 填 {"user":"{title}","text":"{message}"}（宏变量）。
 * 也支持 GET /notify?token=口令&user=xxx&text=xxx 简化调用。
 *
 * 缺点：手机要常开 MacroDroid 后台、iOS 做不了（读不了通知内容）。
 */
async function handleNotify(url, request, env) {
  const token = url.searchParams.get("token");
  if (token !== ACCESS_TOKEN) {
    return new Response("unauthorized\n", { status: 401 });
  }

  let body = {};
  if (request.method === "POST") {
    try { body = JSON.parse(await request.text()); } catch (e) {}
  } else {
    body = {
      user: url.searchParams.get("user") || "",
      text: url.searchParams.get("text") || ""
    };
  }

  const user = String(body.user || "LINE 手机通知").slice(0, 60);
  const text = String(body.text || body.message || "").slice(0, 800);
  if (!text) return Response.json({ ok: true, skipped: "empty text" });

  // 包装成 LINE webhook 事件的同构形状，挂件不用改任何逻辑
  const now = Date.now();
  const rid = now.toString(36) + Math.random().toString(36).slice(2, 8);
  const event = {
    relayTs: now,
    timestamp: now,
    webhookEventId: "noti-" + rid,
    type: "message",
    source: { type: "user", userId: "Unoti" + hashStr(user) },
    message: { id: "n" + rid, type: "text", text },
    hudTitle: user   // 挂件优先用它当会话名
  };

  const data = (await env.LH_KV.get("buf", "json")) || { events: [] };
  data.events.push(event);
  data.events = data.events
    .filter((e) => (e.timestamp || e.relayTs || 0) > now - RETENTION_MS)
    .slice(-MAX_EVENTS);
  await env.LH_KV.put("buf", JSON.stringify(data));
  return Response.json({ ok: true });
}

function hashStr(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** LINE 平台推送的 webhook：验签 -> 追加进 KV -> 返回 200 */
async function handleWebhook(request, env) {
  const body = await request.text();

  // 验签：x-line-signature = base64(hmac-sha256(body, Channel secret))
  const sig = request.headers.get("x-line-signature") || "";
  if (!(await verifySign(body, sig))) {
    return new Response("bad signature\n", { status: 401 });
  }

  let payload = {};
  try { payload = JSON.parse(body); } catch (e) {}
  const events = Array.isArray(payload.events) ? payload.events : [];

  if (events.length) {
    const now = Date.now();
    const data = (await env.LH_KV.get("buf", "json")) || { events: [] };
    for (const ev of events) {
      if (ev && typeof ev === "object") {
        data.events.push(Object.assign({ relayTs: now }, ev));
      }
    }
    data.events = data.events
      .filter((e) => (e.timestamp || e.relayTs || 0) > now - RETENTION_MS)
      .slice(-MAX_EVENTS);
    await env.LH_KV.put("buf", JSON.stringify(data));
  }
  // LINE 的 Verify 按钮发的是空 events，同样返回 200
  return new Response("ok\n", { status: 200 });
}

/** 挂件轮询：返回 timestamp > after 的事件（只读，不写 KV） */
async function handlePull(url, env) {
  if (url.searchParams.get("token") !== ACCESS_TOKEN) {
    return new Response("unauthorized\n", { status: 401 });
  }
  const after = Number(url.searchParams.get("after") || 0);
  const data = (await env.LH_KV.get("buf", "json")) || { events: [] };
  const events = data.events.filter(
    (e) => (e.timestamp || e.relayTs || 0) > after
  );
  return Response.json({ events });
}

async function verifySign(body, sig) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body)
    );
    let b64 = "";
    for (const b of new Uint8Array(mac)) b64 += String.fromCharCode(b);
    return btoa(b64) === sig;
  } catch (e) {
    return false;
  }
}
