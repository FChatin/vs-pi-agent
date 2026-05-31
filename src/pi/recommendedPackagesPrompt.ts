import * as vscode from 'vscode';
import type { PiSessionManager } from './session';
import { isSyncWithPiCli } from './piCliSync';
import { getPiAgentDir } from './piCliSync';
import { installPiPackage } from './piPackageInstall';
import { loadPiCodingAgent } from './piSdk';
import {
    formatMissingPackagesList,
    getMissingRecommendedPackages,
    RECOMMENDED_PI_PACKAGES,
    type RecommendedPiPackage,
} from './recommendedPackages';

async function installRecommendedPackages(
    packages: readonly RecommendedPiPackage[],
    sessionManager: PiSessionManager | undefined,
    outputChannel: vscode.OutputChannel,
    onProgress?: (message: string) => void,
): Promise<string[]> {
    const installed: string[] = [];
    for (const pkg of packages) {
        onProgress?.(`Installing ${pkg.label}…`);
        await installPiPackage(pkg.source, sessionManager, outputChannel);
        installed.push(pkg.source);
    }
    return installed;
}

async function readConfiguredPackageSources(): Promise<string[]> {
    const { SettingsManager } = await loadPiCodingAgent();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const agentDir = await getPiAgentDir();
    const sm = SettingsManager.create(cwd, agentDir);
    return sm.getPackages().map((p) => (typeof p === 'string' ? p : p.source));
}

const GLOBAL_DISMISS_KEY = 'piAgent.recommendedPackagesDismissed';

export async function runRecommendedPackagesSetup(
    sessionManager: PiSessionManager | undefined,
    outputChannel: vscode.OutputChannel,
    packagesToInstall?: readonly RecommendedPiPackage[],
): Promise<void> {
    const configured = await readConfiguredPackageSources();
    const missing =
        packagesToInstall ??
        getMissingRecommendedPackages(configured, sessionManager?.session);

    if (missing.length === 0) {
        vscode.window.showInformationMessage('All recommended Pi packages are already configured.');
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Installing Pi packages',
            cancellable: false,
        },
        async (progress) => {
            await installRecommendedPackages(
                missing,
                sessionManager,
                outputChannel,
                (msg) => progress.report({ message: msg }),
            );
        },
    );

    if (sessionManager) {
        await sessionManager.reloadPiAgentResources();
    }

    vscode.window.showInformationMessage(
        `Installed: ${formatMissingPackagesList(missing)}. Reloaded Pi session.`,
    );
}

/**
 * On activation: warn or install recommended ~/.pi/agent packages when missing.
 */
export async function maybePromptForRecommendedPackages(
    context: vscode.ExtensionContext,
    sessionManager: PiSessionManager,
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    if (!isSyncWithPiCli()) {
        return;
    }

    const config = vscode.workspace.getConfiguration('pi-agent');
    if (!config.get<boolean>('promptRecommendedPackages', true)) {
        return;
    }

    if (context.globalState.get<boolean>(GLOBAL_DISMISS_KEY, false)) {
        return;
    }

    const configured = await readConfiguredPackageSources();
    const missing = getMissingRecommendedPackages(configured, sessionManager.session);
    if (missing.length === 0) {
        return;
    }

    const coreMissing = missing.filter((p) => p.tier === 'core');
    const list = formatMissingPackagesList(missing);
    const detail =
        coreMissing.length > 0
            ? `Plan mode and related UI need: ${formatMissingPackagesList(coreMissing)}.`
            : `Optional: ${list}.`;

    if (config.get<boolean>('autoInstallRecommendedPackages', false)) {
        outputChannel.appendLine(`Auto-installing Pi packages: ${list}`);
        try {
            await runRecommendedPackagesSetup(sessionManager, outputChannel, missing);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Pi package install failed: ${msg}`);
        }
        return;
    }

    const choice = await vscode.window.showWarningMessage(
        `vs-pi-agent: missing Pi CLI packages — ${list}. ${detail} Install via npm into ~/.pi/agent?`,
        { modal: false },
        'Install all',
        'Open Settings',
        'Later',
        "Don't ask again",
    );

    switch (choice) {
        case 'Install all':
            try {
                await runRecommendedPackagesSetup(sessionManager, outputChannel, missing);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Pi package install failed: ${msg}`);
            }
            break;
        case 'Open Settings':
            await vscode.commands.executeCommand('pi-agent.openSettings');
            break;
        case "Don't ask again":
            await context.globalState.update(GLOBAL_DISMISS_KEY, true);
            break;
        default:
            break;
    }
}

export function getRecommendedPackagesHelpMarkdown(): string {
    return RECOMMENDED_PI_PACKAGES.map(
        (p) => `- **${p.label}** — \`${p.source}\`: ${p.description}`,
    ).join('\n');
}
