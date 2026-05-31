import * as vscode from 'vscode';
import type { SidebarProvider } from '../providers/sidebar';

export function registerAttachFromExplorer(
    context: vscode.ExtensionContext,
    getSidebar: () => SidebarProvider | undefined,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'pi-agent.attachFilesFromExplorer',
            async (uri: vscode.Uri, uris?: vscode.Uri[]) => {
                const sidebar = getSidebar();
                if (!sidebar) {
                    vscode.window.showWarningMessage('vs-pi-agent: chat is not ready yet.');
                    return;
                }

                const list = uris?.length ? uris : uri ? [uri] : [];
                const paths = list
                    .filter((u) => u.scheme === 'file')
                    .map((u) => u.fsPath)
                    .filter((p) => p.length > 0);

                if (paths.length === 0) {
                    return;
                }

                await sidebar.attachPaths(paths);
                void vscode.commands.executeCommand('pi-agent.chat.focus');
            },
        ),
    );
}
