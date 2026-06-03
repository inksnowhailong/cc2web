# c2web

用手机 / 浏览器遥控本机正在进行的 Claude Code 会话。
Remote-control your local Claude Code session from your phone or browser.

电脑端照常是原生 TUI；手机端通过单页 web 看「干净回复 + 我在干啥」，并能发指令进**同一个会话**。靠 `claude --resume` 续接你已有的会话，全上下文不丢。

## 工作原理

```
你的终端 (原生TUI) ◄──node-pty 双向── c2web ──读 transcript──► 手机 web
                                         │
                              claude --resume <会话id>
```

- **续会话**：`claude --resume <id>` 续写同一会话、同一 transcript，上下文全在。
- **输出**：用 [@constellos/claude-code-kit](https://www.npmjs.com/package/@constellos/claude-code-kit) 解析会话 transcript，把 assistant 文本 + 工具动作经 SSE 推给手机。
- **输入**：手机发的指令经 node-pty 注入会话；电脑键盘照常。
- **鉴权**：首次运行生成随机 token（存 `~/.c2web/config.json`），手机登录一次；token 走 URL/header，不依赖 cookie。
- **穿透**：自动拉起 cloudflared quick tunnel（免账号）；未装则仅本地/局域网可连。

## 安装

```bash
# 全局命令（推荐）
npm install -g c2web

# 或免安装直接跑
npx c2web
```

> Windows / macOS 开箱即用：依赖 `node-pty` 自带预编译二进制，无需编译工具。Linux 需 build 工具链。
> 想要公网地址需装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)（未装也能局域网用）。

## 使用（出门续干场景）

1. 在你的项目目录正常用 `claude` 干活。
2. 要出门了 —— **先退出**那个 claude（避免两个进程抢同一会话）。
3. 在同一目录启动：
   ```bash
   cd <你的项目目录>
   c2web
   ```
   它自动续接该目录最近的会话，打印 **公网地址 + Token**，随后进入原生界面。
4. 手机打开地址、输入 Token，即可看到并接着这个会话干。

### 参数

- `--resume <id>`：指定要续接的会话 id（默认取当前目录最近会话）
- `--port <n>`：web 端口（默认 8787）
- `--no-tunnel`：不起 cloudflared，仅本地 / 局域网

### 从源码安装（开发）

```bash
git clone <repo> && cd c2web
npm install
node install.mjs   # npm link 注册全局命令 + 尝试装 cloudflared
```

## 安全

- 单人 token 门禁：48 位（192bit）随机 token，没它一律 401。
- 同一时刻只保留一个活动连接。
- 公网经 cloudflared 自带 HTTPS；纯局域网为明文 http，请只在可信网络用。
- token 存 `~/.c2web/config.json`，泄露删掉重启即换新。

## 注意

- 同一会话别让两个进程同时占用：起 c2web 前先退出原 claude。
- 会话按项目目录隔离：在哪个目录起，就续哪个目录的会话。

## License

MIT
