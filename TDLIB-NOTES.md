# TDLib 学习笔记 & 对本项目的取舍

> 研究时间：2026-11-23。TDLib 版本参考 1.8.70（2026-11 的仓库状态）。
> 结论：**不迁移**，但吸收它的三个设计。理由见第四节。

---

## 一、TDLib 到底是什么

一句话：**TDLib 不是「Telegram 的 SDK」，它本身就是一个完整的 Telegram 客户端**，只是把界面层留空了。

官方对其的定义是 "a fully functional Telegram client which takes care of all networking, local storage and data consistency details"。也就是说，它替你做了这些事：

- MTProto 协议的全部加解密、密钥协商、DC 迁移
- 本地数据库（SQLite），离线可读，重启不丢
- 会话列表的权威排序（`chat.positions`，由服务器维护，客户端只负责按 `(position.order, chat.id)` 排）
- 更新（updates）的有序分发，保证状态一致性
- 文件下载/上传、缩略图、断点续传
- 多账号（ClientManager 管多个 client_id）

### 三种接口

| 接口 | 语言 | 特点 |
| --- | --- | --- |
| C++ (`tdclient`) | C++11+ | 零序列化开销，性能最好 |
| JSON (`tdjson`) | 任何能调 C 的语言 | 推荐给大多数集成，C ABI + JSON 字符串 |
| 原生绑定 | Java/Kotlin (JNI)、C# (.NET) | 平台专属，性能接近 C++ |

JSON 接口只有四个函数，这是它最优雅的地方：

```
td_create_client_id()       // 建一个实例，返回 id
td_send(client_id, json)    // 发请求，不等
td_receive(timeout)         // 拉响应/更新，阻塞
td_execute(json)            // 同步执行无副作用的方法
```

请求里 `@type` 是方法名，`@extra` 是自定义关联字段，响应会原样带回。整个 API 只有一个 `invoke` 入口，方法表由 `td_api.tl` 模式文件生成——所以库本身很小，不需要为每个方法写包装。

### 授权是被更新驱动的

这点和 GramJS 很不一样。TDLib 不是「你调 login 方法」，而是它持续推 `updateAuthorizationState`，你根据状态回应：

```
authorizationStateWaitTdlibParameters → 交 api_id/api_hash/数据库密钥
authorizationStateWaitPhoneNumber     → 交手机号
authorizationStateWaitCode            → 交验证码
authorizationStateWaitPassword        → 交两步验证密码
authorizationStateReady               → 完成
```

UI 是状态机的从属者，而不是流程的驱动者。这样做的好处：断线重连、session 失效、强制重新验证，都能自然回落到某个状态，不用写一堆 if。

### 一个改变我判断的事实

TDLib **支持私密聊天（Secret Chats）**。因为它就是完整客户端，E2E 加密层也在里面。

我之前在能力清单里写「Secret Chat 第三方库普遍不实现」——对 GramJS 成立，对 TDLib 不成立。同样，TDLib 也不支持语音/视频通话（VoIP 是独立栈），这一条仍然成立。

---

## 二、Node.js 里怎么用

两个包：

```bash
npm i tdl prebuilt-tdlib
```

```js
const tdl = require('tdl')
const { getTdjson } = require('prebuilt-tdlib')
tdl.configure({ tdjson: getTdjson() })

const client = tdl.createClient({ apiId: 12345, apiHash: '...' })
client.on('error', console.error)
client.on('update', (u) => { /* 所有更新都从这里来 */ })

await client.login()                      // 交互式：手机号/验证码/密码
const me = await client.invoke({ _: 'getMe' })
const chats = await client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit: 10 })
await client.close()                      // 必须关，否则进程挂着不退
```

两个类型陷阱：

- `bytes` 在 JSON 里是 **base64 字符串**，要自己解码
- `int64` 用字符串传，JS 的 number 装不下完整范围

---

## 三、TDLib vs 我们的 GramJS

