import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { ModelInfo } from '../shared/protocol';
import { getAuthStorage } from './auth';
import { getPiAgentDir } from './piCliSync';
import { loadPiCodingAgent } from './piSdk';

let cached: ModelRegistry | undefined;

export async function getModelRegistry(): Promise<ModelRegistry> {
    if (cached) {
        return cached;
    }
    const path = await import('path');
    const { ModelRegistry: MR } = await loadPiCodingAgent();
    const authStorage = await getAuthStorage();
    const agentDir = await getPiAgentDir();
    cached = MR.create(authStorage, path.join(agentDir, 'models.json'));
    return cached;
}

export function getAvailableModels(registry: ModelRegistry): ModelInfo[] {
    return registry.getAvailable().map((m) => ({
        provider: String(m.provider),
        id: m.id,
        name: m.name,
    }));
}

export function findModel(registry: ModelRegistry, provider: string, modelId: string) {
    return registry.find(provider, modelId);
}

export function disposeModelRegistry() {
    cached = undefined;
}
