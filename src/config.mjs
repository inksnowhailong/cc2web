import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** 配置目录放用户 home 下，避免写进只读的全局安装 / npx 缓存目录 */
const CONFIG_DIR = join(homedir(), '.c2web');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** 当前活配对码落地文件：绕开被 claude TUI 占住的控制台，随时另开终端读它拿码 */
export const PAIRCODE_FILE = join(CONFIG_DIR, 'paircode');

/**
 * 读取配置；首次运行自动生成（默认端口 8787、空设备列表），存 ~/.c2web/config.json。
 * sessions 存的是各「已配对设备」session 凭证的 SHA-256 哈希——
 * 明文凭证只在手机浏览器里，磁盘只留哈希，即便配置文件泄露也反推不出可用凭证。
 */
export function loadConfig() {
    if (existsSync(CONFIG_FILE)) {
        const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
        if (!Array.isArray(cfg.sessions)) cfg.sessions = []; // 兼容旧配置 / 缺字段
        return cfg;
    }
    mkdirSync(CONFIG_DIR, { recursive: true });
    const cfg = { port: 8787, sessions: [] };
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return cfg;
}

/** 记录一台新配对设备的 session 哈希并落盘（去重），使其跨重启免再配对 */
export function addSession(hash) {
    const cfg = loadConfig();
    if (!cfg.sessions.includes(hash)) {
        cfg.sessions.push(hash);
        writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    }
}

/** 写入当前活配对码（仅属主可读 0600；Windows 下该目录本就用户隔离） */
export function writePairCode(code) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(PAIRCODE_FILE, code + '\n', { encoding: 'utf8', mode: 0o600 });
}

/** 删除配对码文件（配对完成 / 门关上时清理，避免留下废码） */
export function clearPairCode() {
    try { rmSync(PAIRCODE_FILE, { force: true }); } catch { /* 不存在即可 */ }
}
