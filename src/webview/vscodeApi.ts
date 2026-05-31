declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

/** VS Code allows exactly one acquireVsCodeApi() call per webview. */
export const vscode = acquireVsCodeApi();
