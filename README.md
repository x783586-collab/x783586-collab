# 你好 👋

这里是我的机器人项目管理中心。

## 🤖 项目清单

| 项目 | 仓库名 | 说明 | 运行位置 |
|---|---|---|---|
| **接码记账机器人** | [jieshou-jizhang-bot](https://github.com/x783586-collab/jieshou-jizhang-bot) | SafeW 验证码接码 + 自动记账 | safew 服务器（香港） |
| **平安能量站机器人** | [pingan-nengliangzhan](https://github.com/x783586-collab/pingan-nengliangzhan) | TRON 能量租赁，`@uuusdtzy188bot` | trxbot（新加坡） |
| **内部能量机器人** | [neibu-nengliang-bot](https://github.com/x783586-collab/neibu-nengliang-bot) | 团队内部版，保留免费通道 | safew 服务器（香港） |
| **平安记忆库** | [pingan-jiyiku](https://github.com/x783586-collab/pingan-jiyiku) | 统一记忆的自动备份 | i7 |
| **部署指南** | [bushu-zhinan](https://github.com/x783586-collab/bushu-zhinan) | 能量机器人部署运维文档 | - |

## 🖥️ 服务器

| 名称 | 位置 | 用途 |
|---|---|---|
| safew | 香港 | 接码记账机器人 + 内部能量机器人 + 账本入口 |
| trxbot | 新加坡 | 平安能量站机器人 |

## 🛠️ 技术栈

- Python / aiogram（Telegram Bot）
- Docker / Docker Compose
- SQLite（业务数据）
- Cloudflare Tunnel（对外暴露）
- Tailscale（内网互通）

## 📝 开发流程

1. 在 i7 上改代码（`~/dev/` 下）
2. `git push` 到 GitHub
3. 服务器 `git pull` + 重启容器
