/** Extension UI dialog bridged to the sidebar webview (plan_mode_question, etc.). */

export type ExtensionUiMethod = 'select' | 'confirm' | 'input' | 'editor';

export interface ExtensionUiRequestPayload {
    id: string;
    method: ExtensionUiMethod;
    title?: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
}

export interface ExtensionUiResponsePayload {
    id: string;
    cancelled?: boolean;
    value?: string;
    confirmed?: boolean;
}
