# tg-hub — 三平台多端同步消息挂件

Telegram / SafeXTM / LINE 三个平台，一个中心 Hub 统一收集，桌面悬浮窗 + 手机 PWA 多端看同一份消息。

## 为什么要中心 Hub（而不是每个端各自连平台）

三平台的收消息能力不同，决定了必须有一个中心采集点：

| 平台 | 收消息方式 | 多端问题 |
| --- | --- | --- |
| Telegram | MTProto 账号登录（GramJS），服务器权威 | 官方支持多端，但把登录放 Hub 后凭证只存一处、配置更简单 |
| SafeXTM | Bot API `getUpdates` 长轮询，**破坏性消费** | 两个端同时轮询会互相抢消息 → 只能 Hub 单点消费 |
| LINE | 只有 webhook 推送，**没有拉取接口** | 各端无法各自收推送 → 只能 Hub 接住 webhook 再分发 |

所以：**Hub 负责采集 + 持有权威状态；所有端读 Hub、经 Hub 回写已读/回复**。这就是多端同步的本质。

```
Telegram ─┐
SafeXTM  ─┼─→ [Hub 单点采集 + Store + REST/SSE] ─→ 桌面悬浮窗
LINE     ─┘                                    ─→ 手机 PWA
                                               ─→ 任意浏览器
```

一端标已读 → Hub 回写平台 + 广播 → 所有端未读清零。一端回复 → Hub 发消息 + 追加记录 → 所有端看到。

## 目录

```
tg-hud/
├── hub/                  中心服务
│   ├── server.js         HTTP 服务：REST + SSE + webhook + 登录状态机
│   ├── store.js          权威状态 + 版本 rev + 持久化
│   ├── telegram.js       GramJS 采集（登录一次，session 存 Hub）
│   ├── safextm.js        getUpdates 单点消费
│   ├── line.js           webhook / 手机转发采集
│   ├── config.example.json
│   └── package.json
├── client/               三端共享 UI（一份代码）
│   ├── index.html  app.js  style.css  manifest.json  sw.js
├── client-desktop/       桌面 Electron 壳（HUD + 设置窗，同一程序）
│   ├── main.js  preload.js  package.json  sysmon.js
│   └── settings.html     独立设置窗 UI（--settings 模式）
├── settings-win.bat / settings-mac.command   设置窗双击入口
```

## 部署（3 步）

### 1. 启动 Hub（一台常开的机器：云服务器 / NAS / 常开电脑）

```bash
cd hub
cp config.example.json config.json
# 编辑 config.json：改 hubToken，填各平台凭证
npm install          # 首次，安装 GramJS
node server.js       # 默认监听 0.0.0.0:8787
```

`config.json` 说明：

