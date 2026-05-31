import * as vscode from 'vscode';
import { PiSessionManager } from './pi/session';
import { SidebarProvider } from './providers/sidebar';
import { StatusBarManager } from './providers/status-bar';
import { SettingsPanel } from './providers/settings-panel';
import { clearExtensionApiKeySecrets, getPiAgentDir, isSyncWithPiCli } from './pi/piCliSync';
import { verifyPiSdkResolvable } from './pi/piExtensionDiagnostics';
import { maybePromptForRecommendedPackages } from './pi/recommendedPackagesPrompt';
import { setPiExtensionPath } from './pi/piSdk';

import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';
import { PlanDocumentProvider } from './providers/plan-document';
import { createBootErrorWebviewProvider } from './providers/boot-error-webview';
import { registerAttachFromExplorer } from './pi/attachFromExplorer';
import { ensurePastedAttachmentsDir } from './pi/pastedAttachmentStore';

let piSession: PiSessionManager | undefined;

function registerBootErrorSidebar(
    context: vscode.ExtensionContext,
    message: string,
): void {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'pi-agent.chat',
            createBootErrorWebviewProvider(message),
        ),
    );
}

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('vs-pi-agent');
    outputChannel.appendLine('vs-pi-agent extension activating...');
    setPiExtensionPath(context.extensionPath);

    if (!(await verifyPiSdkResolvable(outputChannel, context.extensionPath))) {
        registerBootErrorSidebar(
            context,
            'Pi SDK could not be loaded from extension node_modules.',
        );
        return;
    }

    try {
        if (isSyncWithPiCli()) {
            const cleared = await clearExtensionApiKeySecrets(context.secrets);
            const agentDir = await getPiAgentDir();
            outputChannel.appendLine(
                `Pi CLI sync enabled. Agent dir: ${agentDir}${cleared > 0 ? ` (removed ${cleared} extension-only API key(s))` : ''}`,
            );
        }

        piSession = new PiSessionManager(outputChannel);
        await piSession.initialize();

        void maybePromptForRecommendedPackages(context, piSession, outputChannel);

        const diffContentProvider = new DiffContentProvider();
        const planDocumentProvider = new PlanDocumentProvider();
        const checkpointManager = new CheckpointManager();
        const statusBar = new StatusBarManager(piSession);

        const diffManager = new DiffManager(piSession, checkpointManager);
        const pastedStorageDir = await ensurePastedAttachmentsDir(context.globalStorageUri.fsPath);
        const sidebarProvider = new SidebarProvider(
            context.extensionUri,
            piSession,
            diffManager,
            checkpointManager,
            outputChannel,
            planDocumentProvider,
            pastedStorageDir,
        );

        registerAttachFromExplorer(context, () => sidebarProvider);

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('pi-agent.chat', sidebarProvider),
            vscode.workspace.registerTextDocumentContentProvider('pi-diff', diffContentProvider),
            vscode.workspace.registerTextDocumentContentProvider('pi-plan', planDocumentProvider),
            statusBar,

            diffManager,
            checkpointManager,
            outputChannel,

            vscode.commands.registerCommand('pi-agent.newChat', async () => {
                await piSession?.newSession();
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.abort', async () => {
                await sidebarProvider.abortActiveTab();
            }),

            vscode.commands.registerCommand('pi-agent.selectModel', async () => {
                await piSession?.showModelPicker();
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.toggleThinking', async () => {
                const level = piSession?.cycleThinkingLevel();
                if (level) {
                    vscode.window.showInformationMessage(`Thinking level: ${level}`);
                }
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.focusChat', () => {
                vscode.commands.executeCommand('pi-agent.chat.focus');
            }),

            vscode.commands.registerCommand('pi-agent.attachFiles', () => {
                void sidebarProvider.pickAttachmentsDialog();
            }),

            vscode.commands.registerCommand('pi-agent.openSettings', () => {
                SettingsPanel.show(
                    context.extensionUri,
                    context.secrets,
                    piSession,
                    context.extension.packageJSON.version,
                    outputChannel,
                );
            }),

            vscode.commands.registerCommand('pi-agent.browsePackages', async () => {
                const { showPiPackageCatalogPicker } = await import('./pi/piPackageCatalogPicker');
                await showPiPackageCatalogPicker(piSession, outputChannel);
            }),

            vscode.commands.registerCommand('pi-agent.login', async () => {
                if (!piSession) return;
                await piSession.submitInput('/login', { mode: 'prompt' });
            }),

            vscode.commands.registerCommand('pi-agent.logout', async () => {
                if (!piSession) return;
                await piSession.submitInput('/logout', { mode: 'prompt' });
            }),

            vscode.commands.registerCommand('pi-agent.reloadSession', async () => {
                if (!piSession) return;
                await piSession.submitInput('/reload', { mode: 'prompt' });
            }),

            vscode.commands.registerCommand('pi-agent.installRecommendedPackages', async () => {
                if (!piSession) return;
                const { runRecommendedPackagesSetup } = await import('./pi/recommendedPackagesPrompt');
                await runRecommendedPackagesSetup(piSession, outputChannel);
            }),
        );

        outputChannel.appendLine('vs-pi-agent extension activated.');
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        outputChannel.appendLine(`Failed to activate: ${msg}`);
        vscode.window.showErrorMessage(`vs-pi-agent failed to activate: ${msg}`);
        registerBootErrorSidebar(context, msg);
    }
}

export async function deactivate() {
    await piSession?.dispose();
    await PiSessionManager.disposeGlobal();
}
