import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

let cachedSdk: typeof import('@earendil-works/pi-coding-agent') | undefined;
let extensionRoot: string | undefined;

export function setPiExtensionPath(extensionPath: string): void {
    extensionRoot = extensionPath;
}

export function getPiExtensionPath(): string | undefined {
    return extensionRoot;
}

export function getPiSdkEntryPath(extensionPath: string): string {
    return path.join(
        extensionPath,
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'index.js',
    );
}

/** Load Pi SDK from extension node_modules (ESM entry). Same build as `pi` CLI. */
export async function loadPiCodingAgent(): Promise<typeof import('@earendil-works/pi-coding-agent')> {
    if (cachedSdk) {
        return cachedSdk;
    }

    const base = extensionRoot;
    if (!base) {
        throw new Error('Pi extension path not set. Call setPiExtensionPath() during activate.');
    }

    const sdkEntry = getPiSdkEntryPath(base);
    if (!fs.existsSync(sdkEntry)) {
        throw new Error(`Pi SDK not found at ${sdkEntry}`);
    }

    cachedSdk = await import(pathToFileURL(sdkEntry).href);
    return cachedSdk;
}