| 字段 | 填什么 |
| --- | --- |
| `hubToken` | 一串随机长口令，所有端用它连 Hub |
| `telegram.apiId` / `apiHash` | 从 [my.telegram.org](https://my.telegram.org/apps) 申请 |
| `telegram.session` | 留空，首次通过 `/api/tg/submit` 登录 state machine 自动写入 |
| `safextm.token` | SafeXTM 里 @BotFather `/newbot` 拿到的 Bot Token |
| `line.token` / `secret` | LINE 官方账号的 Channel access token / secret |
| `line.relayToken` | 玩法B手机转发用的口令 |

**公网访问**：Hub 需要各端能访问。用云服务器最省事；家庭宽带可用 Cloudflare Tunnel / frp 映射 8787 端口，或给自己的域名配反代。生产环境务必用 HTTPS（否则 token 明文传输）。

### 2. Telegram 登录（首次）

Hub 启动后，调登录状态机（桌面端会引导，或手动 curl）：

```bash
# 看当前步骤
curl -H "X-Hub-Token: 你的hubToken" http://HUB:8787/api/tg/auth
# 依次提交 手机号 → 验证码 →（如有）密码
curl -X POST -H "X-Hub-Token: 你的hubToken" -H "Content-Type: application/json" \
  -d '{"value":"+8613800138000"}' http://HUB:8787/api/tg/submit
```

session 自动存入 `config.json`，之后重启免登录。

### 3. 连接各端

**桌面 HUD（系统监控 + 按需通知）**：
```bash
cd client-desktop
npm install
npm start
```
默认是**贴边极小横条，只显示实时 CPU 使用率和上下行网速**，不显示任何应用图标。
- **来消息时**：只冒出「有未读的那个应用」图标（TG/SX/LN 中仅显示有消息的），外圈闪光 + 红色未读角标；读完消息图标自动消失，恢复纯系统监控
- 鼠标悬停图标 → 弹出小卡片看最近几条消息
- 点图标 → 打开完整详细窗口（左右分栏）
- ⚙ → 填 Hub 地址和口令（存本地，无需重复填）

窗口无边框、置顶、贴屏幕右边缘，宽度随图标数量自动伸缩。系统监控采样在 `client-desktop/sysmon.js`（每 1.5s 推送；Linux 显示真实网速，mac/win 网速显示 `--`），窗口逻辑在 `client-desktop/main.js`，外观在 `client/rail.html`。

**独立设置窗（推荐！图形化配置，不用改配置文件）**：
不想手动编辑 `hub/config.json`？双击 `settings-win.bat`（Windows）或 `settings-mac.command`（Mac/Linux）打开一个独立的设置窗口：

- **连接设置**：填 Hub 地址和连接口令，点「测试连接」，连上后自动显示「已连接」
- **Telegram**：填 apiId / apiHash、可选代理，在页面里直接完成登录（手机号 → 验证码 → 密码），不用敲命令
- **SafeXTM**：填 Bot Token
- **LINE**：填官方账号 Token/Secret，或手机转发的 relayToken
- 连上后各平台当前配置会**自动回填**，改完点底部「保存全部」，再到「维护工具」点「重启采集器」即可生效

设置窗和悬浮窗共用同一份连接配置，两边填一次就行；关闭设置窗不影响悬浮窗继续运行。

> 命令行等价写法：`cd client-desktop && npm start -- --settings`

**手机 PWA**：
把 `client/` 目录用任意静态服务器托管（或让 Hub 顺带托管），手机浏览器打开：

```
https://你的域名/client/index.html?hub=https://你的hub:8787&token=口令
```

URL 里的 hub/token 会存到手机本地，之后直接打开即可。iOS Safari「添加到主屏幕」、Android Chrome「安装应用」可像 App 一样全屏运行。

> 桌面和手机填**同一个 Hub 地址和口令**，就能看到同一份消息。

## LINE 两种玩法（都能多端）

- **玩法A（官方账号）**：`config.json` 填 `line.token` + `line.secret`，把 LINE 控制台 Webhook URL 设为 `https://你的域名/hook/line`。Hub 自动验签、收消息。
- **玩法B（手机转发）**：`config.json` 填 `line.relayToken`，Android MacroDroid 把 LINE 通知 POST 到 `https://你的域名/hook/line/notify?token=relayToken`，body `{"user":"发信人","text":"内容"}`。Hub 按发信人分会话。

两种玩法共用 `/hook/line` 系列端点，随时切换。

## Hub API（供二次开发）

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/ping` | GET | 健康检查（无需鉴权） |
| `/api/state?since=rev` | GET | 全量状态；rev 未变返回 `unchanged` |
| `/api/stream` | GET | SSE 实时推送状态变更 |
| `/api/read` | POST | `{sid,key}` 标记已读（回写平台+广播） |
| `/api/reply` | POST | `{sid,key,text}` 回复（回写平台+广播） |
| `/api/totals` | GET | 未读统计 |
| `/api/tg/auth` | GET | Telegram 登录状态 |
| `/api/tg/submit` | POST | `{value}` 提交手机号/验证码/密码 |
| `/api/config` | GET/POST | 读状态（脱敏）/ 更新凭证并重启采集器 |
| `/api/config/full` | GET | 读完整配置（含明文凭证），供本地设置窗回填表单；公网部署应限制到本机 |
| `/hook/line` | POST | LINE 官方 webhook（验签） |
| `/hook/line/notify` | POST | 手机转发（relayToken 校验） |

除 ping / hook 外均需 `X-Hub-Token: 口令` 头。

## 验证情况

- Hub 多端同步测试全绿：鉴权、消息注入、已读全局同步、SSE 双端推送、增量判断
- 客户端 UI 测试全绿：连接、列表、未读角标、点击已读、详情、来源筛选、手机详情切换、无 JS 错误
- 桌面 Electron 真机 e2e：悬浮窗正确连接 Hub、三来源条、会话与未读渲染正常
- 测试环境限制：Telegram 官网在沙箱连不通，GramJS 真机登录未测（逻辑复用已验证的单端版）；SafeXTM/LINE 用文档端点 + mock 验证

## 已知边界

- 免费额度：LINE 回复走 push，计入每月约 200 条（日本 Communication Plan 示例，其他地区不同）；Reply 不计额度但 replyToken 时效短，Hub 选了更稳的 push
- SafeXTM/LINE 只能收「发给机器人/官方账号」的消息，收不到个人账号全部会话（平台不开放）
- Hub 是单点：它挂了所有端都收不到新消息（历史状态仍在 state.json）。生产建议进程守护（systemd/pm2）
- 手机端是响应式网页/PWA，不是原生悬浮窗 App；iOS 无法做系统级悬浮窗（系统限制）
