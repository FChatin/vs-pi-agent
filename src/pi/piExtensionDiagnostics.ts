import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { formatExtensionLoadSummary, notifyExtensionLoadIssues } from './piExtensionCompat';
import { getPiSdkEntryPath, loadPiCodingAgent } from './piSdk';

export function logExtensionLoadResult(
    outputChannel: vscode.OutputChannel,
    result: LoadExtensionsResult | undefined,
    options?: { notify?: boolean },
): void {
    if (!result) {
        return;
    }

    const { loaded, issues } = formatExtensionLoadSummary(result);
    if (issues.length > 0) {
        outputChannel.appendLine(`Pi package/extension load errors (${issues.length}):`);
        for (const issue of issues) {
            outputChannel.appendLine(`  - [${issue.category}] ${issue.path}: ${issue.message}`);
            outputChannel.appendLine(`    Hint: ${issue.hint}`);
        }
    }

    outputChannel.appendLine(`Pi extensions loaded: ${loaded}`);
    if (options?.notify && issues.length > 0) {
        void notifyExtensionLoadIssues(result, outputChannel);
    }
}

export async function verifyPiSdkResolvable(
    outputChannel: vscode.OutputChannel,
    extensionPath: string,
): Promise<boolean> {
    const sdkEntry = getPiSdkEntryPath(extensionPath);
    try {
        if (!fs.existsSync(sdkEntry)) {
            throw new Error(`file missing: ${sdkEntry}`);
        }
        await loadPiCodingAgent();
        outputChannel.appendLine(`Pi SDK OK: ${sdkEntry}`);
        return true;
    } catch (err: any) {
        const detail = err?.message ?? String(err);
        outputChannel.appendLine(`Pi SDK load failed: ${detail}`);
        outputChannel.appendLine(`Expected: ${sdkEntry}`);
        vscode.window.showErrorMessage(
            `vs-pi-agent: could not load SDK. Reinstall the extension VSIX. ${detail}`,
        );
        return false;
    }
}
