import * as vscode from 'vscode';
import type { PiSessionManager } from './session';
import { getPiAgentDir } from './piCliSync';
import { normalizePiPackageSource } from './piPackageCatalog';
import { loadPiCodingAgent } from './piSdk';

function getCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

async function createPackageManager() {
    const { DefaultPackageManager, SettingsManager } = await loadPiCodingAgent();
    const cwd = getCwd();
    const agentDir = await getPiAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    return { packageManager, settingsManager };
}

export async function installPiPackage(
    rawSource: string,
    sessionManager: PiSessionManager | undefined,
    outputChannel?: vscode.OutputChannel,
    onProgress?: (message: string) => void,
): Promise<string> {
    const source = normalizePiPackageSource(rawSource);
    const { packageManager, settingsManager } = await createPackageManager();

    packageManager.setProgressCallback((event) => {
        const msg = event.message ?? `${event.action} ${event.source}`;
        onProgress?.(msg);
        outputChannel?.appendLine(`[package] ${msg}`);
    });

    outputChannel?.appendLine(`Installing ${source}…`);
    await packageManager.installAndPersist(source, { local: false });
    await settingsManager.flush();
    const errors = settingsManager.drainErrors();
    if (errors.length > 0) {
        throw new Error(errors.map((e) => e.error.message).join('; '));
    }

    outputChannel?.appendLine(`Installed ${source}`);
    if (sessionManager) {
        const { schedulePiSessionReload } = await import('./piAgentConfig');
        schedulePiSessionReload(sessionManager, outputChannel);
    }
    return source;
}

export async function removePiPackageBySource(
    rawSource: string,
    sessionManager: PiSessionManager | undefined,
    outputChannel?: vscode.OutputChannel,
): Promise<void> {
    const source = normalizePiPackageSource(rawSource);
    const { packageManager, settingsManager } = await createPackageManager();
    const options = { local: false as const };

    let removedFromSettings = false;
    try {
        removedFromSettings = await packageManager.removeAndPersist(source, options);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel?.appendLine(`[package] uninstall failed (${msg}); removing from settings.json…`);
        removedFromSettings = packageManager.removeSourceFromSettings(source, options);
        if (!removedFromSettings) {
            throw err;
        }
    }

    if (!removedFromSettings) {
        throw new Error(`Package not found: ${source}`);
    }

    await settingsManager.flush();
    const errors = settingsManager.drainErrors();
    if (errors.length > 0) {
        throw new Error(errors.map((e) => e.error.message).join('; '));
    }

    outputChannel?.appendLine(`Removed ${source} from Pi packages`);
    if (sessionManager) {
        const { schedulePiSessionReload } = await import('./piAgentConfig');
        schedulePiSessionReload(sessionManager, outputChannel);
    }
}
