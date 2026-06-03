import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseTranscript } from '@constellos/claude-code-kit/transcripts';

/** 把项目绝对路径编码成 ~/.claude/projects 下的目录名（冒号与斜杠都转 -） */
function encodeProjectDir(cwd) {
    return cwd.replace(/[\\/:]/g, '-');
}

/** 当前项目在 ~/.claude/projects 下的会话目录 */
function projectDir(cwd) {
    return join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
}

/** 定位当前项目「最近修改」的会话 jsonl（无参启动时自动续接） */
export function findLatestSession(cwd) {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    if (!files.length) return null;
    let best = null;
    for (const f of files) {
        const full = join(dir, f);
        const mt = statSync(full).mtimeMs;
        if (!best || mt > best.mt) {
            best = { mt, file: full, sessionId: f.replace(/\.jsonl$/, '') };
        }
    }
    return best;
}

/** 由会话 id 拼出 transcript 文件路径（--resume <id> 显式指定时） */
export function sessionFile(cwd, sessionId) {
    return join(projectDir(cwd), `${sessionId}.jsonl`);
}

/** 把一条（库已解析的）消息转成前端事件：文本块给正文，tool_use 块给「我在干啥」 */
function messageToEvents(m) {
    if (m.type !== 'user' && m.type !== 'assistant') return [];
    const role = m.type; // 'user' | 'assistant'
    const c = m.message?.content;
    const out = [];
    if (typeof c === 'string') {
        if (c.trim()) out.push({ kind: role, text: c });
    } else if (Array.isArray(c)) {
        for (const b of c) {
            if (b.type === 'text' && b.text && b.text.trim()) {
                out.push({ kind: role, text: b.text });
            } else if (b.type === 'tool_use') {
                out.push({ kind: 'tool', text: b.name });
            }
        }
    }
    return out;
}

/**
 * 轮询 tail：文件大小变化时用 @constellos/claude-code-kit 整文件解析（schema 校验 + 过滤噪声行），
 * 按「已推送条数」diff，仅把新增消息转事件推出。库负责脏活，我们只做增量与映射。
 * 注：整文件重解析，长会话每次变更约几十~上百 ms，对"偶尔发指令"的使用足够。
 */
export function tailSession(file, onEvent) {
    let emitted = 0;     // 已推送的消息条数
    let lastSize = -1;   // 上次文件大小，未变则跳过解析
    let running = false; // 防止解析未完时重入

    const pump = async () => {
        if (running) return;
        let size;
        try { size = statSync(file).size; } catch { return; }
        if (size === lastSize) return;
        running = true;
        try {
            const r = await parseTranscript(file);
            const msgs = r.messages || [];
            for (let i = emitted; i < msgs.length; i++) {
                for (const ev of messageToEvents(msgs[i])) onEvent(ev);
            }
            emitted = msgs.length;
            lastSize = size;
        } catch { /* 半行/瞬时错误，下轮重试，不更新 lastSize */ }
        finally { running = false; }
    };

    pump(); // 首次：回放历史
    const timer = setInterval(pump, 700);
    return () => clearInterval(timer);
}
