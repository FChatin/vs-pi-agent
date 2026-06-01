import * as fs from 'node:fs';

export interface SessionJsonlEntry {
    type: string;
    customType?: string;
    data?: unknown;
    name?: string;
    message?: unknown;
    content?: unknown;
}

/** Read all entries from a Pi session .jsonl file (best-effort). */
export function readSessionJsonlEntries(sessionFile: string | undefined): SessionJsonlEntry[] {
    if (!sessionFile || !fs.existsSync(sessionFile)) {
        return [];
    }
    const entries: SessionJsonlEntry[] = [];
    try {
        const text = fs.readFileSync(sessionFile, 'utf8');
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                entries.push(JSON.parse(trimmed) as SessionJsonlEntry);
            } catch {
                /* skip bad line */
            }
        }
    } catch {
        return [];
    }
    return entries;
}

const SESSION_NAME_HEAD_BYTES = 256 * 1024;

/** Session display name from jsonl metadata (first chunk only). */
export function readSessionDisplayName(sessionFile: string | undefined): string | undefined {
    if (!sessionFile || !fs.existsSync(sessionFile)) {
        return undefined;
    }

    try {
        const fd = fs.openSync(sessionFile, 'r');
        const buf = Buffer.alloc(SESSION_NAME_HEAD_BYTES);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        let name: string | undefined;
        for (const line of buf.slice(0, bytesRead).toString('utf8').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                const entry = JSON.parse(trimmed) as SessionJsonlEntry;
                if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
                    name = entry.name.trim();
                }
                if (entry.type === 'session_name' && typeof entry.name === 'string' && entry.name.trim()) {
                    name = entry.name.trim();
                }
            } catch {
                /* skip bad line */
            }
        }
        return name;
    } catch {
        return undefined;
    }
}
