import { URL } from 'url';

/** 从请求取 token：优先 query ?token=（EventSource 只能这样带），其次 x-token 头 */
function readToken(req) {
    try {
        const q = new URL(req.url, 'http://localhost').searchParams.get('token');
        if (q) return q;
    } catch { /* url 解析失败忽略 */ }
    return req.headers['x-token'] || null;
}

/** 校验请求是否携带有效 token */
export function isAuthed(req, token) {
    return readToken(req) === token;
}
