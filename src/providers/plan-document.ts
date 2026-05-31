import * as vscode from 'vscode';

/**
 * Read-only virtual document for the active session's proposed plan.
 */
export class PlanDocumentProvider implements vscode.TextDocumentContentProvider {
    private readonly _contentByKey = new Map<string, string>();
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();

    readonly onDidChange = this._onDidChange.event;

    uriForSession(sessionId: string): vscode.Uri {
        const key = encodeURIComponent(sessionId || 'default');
        return vscode.Uri.from({ scheme: 'pi-plan', path: `/${key}/Pi Plan.md` });
    }

    setPlanContent(sessionId: string, markdown: string): void {
        const key = encodeURIComponent(sessionId || 'default');
        this._contentByKey.set(
            key,
            markdown ||
                '# Pi Plan\n\n_No plan yet. Use **Plan** mode and describe what you want to build._\n',
        );
        this._onDidChange.fire(this.uriForSession(sessionId));
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const segment = uri.path.split('/').filter(Boolean)[0] ?? 'default';
        const key = decodeURIComponent(segment);
        return (
            this._contentByKey.get(key) ??
            '# Pi Plan\n\n_No plan yet. Switch to **Plan** mode in the chat header, then describe your goal._\n'
        );
    }
}

export async function openPlanDocument(
    provider: PlanDocumentProvider,
    sessionId: string | undefined,
    column: vscode.ViewColumn = vscode.ViewColumn.Beside,
): Promise<void> {
    const uri = provider.uriForSession(sessionId ?? 'default');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: column,
        preserveFocus: true,
    });
}
