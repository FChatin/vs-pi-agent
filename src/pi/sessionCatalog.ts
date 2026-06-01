import * as fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionInfo, SessionListSort } from '../shared/protocol';

function getPiAgentDir(): string {
    const env = process.env.PI_CODING_AGENT_DIR?.trim();
    if (env) {
        return env;
    }
    return path.join(os.homedir(), '.pi', 'agent');
}

/** Same encoding as Pi CLI `getDefaultSessionDirPath`. */
export function encodePiSessionCwd(cwd: string): string {
    const resolvedCwd = path.resolve(cwd);
    return `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

export function getPiSessionDirForCwd(cwd: string, agentDir = getPiAgentDir()): string {
    return path.join(agentDir, 'sessions', encodePiSessionCwd(cwd));
}

export interface SessionTreeNode {
    session: SessionInfo;
    children: SessionTreeNode[];
}

export interface FlatSessionTreeItem {
    session: SessionInfo;
    depth: number;
    isLast: boolean;
    ancestorContinues: boolean[];
}

/** Match Pi CLI session selector (realpath when possible). */
export function canonicalizeSessionPath(filePath: string | undefined): string {
    if (!filePath) {
        return '';
    }
    try {
        return fs.realpathSync(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

function canonicalizePath(filePath: string | undefined): string | undefined {
    if (!filePath) {
        return filePath;
    }
    return canonicalizeSessionPath(filePath);
}

function extractTextContent(message: unknown): string {
    if (!message || typeof message !== 'object') {
        return '';
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter((part): part is { type?: string; text?: string } => typeof part === 'object' && part !== null)
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n');
}

function getLastActivityTime(entries: Array<Record<string, unknown>>): number | undefined {
    let last: number | undefined;
    for (const entry of entries) {
        if (entry.type !== 'message') {
            continue;
        }
        const message = entry.message as { timestamp?: number; role?: string } | undefined;
        if (typeof message?.timestamp === 'number') {
            last = Math.max(last ?? 0, message.timestamp);
            continue;
        }
        const entryTs = entry.timestamp;
        if (typeof entryTs === 'string') {
            const parsed = new Date(entryTs).getTime();
            if (!Number.isNaN(parsed)) {
                last = Math.max(last ?? 0, parsed);
            }
        }
    }
    return last;
}

const sessionInfoByPath = new Map<string, { mtimeMs: number; info: SessionInfo }>();

/** Drop cached session metadata (e.g. after resume or new session). */
export function clearSessionInfoCache(): void {
    sessionInfoByPath.clear();
}

/** Drop one file from the session metadata cache (after rename/delete). */
export function invalidateSessionInfoPath(sessionPath: string): void {
    sessionInfoByPath.delete(sessionPath);
    try {
        sessionInfoByPath.delete(canonicalizeSessionPath(sessionPath));
    } catch {
        /* best-effort */
    }
}

async function buildSessionInfoFromFileLiteAsync(filePath: string): Promise<SessionInfo | null> {
    let fileStat: fs.Stats;
    try {
        fileStat = await stat(filePath);
    } catch {
        return null;
    }

    return new Promise((resolve) => {
        let header: Record<string, unknown> | null = null;
        let messageCount = 0;
        let firstMessage = '';
        let name: string | undefined;
        let lastActivity = fileStat.mtimeMs;

        const stream = createReadStream(filePath, { encoding: 'utf8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });

        const finish = (): void => {
            if (!header) {
                resolve(null);
                return;
            }

            const headerTs =
                typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
            const modified =
                lastActivity > 0
                    ? lastActivity
                    : !Number.isNaN(headerTs)
                      ? headerTs
                      : fileStat.mtimeMs;

            const match = /^(.+)_(.+)\.jsonl$/.exec(path.basename(filePath));
            const id =
                typeof header.id === 'string' ? header.id : match?.[2] ?? path.basename(filePath);

            resolve({
                id,
                name: name ?? id,
                path: filePath,
                cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
                parentSessionPath:
                    typeof header.parentSession === 'string' ? header.parentSession : undefined,
                messageCount,
                firstMessage: firstMessage || '(no messages)',
                created: !Number.isNaN(headerTs) ? headerTs : fileStat.mtimeMs,
                lastModified: modified,
            });
        };

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) {
                return;
            }
            let entry: Record<string, unknown>;
            try {
                entry = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
                return;
            }

            if (!header && entry.type === 'session') {
                header = entry;
                const headerTs =
                    typeof header.timestamp === 'string'
                        ? new Date(header.timestamp).getTime()
                        : NaN;
                if (!Number.isNaN(headerTs)) {
                    lastActivity = Math.max(lastActivity, headerTs);
                }
                return;
            }

            if (entry.type === 'session_info') {
                const raw = (entry as { name?: string }).name?.trim();
                if (raw) {
                    name = raw;
                }
            }
            if (entry.type === 'session_name' && typeof entry.name === 'string' && entry.name.trim()) {
                name = entry.name.trim();
            }
            if (entry.type !== 'message') {
                return;
            }

            messageCount++;
            const message = entry.message as { role?: string; timestamp?: number } | undefined;
            if (typeof message?.timestamp === 'number') {
                lastActivity = Math.max(lastActivity, message.timestamp);
            } else {
                const entryTs = entry.timestamp;
                if (typeof entryTs === 'string') {
                    const parsed = new Date(entryTs).getTime();
                    if (!Number.isNaN(parsed)) {
                        lastActivity = Math.max(lastActivity, parsed);
                    }
                }
            }

            if (!firstMessage && message?.role === 'user') {
                const textContent = extractTextContent(message)
                    .replace(/[\x00-\x1f\x7f]/g, ' ')
                    .trim();
                if (textContent) {
                    firstMessage = textContent;
                }
            }
        });

        rl.on('close', finish);
        stream.on('error', () => resolve(null));
    });
}

async function buildSessionInfoCachedAsync(filePath: string): Promise<SessionInfo | null> {
    try {
        const fileStat = await stat(filePath);
        const cached = sessionInfoByPath.get(filePath);
        if (cached && cached.mtimeMs === fileStat.mtimeMs) {
            return cached.info;
        }
        const info = await buildSessionInfoFromFileLiteAsync(filePath);
        if (info) {
            sessionInfoByPath.set(filePath, { mtimeMs: fileStat.mtimeMs, info });
        } else {
            sessionInfoByPath.delete(filePath);
        }
        return info;
    } catch {
        return null;
    }
}

async function buildSessionInfoFromFileAsync(filePath: string): Promise<SessionInfo | null> {
    return buildSessionInfoCachedAsync(filePath);
}

/** Read one Pi session .jsonl file into SessionInfo (same fields as Pi CLI session selector). */
export function buildSessionInfoFromFile(filePath: string): SessionInfo | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    let statResult: fs.Stats;
    try {
        statResult = fs.statSync(filePath);
    } catch {
        return null;
    }

    let text: string;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }

    return parseSessionInfoFromText(filePath, text, statResult.mtimeMs);
}

function parseSessionInfoFromText(filePath: string, text: string, statsMtimeMs: number): SessionInfo | null {
    const entries: Array<Record<string, unknown>> = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            entries.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
            /* skip malformed line */
        }
    }

    if (entries.length === 0) {
        return null;
    }

    const header = entries[0];
    if (header.type !== 'session') {
        return null;
    }

    let messageCount = 0;
    let firstMessage = '';
    let name: string | undefined;

    for (const entry of entries) {
        if (entry.type === 'session_info') {
            const raw = (entry as { name?: string }).name?.trim();
            name = raw || undefined;
        }
        if (entry.type === 'session_name' && typeof entry.name === 'string' && entry.name.trim()) {
            name = entry.name.trim();
        }
        if (entry.type !== 'message') {
            continue;
        }
        messageCount++;
        const message = entry.message as { role?: string } | undefined;
        const textContent = extractTextContent(message).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
        if (!textContent) {
            continue;
        }
        if (!firstMessage && message?.role === 'user') {
            firstMessage = textContent;
        }
    }

    const headerTs = typeof header.timestamp === 'string' ? new Date(header.timestamp).getTime() : NaN;
    const lastActivity = getLastActivityTime(entries);
    const modified =
        lastActivity && lastActivity > 0
            ? lastActivity
            : !Number.isNaN(headerTs)
              ? headerTs
              : statsMtimeMs;

    const match = /^(.+)_(.+)\.jsonl$/.exec(path.basename(filePath));
    const id = typeof header.id === 'string' ? header.id : match?.[2] ?? path.basename(filePath);

    return {
        id,
        name: name ?? id,
        path: filePath,
        cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
        parentSessionPath: typeof header.parentSession === 'string' ? header.parentSession : undefined,
        messageCount,
        firstMessage: firstMessage || '(no messages)',
        created: !Number.isNaN(headerTs) ? headerTs : statsMtimeMs,
        lastModified: modified,
    };
}

function listSessionFilesInDir(dir: string): string[] {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith('.jsonl')) {
            files.push(path.join(dir, entry));
        }
    }
    return files;
}

const MAX_CONCURRENT_SESSION_INFO_LOADS = 24;

/** Same concurrency model as Pi CLI SessionManager.listAll. */
async function buildSessionInfosWithConcurrency(
    files: string[],
    onLoaded?: () => void,
): Promise<(SessionInfo | null)[]> {
    const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
    const inFlight = new Set<Promise<void>>();
    let nextIndex = 0;

    const startNext = (): void => {
        const index = nextIndex++;
        const file = files[index];
        if (!file) {
            return;
        }
        const task = buildSessionInfoFromFileAsync(file)
            .then((info) => {
                results[index] = info;
            })
            .catch(() => {
                results[index] = null;
            })
            .finally(() => {
                inFlight.delete(task);
                onLoaded?.();
            });
        inFlight.add(task);
    };

    while (nextIndex < files.length || inFlight.size > 0) {
        while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
            startNext();
        }
        if (inFlight.size > 0) {
            await Promise.race(inFlight);
        }
    }

    return results;
}

function sortSessionsByModified(sessions: SessionInfo[]): SessionInfo[] {
    return sessions.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
}

/** Sessions for one workspace cwd (Pi CLI "current folder" scope). */
export async function listPiSessionsForCwdAsync(
    cwd: string,
    onProgress?: (loaded: number, total: number) => void,
): Promise<SessionInfo[]> {
    const sessionDir = getPiSessionDirForCwd(cwd);
    const files = listSessionFilesInDir(sessionDir);
    let loaded = 0;
    const results = await buildSessionInfosWithConcurrency(files, () => {
        loaded++;
        onProgress?.(loaded, files.length);
    });
    return sortSessionsByModified(results.filter((info): info is SessionInfo => info !== null));
}

/** All sessions across every project folder (Pi CLI "all" scope). */
export async function listAllPiSessionsAsync(
    onProgress?: (loaded: number, total: number) => void,
): Promise<SessionInfo[]> {
    const root = path.join(getPiAgentDir(), 'sessions');
    if (!fs.existsSync(root)) {
        return [];
    }

    const allFiles: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        allFiles.push(...listSessionFilesInDir(path.join(root, entry.name)));
    }

    let loaded = 0;
    const results = await buildSessionInfosWithConcurrency(allFiles, () => {
        loaded++;
        onProgress?.(loaded, allFiles.length);
    });
    return sortSessionsByModified(results.filter((info): info is SessionInfo => info !== null));
}

/** @deprecated Use listPiSessionsForCwdAsync */
export function listPiSessionsForCwd(cwd: string): SessionInfo[] {
    const sessionDir = getPiSessionDirForCwd(cwd);
    const sessions: SessionInfo[] = [];
    for (const filePath of listSessionFilesInDir(sessionDir)) {
        const info = buildSessionInfoFromFile(filePath);
        if (info) {
            sessions.push(info);
        }
    }
    return sortSessionsByModified(sessions);
}

/** @deprecated Use listAllPiSessionsAsync */
export function listAllPiSessions(): SessionInfo[] {
    const root = path.join(getPiAgentDir(), 'sessions');
    if (!fs.existsSync(root)) {
        return [];
    }

    const sessions: SessionInfo[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        for (const filePath of listSessionFilesInDir(path.join(root, entry.name))) {
            const info = buildSessionInfoFromFile(filePath);
            if (info) {
                sessions.push(info);
            }
        }
    }
    return sortSessionsByModified(sessions);
}

/** Build parent/child tree from session headers (same algorithm as Pi CLI). */
export function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
    const byPath = new Map<string, SessionTreeNode>();
    for (const session of sessions) {
        const sessionPath = canonicalizePath(session.path) ?? session.path;
        byPath.set(sessionPath, { session, children: [] });
    }

    const roots: SessionTreeNode[] = [];
    for (const session of sessions) {
        const sessionPath = canonicalizePath(session.path) ?? session.path;
        const node = byPath.get(sessionPath);
        if (!node) {
            continue;
        }
        const parentPath = canonicalizePath(session.parentSessionPath);
        if (parentPath && byPath.has(parentPath)) {
            byPath.get(parentPath)!.children.push(node);
        } else {
            roots.push(node);
        }
    }

    const sortNodes = (nodes: SessionTreeNode[]): void => {
        nodes.sort((a, b) => (b.session.lastModified ?? 0) - (a.session.lastModified ?? 0));
        for (const node of nodes) {
            sortNodes(node.children);
        }
    };
    sortNodes(roots);
    return roots;
}

/** Flatten tree for display with depth + connector metadata. */
export function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionTreeItem[] {
    const result: FlatSessionTreeItem[] = [];

    const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
        result.push({ session: node.session, depth, isLast, ancestorContinues });
        for (let i = 0; i < node.children.length; i++) {
            const childIsLast = i === node.children.length - 1;
            const continues = depth > 0 ? !isLast : false;
            walk(node.children[i], depth + 1, [...ancestorContinues, continues], childIsLast);
        }
    };

    for (let i = 0; i < roots.length; i++) {
        walk(roots[i], 0, [], i === roots.length - 1);
    }
    return result;
}

export function buildSessionTreePrefix(item: FlatSessionTreeItem): string {
    if (item.depth === 0) {
        return '';
    }
    const parts = item.ancestorContinues.map((continues) => (continues ? '│  ' : '   '));
    const branch = item.isLast ? '└─ ' : '├─ ';
    return parts.join('') + branch;
}

function matchesQuery(session: SessionInfo, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) {
        return true;
    }
    const haystack = [
        session.name,
        session.id,
        session.firstMessage,
        session.path,
        session.cwd,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return haystack.includes(q);
}

export function buildSessionDisplayList(
    sessions: SessionInfo[],
    sortMode: 'threaded' | 'recent',
    query = '',
): FlatSessionTreeItem[] {
    const filtered = sessions.filter((s) => matchesQuery(s, query));
    if (sortMode === 'recent') {
        return filtered
            .slice()
            .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
            .map((session) => ({
                session,
                depth: 0,
                isLast: true,
                ancestorContinues: [],
            }));
    }
    return flattenSessionTree(buildSessionTree(filtered));
}

export interface SessionListRow {
    sessionPath: string;
    label: string;
    meta: string;
    prefix: string;
    isCurrent: boolean;
}

function sessionTitle(session: SessionInfo): string {
    const hasName = !!session.name && session.name !== session.id;
    const title = (hasName ? session.name : session.firstMessage || session.id) ?? session.id;
    return title.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

/** Rows for resume UI (CLI `/resume` list format). */
export function buildSessionListRows(
    sessions: SessionInfo[],
    sort: SessionListSort,
    query: string,
    options: { showCwd: boolean; currentSessionPath?: string },
): SessionListRow[] {
    const display = buildSessionDisplayList(sessions, sort, query);
    const currentCanon = options.currentSessionPath
        ? canonicalizePath(options.currentSessionPath)
        : undefined;

    return display.map((item) => {
        const session = item.session;
        const prefix = buildSessionTreePrefix(item);
        const age = formatSessionAge(session.lastModified);
        const msgCount = String(session.messageCount ?? 0);
        const meta =
            options.showCwd && session.cwd
                ? `${shortenPath(session.cwd)} · ${msgCount} · ${age}`
                : `${msgCount} · ${age}`;
        const sessionCanon = canonicalizePath(session.path) ?? session.path;
        return {
            sessionPath: session.path,
            label: sessionTitle(session),
            meta,
            prefix,
            isCurrent: !!currentCanon && currentCanon === sessionCanon,
        };
    });
}

function shortenPath(filePath: string | undefined): string {
    if (!filePath) {
        return '';
    }
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

export function formatSessionAge(ms: number | undefined): string {
    if (!ms) {
        return '';
    }
    const diffMs = Date.now() - ms;
    const diffMins = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffDays = Math.floor(diffMs / 86_400_000);
    if (diffMins < 1) return 'now';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
    return `${Math.floor(diffDays / 365)}y`;
}
