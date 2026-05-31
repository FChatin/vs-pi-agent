import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildSearchPatterns, scoreFileMatch } from '../shared/workspaceFileSearchScore';

export interface WorkspaceFileMatch {
    relativePath: string;
    absolutePath: string;
    basename: string;
}

const EXCLUDE =
    '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.venv/**,**/vendor/**,**/*.vsix,**/coverage/**,**/.next/**,**/build/**}';

const MAX_SCAN = 1200;
const DEFAULT_LIMIT = 40;

export async function searchWorkspaceFiles(
    query: string,
    maxResults = DEFAULT_LIMIT,
): Promise<WorkspaceFileMatch[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        return [];
    }

    const q = query.trim().toLowerCase();
    if (!q) {
        return [];
    }

    const patterns = buildSearchPatterns(q);
    const byPath = new Map<string, WorkspaceFileMatch>();

    for (const folder of folders) {
        const root = folder.uri.fsPath;
        for (const pattern of patterns) {
            if (byPath.size >= MAX_SCAN) {
                break;
            }
            let uris: vscode.Uri[];
            try {
                uris = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, pattern),
                    EXCLUDE,
                    MAX_SCAN - byPath.size,
                );
            } catch {
                continue;
            }
            for (const u of uris) {
                if (u.scheme !== 'file') {
                    continue;
                }
                const absolutePath = u.fsPath;
                if (byPath.has(absolutePath)) {
                    continue;
                }
                const relativePath = path.relative(root, absolutePath).replace(/\\/g, '/');
                if (relativePath.startsWith('..')) {
                    continue;
                }
                byPath.set(absolutePath, {
                    relativePath,
                    absolutePath,
                    basename: path.basename(absolutePath),
                });
            }
        }
    }

    return [...byPath.values()]
        .map((m) => ({ m, score: scoreFileMatch(m, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.m.relativePath.localeCompare(b.m.relativePath))
        .slice(0, maxResults)
        .map((x) => x.m);
}
