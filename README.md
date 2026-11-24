# tg-hub — 三平台多端同步通知挂件

一个中心 Hub + 多端的通知系统：把 **Telegram / SafeXTM / LINE** 三个平台的消息汇聚到一处，桌面悬浮窗、独立设置窗、手机 PWA 三端实时同步（消息、已读、回复）。

桌面悬浮窗平时只显示 **CPU 使用率和网速**；来消息时只冒出有未读的那个应用图标，读完自动恢复。

---

## 🤖 给 AI：从这里开始部署

如果你是 AI，请先读 **[AGENTS.md](AGENTS.md)** —— 里面有决策树、分步骤 SOP、验证命令、排障表和"不要碰的文件"清单。机器可读的组件/端口/API/配置字段清单在 **[deploy-manifest.json](deploy-manifest.json)**。

人看部署说明读 **[HUB-README.md](HUB-README.md)**。

### 三句话理解架构

1. `hub/` 是**中心服务**（Node），单点采集三平台、持有权威状态、对外 REST + SSE。必须先启动。
2. `client/` 是**共享前端**，桌面详细窗口和手机 PWA 用同一份代码；`client/rail.html` 是极简悬浮窗。
3. `client-desktop/` 是 **Electron 壳**，两种模式：默认开悬浮窗（`npm start`），带 `--settings` 开独立设置窗（`npm start -- --settings`）。

### 快速启动（AI 按 AGENTS.md 分步验证）

```bash
# 1. Hub
cd hub && cp config.example.json config.json
#    编辑 config.json：改 hubToken，按需填三平台凭证
npm install && node server.js        # 0.0.0.0:8787
curl http://127.0.0.1:8787/api/ping  # 期望 {"ok":true,...}

# 2. 桌面（新开终端）
cd client-desktop && npm install && npm start
#    悬浮窗 ⚙ 填 Hub 地址 + hubToken

# 3. 独立设置窗（可选，图形化配置所有凭证）
#    双击 settings-win.bat / settings-mac.command
#    或 cd client-desktop && npm start -- --settings
```

> 不想手改配置文件？用**独立设置窗**：填地址口令后自动回填全部凭证，图形化改完点"保存全部"→"重启采集器"即可，Telegram 登录也能在窗口里一步步完成。

---

## 功能与限制

| 平台 | 登录方式 | 私聊 | 群聊 | 实时性 |
| --- | --- | --- | --- | --- |
| Telegram | 本人账号（MTProto） | 收发 ✅ | 收发 ✅ | 真·实时 |
| SafeXTM | Bot API | 收发 ✅ | 仅机器人所在群 | 长轮询准实时 |
| LINE | 官方账号 / 手机转发 | 官方✅ / 转发仅看 | 官方需开加群 | webhook 实时 |

> **重要**：SafeXTM 和 LINE 受平台 API 限制，只能覆盖"跟机器人/官方账号相关"的会话，**无法镜像个人账号的全部私聊群聊**。只有 Telegram（用户账号）是完整收发。LINE 手机转发模式只能看通知、不能回复。

---

## 目录

```
hub/                中心服务（server.js / store.js / 三个采集器）
client/             三端共享 UI（index.html / rail.html / app.js / PWA）
client-desktop/     Electron 壳（HUD + 设置窗 settings.html）
settings-*.bat/command   设置窗双击入口
tools/line-worker.js     LINE 手机转发的 Cloudflare Worker 参考
AGENTS.md / deploy-manifest.json / HUB-README.md   部署文档
LINE-API-REFERENCE.md / FEATURES.md / TDLIB-NOTES.md   参考资料
```

旧的**单端版**（多来源 HUD）文档保留在 `README-legacy.md`、`FEATURES.md`、`index.html`、`login.html`、`electron/`、`line-setup.html`，本次多端交付**不使用**它们，也不要改动。

## 配置安全

- 凭证只存 `hub/config.json`，普通展示端只拿到脱敏状态。
- `/api/config/full`（设置窗回填用）返回明文凭证，**公网部署务必在反代层限制到本机**。
- `hub/state.json` 是消息状态，**不要删除**（删了丢历史）。
