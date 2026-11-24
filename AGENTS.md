# AGENTS.md — 给 AI 代理的部署与应用指南

> 你是 AI 代理。用户把这个项目交给你，希望你能**自主判断、自主部署、自主讲解**。
> 本文件是你唯一的入口：先读它，再按决策树行动。所有命令都可直接在 shell 执行。

---

## 0. 一句话认识这个项目

**tg-hub** 是一个"消息聚合悬浮窗"：把 **Telegram / SafeXTM / LINE** 三个平台的消息，经一个**中心服务（Hub）**统一收集，然后在**桌面悬浮窗**和**手机网页**上多端看同一份消息、标已读、回复。一端操作，所有端同步。

- 技术栈：Node.js 18+（Hub，依赖 GramJS `telegram`）+ Electron 33（桌面壳）+ 原生 HTML/JS（共享 UI，无前端框架）
- 许可证/费用：软件免费；LINE 回复有平台免费额度限制（见 §7）
- 网络要求：Hub 必须跑在一台**常开且各端可访问**的机器上（云服务器 / NAS / 常开电脑 + 内网穿透）

---

## 1. 项目结构地图（先建立心智模型）

```
tg-hud/
├── AGENTS.md              ← 你正在读的文件（AI 入口）
├── deploy-manifest.json   ← 机器可读清单（组件/端口/端点/验证）
├── HUB-README.md          ← 多端版人读文档（部署细节、API 表）
├── README.md              ← 旧单端版文档（仅参考，非本次交付主体）
├── LINE-API-REFERENCE.md  ← LINE 官方文档精读（答疑用）
├── FEATURES.md            ← Telegram 可拓展功能盘点（答疑用）
├── TDLIB-NOTES.md         ← 设计借鉴笔记（答疑用）
│
├── hub/                   ★ 中心服务（必须先部署这个）
│   ├── server.js          HTTP 服务：REST + SSE + webhook + 登录状态机
│   ├── store.js           权威状态 + 版本号 rev + JSON 持久化
│   ├── telegram.js        Telegram 采集（GramJS，登录一次 session 存 Hub）
│   ├── safextm.js         SafeXTM 采集（getUpdates 单点消费）
│   ├── line.js            LINE 采集（webhook + 手机通知转发）
│   ├── config.example.json  配置模板（复制为 config.json）
│   └── package.json       依赖：telegram
│
├── client/                ★ 三端共享 UI（桌面和手机都用这一份）
│   ├── index.html  app.js  style.css  manifest.json  sw.js
│
├── client-desktop/        ★ 桌面 Electron 壳（HUD + 独立设置窗，同一程序两种启动模式）
│   ├── main.js  preload.js  package.json（依赖 electron）
│   ├── sysmon.js            系统监控采样（CPU/网速）
│   └── settings.html        ★ 独立桌面设置窗 UI（--settings 模式加载）
│
├── settings-mac.command / settings-win.bat  ★ 独立桌面设置窗双击入口（新，非旧单端版）
├── electron/              旧单端版（保留备份，本次交付不用，可忽略）
├── tools/line-worker.js   LINE 玩法 B 的 Cloudflare Worker 参考代码
├── login.html / line-setup.html / index.html  旧单端版页面（可忽略）
└── start-mac.command / start-win.bat  旧单端版启动脚本（可忽略）
```

**关键认知**：本次交付主体是 `hub/` + `client/` + `client-desktop/` 这三块。其余是历史单端版和参考文档不要动、不必重写。

**两种桌面启动模式**（都在 client-desktop，共用 `userData/hub-client.json` 的连接配置）：
- 默认 `npm start` → 悬浮 HUD（CPU/网速 + 通知图标）
- `npm start -- --settings` → 独立桌面设置窗（集中配置 Hub 地址/口令、三平台凭证、Telegram 登录、来源状态、重启采集器）。双击入口是 `settings-win.bat`（Win）/ `settings-mac.command`（Mac/Linux）。

---

## 2. 决策树：先搞清用户到底要什么，再动手

按用户的要求走对应分支，**不要一上来就把三个平台全配了**（凭证没齐会卡住）：

```
用户说"部署/跑起来"
├─ 有服务器/云主机吗？
│   ├─ 有 → Hub 部署在服务器上（§4），各端填公网地址
│   └─ 没有 → 部署在本机，若要手机访问须内网穿透（§4.3）；仅本机桌面看则无需穿透
├─ 要接哪些平台？（可只接一个，config 里没填凭证的平台会自动跳过、不报错）
│   ├─ Telegram → 需要 apiId/apiHash（§4.2 登录），体验最完整（能收全部会话、能回复）
│   ├─ SafeXTM  → 需要一个 Bot Token（@BotFather /newbot）
│   └─ LINE     → 选玩法 A（官方账号 Token+Secret）或玩法 B（手机转发 relayToken，见 §6）
└─ 要在哪些端看？
    ├─ 桌面 → 部署 client-desktop（§5.1）
    ├─ 手机 → 静态托管 client/（§5.2）
    └─ 都要 → 两边填同一个 Hub 地址 + 口令即可同步
```

