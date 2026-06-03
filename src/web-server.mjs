import http from 'http';
import { readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = join(__dirname, '..', 'public', 'index.html');

/**
 * 启动 web 服务：登录校验（HTTP）+ 单条 WebSocket 通道（对话事件 + 终端镜像 + 发送/按键）。
 * 全用 WS 而非 SSE/轮询：WS 走 cloudflared 原生支持、不被缓冲，且对话消息即时无延迟。
 * 鉴权用 token：/login 校验，/ws 握手时校验 ?token=。
 * @param {{port:number, token:string, onSend:(text:string)=>void, onTermInput?:(d:string)=>void, onTermResize?:(c:number,r:number)=>void}} opts
 * @returns {{push:(ev:object)=>void, pushTerm:(data:string)=>void}}
 */
export function startWebServer({ port, token, onSend, onTermInput, onTermResize }) {
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

        // 登录：仅校验 token，返回 ok/401（前端自行保存，后续走 WS）
        if (req.method === 'POST' && url === '/login') {
            const body = await readBody(req);
            let t = '';
            try { t = JSON.parse(body).token; } catch { /* 坏请求 */ }
            const ok = t === token;
            res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok }));
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

    // 统一 WebSocket 通道：/ws?token=xxx
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const u = new URL(req.url, 'http://x');
        // 路径与 token 校验不过直接断开（WS 握手阶段无法走普通 401）
        if (u.pathname !== '/ws' || u.searchParams.get('token') !== token) { socket.destroy(); return; }
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
    return { push, pushTerm };
}
