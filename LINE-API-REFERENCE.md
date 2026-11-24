# LINE Messaging API 官方文档精读

> 来源：<https://developers.line.biz/en/docs/>（LINE Developers 官方文档，英文版）
> 精读日期：2026-11-23
> 整理目的：为 tg-hud 挂件的 LINE 来源（玩法 A，官方账号方式）提供权威、可核对的 API 参考。
> 说明：本文所有数字、限制、端点均来自上述官方文档；凡是官方文档未明确给出的，均标注「官方未公开」，不做推测。

---

## 目录

1. [先说结论：对整个文档站的判断](#1-先说结论)
2. [Messaging API 是什么、能做什么](#2-messaging-api-是什么能做什么)
3. [建号与凭证（含一处重要时效修正）](#3-建号与凭证)
4. [收消息：Webhook 全解](#4-收消息webhook-全解)
5. [消息类型](#5-消息类型)
6. [发消息：五种方式](#6-发消息五种方式)
7. [定价与免费额度](#7-定价与免费额度)
8. [限流与开发规范](#8-限流与开发规范)
9. [能力边界与常见误解澄清](#9-能力边界与常见误解澄清)
10. [与 tg-hud 现有实现的对照](#10-与-tg-hud-现有实现的对照)
11. [文档站完整索引](#11-文档站完整索引)

---

## 1. 先说结论

官方文档站共 13 个板块，和「在自己应用里收 LINE 消息」直接相关的只有 **Messaging API** 一个；它以**官方账号机器人**的视角工作，个人账号之间的私聊不在任何官方 API 的覆盖范围内。这与本项目先前的判断一致。

精读中发现 **3 处需要修正或强调**的事实，先列在前面：

| # | 事项 | 先前说法 | 官方文档实际说法 |
| --- | --- | --- | --- |
| 1 | 如何建 Messaging API 频道 | 在 LINE Developers Console 里直接创建 | **2024-09-04 起已不能在 Developers Console 直接创建**；必须先建 LINE 官方账号，再从 Official Account Manager 开通 Messaging API（[原文](https://developers.line.biz/en/docs/messaging-api/getting-started/#using-console)） |
| 2 | 已读回执 | 「LINE 不支持已读回执」 | 方向说反了。有 `POST /v2/bot/chat/markAsRead`，但它是**把用户发来的消息标记为已读（bot 让对方看到「已读」）**；**无法查看自己发出的消息被谁读了**。对挂件来说，两者都用不上（[原文](https://developers.line.biz/en/docs/messaging-api/mark-as-read/)） |
| 3 | 回复是否消耗额度 | 「回复走 push，约 200 条/月免费」 | **Reply message 不计入消息数**（官方明确），Push/Multicast/Broadcast/Narrowcast 才计入。项目里用 push 回复是可用但不经济的做法，可优化为 reply（[原文](https://developers.line.biz/en/docs/messaging-api/pricing/#sending-methods-that-are-counted-towards-the-number-of-messages)） |

---

## 2. Messaging API 是什么、能做什么

> "Use the Messaging API to build bots to provide personalized experiences on LINE to your users."
> — [Messaging API overview](https://developers.line.biz/en/docs/messaging-api/overview/)

### 通信模型

全部走 HTTPS + JSON。收消息**只有一种方式：Webhook 推送**——没有 `getUpdates` 之类的拉取接口。

```
用户给官方账号发消息
   → LINE 平台向 bot server 的 webhook URL 发 HTTP POST（webhook event object）
   → bot server 校验签名
   → bot server 通过 LINE 平台回复用户
```
（[原文](https://developers.line.biz/en/docs/messaging-api/overview/#how-messaging-api-works)）

这解释了为什么挂件玩法 A 必须有一个公网中转：家庭电脑没有公网地址，LINE 推不进来。

### 官方列出的能力清单

| 能力 | 说明 |
| --- | --- |
| 回复消息 | 给把官方账号加为好友的用户发 reply message |
| 随时主动发消息 | push message，可发给用户 / 群 / 多人聊天 |
| 多种消息类型 | 文本、贴图、图片、视频、音频、位置、优惠券、imagemap、template、Flex Message 等 11 类 |
| 获取用户发送的内容 | 通过 message ID 取图片/视频/音频/文件（内容会在一定时间后自动删除） |
| 获取用户资料 | 一对一和群聊中可取 displayName、语言、头像、状态消息 |
| 加入群聊 | 在群里发消息、取群成员信息 |
| Rich menu | 聊天界面常驻自定义菜单 |
| Beacon | 用户进入 beacon 范围时触发 |
| Account link | 把自有服务账号和 LINE 账号安全关联 |
| 发送量统计 | 各类发送数、本月配额与已用量 |

（[原文](https://developers.line.biz/en/docs/messaging-api/overview/#what-you-can-do)）

---

## 3. 建号与凭证

### 3.1 建号流程（按 2026 年现行官方流程）

官方 Getting started 页面（[链接](https://developers.line.biz/en/docs/messaging-api/getting-started/)）给的两大步：

1. **创建 LINE 官方账号**
   - 注册 **Business ID**（可用 LINE 账号或邮箱注册）
   - 填写官方账号 entry form
   - 建好后在 **LINE Official Account Manager**（manager.line.biz）确认
2. **为官方账号开通 Messaging API**
   - 在 Official Account Manager 里开启 Messaging API → 系统创建 Messaging API channel
   - 用同一账号登录 **LINE Developers Console**（developers.line.biz/console）即可看到该频道
   - 首次使用需登记开发者信息（姓名 + 邮箱）

⚠️ **时效修正**：官方明确写着「As of September 4, 2024, it's no longer possible to create Messaging API channels directly from the LINE Developers Console」。本项目 `line-setup.html` 向导第 1 步写的是「打开 developers.line.biz → Create a LINE Official Account」，与现行入口不完全一致，建议改为「从 manager.line.biz 注册 Business ID 建官方账号，再开启 Messaging API」。功能上最终都能到达同一控制台，但照着旧文案点会找不到按钮。

另一个官方强调的坑：**Provider 一旦指定就不能更改或解绑**，不同 Provider 下同一用户会得到不同的 user ID，所以建号时 Provider 要选对（[原文](https://developers.line.biz/en/docs/messaging-api/getting-started/#step-one-enable-use-of-messaging-api)）。

### 3.2 四类 Channel access token

来源：[Channel access token 基础页](https://developers.line.biz/en/docs/basics/channel-access-token/)

| 类型 | 有效期 | 每频道可签发数 | 备注 |
| --- | --- | --- | --- |
| 自定义有效期（v2.1） | 最长 30 天 | 30 | 用 JWT 签发，安全性更高 |
| Stateless | 15 分钟 | 不限 | 签发后无法吊销，设计为每次调用都签一个 |
| Short-lived | 30 天 | 30 | 超过后最旧的自动失效 |
| **Long-lived（长期）** | **永不过期** | 1 | 仅 Messaging API 频道可签，可在 Console 随时签发/吊销 |

项目向导里让用户签的就是**长期 Token**——对个人小项目是最省事的正确选择。重新签发长期 Token 会让旧的立即失效；官方提供「续期最多 24 小时」的过渡期机制。

**v2.1 的 JWT 规格**（[原文](https://developers.line.biz/en/docs/messaging-api/generate-json-web-token/)）：RSA 2048 位、RS256；payload 中 `iss`=`sub`=Channel ID，`aud`=`https://api.line.me/`，`exp` 最长 30 分钟，`token_exp` 最长 30 天。

### 3.3 其他凭证

- **Channel secret**：32 位，在 Console 的 **Basic settings** 标签页获取（需 Admin 权限），用于 Webhook 验签。可重新签发，签发后旧的立即失效。
- **调用鉴权**：所有 API 请求头统一为 `Authorization: Bearer {channel access token}`。
- **域名分工**：绝大多数端点用 `api.line.me`；取用户发送的内容、上传/下载 rich menu 图片、上传受众文件用 `api-data.line.me`（[原文](https://developers.line.biz/en/reference/messaging-api/#domain-name)）。

---

## 4. 收消息：Webhook 全解

来源：[Receive messages (webhook)](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)

### 4.1 机制要点

- 用户加好友或发消息时，LINE 发 **HTTP POST** 到 webhook URL，body 是 webhook event object。
- bot server 长时间收不到会导致 LINE **暂停推送**。
- **必须先验签再处理**；官方**不公开 LINE 的 IP 地址**（且随时会变），禁止用 IP 白名单代替验签。
- 建议**异步处理**事件，避免阻塞后续请求。

### 4.2 事件类型全表

| type | 触发时机 | 可回复 | 一对一 | 群聊 | 多人聊天 |
| --- | --- | :---: | :---: | :---: | :---: |
| `message` | 用户发消息 | 是 | ✅ | ✅ | ✅ |
| `edit` | 用户编辑消息 | 是 | ❌ | ✅ | ❌ |
| `unsend` | 用户撤回消息 | — | ✅ | ✅ | ✅ |
| `follow` | 加好友 / 解除屏蔽 | 是 | ✅ | ❌ | ❌ |
| `unfollow` | 屏蔽官方账号 | — | ✅ | ❌ | ❌ |
| `join` | 官方账号被拉进群 | 是 | ❌ | ✅ | ✅ |
| `leave` | 被移出群 / 删除账号 | — | ❌ | ✅ | ✅ |
| `memberJoined` | 有新成员加入群 | 是 | ❌ | ✅ | ✅ |
| `memberLeft` | 有成员离开群 | — | ❌ | ✅ | ✅ |
| `postback` | 用户点 postback action | 是 | ✅ | ✅ | ✅ |
| `videoViewingComplete` | 用户看完指定 trackingId 的视频 | 是 | ✅ | ❌ | ❌ |
| `beacon` | 进入 Beacon 范围 | 是 | — | — | — |
| `accountLink` | 完成账号联动 | 是 | — | — | — |

### 4.3 事件对象结构（原文示例）

```json
{
  "destination": "xxxxxxxxxx",
  "events": [{
    "type": "message",
    "message": { "type": "text", "id": "...", "text": "Chicken, please." },
    "webhookEventId": "01H810YECXQQZ37VAXPF6H9E6T",
    "deliveryContext": { "isRedelivery": false },
    "timestamp": 1692251666727,
    "source": { "type": "group", "groupId": "Ca56...", "userId": "U4af..." },
    "replyToken": "38ef843bde154d9b91c21320ffd17a0f",
    "mode": "active"
  }]
}
```

关键字段：

- `destination`：bot 的 user ID，可用来确认事件确实发给这个 bot。
- `webhookEventId`：**去重键**。同一事件可能因网络原因重复投递，务必用它去重。
- `deliveryContext.isRedelivery`：是否为重送。重送时 `webhookEventId` 和 `replyToken` 保持不变，只有这个字段不同。
- `timestamp`：重送可能导致事件乱序，需要判断顺序时用它。
- `source.type`：`user` / `group` / `room`，附带对应的 `userId` / `groupId` / `roomId`。
- `replyToken`：用于 30 秒内的 reply（下详）。

### 4.4 去重与重送（Webhook redelivery）

- 功能**默认关闭**，需在 Console 的 Messaging API 标签页同时打开 Use webhook 和 Webhook redelivery。
- 仅当 bot server **没有返回 2xx** 时才重送。
- 官方**不公开**重送次数和间隔，且可能变更；不保证可靠送达。
- 重送内容除 `isRedelivery` 外与原事件相同 → 必须自行用 `webhookEventId` 去重。

### 4.5 验签算法

来源：[Verify webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)

1. 用 **channel secret** 作密钥，对 **原始 request body 字符串**做 **HMAC-SHA256**。
2. 结果做 **Base64**，与请求头 `x-line-signature` 比对。
3. 不一致或无该头 → 不处理，直接报错结束。

官方 openssl 验证命令：

```sh
echo -n '{"destination":"U8e7...","events":[]}' | \
  openssl dgst -sha256 -hmac '8c570fa6dd201bb328f1c1eac23a96d8' -binary | openssl base64
```

常见失败原因（官方列举）：验签前解析/反序列化/格式化了 body、用了别的算法（如 SHA1）、用了别的频道的 secret、转义字符被解释、编码不是 UTF-8、代理改写了 body。

> 对照项目：`tools/line-worker.js` 的 `handleWebhook()` 正是用 Web Crypto 的 HMAC-SHA256 + Base64 实现，且用 `await request.text()` 保持原始 body，符合官方要求。

### 4.6 Webhook URL 验证

来源：[Verify webhook URL](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/)

点 Console 的 **Verify** 按钮（或调 `POST /v2/bot/channel/webhook/test`）时，LINE 会发一个**不含事件的 POST**：

```json
{"destination": "xxxxxxxxxx", "events": []}
```

bot server 只要返回 **200** 即可。

### 4.7 收内容的两条硬限制

- **文本只能在 webhook 里拿一次**，没有任何 API 事后重新取文本。
- 图片/视频/音频/文件可通过 `GET https://api-data.line.me/v2/bot/message/{messageId}/content` 取，但**会在一定时间后自动删除**（官方未公开具体时长）。
- 引用消息只能拿到 `quotedMessageId`，**取不到被引用消息的内容**。

---

## 5. 消息类型

来源：[Message types](https://developers.line.biz/en/docs/messaging-api/message-types/)

| 类型 | 要点 |
| --- | --- |
| Text | 文本，可用 LINE emoji 和 Unicode emoji |
| Text (v2) | 可用 `{}` 语法插入 mention 和 emoji；**官方说今后新功能只加在 v2 上** |
| Sticker | 指定 package ID + sticker ID，只能用官方提供的贴图列表 |
| Image | 需给原图和预览图两个 HTTPS（TLS 1.2+）URL |
| Video | 视频 URL + 预览图 URL，HTTPS |
| Audio | 文件 URL + 时长，HTTPS |
| Location | 标题、地址、经纬度 |
| Coupon | 指定 coupon ID |
| Imagemap | 一张图上划分多个可点区域，可叠加视频 |
| Template | 4 种预设布局：Buttons / Confirm / Carousel / Image carousel |
| Flex Message | 基于 CSS Flexbox 的自定义布局，最灵活 |

所有消息类型都可挂 **Quick reply** 快捷回复按钮（显示在聊天底部）。

---

## 6. 发消息：五种方式

来源：[Sending messages](https://developers.line.biz/en/docs/messaging-api/sending-messages/)

| 方式 | 端点 | 目标 | 是否计入额度 |
| --- | --- | --- | :---: |
| Reply | `POST /v2/bot/message/reply` | 触发 webhook 的用户，`replyToken` 指定 | **否** |
| Push | `POST /v2/bot/message/push` | `to` 指定的 user/group/room ID | 是 |
| Multicast | `POST /v2/bot/message/multicast` | 一组 user ID | 是 |
| Narrowcast | `POST /v2/bot/message/narrowcast` | 按属性/受众筛选 | 是（60 次/小时） |
| Broadcast | `POST /v2/bot/message/broadcast` | 全部好友 | 是（60 次/小时） |

**通用限制**

- 单次请求**最多 5 个 message object**。
- 计数按**接收人数**算，与 message object 个数无关（给 5 人群发含 4 个对象的 push 只算 5 条）。
- 发给已 block 官方账号的用户或不存在的 user ID **不计入**。
- Narrowcast **不能发给群聊/多人聊天**；受众需先处于 `READY` 状态。

**Reply 的要点**

- `replyToken` 来自 webhook event，用一次即失效，过期后再用会报 `Invalid reply token`。
- **官方在这几个页面均未公开 replyToken 的具体有效秒数**——网上流传的「约 30 秒」并非出自本文引用的官方文档，故本文不采用该数字。实践上应**收到 webhook 后立刻回复**。
- 若想突破 replyToken 的时效/一次性限制，改用 push（但需要知道 user ID 且计入额度）。

**其他相关端点**

- 加载动画：`POST /v2/bot/chat/loading/start`
- 标记为已读：`POST /v2/bot/chat/markAsRead`（用 webhook 里的 `markAsReadToken`，**无过期时间**）
- 配额查询：`GET /v2/bot/message/quota`、`GET /v2/bot/message/quota/consumption`

---

## 7. 定价与免费额度

来源：[Messaging API pricing](https://developers.line.biz/en/docs/messaging-api/pricing/)

**所有计划每月都有一定量的免费消息**，额度因国家/地区和订阅计划而异。官方给出的**日本地区示例**：

| | Communication Plan | Light Plan | Standard Plan |
| --- | --- | :---: | :---: |
| 月费 | **免费** | JPY 5,000 | JPY 15,000 |
| 每月免费消息 | **最多 200 条** | 最多 5,000 条 | 最多 30,000 条 |
| 超额单条 | 不适用 | 不适用 | 最多 JPY 3/条 |

注意：

- 这是**日本地区示例**，官方明确说各地区计划不同，需查本地页面（中国大陆/台湾/泰国等各有链接）。项目里说的「约 200 条/月免费」即来自 Communication Plan。
- 超额后**直接报错不发送**，可查 `GET /v2/bot/message/quota/consumption`。
- **Reply 不计入消息数**；Push / Multicast / Broadcast / Narrowcast 计入。
- 收消息本身**不收费、不占额度**——这是挂件「只看通知」场景几乎零成本的原因。

---

## 8. 限流与开发规范

### 8.1 速率限制（按频道计）

来源：[Messaging API reference — Rate limits](https://developers.line.biz/en/reference/messaging-api/#rate-limits)

| 限制 | 适用端点（节选） |
| --- | --- |
| 2,000 请求/秒 | 其他大多数端点 |
| 370 请求/秒 | Issue short-lived channel access token |
| 200 请求/秒 | Send multicast、 coupon 相关、会员状态查询 |
| 100 请求/秒 | Display a loading animation |
| 60 请求/小时 | Send narrowcast、Send broadcast、统计类端点、Test webhook endpoint |
| 60 请求/分钟 | audience 相关 |
| 1,000 请求/分钟 | Set/Get webhook endpoint URL |
| 10 请求/秒 | Get rich menu list |

超限返回 `429 Too Many Requests`。

### 8.2 禁止事项

来源：[Development guidelines](https://developers.line.biz/en/docs/messaging-api/development-guidelines/)

- 不要对 LINE 平台发大量请求做压测/运维测试
- 不要借 LINE 平台给自己的 bot server 做压测
- 不要给同一用户发大量消息
- 不要向不存在的 user ID 发请求
- 不要用 API 反推用户属性
- **不要用 IP 白名单限制 webhook 来源**（LINE 不公开 IP）

### 8.3 推荐事项

- 收到 webhook 先**验签**
- 收到 `unsend` 事件后，**删除/取消显示**对应消息，尊重用户撤回
- 保存日志：API 的 `x-line-request-id`、时间、方法、端点、状态码；webhook 的发信 IP、时间、路径、状态码、原始 body、`x-line-signature`
- 按「非破坏性新增功能」设计：官方可能不通知就加端点、加可选字段、加枚举值、改字段顺序，代码要能容忍

---

## 9. 能力边界与常见误解澄清

| 问题 | 官方能力 | 对挂件的含义 |
| --- | --- | --- |
| 能收个人账号之间的私聊吗？ | 不能。API 只有官方账号视角 | 玩法 A 只能收发给官方账号的消息；这才需要玩法 B 走手机通知转发 |
| 能看"我发的消息被谁读了吗"？ | **不能**。只有 markAsRead（把用户消息标已读） | 挂件无法获得"对方已读"状态；与 Telegram 的已读回执方向相反 |
| 能拿到聊天记录吗？ | 不能。文本只在 webhook 到达时给一次 | 挂件只能从启动后收到的事件积累历史，无法回溯 |
| 能拿到用户手机号吗？ | 不能（FAQ 明确） | — |
| 能在群里随便发吗？ | 要先在 Console 打开「Allow bot to join group chats」，默认关闭；且一个群只能有一个官方账号 | 玩法 A 的群消息覆盖受此限制 |
| 消息是实时的吗？ | webhook 推送是即时的，但**多 message object 不保证按序显示**（FAQ） | 挂件按 timestamp 排序有意义 |
| 能撤回/删除已发的消息吗？ | 不能 | — |
| 能发 PDF 吗？ | 不能 | — |

多人聊天（multi-person chat）自 LINE 10.17.0 起并入群聊（group chat），旧的多人聊天仍可用；新创建的都算群聊（[原文](https://developers.line.biz/en/docs/messaging-api/group-chats/)）。

---

## 10. 与 tg-hud 现有实现的对照

| 项目实现 | 官方文档对应 | 状态与建议 |
| --- | --- | --- |
| `line.js` 的 `start()` 用 `/v2/bot/info` 验证 Token | `GET /v2/bot/info` | ✅ 正确 |
| Webhook 由 `tools/line-worker.js` 接收、验签、存 KV | 本文 4.5 / 4.6 | ✅ 正确，用原始 body 做 HMAC-SHA256 |
| `poll()` 每 6 秒拉 `/pull?token=&after=` | 官方无此 API，是自建中转协议 | ✅ 合理，等价弥补无 getUpdates |
| 用 `webhookEventId` 去重、`timestamp` 过滤 | 本文 4.3 / 4.4 | ✅ 正确 |
| `/v2/bot/profile/{userId}` 补用户名 | Users 端点 | ✅ 正确 |
| `/v2/bot/group/{id}/summary`、`member/{userId}` 补群名/成员名 | Group chats 端点 | ✅ 正确，注意需开启 Allow bot to join group chats |
| 回复走 `/v2/bot/message/push` | 本文 6 | ⚠️ **可优化**：改为 reply（用 webhook 的 `replyToken`）不占每月 200 条额度；但 replyToken 一次性且时效未知，push 更稳妥。建议保留 push，文档里说明取舍 |
| 界面文案「LINE 不支持已读回执」 | 本文 9 | ⚠️ **措辞不准**：应为「无法查看自己发出的消息是否被读」，bot 可主动 markAsRead |
| `line-setup.html` 第 1 步建号入口 | 本文 3.1 | ⚠️ **已过时**：2024-09-04 后不能再从 Developers Console 直接建频道，应改走 manager.line.biz 建官方账号再开通 |
| 免费额度「约 200 条/月」 | 本文 7 | ✅ 数字正确，但需注明是**日本 Communication Plan 示例**，其他地区不同 |

---

## 11. 文档站完整索引

来源：<https://developers.line.biz/en/docs/>

| 板块 | 用途 | 与本项目相关性 |
| --- | --- | --- |
| LINE Platform basics | Token、用户资料、API 状态 | ⭐⭐ 直接相关 |
| LINE Developers Console | 管理 channel / provider | ⭐⭐ 直接相关 |
| **Messaging API** | 官方账号机器人收发消息 | ⭐⭐⭐ 核心 |
| LINE Social Plugins | 分享/加好友按钮 | ❌ |
| LINE Login | 用 LINE 账号登录第三方站点 | ❌（可拿用户资料，但不能收消息） |
| LINE Login SDKs | 各平台登录 SDK | ❌ |
| LINE Front-end Framework (LIFF) | LINE 内网页应用 | ❌ |
| LINE MINI App | LINE 内小程序 | ❌ |
| Options for corporate customers | 企业功能，需申请 | ❌ |
| LINE Pay | 支付 | ❌ |
| LINE Ads API / Conversion API | 广告 | ❌ |
| LY Ads Network | 广告（仅日文） | ❌ |

### Messaging API 子页面分组（供深入查阅）

- **Quickstart**：overview、message types、getting started、issue token v2.1、build a bot、pricing
- **Guides**：send messages、character counting、get user IDs、stickers、emoji、audiences、quick replies、statistics、URL scheme、beacons、gain friends、account linking、icon/nickname、loading indicator、membership、coupons、quote tokens、mark as read、retry、stop using、measure impressions、Node.js 示例
- **Webhooks**：receive messages、verify URL、verify signature、check errors/statistics、SSL/TLS spec
- **Rich menus**：overview、use、per-user、switch tabs、stop、play
- **Flex Message**：send、elements、layout、video、simulator
- **Concepts**：actions、group chats、user consent
- **SDK**：[LINE Messaging API SDKs](https://developers.line.biz/en/docs/messaging-api/line-bot-sdk/)（官方支持多语言，本项目用原生 fetch 手写，无依赖）

---

## 附：关键原始链接速查

- API 总览：<https://developers.line.biz/en/docs/messaging-api/>
- API Reference：<https://developers.line.biz/en/reference/messaging-api/>
- 建号入门：<https://developers.line.biz/en/docs/messaging-api/getting-started/>
- 定价：<https://developers.line.biz/en/docs/messaging-api/pricing/>
- 收消息/Webhook：<https://developers.line.biz/en/docs/messaging-api/receiving-messages/>
- 验签：<https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/>
- 发消息：<https://developers.line.biz/en/docs/messaging-api/sending-messages/>
- 群聊：<https://developers.line.biz/en/docs/messaging-api/group-chats/>
- 四类 Token：<https://developers.line.biz/en/docs/basics/channel-access-token/>
- 标已读：<https://developers.line.biz/en/docs/messaging-api/mark-as-read/>
- 开发规范：<https://developers.line.biz/en/docs/messaging-api/development-guidelines/>
- FAQ：<https://developers.line.biz/en/faq/>
- 限流：<https://developers.line.biz/en/reference/messaging-api/#rate-limits>
