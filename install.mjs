#!/usr/bin/env node
// 一键安装：注册全局命令 + 安装 cloudflared（可选）+ 打印用法
import { execSync, spawnSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';

/** 检测某命令是否在 PATH 中 */
function has(cmd) {
    const probe = isWin ? `where ${cmd}` : `command -v ${cmd}`;
    try { execSync(probe, { stdio: 'ignore' }); return true; } catch { return false; }
}

/** 在本包目录执行一条命令，输出透传 */
function run(cmd) {
    console.log(`\n> ${cmd}`);
    return spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: __dirname }).status === 0;
}

console.log('=== Claude Phone Bridge 安装 ===');

// 1. 注册全局命令（claude-phone-bridge / cpb）
console.log('\n[1/3] 注册全局命令 (npm link)...');
if (!run('npm link')) {
    console.log('⚠ npm link 失败，可手动改用: npm install -g .');
}

// 2. 安装 cloudflared（拿公网地址用；缺了也能局域网用）
console.log('\n[2/3] 检查 cloudflared...');
if (has('cloudflared')) {
    console.log('cloudflared 已安装 ✓');
} else if (isWin && has('winget')) {
    run('winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements');
} else if (!isWin && has('brew')) {
    run('brew install cloudflared');
} else {
    console.log('⚠ 未能自动安装 cloudflared（无 winget/brew）。');
    console.log('  手动下载: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    console.log('  没有它也能在局域网用，只是没有公网地址。');
}

// 3. 用法
console.log(`
[3/3] 完成 ✓（若全局命令未生效，请开一个新终端刷新 PATH）

用法 — 在你要遥控的项目目录里运行:
  cd <你的项目目录>
  c2web                     # 续接本目录最近会话
  c2web --resume <会话id>   # 指定要续的会话
  c2web --port 9000         # 换端口（默认 8787）
  c2web --no-tunnel         # 不起隧道，仅本地/局域网

启动后打印 [公网地址或本地址] + [Token]；手机打开地址、输 Token 登录即可。
提示: 起 bridge 前先退出该目录里正在跑的 claude，避免两进程抢同一会话。
`);
