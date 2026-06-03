#!/usr/bin/env node
import { existsSync } from 'fs';
import { networkInterfaces } from 'os';
import { loadConfig } from './src/config.mjs';
import { findLatestSession, sessionFile, tailSession } from './src/transcript.mjs';
import { startWebServer } from './src/web-server.mjs';
import { startTunnel } from './src/tunnel.mjs';
import { startPty } from './src/pty-host.mjs';

/** 取本机所有非内网回环的 IPv4（局域网地址，供手机同 WiFi 访问） */
function lanIPs() {
    const out = [];
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const ni of ifaces[name] || []) {
            if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
        }
    }
    return out;
}

/** 解析极简命令行参数：--resume <id> / --port <n> / --no-tunnel */
function parseArgs(argv) {
    const a = { resume: null, port: null, noTunnel: false };
    for (let i = 2; i < argv.length; i++) {
        const v = argv[i];
        if (v === '--no-tunnel') a.noTunnel = true;
        else if (v === '--resume') a.resume = argv[++i];
        else if (v === '--port') a.port = parseInt(argv[++i], 10);
    }
    return a;
}

async function main() {
    const args = parseArgs(process.argv);
    const cfg = loadConfig();
    const port = args.port || cfg.port;

    // 选定要续接的会话：显式 --resume 优先，否则自动取当前目录最近会话
    let sessionId = args.resume;
    let file = null;
    if (sessionId) {
        file = sessionFile(process.cwd(), sessionId);
        if (!existsSync(file)) {
            console.error(`会话 ${sessionId} 不属于当前目录的项目（${process.cwd()}）。`);
            console.error('会话按项目目录隔离：请先 cd 到该会话所在的项目目录，再启动 bridge。');
            process.exit(1);
        }
    } else {
        const latest = findLatestSession(process.cwd());
        if (!latest) {
            console.error('找不到当前目录的历史会话。请先在本目录用 claude 跑过一次，或用 --resume <id> 指定。');
            process.exit(1);
        }
        sessionId = latest.sessionId;
        file = latest.file;
    }

    // pty 句柄延迟赋值；下列回调在手机交互时才触发，那时 ptyHost 已就绪
    let ptyHost = null;
    const web = startWebServer({
        port,
        token: cfg.token,
        onSend: (text) => { if (ptyHost) ptyHost.submit(text); },          // 对话视图：发整条指令
        onTermInput: (d) => { if (ptyHost) ptyHost.write(d); },            // 终端视图：原始按键
        onTermResize: (c, r) => { if (ptyHost) ptyHost.resize(c, r); },    // 终端视图：尺寸同步
    });

    // tail transcript → 推送 web（电脑打字 / 手机发的 / 思绪主动说的，都会经此到手机）
    tailSession(file, (ev) => web.push(ev));

    // 内网穿透（未装 cloudflared 自动降级为仅本地）
    const publicUrl = args.noTunnel ? null : await startTunnel(port);

    // 进入 pty 接管终端「之前」先把连接信息打全
    console.log('\n==== Claude Phone Bridge ====');
    console.log(`会话:   ${sessionId}`);
    console.log(`本地:   http://localhost:${port}`);
    for (const ip of lanIPs()) console.log(`局域网: http://${ip}:${port}  (手机同 WiFi 用这个)`);
    console.log(`公网:   ${publicUrl || '(cloudflared 未就绪，仅本地/局域网可连；装好后重启即获公网地址)'}`);
    console.log(`Token:  ${cfg.token}`);
    console.log('手机打开上面地址、输入 Token 登录。3 秒后进入会话（电脑端为原生界面）...\n');
    await new Promise(r => setTimeout(r, 3000));

    // 启动 pty：续接会话 + 接管本地终端；原始输出转发给手机终端镜像
    ptyHost = startPty(sessionId, {
        onExit: (code) => {
            console.log(`\nclaude 已退出 (code=${code})，bridge 结束。`);
            process.exit(code || 0);
        },
        onData: (d) => web.pushTerm(d),
    });

    // 退出清理：杀掉 pty 子进程，避免 Windows 下孤儿残留占用端口
    const cleanup = () => { try { if (ptyHost) ptyHost.kill(); } catch { /* 已退出 */ } };
    process.on('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
        try { process.on(sig, () => { cleanup(); process.exit(0); }); } catch { /* 平台不支持该信号 */ }
    }
    // 终端被关闭时 stdin 管道会断，借此兜底清理（Windows 关窗口不发可靠信号）
    process.stdin.on('end', () => { cleanup(); process.exit(0); });
    process.stdin.on('close', () => { cleanup(); process.exit(0); });
}

main();