| 维度 | GramJS（现用） | TDLib |
| --- | --- | --- |
| 形态 | 纯 JS 的 MTProto 实现 | 官方 C++ 客户端 + 本地数据库 |
| 安装 | `npm i telegram`，零原生依赖 | 每个平台一份 `.dll/.so/.dylib`，要配 asar unpack |
| 包体积 | ~2MB | 单平台 30–60MB，四平台打包上百 MB |
| 会话排序 | 自己按 `last.date` 排 | 服务器给的 `position.order`，权威 |
| 未读准确性 | 自己累加，会漂移 | 服务器更新直接给 `stillUnread` |
| 冷启动 | 空白，等网络 | 本地库，秒开 |
| 断线重连 | 自己处理 | 内建状态机 |
| Secret Chat | 不支持 | 支持 |
| 通话 | 不支持 | 不支持 |
| 调试 | JS 栈，好读 | 原生崩溃，难查 |
| 分发 | 拷目录就能跑 | 要为 win/mac(arm+x64)/linux 各打一份 |

**TDLib 的优势全部来自「它替你做状态管理」，代价是把部署复杂度搬到你身上。**

---

## 四、为什么这次不迁移

1. **分发形态不匹配**。这是个给人双击运行的 zip。TDLib 要为四个平台各带一份原生库，还得处理 asar 解包、代码签名、macOS 公证。现在的 GramJS 版解压即用。
2. **功能面很小**。我们只要「会话列表 + 未读 + 摘要 + 发送」，不碰历史检索、文件传输、多账号、Secret Chat。TDLib 的强项（本地全量库、复杂状态机）用不上。
3. **迁移等于重写**。TDLib 的方法名、数据结构、授权流程全不一样，`main.js` 要重写一遍，还得重新验证登录链路。
4. **收益可以用小改动拿到**。TDLib 最值钱的三条设计，不需要它也能实现——见下节。

**什么情况下应该换**：
- 要做成给非技术用户安装的正式 App（有安装包、签名、自动更新）
- 需要 Secret Chat、完整历史搜索、离线读全部消息
- 多账号同时在线
- 现有库在协议边缘 case 上反复出 bug

---

## 五、这次吸收了哪三条

### 1. 冷启动缓存（本地先有状态，网络后到）

新增 `chats.json`：会话列表（含头像、摘要、未读数）在每次状态变化 1.5 秒后落盘。下次启动**先渲染缓存**，连上后再被真实数据覆盖。

效果：打开就是熟悉的列表，而不是空条等三秒。头像超过 60KB 不入缓存，文件不会膨胀。

### 2. 未读以服务器为准（修掉一个真实缺陷）

原来的逻辑是 `unread = unread + 1`，纯本地累加。问题是：**你在手机上读了消息，这条挂件的红点不会消失**，越用越不准。

现在监听原始更新 `UpdateReadHistoryInbox` / `UpdateReadChannelInbox`，服务器一说「还剩 0 条」，立刻归零。TDLib 的做法就是「不要自己算，等服务器告诉你」。

### 3. 更新驱动的状态同步

顺手补了三个原来没有的同步：

| 更新 | 处理 |
| --- | --- |
| `UpdateEditMessage` | 消息被编辑，摘要跟着变 |
| `UpdateDeleteMessages` | 最后一条被撤回，重新拉列表回退到上一条 |
| `UpdateReadHistoryOutbox` | 对方读了我发的消息（留给以后做已读回执） |

---

## 六、如果想再往前一步

按性价比排序，TDLib 还有两条值得抄——**两条都已落地**：

1. **会话位置用服务器的** ✅ 已实现。`loadDialogs` 保留服务器返回顺序（即官方客户端顺序），提取 `dialog.pinned` 传给渲染层；新消息到达时，会话只提到「置顶区之后的第一个非置顶位」，不再打乱置顶。渲染层排序改为：置顶 → 未读 → 服务器原序（不按时间重排）。展开列表的置顶会话名字后有一个低调的小图钉。
2. **授权状态机** ✅ 已实现。`authState` 显式记录 `idle → connecting → wait-phone → wait-code → wait-password → verifying → saving → ready | fail` 每一步；登录窗口打开时通过 `login:get-state` 查询当前进度，**中断后从断点继续**（比如输验证码时关了窗口，重开直接回到验证码步骤），而不是从头再来。状态变化实时推送给向导（`login:state`）。
