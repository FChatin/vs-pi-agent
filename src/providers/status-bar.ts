import * as vscode from 'vscode';
import type { PiChatSession } from '../pi/slashCommands';

export class StatusBarManager implements vscode.Disposable {
    private _item: vscode.StatusBarItem;
    private _session: PiChatSession;
    private _unsubscribe: (() => void) | undefined;

    constructor(session: PiChatSession) {
        this._session = session;
        this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this._item.command = 'pi-agent.selectModel';
        this._update();
        this._item.show();

        this._unsubscribe = session.events.onAll((event) => {
            if (
                event.type === 'agent_start' ||
                event.type === 'agent_end' ||
                event.type === 'message_end' ||
                event.type === 'turn_end' ||
                event.type === 'auto_retry_start' ||
                event.type === 'auto_retry_end'
            ) {
                this._update();
            }
        });
    }

    private _update(): void {
        const model = this._session.getCurrentModel();
        const agentSession = this._session.session;
        const isRetrying = agentSession?.isRetrying ?? false;
        const isStreaming = (agentSession?.isStreaming ?? false) || isRetrying;
        const icon = isRetrying
            ? '$(sync~spin)'
            : isStreaming
              ? '$(loading~spin)'
              : '$(hubot)';
        const name = model ? (model.name ?? model.id) : 'No model';
        const retrySuffix =
            isRetrying && agentSession && agentSession.retryAttempt > 0
                ? ` (reconnecting ${agentSession.retryAttempt})`
                : '';
        this._item.text = `${icon} vs-pi-agent: ${name}${retrySuffix}`;

        const usage = this._session.session?.getContextUsage?.();
        const parts: string[] = ['vs-pi-agent'];
        if (usage) {
            if (usage.tokens !== null) {
                parts.push(`Context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`);
            }
            if (usage.percent !== null) {
                parts.push(`Usage: ${Math.round(usage.percent)}%`);
            }
        }
        const thinking = this._session.getThinkingLevel();
        if (thinking) {
            parts.push(`Thinking: ${thinking}`);
        }
        this._item.tooltip = parts.join('\n');
    }

    dispose(): void {
        this._unsubscribe?.();
        this._item.dispose();
    }
}
