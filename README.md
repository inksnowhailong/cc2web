<div align="center">

# c2web

**用手机 / 浏览器，遥控本机正在跑的 Claude Code 会话。**

Remote-control your local Claude Code session from your phone or browser.

</div>

---

电脑上正用 Claude Code 干得起劲，临时要出门？  
`c2web` 让你的手机接管**同一个会话**——电脑端照常是原生 TUI，手机端通过一个单页 web 看回复、发指令、看选项、甚至中断正在跑的命令。靠 `claude --resume` 续接你已有会话，**全上下文不丢**。(๑˃́ꇴ˂̀๑)

## ✨ 特性

- 🔄 **同一会话双端同步**：电脑 TUI 与手机 web 操作的是同一个 Claude 会话，输入输出互通。
- 🪟 **双视图**
  - **对话**：markdown 漂亮渲染，日常看回复舒服。
  - **终端**：xterm.js 镜像电脑端 TUI，**权限提示 / 选项菜单 / 进度全看得见**，配 `Esc 中断 / Enter / Ctrl+C / ↑↓ / Tab` 快捷键，能看选项、能推进、能撤销正在进行的命令。
- ⚡ **单条 WebSocket**：对话即时无延迟；走 cloudflared 隧道不被缓冲（SSE 在免费隧道上会被卡死，故弃用）。
- 📵 **零 CDN**：marked / xterm 等资源全部本机服务，**国内移动网络 / 受限网络照样能用**，页面只发同源请求。
- 📱 **移动端优化**：`100dvh` + 安全区适配，输入栏不被浏览器工具栏 / 小白条遮挡。
- 🌐 **免费内网穿透**：自动拉起 cloudflared quick tunnel（免账号），同时打印局域网地址供同 WiFi 直连。
- 🔐 **配对码门禁**：启动只露一个 8 位短码（90 秒有效、用一次即焚）；手机配对一次拿到只存浏览器的 session 凭证，之后长期免配对，横幅被截屏也没用。

## 📦 安装

```bash
# 全局命令（推荐）；装好后命令名就是 c2web
npm install -g @inksnow/c2web

# 或免安装直接跑
npx @inksnow/c2web
```

> **Windows / macOS 开箱即用**：依赖 `node-pty` 自带预编译二进制，无需编译工具链。  
> 想要公网地址需装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)（未装也能局域网用）。  
> 前提：本机已装好并登录 [Claude Code](https://docs.claude.com/claude-code) CLI。

## 🚀 使用（出门续干场景）

1. 在你的项目目录正常用 `claude` 干活。
2. 要出门了 —— **先退出**那个 claude（避免两个进程抢同一会话）。
3. 在**同一目录**启动：
   ```bash
   cd <你的项目目录>
   c2web
   ```
   它会自动续接该目录最近的会话，并打印：
   ```
   ==== Claude Phone Bridge ====
   本地:   http://localhost:8787
   局域网: http://192.168.x.x:8787   (手机同 WiFi 用这个)
   公网:   https://xxxx.trycloudflare.com
   配对码: 04281769   (8 位数字，90 秒内有效、用一次即焚，每 90 秒自动换新)
           当前活码持续写入：~/.c2web/paircode
   ```
4. 手机打开地址、输入**配对码**完成首次配对，即可看到并接着这个会话干。(´･ᴗ･ ` )
   - 配对成功后该设备**长期免配对**，下次直接打开地址即连；配对入口随即关闭。
   - 90 秒没配上、码被 claude 界面盖住了？另开一个终端 `cat ~/.c2web/paircode` 读当前活码即可，无需重启。

## ⌨️ 参数

| 参数 | 说明 |
|---|---|
| `--resume <id>` | 指定要续接的会话 id（默认取当前目录最近会话） |
| `--port <n>` | web 端口（默认 8787） |
| `--no-tunnel` | 不起 cloudflared，仅本地 / 局域网 |

## 🖥️ 两个视图

```
┌─ 顶部标签 ──────────────┐
│  [对话]   [终端]         │  ← 一键切换
├────────────────────────┤
│ 对话：markdown 漂亮阅读   │  看回复、发整条指令
│ 终端：xterm 镜像电脑 TUI  │  看选项菜单/权限提示、推进、Esc 中断
└────────────────────────┘
```

终端视图偶发空白时，点左上角橙色 **`⟳ 刷新`**：它会抖动一次终端尺寸逼 TUI 全量重绘，拽回当前完整画面。

## 🧠 工作原理

```
┌─────────────┐   node-pty 双向     ┌──────────┐   单条 WebSocket   ┌────────────┐
│ 你的终端 TUI │ ◄────────────────► │  c2web   │ ◄───────────────► │  手机 web   │
└─────────────┘                     │ (本机)    │                   │ 对话 + 终端 │
                                    └──────────┘                   └────────────┘
                              claude --resume <会话id>
                  读 transcript → 对话视图 ｜ 镜像 pty 原始输出 → 终端视图
```

- **续会话**：`claude --resume <id>` 续写同一会话、同一 transcript，上下文全在。
- **对话视图**：用 [@constellos/claude-code-kit](https://www.npmjs.com/package/@constellos/claude-code-kit) 解析 transcript，把 assistant 文本 + 工具动作推给手机。
- **终端视图**：直接镜像 node-pty 的原始输出，手机端 xterm 还原成与电脑一致的 TUI，按键回传 pty。
- **传输**：单条 WebSocket 同时承载对话事件与终端流；对话带 id，断线重连自动去重。
- **鉴权**：两段式「配对码 → session 凭证」。启动若无已配对设备则开放配对：露一个 8 位短码（90s 有效、用一次即焚、每 90s 轮换并写入 `~/.c2web/paircode`）。手机 `POST /pair` 校验短码后拿到一次性签发的 session（明文只发这一次、只存浏览器）；服务端 `~/.c2web/config.json` 仅存其 SHA-256 哈希。之后 `/ws` 握手校验 session，走 URL，不依赖 cookie。**一旦有设备配上，配对入口立即关闭。**
- **穿透**：自动拉起 cloudflared quick tunnel（免账号）；未装则仅本地 / 局域网可连。

## 🔐 安全

- 配对码门禁：8 位数字短码只在「尚无已配对设备」时开放，90 秒有效、用一次即焚、每 90 秒轮换；**横幅或截屏里的码 90 秒后即作废**。
- 设备凭证：配对签发的 session 凭证只存手机浏览器；磁盘只存它的哈希，配置文件泄露也反推不出可用凭证。
- 公网经 cloudflared 自带 HTTPS；纯局域网为明文 http，请只在可信网络用。
- 换手机 / 清了浏览器要重新配对：删除 `~/.c2web/config.json` 后重启即重新开放配对。

## ⚠️ 注意

- 同一会话别让两个进程同时占用：起 `c2web` 前先退出原 `claude`。
- 会话按项目目录隔离：在哪个目录起，就续哪个目录的会话。

## 🛠️ 从源码

```bash
git clone https://github.com/inksnowhailong/cc2web.git
cd cc2web
npm install
node install.mjs   # npm link 注册全局命令 + 尝试装 cloudflared
```

## License

[MIT](./LICENSE) © moxue
