import { access } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const IMAGE_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.bmp',
    '.svg',
    '.ico',
]);

export function isImageFilePath(filePath: string): boolean {
    return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Open a workspace file in the editor (text) or default app (images, binary). */
export async function openAttachmentFile(filePath: string): Promise<void> {
    const normalized = filePath.trim();
    if (!normalized) {
        return;
    }

    try {
        await access(normalized);
    } catch {
        void vscode.window.showErrorMessage(
            `Attachment not found: ${path.basename(normalized) || normalized}`,
        );
        return;
    }

    const uri = vscode.Uri.file(normalized);
    if (isImageFilePath(normalized)) {
        await vscode.commands.executeCommand('vscode.open', uri);
        return;
    }

    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
        await vscode.commands.executeCommand('vscode.open', uri);
    }
}
