import * as vscode from 'vscode';
import type { PiChatSession } from '../pi/slashCommands';
import { formatTokenSummaryText } from '../webview/tokenStatsBar';

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
                event.type === 'context_usage' ||
                event.type === 'auto_retry_start' ||
                event.type === 'auto_retry_end'
            ) {
                this._update();
            }
        });
    }

    refresh(): void {
        this._update();
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
        const usage = this._session.session?.getContextUsage?.();
        const statsText = formatTokenSummaryText(usage, this._session.getSessionTokenStats());
        const modelLabel = `${icon} vs-pi-agent: ${name}${retrySuffix}`;
        this._item.text = statsText ? `${modelLabel} · ${statsText}` : modelLabel;

        const tooltipParts: string[] = ['vs-pi-agent'];
        if (usage) {
            if (usage.tokens !== null) {
                tooltipParts.push(
                    `Context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`,
                );
            }
            if (usage.percent !== null) {
                tooltipParts.push(`Usage: ${Math.round(usage.percent)}%`);
            }
        }
        const sessionTokens = this._session.getSessionTokenStats();
        if (sessionTokens) {
            tooltipParts.push(
                `Session in/out: ${sessionTokens.input.toLocaleString()} / ${sessionTokens.output.toLocaleString()}`,
            );
            if (sessionTokens.cost > 0) {
                tooltipParts.push(`Cost: $${sessionTokens.cost.toFixed(4)}`);
            }
        }
        const thinking = this._session.getThinkingLevel();
        if (thinking) {
            tooltipParts.push(`Thinking: ${thinking}`);
        }
        this._item.tooltip = tooltipParts.join('\n');
    }

    dispose(): void {
        this._unsubscribe?.();
        this._item.dispose();
    }
}
