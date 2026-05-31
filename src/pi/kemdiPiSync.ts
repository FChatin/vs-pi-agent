import * as fs from 'fs';
import * as path from 'path';
import type { AgentSession, ModelRegistry } from '@earendil-works/pi-coding-agent';

const KEMDI_CONFIG_FILE = '.kemdicode-mcp.json';

const PROVIDER_PREFIX: Record<string, string> = {
    google: 'g',
    gemini: 'g',
    anthropic: 'a',
    openai: 'o',
    openrouter: 'openrouter',
    groq: 'q',
    deepseek: 'd',
    ollama: 'l',
    perplexity: 'p',
};

const PROVIDER_BASE_URL: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1',
    anthropic: 'https://api.anthropic.com/v1',
    openai: 'https://api.openai.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
    groq: 'https://api.groq.com/openai/v1',
    deepseek: 'https://api.deepseek.com/v1',
    ollama: 'http://127.0.0.1:11434/v1',
};

export interface KemdiServerConfigPatch {
    primaryModel: string;
    fallbackModel?: string;
    apiBaseUrl?: string;
    apiKey?: string;
}

/** Map Pi session model → kemdicode primary model spec (g:, a:, openrouter:, …). */
export function formatKemdiPrimaryModel(provider: string, modelId: string): string {
    const p = (provider || '').trim().toLowerCase();
    const id = (modelId || '').trim();
    if (!id) {
        return '';
    }
    if (/^[a-z]:/i.test(id) || id.startsWith('openrouter:') || id.startsWith('anthropic:')) {
        return id;
    }
    if (id.includes('/')) {
        return p === 'openrouter' ? `openrouter:${id}` : `openrouter:${id}`;
    }
    const prefix = PROVIDER_PREFIX[p];
    if (prefix && prefix !== 'openrouter') {
        return `${prefix}:${id}`;
    }
    if (p === 'openrouter') {
        return `openrouter:${id}`;
    }
    return id;
}

function getProviderId(model: { provider?: unknown }): string {
    return String(model.provider ?? '');
}

/**
 * Build Kemdi server config from the active Pi model + registry auth (OpenAI-compatible).
 */
export async function buildKemdiConfigFromPiSession(
    session: AgentSession,
): Promise<KemdiServerConfigPatch | undefined> {
    const model = session.model;
    if (!model) {
        return undefined;
    }
    const provider = getProviderId(model);
    const primaryModel = formatKemdiPrimaryModel(provider, model.id);
    if (!primaryModel) {
        return undefined;
    }

    const registry = session.modelRegistry;
    let apiKey: string | undefined;
    let apiBaseUrl = PROVIDER_BASE_URL[provider.toLowerCase()];

    try {
        if (registry.hasConfiguredAuth(model)) {
            const auth = await registry.getApiKeyAndHeaders(model);
            apiKey = auth.apiKey;
            const base = (auth as { baseUrl?: string }).baseUrl;
            if (typeof base === 'string' && base.length > 0) {
                apiBaseUrl = base.endsWith('/v1') ? base : `${base.replace(/\/$/, '')}/v1`;
            }
        } else {
            apiKey = await registry.getApiKeyForProvider(provider);
        }
    } catch {
        apiKey = await registry.getApiKeyForProvider(provider).catch(() => undefined);
    }

    const patch: KemdiServerConfigPatch = {
        primaryModel,
        fallbackModel: primaryModel,
    };
    if (apiBaseUrl) {
        patch.apiBaseUrl = apiBaseUrl;
    }
    if (apiKey) {
        patch.apiKey = apiKey;
    }
    return patch;
}

/** Merge Kemdi project config so MCP subprocess uses the same model as Pi (not CLI --model). */
export async function syncKemdiProjectConfig(
    cwd: string,
    patch: KemdiServerConfigPatch,
): Promise<boolean> {
    if (!patch.primaryModel) {
        return false;
    }
    const filePath = path.join(cwd, KEMDI_CONFIG_FILE);
    let fileConfig: Record<string, Record<string, unknown>> = {};
    if (fs.existsSync(filePath)) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(filePath, 'utf8')) as typeof fileConfig;
        } catch {
            fileConfig = {};
        }
    }
    const server = { ...(fileConfig.server ?? {}) };
    server.primaryModel = patch.primaryModel;
    if (patch.fallbackModel) {
        server.fallbackModel = patch.fallbackModel;
    }
    if (patch.apiBaseUrl) {
        server.apiBaseUrl = patch.apiBaseUrl;
    }
    if (patch.apiKey) {
        server.apiKey = patch.apiKey;
    }
    fileConfig.server = server;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(fileConfig, null, 2)}\n`, 'utf8');
    return true;
}

export async function syncKemdiWithPiSession(session: AgentSession | undefined, cwd: string): Promise<void> {
    if (!session?.model) {
        return;
    }
    const patch = await buildKemdiConfigFromPiSession(session);
    if (!patch) {
        return;
    }
    await syncKemdiProjectConfig(cwd, patch);
}
