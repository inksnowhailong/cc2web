import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

/** 配置目录放用户 home 下，避免写进只读的全局安装 / npx 缓存目录 */
const CONFIG_DIR = join(homedir(), '.c2web');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** 生成 48 位十六进制随机访问 token */
function genToken() {
    return randomBytes(24).toString('hex');
}

/**
 * 读取配置；首次运行自动生成（含新 token、默认端口 8787），存 ~/.c2web/config.json。
 * token 即"单人门禁"，只有知道的人能连进来。
 */
export function loadConfig() {
    if (existsSync(CONFIG_FILE)) {
        return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    }
    mkdirSync(CONFIG_DIR, { recursive: true });
    const cfg = { token: genToken(), port: 8787 };
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return cfg;
}
