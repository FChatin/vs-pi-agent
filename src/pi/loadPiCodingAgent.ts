import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePiCliInvocation } from './piCliPaths';

export type PiCodingAgentModule = typeof import('@earendil-works/pi-coding-agent');

let cached: Promise<PiCodingAgentModule> | undefined;

/** Load pi-coding-agent from the same install as the user's `pi` CLI (not bundled in the extension). */
export async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
    if (!cached) {
        cached = (async () => {
            const invocation = await resolvePiCliInvocation();
            const indexPath = path.join(path.dirname(invocation.cliJsPath), 'index.js');
            return import(pathToFileURL(indexPath).href) as Promise<PiCodingAgentModule>;
        })();
    }
    return cached;
}

export async function loadPiInteractiveHelpers(): Promise<{
    isApiKeyLoginProvider: (
        providerId: string,
        oauthProviderIds: Set<string>,
    ) => boolean;
}> {
    const invocation = await resolvePiCliInvocation();
    const modulePath = path.join(
        path.dirname(invocation.cliJsPath),
        'modes/interactive/interactive-mode.js',
    );
    const mod = (await import(pathToFileURL(modulePath).href)) as {
        isApiKeyLoginProvider: (
            providerId: string,
            oauthProviderIds: Set<string>,
        ) => boolean;
    };
    return { isApiKeyLoginProvider: mod.isApiKeyLoginProvider };
}
