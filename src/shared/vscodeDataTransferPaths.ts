import * as vscode from 'vscode';
import { parseUriListLines } from './dropPaths';

export async function collectPathsFromVscodeDataTransfer(
    dataTransfer: vscode.DataTransfer,
): Promise<string[]> {
    const paths: string[] = [];
    const uriMimes = ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls'];
    for (const mime of uriMimes) {
        const item = dataTransfer.get(mime);
        if (!item) {
            continue;
        }
        const raw = await item.asString();
        if (raw) {
            paths.push(...parseUriListLines(raw));
        }
    }

    for (const [_mime, item] of dataTransfer) {
        const file = item.asFile();
        if (file?.uri) {
            paths.push(file.uri.fsPath);
        }
    }

    return [...new Set(paths)];
}