**如果用户只是问"怎么用/怎么配置"**（不是真要你操作服务器）：直接按 §5、§6、§7 用自然语言讲清楚，不要去改文件。

---

## 3. 部署前检查（动手前必做）

```bash
node --version    # 需要 >= 18，建议 20 LTS
npm --version
```

- 缺 Node：让人去 nodejs.org 装 20 LTS（或 `nvm install 20`）。
- 沙箱/服务器无公网 IP 但手机要访问：准备 Cloudflare Tunnel（`cloudflared tunnel --url http://localhost:8787`）或 frp/ngrok 之一。
- **生产环境务必 HTTPS**：否则 Hub 口令和平台 Token 明文传输。Cloudflare Tunnel / Nginx + Let's Encrypt 都行。

---

## 4. 部署 Hub（核心，必须先做）

### 4.1 启动服务

```bash
cd hub
cp config.example.json config.json
# 编辑 config.json：至少把 hubToken 改成一串随机长口令
#   生成口令：node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
npm install            # 首次安装 GramJS
node server.js         # 默认 0.0.0.0:8787
```

**验证（每一步都要验证，别跳）**：

```bash
curl http://127.0.0.1:8787/api/ping
# 期望：返回 JSON，含 "ok":true 之类（无需鉴权）
```

服务会在 `hub/state.json` 持久化消息状态。**不要删除该文件**（删了就丢历史）。

### 4.2 配置凭证

编辑 `hub/config.json`，字段含义：

| 字段 | 填什么 | 不填的后果 |
| --- | --- | --- |
| `hubToken` | 随机长口令，所有端用它连 | 必填，否则端连不上 |
| `telegram.apiId` / `apiHash` | 从 my.telegram.org/apps 申请（数字 + 字符串） | 留空则 Telegram 源不启用 |
| `telegram.session` | **留空**，首次登录后自动写入 | — |
| `telegram.proxy` | 国内网络可能需要 SOCKS5，否则可删 | 连不上 Telegram 时填 |
| `safextm.token` | SafeXTM 里 @BotFather `/newbot` 拿的 Token | 留空则 SafeXTM 不启用 |
| `line.token` / `line.secret` | 玩法 A：LINE 官方账号凭证 | 玩法 A 必填 |
| `line.relayToken` | 玩法 B：手机转发的口令，自定 | 玩法 B 必填 |

> 凭证没齐可以先启动，没配的平台只是不采集，不影响其他平台。

**Telegram 首次登录**（凭证填了才做；session 写入后免登录）：

```bash
# 1. 看当前登录步骤
curl -H "X-Hub-Token: 口令" http://127.0.0.1:8787/api/tg/auth
# 2. 按返回的 step 依次提交（手机号带国家码 → 验证码 → 如有密码再提交）
curl -X POST -H "X-Hub-Token: 口令" -H "Content-Type: application/json" \
  -d '{"value":"+8613800138000"}' http://127.0.0.1:8787/api/tg/submit
# 3. 重复"看步骤→提交"直到返回 ready；session 自动写进 config.json
```

**验证**：`/api/tg/auth` 返回 step=ready 或状态显示已连接。

### 4.3 公网访问（手机端 / 远端桌面需要）

- 云服务器：安全组放行 8787，配 HTTPS 反代。
- 家用机：Cloudflare Tunnel 最省事——
  ```bash
  cloudflared tunnel --url http://localhost:8787
  # 得到 https://xxx.trycloudflare.com，各端填这个地址
  ```
- 只要本机桌面看：跳过此步，桌面端填 `http://127.0.0.1:8787`。

---

## 5. 连接各端（Hub 跑起来之后）

### 5.1 桌面 HUD（系统监控 + 按需通知）

```bash
cd client-desktop
npm install         # 装 Electron 33（国内网络慢可用 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
npm start
```

默认是**贴边极小横条，平时只显示实时 CPU 使用率和上下行网速**，不显示任何应用图标。
- **来消息时**：只冒出「有未读的那个应用」图标（TG/SX/LN 中仅显示有消息的），外圈闪光 + 红色未读角标；读完消息图标自动消失，恢复纯系统监控
- ⚙ → 填 **Hub 地址**（如 `https://xxx.trycloudflare.com` 或 `http://127.0.0.1:8787`）和 **hubToken** → 保存（存本地免填）
- 鼠标悬停图标 → 小卡片看最近几条消息
- 点图标 → 打开完整详细窗口（左右分栏）

