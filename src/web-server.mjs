import http from 'http';
import { readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes, randomInt } from 'crypto';
import { WebSocketServer } from 'ws';
import { writePairCode, clearPairCode, PAIRCODE_FILE } from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = join(__dirname, '..', 'public', 'index.html');

/** 配对码有效期 / 轮换周期：90 秒 */
const PAIR_TTL_MS = 90_000;
/** session 凭证哈希：磁盘与内存只存哈希，明文只在配对那一刻发给手机 */
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
/** 生成 8 位数字配对码（不足前导补 0） */
const genPairCode = () => String(randomInt(0, 100_000_000)).padStart(8, '0');

/**
 * 启动 web 服务：设备配对（HTTP）+ 单条 WebSocket 通道（对话事件 + 终端镜像 + 发送/按键）。
 * 全用 WS 而非 SSE/轮询：WS 走 cloudflared 原生支持、不被缓冲，且对话消息即时无延迟。
 * 鉴权用「配对码 → session 凭证」两段式：
 *   - 启动时若无任何已配对设备，进入「配对引导」：生成 8 位短码、写入本机文件、每 90s 轮换、用一次即焚；
 *   - 手机 POST /pair 校验短码 → 签发设备专属 session（明文仅此一次），服务端只存其哈希；
 *   - 之后 /ws 握手校验 ?session=，跨重启长期免再配对；
 *   - 一旦有设备配上，立即停轮换 + 删码文件——配对入口关门（「配上就停」）。
 * @param {{port:number, sessions?:string[], onPair?:(hash:string)=>void, onSend:(text:string)=>void, onTermInput?:(d:string)=>void, onTermResize?:(c:number,r:number)=>void}} opts
 * @returns {{push:(ev:object)=>void, pushTerm:(data:string)=>void, pairStatus:()=>{bootstrapping:boolean, code:string|null, file:string}}}
 */
