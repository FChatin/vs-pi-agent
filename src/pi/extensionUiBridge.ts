import * as vscode from 'vscode';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ExtensionUIContext, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent';
import type { ExtensionUiRequestPayload, ExtensionUiResponsePayload } from '../shared/extensionUi';
import type { ServerMessage } from '../shared/protocol';

type PendingDialog = {
    resolve: (value: unknown) => void;
    clearTimers: () => void;
};

function newRequestId(): string {
    return `ui-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Bridges pi-coding-agent ExtensionUIContext to the sidebar webview.
 * Enables plan_mode_question and other extension dialogs as clickable cards.
 */
export class ExtensionUiBridge {
    private _post: ((msg: ServerMessage) => void) | undefined;
    private readonly _pending = new Map<string, PendingDialog>();

    setPost(fn: (msg: ServerMessage) => void): void {
        this._post = fn;
    }

    attach(session: AgentSession | undefined): void {
        const runner = session?.extensionRunner;
        if (!runner) {
            return;
        }
        runner.setUIContext(this.createContext());
    }

    detach(session: AgentSession | undefined): void {
        session?.extensionRunner?.setUIContext(undefined);
        for (const [id, pending] of this._pending) {
            pending.clearTimers();
            pending.resolve(undefined);
            this._pending.delete(id);
        }
    }

    handleResponse(payload: ExtensionUiResponsePayload): void {
        const pending = this._pending.get(payload.id);
        if (!pending) {
            return;
        }
        pending.clearTimers();
        this._pending.delete(payload.id);

        if (payload.cancelled) {
            pending.resolve(undefined);
            return;
        }

        switch (true) {
            case payload.confirmed !== undefined:
                pending.resolve(payload.confirmed);
                break;
            default:
                pending.resolve(payload.value);
        }
    }

    createContext(): ExtensionUIContext {
        const noop = () => {};
        const noopUnsub = () => () => {};

        return {
            select: (title, options, opts) => this.dialog('select', { title, options }, opts),
            confirm: (title, message, opts) =>
                this.dialog('confirm', { title, message }, opts).then((v) => v === true),
            input: (title, placeholder, opts) => this.dialog('input', { title, placeholder }, opts),
            editor: (title, prefill, opts) => this.dialog('editor', { title, prefill }, opts),
            notify: (message, type) => {
                if (type === 'error') {
                    void vscode.window.showErrorMessage(message);
                } else if (type === 'warning') {
                    void vscode.window.showWarningMessage(message);
                } else {
                    void vscode.window.showInformationMessage(message);
                }
            },
            onTerminalInput: noopUnsub,
            setStatus: noop,
            setWorkingMessage: noop,
            setWorkingVisible: noop,
            setWorkingIndicator: noop,
            setHiddenThinkingLabel: noop,
            setWidget: noop,
            setFooter: noop,
            setHeader: noop,
            setTitle: noop,
            custom: async () => undefined,
            pasteToEditor: noop,
            setEditorText: noop,
            getEditorText: () => '',
            addAutocompleteProvider: noop,
            setEditorComponent: noop,
            getEditorComponent: () => undefined,
        } as ExtensionUIContext;
    }

    private dialog(
        method: ExtensionUiRequestPayload['method'],
        fields: Omit<ExtensionUiRequestPayload, 'id' | 'method'>,
        opts?: ExtensionUIDialogOptions,
    ): Promise<string | boolean | undefined> {
        const id = newRequestId();
        return new Promise((resolve) => {
            const timers: ReturnType<typeof setTimeout>[] = [];
            const clearTimers = () => {
                for (const t of timers) {
                    clearTimeout(t);
                }
            };

            const finish = (value: unknown) => {
                clearTimers();
                this._pending.delete(id);
                resolve(value as string | boolean | undefined);
            };

            this._pending.set(id, { resolve: finish, clearTimers });

            if (opts?.signal) {
                opts.signal.addEventListener(
                    'abort',
                    () => {
                        finish(undefined);
                        this._post?.({ type: 'extensionUiDismiss', id });
                    },
                    { once: true },
                );
            }

            if (opts?.timeout && opts.timeout > 0) {
                timers.push(
                    setTimeout(() => {
                        finish(undefined);
                        this._post?.({ type: 'extensionUiDismiss', id });
                    }, opts.timeout),
                );
            }

            const request: ExtensionUiRequestPayload = { id, method, ...fields };
            this._post?.({ type: 'extensionUiRequest', request });
        });
    }
}
