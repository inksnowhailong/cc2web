import { createRequire } from 'module';

// node-pty 是原生 CommonJS 模块，用 createRequire 在 ESM 里稳妥加载
const require = createRequire(import.meta.url);
const pty = require('node-pty');

/**
 * 在伪终端里 resume 指定会话，并把 pty 与本地终端双向打通：
 * - pty 输出 → 本地终端（电脑端原生 TUI）+ onData 回调（转发给手机终端镜像）
 * - 本地键盘 → pty（你照常在电脑上打字）
 * - submit(text) → 手机「对话」视图发整条指令；write(d) → 手机「终端」视图发原始按键
 *
 * @param {string} sessionId 要续接的会话 id
 * @param {{onExit:(code:number)=>void, onData?:(data:string)=>void}} hooks
 */
export function startPty(sessionId, { onExit, onData }) {
    const isWin = process.platform === 'win32';
    const file = isWin ? 'claude.cmd' : 'claude';
    const child = pty.spawn(file, ['--resume', sessionId], {
        name: 'xterm-color',
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 30,
        cwd: process.cwd(),
        env: process.env,
    });

    // pty 输出：镜像到本地终端，同时回调给手机终端镜像
    child.onData(d => { process.stdout.write(d); onData?.(d); });

    // 本地终端原始输入透传给 pty
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', d => child.write(d.toString()));

    // 终端尺寸变化同步给 pty，避免 TUI 错位
    process.stdout.on('resize', () => {
        child.resize(process.stdout.columns || 80, process.stdout.rows || 30);
    });

    child.onExit(({ exitCode }) => {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        onExit(exitCode);
    });

    return {
        /** 手机「对话」视图：注入一条指令（文本 + 回车提交） */
        submit: (text) => { child.write(text); child.write('\r'); },
        /** 手机「终端」视图：原始按键透传（含 Esc 中断、方向键选择、Ctrl+C 等） */
        write: (data) => { try { child.write(data); } catch { /* 已退出 */ } },
        /** 手机终端尺寸变化 → 同步 pty，保证 TUI 在手机上不错位 */
        resize: (cols, rows) => { try { child.resize(cols || 80, rows || 30); } catch { /* 已退出 */ } },
        /** 杀掉 pty 子进程（退出时清理，避免 Windows 下孤儿残留） */
        kill: () => { try { child.kill(); } catch { /* 已退出 */ } },
    };
}
