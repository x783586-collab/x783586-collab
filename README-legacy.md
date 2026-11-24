# 消息 HUD

屏幕边缘的一条窄挂件，把你在意的几个应用的消息收在一条竖条里。平时半透明贴在边上不抢眼，有新消息会自己亮一下、头像旁边冒红点；鼠标移上去看最近几条，点一下跳到对应应用。

默认只有 Telegram，其余来源在设置里逐个打开。

---

## 一、能接哪些来源

| 来源 | 要准备什么 | 能收 | 能在挂件里回复 |
| --- | --- | --- | --- |
| Telegram | 自己的账号（API ID + 登录一次） | ✅ 私聊 / 群 / 频道 | ✅ |
| 邮件 IMAP | 邮箱地址 + 应用专用密码 | ✅ | ❌（跳转到邮件客户端） |
| RSS / Atom | 订阅地址，无需账号 | ✅ | ❌ |
| GitHub | Personal Access Token | ✅ 通知流 | ❌ |
| GitLab | Private Token | ✅ 待办 | ❌ |
| Slack | App-Level Token + Bot Token | ✅ 频道 / 私信 | ✅ |
| Matrix | homeserver + access token | ✅ 房间 | ✅ |
| Discord | Bot Token（要开 MESSAGE CONTENT） | ✅ 频道 / 私信 | ✅ |
| SafeXTM | Bot Token（@BotFather /newbot） | ✅ 发给机器人的私聊 / 群 | ✅ |
| LINE | 官方账号 + Channel Access Token + 公网中转（免费部署） | ✅ 发给官方账号的私聊 / 群 | ✅（消耗 push 额度） |

**接不了的**：微信、QQ、WhatsApp 个人号都没有官方接口，靠逆向协议有封号风险，没做。企业微信、钉钉、飞书的群机器人只能发不能收，也不在列表里。

**SafeXTM 特别说明**：它只开放了 Bot API（兼容 Telegram Bot API），没有用户账号的登录接口。所以只能像 Discord 那样以机器人方式接入——收得到「发给这个机器人的消息」和机器人所在的群，收不到你账号的全部会话。

**LINE 特别说明**：LINE 只开放 Messaging API（机器人视角），且**只支持 webhook 推送**——没有 Telegram 那样的轮询接口，家庭电脑收不到推送，所以需要一个公网中转。项目自带 [tools/line-worker.js](tools/line-worker.js)，免费部署到 Cloudflare Workers 即可（文件头部有完整步骤，约 5 分钟）。玩法 A：建一个免费官方账号（用你自己的 LINE 账号就能建，不需要额外的机器人账号），能收发给它的私聊和所在群消息，挂件里回复走 push 消息（消耗每月约 200 条免费额度）。玩法 B：**不想建官方账号？** 用 Android 手机的 MacroDroid 监听 LINE 通知，转发到中转的 `/notify` 端点（配置见文件头注释），能收到手机上真实的全部 LINE 消息（私聊/群/频道），只是不能在挂件里回复，且 iOS 做不了。

每个来源独立连接，一个掉线不影响其他。

---

## 二、运行

