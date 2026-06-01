import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionInfo, SessionListScope, SessionListSort } from '../shared/protocol';
import type { PiChatSession } from './slashCommands';
import { resolvePiWorkspaceCwd } from './piCliPaths';
import {
    buildSessionDisplayList,
    buildSessionTreePrefix,
    formatSessionAge,
    listAllPiSessionsAsync,
    listPiSessionsForCwdAsync,
} from './sessionCatalog';

interface ResumePickItem extends vscode.QuickPickItem {
    sessionPath: string;
}

function shortenPath(filePath: string | undefined): string {
    if (!filePath) {
        return '';
    }
    const home = os.homedir();
    return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function canonicalizeSessionPath(filePath: string | undefined): string {
    if (!filePath) {
        return '';
    }
    try {
        return fs.realpathSync(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

function sessionToPickItem(
    item: ReturnType<typeof buildSessionDisplayList>[number],
    showCwd: boolean,
    currentSessionPath: string | undefined,
): ResumePickItem {
    const session = item.session;
    const hasName = !!session.name && session.name !== session.id;
    const title = (hasName ? session.name : session.firstMessage || session.id) ?? session.id;
    const normalized = title.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    const prefix = buildSessionTreePrefix(item);
    const age = formatSessionAge(session.lastModified);
    const msgCount = String(session.messageCount ?? 0);
    const isCurrent =
        !!currentSessionPath &&
        canonicalizeSessionPath(currentSessionPath) === canonicalizeSessionPath(session.path);
    const label = `${prefix}${normalized}`;
    const right = showCwd && session.cwd ? `${shortenPath(session.cwd)} ${msgCount} ${age}` : `${msgCount} ${age}`;

    return {
        label: isCurrent ? `$(circle-filled) ${label}` : label,
        description: right,
        sessionPath: session.path,
    };
}

function scopeTitle(scope: SessionListScope): string {
    return scope === 'current' ? 'Resume Session (Current Folder)' : 'Resume Session (All)';
}

/** VS Code QuickPick mirroring Pi CLI `/resume` session selector. */
export async function showResumeSessionPicker(
    manager: PiChatSession,
    onResumed?: () => void | Promise<void>,
): Promise<void> {
    let scope: SessionListScope = 'current';
    let sort: SessionListSort = 'threaded';
    let cachedCurrent: SessionInfo[] | null = null;
    let cachedAll: SessionInfo[] | null = null;
    let loadGeneration = 0;

    const quickPick = vscode.window.createQuickPick<ResumePickItem>();
    quickPick.title = scopeTitle(scope);
    quickPick.placeholder = 'Search sessions…';
    quickPick.matchOnDescription = true;
    quickPick.ignoreFocusOut = true;
    quickPick.buttons = [
        { iconPath: new vscode.ThemeIcon('folder'), tooltip: 'Toggle scope (Current folder / All)' },
        { iconPath: new vscode.ThemeIcon('list-tree'), tooltip: 'Toggle sort (Threaded / Recent)' },
    ];

    const getCwd = (): string => resolvePiWorkspaceCwd(manager.session?.cwd);

    const currentSessionPath = manager.session?.sessionFile;

    const renderItems = (sessions: SessionInfo[], query: string): void => {
        const showCwd = scope === 'all';
        const display = buildSessionDisplayList(sessions, sort, query);
        if (display.length === 0) {
            quickPick.items = [
                {
                    label:
                        scope === 'current'
                            ? 'No sessions in current folder'
                            : 'No sessions found',
                    sessionPath: '',
                    alwaysShow: true,
                },
            ];
            return;
        }
        quickPick.items = display.map((item) => sessionToPickItem(item, showCwd, currentSessionPath));
    };

    const loadSessions = async (query: string): Promise<void> => {
        const generation = ++loadGeneration;
        quickPick.busy = true;
        try {
            let sessions: SessionInfo[];
            if (scope === 'current') {
                if (!cachedCurrent) {
                    cachedCurrent = await listPiSessionsForCwdAsync(getCwd());
                }
                sessions = cachedCurrent;
            } else {
                if (!cachedAll) {
                    cachedAll = await listAllPiSessionsAsync((loaded, total) => {
                        if (generation !== loadGeneration) {
                            return;
                        }
                        quickPick.title = `${scopeTitle(scope)} · Loading ${loaded}/${total}`;
                    });
                }
                sessions = cachedAll;
            }

            if (generation !== loadGeneration) {
                return;
            }

            quickPick.title = scopeTitle(scope);
            renderItems(sessions, query);
        } catch (err: unknown) {
            if (generation !== loadGeneration) {
                return;
            }
            const message = err instanceof Error ? err.message : String(err);
            quickPick.items = [
                {
                    label: `$(error) Failed to load sessions`,
                    description: message,
                    sessionPath: '',
                    alwaysShow: true,
                },
            ];
        } finally {
            if (generation === loadGeneration) {
                quickPick.busy = false;
            }
        }
    };

    quickPick.onDidChangeValue((query) => {
        const sessions = scope === 'current' ? cachedCurrent : cachedAll;
        if (sessions) {
            renderItems(sessions, query);
        }
    });

    quickPick.onDidTriggerButton(async (button) => {
        if (button.tooltip?.startsWith('Toggle scope')) {
            scope = scope === 'current' ? 'all' : 'current';
            quickPick.title = scopeTitle(scope);
            quickPick.value = '';
            await loadSessions('');
            return;
        }
        if (button.tooltip?.startsWith('Toggle sort')) {
            sort = sort === 'threaded' ? 'recent' : 'threaded';
            const sessions = scope === 'current' ? cachedCurrent : cachedAll;
            if (sessions) {
                renderItems(sessions, quickPick.value);
            } else {
                await loadSessions(quickPick.value);
            }
        }
    });

    quickPick.onDidAccept(async () => {
        const item = quickPick.selectedItems[0];
        quickPick.hide();
        if (!item?.sessionPath) {
            return;
        }
        if (
            currentSessionPath &&
            canonicalizeSessionPath(currentSessionPath) === canonicalizeSessionPath(item.sessionPath)
        ) {
            return;
        }

        const resumed = await manager.loadSession(item.sessionPath);
        if (!resumed) {
            return;
        }

        await onResumed?.();

        const label =
            manager.session?.sessionName?.trim() ||
            manager.session?.sessionId ||
            item.label.replace(/^\$\([^)]+\)\s*/, '');
        vscode.window.showInformationMessage(`Resumed session: ${label}`);
    });

    quickPick.show();
    await loadSessions('');
}
