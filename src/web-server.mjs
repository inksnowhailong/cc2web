import http from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isAuthed } from './auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = join(__dirname, '..', 'public', 'index.html');

/**
 * 启动 web 服务：登录校验 + SSE 输出流 + 发送接口。
 * 鉴权用 token（query ?token= 或 x-token 头），不依赖 cookie，规避浏览器 SSE+cookie 的坑。
 * @param {{port:number, token:string, onSend:(text:string)=>void}} opts
 * @returns {{push:(ev:object)=>void}}
 */
export function startWebServer({ port, token, onSend }) {
    const recent = [];   // 最近事件环形缓冲（新连接回放）
    let client = null;   // 单连接：只保留最新一个 SSE 客户端

    function push(ev) {
        recent.push(ev);
        if (recent.length > 200) recent.shift();
        if (client) {
            try { client.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* 已断 */ }
        }
    }

    const readBody = (req) => new Promise(resolve => {
        let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s));
    });

    const server = http.createServer(async (req, res) => {
        const url = req.url.split('?')[0];

        // 首页
        if (req.method === 'GET' && url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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

        // SSE 输出流：新连接顶替旧的（EventSource 会自动重连，避免被锁卡死）
        if (req.method === 'GET' && url === '/stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no', // 提示反代别缓冲 SSE
            });
            if (client && client !== res) { try { client.end(); } catch { /* noop */ } }
            client = res;
            for (const ev of recent) res.write(`data: ${JSON.stringify(ev)}\n\n`); // 回放历史
            const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);
            req.on('close', () => { clearInterval(ping); if (client === res) client = null; });
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

    server.listen(port);
    return { push };
}