需要 [Node.js](https://nodejs.org)（LTS 版，一路下一步）。

双击 `start-mac.command`（macOS）或 `start-win.bat`（Windows）。第一次会自动装依赖，大约一两分钟，黑窗口停着不动是正常的。

启动后屏幕右侧出现一条窄挂件。第一次如果什么都没配，会弹出 Telegram 登录向导，可以关掉——先用设置里的其他来源也行。

---

## 三、加一个来源

点挂件底部的齿轮 → **消息来源** → 找对应的那行 → 点「配置」→ 填凭证 → **测试连接** → 保存并启用。LINE 例外：点「配置」会打开一个**分步向导窗口**，从部署中转到接通 LINE 每一步都能当场验证，跟着点就行。

填错了会当场显示具体原因，不用猜。

| 来源 | 凭证怎么拿 |
| --- | --- |
| **邮件** | Gmail / Outlook 要在账号安全设置里生成「应用专用密码」，直接用登录密码一定失败。QQ 邮箱在「设置 → 账户」开启 IMAP 并拿授权码 |
| **RSS** | 直接粘贴地址。想加名字就写成 `少数派 \| https://sspai.com/feed`，一行一个 |
| **GitHub** | Settings → Developer settings → Personal access tokens → 勾 `notifications` |
| **GitLab** | Preferences → Access Tokens → 勾 `read_api`。自建实例记得把地址改成自己的 |
| **Slack** | 建 App → Basic Information → App-Level Tokens（`xapp-`，勾 `connections:write`）；再在 OAuth & Permissions 加 `channels:history` `chat:write` 拿 Bot Token（`xoxb-`） |
| **Matrix** | Element → 设置 → 帮助与关于 → 访问令牌。homeserver 写完整地址，含 `https://` |
| **Discord** | 开发者门户 → 建应用 → Bot → Reset Token；**务必打开 MESSAGE CONTENT INTENT**；再把 Bot 邀请进服务器 |
| **SafeXTM** | 打开 SafeXTM → 搜索 **@BotFather** → 发送 `/newbot` → 按提示起名 → 复制完整 Token（形如 `4839574812:AAFD...`） |
| **LINE** | 玩法 A：① [developers.line.biz](https://developers.line.biz) 用你的 LINE 账号登录，免费创建官方账号 → 建 Messaging API 频道 → 签发 **Channel access token**（长期）；② 把项目里的 `tools/line-worker.js` 部署到 Cloudflare Workers（步骤在文件头部注释里），得到 Worker 地址；③ 把 Worker 地址填进频道的 Webhook URL 并点 Verify；④ 挂件里填 Worker 地址、中转口令、Channel Access Token。玩法 B：不建官方账号，只部署 Worker 并填地址 + 口令，手机端按 `tools/line-worker.js` 头部注释配 MacroDroid |

**Discord 特别注意**：Bot 只收得到它被邀请进去的服务器里的消息。只建 Bot 不邀请，挂件永远是空的。

---

## 四、用 Telegram 的话

这条最麻烦，因为要连 Telegram 服务器，必须有「应用身份」。这是官方机制，所有第三方客户端都一样。

1. 浏览器打开 **https://my.telegram.org**，输入手机号（带国家码）
2. 验证码发到你的 **Telegram 应用**里，不是短信——去聊天列表找 "Telegram" 官方账号
3. 登录后点 **API development tools**
4. 随便填：App title 写 `hud`，Platform 选 `Desktop`
5. 复制 **App api_id**（数字）和 **App api_hash**（32 位）

> 这两个值等于这台电脑的身份凭证，别发群里也别截图分享。

### 卡住了？对照这几条

| 现象 | 原因与处理 |
| --- | --- |
| 网页打不开 | `my.telegram.org` 在部分网络环境无法直连，先开代理。挂件连 Telegram 走另一条通道，不受影响 |
| 收不到验证码 | 验证码不发短信，去 Telegram 里找官方账号的对话 |
| too many attempts | 输错太多次，等 10-30 分钟再试 |
| 页面直接显示了 api_id | 这个手机号以前建过应用，复用原来那组即可 |
| API_ID_INVALID | id 或 hash 抄错，或用了网上流传的公共 id（会被限制）。必须自己申请 |

登录向导里也内置了这 5 步，展开就能看。

---

## 五、日常怎么用

| 操作 | 效果 |
| --- | --- |
| 看窄条 | 一个圆 = 一个会话，左上角小色点 = 来源；右上角红数字 = 未读 |
| 鼠标悬停 | 弹出最近三条内容，能回复的来源会带输入框 |
| 单击头像 | 跳到对应应用，同时清零未读 |
| 点底部 `‹` | 展开完整列表，顶部有来源筛选 |
| 新消息到达 | 挂件从半透明变清晰，对应头像按来源色闪一圈，3 秒后暗回去 |
| 右键挂件 | 重新连接 / 登录 / 退出 |

窄条最多放 9 个，顺序与官方 Telegram 一致：置顶永远在前，其次未读，组内按服务器顺序；置顶会话在展开列表里有小图钉标记。

---

## 六、设置项

点 ⚙ 打开，改完点保存，不用重启。

| 分组 | 内容 |
| --- | --- |
| 消息来源 | 8 个来源的开关、状态、凭证配置 |
| 关注的会话 | 切到「只盯选中」，其余会话完全不显示不提醒（跨来源混选） |
| 不打扰 | 免打扰时段、只提醒被点名、机器人消息自动已读、一键静音 1 小时 |
| 关键词提醒 | 命中的消息标红，并穿透免打扰 |
| 提醒方式 | 系统通知、声音、未读角标 |
| 外观 | 左右贴边、平时不透明度、鼠标离开时点击穿透 |
| 快捷回复 | 最多 3 条，悬停卡片里一键填入 |
| 系统 | 开机自启、`Ctrl+Shift+T` 呼出/隐藏、`Ctrl+Shift+D` 静音一小时、配置导入导出 |

### 两个来自 TDLib 的做法

**冷启动缓存**：上次的列表存在本地，下次启动先显示出来，连上后覆盖。不用盯着空白等。

**未读以服务器为准**：Telegram 的未读不靠本地累加，服务器说「还剩 0 条」就立刻清零。你在手机上读了，挂件红点会跟着消失。

---

## 七、关于隐私

- 消息只在内存里流转，不落盘、不上传。本地只缓存会话标题和最后一条摘要，用于冷启动
- 所有凭证存在 `config.json`（macOS 在 `~/Library/Application Support/tg-hud/`，Windows 在 `%APPDATA%\tg-hud\`，Linux 在 `~/.config/tg-hud/`）
- 这个文件等于你所有账号的钥匙，别外传。导出配置时也会带上凭证，转发前先看一眼
- 不想用了：删掉这个文件，再去各平台把对应的 Token / 会话撤销掉

---

## 八、常见问题

| 现象 | 处理 |
| --- | --- |
| 挂件不出现 | 可能被别的窗口挡住了。`Ctrl+Shift+T` 呼出 |
| 邮件一直连不上 | 九成是用了登录密码而不是应用专用密码；端口 993 是加密，143 是明文 |
| RSS 一直转圈 | 订阅地址可能不通，或被墙。换个地址试试 |
| Discord 空的 | 没开 MESSAGE CONTENT INTENT，或 Bot 没被邀请进服务器 |
| Slack 报 invalid_auth | 用错 Token 类型了。接收要 `xapp-`，读取频道要 `xoxb-` |
| GitHub 报 403 | 触发速率限制（未认证 60 次/小时），确认 Token 填对了 |
| 换电脑后配置没了 | 用设置里的「导出配置」，在新机器导入 |
| 想让挂件更隐蔽 | 设置里把不透明度调到 30% 左右 |

---

## 九、想改样子

- `index.html` 是全部界面和样式，改完刷新即可，不用重新装依赖
- `electron/sources/` 下每个文件是一个来源，接口统一：`start()` / `stop()` / `markRead()` / `send()`，新增来源照抄一个最像的改
- 配色：`SRC_META` 里的 `color` 决定来源色点、筛选标签和脉冲光晕
