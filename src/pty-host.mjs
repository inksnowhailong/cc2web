import { createRequire } from 'module';

// node-pty 是原生 CommonJS 模块，用 createRequire 在 ESM 里稳妥加载
const require = createRequire(import.meta.url);
const pty = require('node-pty');

/**
 * 在伪终端里 resume 指定会话，并把 pty 与本地终端双向打通：
 * - pty 输出 → 本地终端（电脑端看到的就是原生 Claude TUI）
 * - 本地键盘 → pty（你照常在电脑上打字）
 * - submit(text) → 供手机端把指令注入同一个会话
 *
 * @param {string} sessionId 要续接的会话 id
 * @param {(code:number)=>void} onExit claude 退出回调
 */
export function startPty(sessionId, onExit) {
    const isWin = process.platform === 'win32';
    const file = isWin ? 'claude.cmd' : 'claude';
    const child = pty.spawn(file, ['--resume', sessionId], {
        name: 'xterm-color',
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 30,
        cwd: process.cwd(),
        env: process.env,
    });

    // pty 输出镜像到本地终端
    child.onData(d => process.stdout.write(d));

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
        /** 手机端注入一条指令：写入文本后回车提交 */
        submit: (text) => { child.write(text); child.write('\r'); },
    };
}
