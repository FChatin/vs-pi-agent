import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { getPiSdkEntryPath, loadPiCodingAgent } from './piSdk';

export function logExtensionLoadResult(
    outputChannel: vscode.OutputChannel,
    result: LoadExtensionsResult | undefined,
): void {
    if (!result) {
        return;
    }

    const errors = result.errors ?? [];
    if (errors.length > 0) {
        outputChannel.appendLine(`Pi package/extension load errors (${errors.length}):`);
        for (const err of errors) {
            const msg = err.error instanceof Error ? err.error.message : String(err.error);
            outputChannel.appendLine(`  - ${err.path}: ${msg}`);
        }
    }

    const loaded = result.extensions?.length ?? 0;
    outputChannel.appendLine(`Pi extensions loaded: ${loaded}`);
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
