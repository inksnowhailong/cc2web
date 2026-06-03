import http from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isAuthed } from './auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = join(__dirname, '..', 'public', 'index.html');

/**
 * 启动 web 服务：登录校验 + 事件轮询 + 发送接口。
 * 输出改用短轮询而非 SSE：Cloudflare 免费隧道会缓冲 text/event-stream 永不放行，
 * 而轮询是会正常结束的普通请求，任何 CDN/反代都不缓冲，穿透稳定。
 * 鉴权用 token（query ?token= 或 x-token 头），不依赖 cookie。
 * @param {{port:number, token:string, onSend:(text:string)=>void}} opts
 * @returns {{push:(ev:object)=>void}}
 */
export function startWebServer({ port, token, onSend }) {
    const recent = [];   // 最近事件缓冲（带递增 id，供轮询增量拉取）
    let seq = 0;         // 事件序号，客户端用它做游标

    function push(ev) {
        seq += 1;
        recent.push({ id: seq, ...ev });
        if (recent.length > 200) recent.shift();
    }

    const readBody = (req) => new Promise(resolve => {
        let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s));
    });

    const server = http.createServer(async (req, res) => {
        const url = req.url.split('?')[0];

        // 首页
        if (req.method === 'GET' && url === '/') {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store', // 始终拿最新页面，避免浏览器缓存旧版
            });
            res.end(readFileSync(INDEX, 'utf8'));
            return;
        }

        // 登录：仅校验 token，返回 ok/401（前端自行保存 token）
        if (req.method === 'POST' && url === '/login') {
            const body = await readBody(req);
            let t = '';
            try { t = JSON.parse(body).token; } catch { /* 坏请求 */ }
            const ok = t === token;
            res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok }));
            return;
        }

        // 以下接口需 token（query / x-token 头）
        if (!isAuthed(req, token)) { res.writeHead(401); res.end('unauthorized'); return; }

        // 事件轮询：返回 id 大于 since 的增量事件 + 当前游标，客户端定时拉取
        if (req.method === 'GET' && url === '/events') {
            const since = parseInt(new URL(req.url, 'http://x').searchParams.get('since') || '0', 10);
            const events = recent.filter(e => e.id > since);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ events, last: seq }));
            return;
        }

        // 发指令 → 注入会话
        if (req.method === 'POST' && url === '/send') {
            const body = await readBody(req);
            let text = '';
            try { text = JSON.parse(body).text || ''; } catch { /* 坏请求 */ }
            if (text) onSend(text);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
            return;
        }

        res.writeHead(404); res.end('not found');
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
    return { push };
}
