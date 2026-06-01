import * as vscode from 'vscode';
import * as path from 'node:path';
import { PiRpcSessionManager, createPiChatSession } from './pi/rpcSession';
import type { PiChatSession } from './pi/slashCommands';
import { SidebarProvider } from './providers/sidebar';
import { StatusBarManager } from './providers/status-bar';
import { SettingsPanel } from './providers/settings-panel';
import { clearExtensionApiKeySecrets, getPiAgentDir, isSyncWithPiCli } from './pi/piCliSync';
import { verifyPiCliAvailable, resolvePiCliInvocation } from './pi/piCliPaths';
import { canLoadPiNativeModules } from './pi/piExtensionCompat';
import { maybePromptForRecommendedPackages } from './pi/recommendedPackagesPrompt';
import { setPiExtensionPath } from './pi/extensionPath';

import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';
import { PlanDocumentProvider } from './providers/plan-document';
import { createBootErrorWebviewProvider } from './providers/boot-error-webview';
import { rebuildAgentNativeModules } from './pi/piExtensionCompat';
import { registerAttachFromExplorer } from './pi/attachFromExplorer';
import { ensurePastedAttachmentsDir } from './pi/pastedAttachmentStore';

let piSession: PiChatSession | undefined;

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

    if (!(await verifyPiCliAvailable(outputChannel))) {
        registerBootErrorSidebar(
            context,
            'Pi CLI not found. Install pi globally (`npm i -g @earendil-works/pi-coding-agent`) or set pi-agent.cliPath.',
        );
        return;
    }

    try {
        const invocation = await resolvePiCliInvocation();
        const npmDir = path.join(getPiAgentDir(), 'npm');
        if (!(await canLoadPiNativeModules(invocation, npmDir))) {
            outputChannel.appendLine(
                'WARNING: better-sqlite3 failed to load under pi Node. Memory/search tools may fail. Run "vs-pi-agent: Rebuild Pi native modules".',
            );
            void vscode.window.showWarningMessage(
                'Pi memory/search native modules are not loading under your global pi Node. Run "vs-pi-agent: Rebuild Pi native modules" or reload after fixing pi Node.',
            );
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Pi native module preflight skipped: ${msg}`);
    }

    try {
        if (isSyncWithPiCli()) {
            const cleared = await clearExtensionApiKeySecrets(context.secrets);
            const agentDir = getPiAgentDir();
            outputChannel.appendLine(
                `Pi CLI sync enabled. Agent dir: ${agentDir}${cleared > 0 ? ` (removed ${cleared} extension-only API key(s))` : ''}`,
            );
        }

        piSession = await createPiChatSession(outputChannel);
        outputChannel.appendLine(
            'Backend: Pi CLI RPC only (`pi --mode rpc`) — same packages/skills/extensions as terminal.',
        );

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
                await sidebarProvider.pushStateSync();
                sidebarProvider.postModelFooter();
            }),

            vscode.commands.registerCommand('pi-agent.abort', async () => {
                await sidebarProvider.abortActiveTab();
            }),

            vscode.commands.registerCommand('pi-agent.selectModel', async () => {
                await piSession?.showModelPicker();
                sidebarProvider.sendStateSync();
                statusBar.refresh();
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

            vscode.commands.registerCommand('pi-agent.openSessionPanel', () => {
                void sidebarProvider.openSessionPanel();
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

            vscode.commands.registerCommand('pi-agent.openMcpSettings', () => {
                SettingsPanel.showWithSection('mcp');
            }),

            vscode.commands.registerCommand('pi-agent.browsePackages', async () => {
                const { showPiPackageCatalogPicker } = await import('./pi/piPackageCatalogPicker');
                await showPiPackageCatalogPicker(piSession, outputChannel);
            }),

            vscode.commands.registerCommand('pi-agent.login', async () => {
                if (!piSession) return;
                const { runPiLoginFlow } = await import('./pi/slashCommands');
                await runPiLoginFlow(piSession);
            }),

            vscode.commands.registerCommand('pi-agent.logout', async () => {
                if (!piSession) return;
                const { runPiLogoutFlow } = await import('./pi/slashCommands');
                await runPiLogoutFlow(piSession);
            }),

            vscode.commands.registerCommand('pi-agent.reloadSession', async () => {
                if (!piSession) return;
                await piSession.reloadPiAgentResources();
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.installRecommendedPackages', async () => {
                if (!piSession) return;
                const { runRecommendedPackagesSetup } = await import('./pi/recommendedPackagesPrompt');
                await runRecommendedPackagesSetup(piSession, outputChannel);
            }),

            vscode.commands.registerCommand('pi-agent.rebuildNativeModules', async () => {
                await rebuildAgentNativeModules(outputChannel);
                if (piSession) {
                    await piSession.reloadPiAgentResources();
                }
                sidebarProvider.sendStateSync();
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
    await PiRpcSessionManager.disposeGlobal();
}