**验证**：屏幕右边缘出现极小横条显示 CPU/网速、无图标；注入一条消息后只出现对应应用图标 + 角标 + 闪光；标记已读后图标消失。

> 系统监控采样在 `client-desktop/sysmon.js`（Linux 真实网速，mac/win 显示 `--`）；窗口宽度/位置在 `main.js` 的 `railWidth()`/`edgePos()`；外观在 `client/rail.html`。

### 5.1b 独立桌面设置窗（集中配置，双击打开）

不想让用户逐个改 `config.json` / 记命令行时，用这个独立的图形设置窗。**它和 HUD 是同一个 Electron 程序、共用同一份本地连接配置**，但作为单独窗口打开、互不干扰。

```bash
# 双击启动（推荐给用户）：
#   Windows: settings-win.bat
#   Mac/Linux: settings-mac.command
# 等价命令：
cd client-desktop && npm install   # 若未装
npm start -- --settings
```

**能做什么**：填 Hub 地址/连接口令 → 连上后自动回填当前全部凭证 → 图形化修改 Telegram（apiId/apiHash/代理）、SafeXTM token、LINE（token/secret/relayToken）、hubToken → 驱动 Telegram 登录状态机（手机号→验证码→密码）→ 查看三来源状态 → 重启采集器。

**实现要点（AI 修改时注意）**：
- UI 在 `client-desktop/settings.html`，逻辑内联在文件底部 `<script>`。
- `main.js` 用 `process.argv.includes("--settings")` 判断模式；`createSettings()` 开窗；`proxyApi()` 用 Node `http/https` 代理 Hub 请求，**绕开 file:// 页面的跨域**。
- `preload.js` 暴露 `window.settingsApi`：`getConfig/saveConfig/api/openExternal/openGuide/close`。
- Hub 端依赖鉴权的 `GET /api/config/full`（返回明文凭证回填表单）；普通展示端仍用脱敏的 `/api/config`。公网部署应在反代层把 `/api/config/full` 限制到本机。

**验证**：双击脚本打开设置中心 → 填地址+口令显示「已连接」并回填凭证 → 改一项保存 → `GET /api/config/full` 值更新 → 悬浮窗仍正常显示 CPU/网速（不受影响）。

> 注意 userData 路径：真实 `npm start` 下是 `~/.config/tg-hub-desktop/hub-client.json`（Mac 在 `~/Library/Application Support/tg-hub-desktop/`）。测试时若用 `electron main.js --settings` 直接跑，会因读不到 package.json 使 app name 变成 Electron、配置落到别处——**测试要用 `cd client-desktop && electron . --settings`**。

### 5.2 手机 PWA

把 `client/` 目录用任意静态服务器托管（也可用 Hub 或 Nginx 顺带托管），手机浏览器打开：

```
https://你的静态域名/index.html?hub=https://你的hub地址&token=hubToken
```

URL 里的 hub/token 会存到手机本地。Android Chrome「安装应用」、iOS Safari「添加到主屏幕」可全屏运行。

**验证**：手机上出现和桌面相同的会话列表；一端点开会话标已读，刷新另一端未读角标消失。

> 关键：**桌面和手机填同一个 Hub 地址 + 同一个 hubToken**，才看得到同一份消息。

---

## 6. LINE 两种玩法（按需选，不要混）

| | 玩法 A：官方账号 | 玩法 B：手机转发 |
| --- | --- | --- |
| 要什么 | LINE 官方账号 Token + Secret | 一个自定 relayToken + Android 手机 |
| 收什么 | 发给官方账号的私聊/群 | 手机上**全部** LINE 通知（私聊/群/频道） |
| 能回复吗 | 能（走 push，占免费额度） | 不能（回复框自动隐藏） |
| 平台 | 不限 | 仅 Android（iOS 读不到通知内容） |
| 配置 | `line.token` + `line.secret` | `line.relayToken` |

- **玩法 A**：LINE 控制台把 Webhook URL 设为 `https://你的hub域名/hook/line`，Hub 自动验签收消息。
  > 注意：2024-09-04 起不能再从 Developers Console 直接建 Messaging API 频道，要先去 manager.line.biz 用 Business ID 建官方账号再开通。详见 `LINE-API-REFERENCE.md` 第 1 章。
