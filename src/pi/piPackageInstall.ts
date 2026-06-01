import * as vscode from 'vscode';
import type { PiChatSession } from './slashCommands';
import { getPiAgentDir, runPiCliCommand } from './piCliPaths';
import { normalizePiPackageSource } from './piPackageCatalog';

function getCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

export async function installPiPackage(
    rawSource: string,
    sessionManager: PiChatSession | undefined,
    outputChannel?: vscode.OutputChannel,
    onProgress?: (message: string) => void,
): Promise<string> {
    const source = normalizePiPackageSource(rawSource);
    onProgress?.(`Installing ${source}…`);
    outputChannel?.appendLine(`Installing ${source} via pi CLI…`);

    await runPiCliCommand(['install', source], getCwd(), outputChannel);

    outputChannel?.appendLine(`Installed ${source}`);
    if (sessionManager) {
        const { schedulePiSessionReload } = await import('./piAgentConfig');
        schedulePiSessionReload(sessionManager, outputChannel);
    }
    return source;
}

export async function removePiPackageBySource(
    rawSource: string,
    sessionManager: PiChatSession | undefined,
    outputChannel?: vscode.OutputChannel,
): Promise<void> {
    const source = normalizePiPackageSource(rawSource);
    outputChannel?.appendLine(`Removing ${source} via pi CLI…`);
    await runPiCliCommand(['remove', source], getCwd(), outputChannel);
    outputChannel?.appendLine(`Removed ${source}`);
    if (sessionManager) {
        const { schedulePiSessionReload } = await import('./piAgentConfig');
        schedulePiSessionReload(sessionManager, outputChannel);
    }
}
