# 你好 👋

这里是我的机器人项目管理中心。**2026-11-15 做过一次现场校准**，以服务器实际运行为准。

## 🤖 项目清单

| 项目 | 仓库名 | 说明 | 运行位置 |
|---|---|---|---|
| **接码记账机器人** | [jieshou-jizhang-bot](https://github.com/x783586-collab/jieshou-jizhang-bot) | SafeW 验证码接码 + 自动记账；TG 记账 bot `@zhu18888888bot` | 服务器1（腾讯云 · 香港，Debian 13） |
| **平安能量站机器人** | [pingan-nengliangzhan](https://github.com/x783586-collab/pingan-nengliangzhan) | TRON 能量租赁；当前跑的是「平安能量站2」`@lyg5833bot`，`INTERNAL_MODE=1` 内部免费 | 服务器2（腾讯云 · 新加坡，Docker） |
| **内部能量机器人** | [neibu-nengliang-bot](https://github.com/x783586-collab/neibu-nengliang-bot) | 老板业务台：发免费能量、记 U 进出、利润、库存/地址 | **代码保留、当前未部署**（能力已并入能量站的内部模式） |
| **平安记忆库** | [pingan-jiyiku](https://github.com/x783586-collab/pingan-jiyiku) | 统一记忆库（Markdown vault，自动备份到 GitHub） | i7（2026-11-07 后备份暂停，等 i7 恢复） |
| **部署指南** | [bushu-zhinan](https://github.com/x783586-collab/bushu-zhinan) | 能量机器人部署运维文档 | - |
| **设备还原库** | [shebei-huanyuan](https://github.com/x783586-collab/shebei-huanyuan) | 每台设备一台账 + 一键还原脚本 | 各设备（已入库：mini、服务器1、服务器2） |

## 🖥️ 服务器

| 名称 | 位置 | 用途 |
|---|---|---|
| **服务器1** | 香港（腾讯云） | 接码记账机器人（SafewBot）+ 账本入口 `https://admin.huoyanbaobao8.top` |
| **服务器2** | 新加坡（腾讯云） | 平安能量站（当前内部免费模式）+ 音乐站 |

## 🛠️ 技术栈

- Python / aiogram（Telegram Bot）
- Docker / Docker Compose
- SQLite（业务数据）
- Cloudflare Tunnel（对外暴露）
- Tailscale（内网互通）

## 📝 开发流程（2026-11-15 修正）

以前写的「i7 改 → push → 服务器 pull」已经停用（`safewbot-autopull` 2026-11-11 关闭）。现在的真实流程：

1. 代码在 **服务器1** `/root/safewbot`（`main` 分支），它才是权威版本；i7 上的 `~/dev/` 只是工作副本。
2. 改完先本地语法检查，再用 `/usr/local/bin/safewbot-deploy` 部署（先 worktree 预检，再重启 `safewbot` + `tgbot`，改 `billcard.py` 时 `webadmin` 也要重启）。
3. `git push` 到 GitHub：`production` 分支 = 生产快照，`main` 分支同步对齐；回滚就从 `production` 拉。
4. 2026-11-15 已把服务器上积压的未提交改动（账单卡、进件权限、内部台账、日更提醒等）全部提交并推送，双分支 HEAD = `a6bf982`。

## ⚠️ 校准备注

- 三个「平安能量站」bot 并存过：`@uuusdtzy188bot`（最早客户版）、`@Gcbrjsk2bot`（旧文案）、`@lyg5833bot`（现在在跑的「平安能量站2」）。
- 能量站 2026-11-15 查库：3 个用户 / 39 单 / **0 笔充值**——当前不是对客户收款的业务，是内部免费通道。
- 服务器1 早期有个 8899 端口的临时 HTTP 服务暴露过 `/root`，2026-11-15 复查已不在运行。