- **玩法 B**：Android 装 MacroDroid，建宏「收到 LINE 通知 → HTTP POST」到
  ```
  https://你的hub域名/hook/line/notify?token=relayToken
  Body: {"user":"{title}","text":"{message}"}
  ```
  （`{title}`/`{message}` 是 MacroDroid 变量，自动替换成发信人和内容）。工具代码在 `tools/line-worker.js`。

---

## 7. 能力边界（如实告诉用户，别过度承诺）

| 做不到 | 原因 |
| --- | --- |
| 收 Telegram/SafeXTM/LINE **个人账号的全部会话** | 后两者只开放机器人/官方账号接口；LINE 个人号完全无 API。玩法 B 是读手机通知的折中，不是真账号接入 |
| iOS 系统级悬浮窗 | 系统限制，只能做 PWA 网页 |
| 多端各自独立收消息 | SafeXTM getUpdates 是破坏性消费、LINE 无拉取接口，必须中心 Hub 单点采集 |
| LINE 无限免费回复 | push 消息计入平台免费额度（日本 Communication Plan 约 200 条/月，各地区不同） |
| 查看"我发的消息被谁读了" | LINE 无此能力；markAsRead 是"把用户消息标已读"，方向相反 |

**Hub 是单点**：它挂了所有端都收不到新消息（历史仍在 `state.json`）。生产环境建议 systemd / pm2 守护。

---

## 8. Hub API 速查（二次开发 / 排障用）

除 `/api/ping` 和 `/hook/*` 外，均需请求头 `X-Hub-Token: 口令`。

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/api/ping` | GET | 健康检查（免鉴权） |
| `/api/state?since=rev` | GET | 全量状态；rev 未变返回 `unchanged`（省流量） |
| `/api/stream` | GET | SSE 实时推送状态变更 |
| `/api/read` | POST | `{sid,key}` 标已读（回写平台+广播） |
| `/api/reply` | POST | `{sid,key,text}` 回复（回写平台+广播） |
| `/api/totals` | GET | 未读统计 |
| `/api/tg/auth` | GET | Telegram 登录当前步骤 |
| `/api/tg/submit` | POST | `{value}` 提交手机号/验证码/密码 |
| `/api/config` | GET/POST | 读（脱敏）状态 / 更新凭证并重启采集器 |
| `/hook/line` | POST | LINE 官方 webhook（验签） |
| `/hook/line/notify` | POST | 手机转发（relayToken 校验） |

`sid` 取值：`telegram` / `safextm` / `line`。

---

## 9. 故障排查表（AI 遇到报错先查这里）

| 现象 | 最可能原因 | 处理 |
| --- | --- | --- |
| `curl /api/ping` 不通 | Hub 没起 / 端口不对 / 防火墙 | 看 `node server.js` 前台日志；确认 8787 放行 |
| 桌面/手机连不上 Hub | 地址或口令错、HTTPS/HTTP 混用 | 地址末尾别带 `/`；手机和桌面必须同地址同口令 |
| Telegram 登录卡在 wait-code | 没收到验证码 / 代理没配 | 检查手机号格式；国内网络需填 SOCKS5 proxy |
| SafeXTM 收不到消息 | Token 错 / Bot 没被拉进群 | 用假 token 测应报 401；确认 Bot 在目标群 |
| LINE 玩法 A 收不到 | Webhook URL 没设 / 没开 Use webhook | 控制台点 Verify；确认已开 webhook 开关 |
| LINE 玩法 B 收不到 | relayToken 两边不一致 / MacroDroid 被系统杀 | 口令必须完全一致；把 MacroDroid 加省电白名单 |
| 消息重复 | 多端各自runs了采集器 | 确认只有一个 Hub 在轮询 SafeXTM |
| 重启后消息没了 | 误删 `state.json` | 该文件是持久化状态，禁止删除 |
| Electron 启动崩溃 (SIGSEGV) | headless/GPU 问题 | 仅测试环境加 `--disable-gpu`；正常桌面不会 |

---

## 10. 给 AI 的行动准则

1. **先读 deploy-manifest.json** 取组件路径、端口、验证命令（机器可读，比人读文档精确）。
2. **分步执行、每步验证**：启动 Hub → ping → 配凭证 → 登录（如需要）→ 接端 → 验证同步。不要一次性改一堆再测。
3. **凭证通过环境变量或让用户填**，不要把用户提供的 Token/口令写进日志或对外输出。
4. **能力边界如实说**：做不到的（见 §7）明确告诉用户，不要编造。
5. **不碰历史单端版**（`electron/`、`index.html`、`login.html`、`line-setup.html`），本次交付是多端版。
6. **改配置后重启 Hub** 才会重连采集器（或调 `/api/config` POST）。
7. 用户说"继续/照做/?"这类简短确认时，直接执行下一步，不要再复述背景。