export function startWebServer({ port, sessions = [], onPair, onSend, onTermInput, onTermResize }) {
    const validSessions = new Set(sessions); // 已配对设备的 session 哈希
    let pairCode = null;                      // 当前活配对码；null 表示配对入口已关闭
    let pairExpiresAt = 0;                    // 当前码过期时刻（毫秒时间戳）
    let rotateTimer = null;                   // 轮换定时器句柄
    let bootstrapping = validSessions.size === 0; // 无任何已配对设备时才开放配对

    /** 轮换出一个新码、刷新有效期、写入本机文件（控制台被 claude 占住时可另开终端读它） */
    function rotatePairCode() {
        pairCode = genPairCode();
        pairExpiresAt = Date.now() + PAIR_TTL_MS;
        writePairCode(pairCode);
    }

    /** 配对成功后关门：停轮换、清空当前码、删码文件 */
    function closePairing() {
        if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
        pairCode = null;
        bootstrapping = false;
        clearPairCode();
    }

    // 仅在「尚无已配对设备」时开放配对引导并启动轮换
    if (bootstrapping) {
        rotatePairCode();
        rotateTimer = setInterval(rotatePairCode, PAIR_TTL_MS);
    } else {
        clearPairCode(); // 已有设备：确保不残留上次的废码文件
    }
    const recent = [];          // 对话事件缓冲（带递增 id，新连接回放 + 重连去重）
    let seq = 0;                // 事件序号
    let termBuf = '';           // 终端原始输出缓冲（attach 时回放当前屏）
    const clients = new Set();  // 所有 ws，每个带 .wantTerm 标记是否正在看终端

    /** 推一条对话事件：存入缓冲并即时广播给所有客户端 */
    function push(ev) {
        seq += 1;
        const withId = { id: seq, ...ev };
        recent.push(withId);
        if (recent.length > 200) recent.shift();
        const msg = JSON.stringify({ t: 'ev', e: withId });
        for (const ws of clients) { try { ws.send(msg); } catch { /* 已断 */ } }
    }

    /** 推一段 pty 原始输出：存入回放缓冲，仅广播给正在看终端的客户端 */
    function pushTerm(data) {
        termBuf += data;
        if (termBuf.length > 64 * 1024) termBuf = termBuf.slice(-64 * 1024); // 只留最近 64KB
        const msg = JSON.stringify({ t: 'term', d: data });
        for (const ws of clients) { if (ws.wantTerm) { try { ws.send(msg); } catch { /* 已断 */ } } }
    }

    const readBody = (req) => new Promise(resolve => {
        let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s));
    });

    const server = http.createServer(async (req, res) => {
        const url = req.url.split('?')[0];

        // 首页
        if (req.method === 'GET' && url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(readFileSync(INDEX, 'utf8'));
            return;
        }

        // 配对：校验短码（90s 内有效、一次即焚），通过则签发本设备专属 session 凭证
        if (req.method === 'POST' && url === '/pair') {
            const body = await readBody(req);
            let code = '';
            try { code = String(JSON.parse(body).code || ''); } catch { /* 坏请求 */ }
            const ok = pairCode !== null && Date.now() <= pairExpiresAt && code === pairCode;
            if (!ok) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false }));
                return;
            }
            const session = randomBytes(32).toString('hex'); // 明文仅此一次，只存手机浏览器
            const hash = sha256(session);
            validSessions.add(hash);
            onPair?.(hash);   // 落盘哈希，跨重启免再配对
            closePairing();   // 配上就停：关门、停轮换、删码文件
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, session }));
            return;
        }

        // 本地 vendor 静态资源（marked/xterm 等）：零 CDN，移动端/受限网络也能加载
        if (req.method === 'GET' && url.startsWith('/vendor/')) {
            const name = basename(url); // basename 防目录穿越
            try {
                const buf = readFileSync(join(__dirname, '..', 'public', 'vendor', name));
                const ct = name.endsWith('.css') ? 'text/css' : 'text/javascript';
                res.writeHead(200, { 'Content-Type': `${ct}; charset=utf-8`, 'Cache-Control': 'max-age=86400' });
                res.end(buf);
            } catch { res.writeHead(404); res.end('not found'); }
            return;
        }

        res.writeHead(404); res.end('not found');
    });

    // 统一 WebSocket 通道：/ws?session=xxx
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const u = new URL(req.url, 'http://x');
        // 路径与 session 校验不过直接断开（WS 握手阶段无法走普通 401）
        const sess = u.searchParams.get('session') || '';
        if (u.pathname !== '/ws' || !validSessions.has(sha256(sess))) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => {
            ws.wantTerm = false;
            clients.add(ws);
            // 回放对话历史（客户端按 id 去重，重连不会重复渲染）
            for (const ev of recent) { try { ws.send(JSON.stringify({ t: 'ev', e: ev })); } catch { /* noop */ } }
            ws.on('message', raw => {
                let m; try { m = JSON.parse(raw.toString()); } catch { return; }
                if (m.t === 'send') onSend?.(m.text);
                else if (m.t === 'i') onTermInput?.(m.d);              // 终端按键透传
                else if (m.t === 'r') onTermResize?.(m.c, m.r);        // 终端尺寸同步
                else if (m.t === 'attach') {                           // 进终端页：订阅 + 回放当前屏
                    ws.wantTerm = true;
                    try { ws.send(JSON.stringify({ t: 'term-replay', d: termBuf })); } catch { /* noop */ }
                } else if (m.t === 'detach') {                         // 出终端页：退订，省流量
                    ws.wantTerm = false;
                }
            });
            ws.on('close', () => clients.delete(ws));
        });
    });

    // 端口被占用等错误：给人话提示而非抛栈崩溃
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`\n端口 ${port} 已被占用——很可能上次的 c2web 没退干净（Windows 关窗口常残留孤儿进程）。`);
            console.error(`解决：换端口  c2web --port ${port + 1}   或先杀掉占用该端口的进程再重试。`);
        } else {
            console.error('web 服务出错:', e.message);
        }
        process.exit(1);
    });
    server.listen(port);
    return {
        push,
        pushTerm,
        /** 供横幅展示：是否处于配对引导、当前活码、码文件路径 */
        pairStatus: () => ({ bootstrapping, code: pairCode, file: PAIRCODE_FILE }),
    };
}
