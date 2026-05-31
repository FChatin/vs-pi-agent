import type { AuthStorage } from '@earendil-works/pi-coding-agent';
import { getPiAgentDir } from './piCliSync';
import { loadPiCodingAgent } from './piSdk';

let cached: AuthStorage | undefined;

export async function getAuthStorage(): Promise<AuthStorage> {
    if (cached) {
        return cached;
    }
    const { AuthStorage: AS } = await loadPiCodingAgent();
    const path = await import('path');
    const agentDir = await getPiAgentDir();
    cached = AS.create(path.join(agentDir, 'auth.json'));
    return cached;
}

export function disposeAuthStorage() {
    cached = undefined;
}
