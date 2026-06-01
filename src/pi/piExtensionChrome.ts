import type { ServerMessage } from '../shared/protocol';

export interface PiExtensionStatus {
    key: string;
    text?: string;
}

export interface PiExtensionWidget {
    key: string;
    lines?: string[];
    placement?: 'aboveEditor' | 'belowEditor';
}

/**
 * Tracks Pi extension status bar keys and widgets from RPC extension_ui_request.
 * Shared between sidebar webview and VS Code status bar.
 */
export class PiExtensionChrome {
    private _statuses = new Map<string, string | undefined>();
    private _widgets = new Map<string, PiExtensionWidget>();
    private _title?: string;
    private _post: ((msg: ServerMessage) => void) | undefined;

    setPost(fn: (msg: ServerMessage) => void): void {
        this._post = fn;
    }

    setStatus(key: string, text: string | undefined): void {
        this._statuses.set(key, text);
        this._emit();
    }

    setWidget(key: string, lines: string[] | undefined, placement?: 'aboveEditor' | 'belowEditor'): void {
        if (!lines?.length) {
            this._widgets.delete(key);
        } else {
            this._widgets.set(key, { key, lines, placement });
        }
        this._emit();
    }

    setTitle(title: string): void {
        this._title = title;
        this._emit();
    }

    getSnapshot(): {
        statuses: PiExtensionStatus[];
        widgets: PiExtensionWidget[];
        title?: string;
    } {
        return {
            statuses: [...this._statuses.entries()].map(([key, text]) => ({ key, text })),
            widgets: [...this._widgets.values()],
            title: this._title,
        };
    }

    /** Primary status line for VS Code status bar (MCP, plan-mode, profile, …). */
    getPrimaryStatusText(): string | undefined {
        const priority = ['plan-mode', 'mcp', 'profile', 'cursor', 'subagent-async'];
        for (const key of priority) {
            const text = this._statuses.get(key);
            if (text?.trim()) {
                return stripAnsi(text.trim());
            }
        }
        for (const [, text] of this._statuses) {
            if (text?.trim()) {
                return stripAnsi(text.trim());
            }
        }
        return undefined;
    }

    private _emit(): void {
        this._post?.({ type: 'piExtensionChrome', chrome: this.getSnapshot() });
    }
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}
