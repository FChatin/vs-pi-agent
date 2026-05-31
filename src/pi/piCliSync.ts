import * as vscode from 'vscode';
import type { AgentSession, CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { loadPiCodingAgent } from './piSdk';

export const SYNC_WITH_PI_CLI_KEY = 'syncWithPiCli';

/** When true, auth, models, packages, skills, and sessions follow Pi CLI (~/.pi/agent). */
export function isSyncWithPiCli(): boolean {
    return vscode.workspace.getConfiguration('pi-agent').get<boolean>(SYNC_WITH_PI_CLI_KEY, true);
}

export async function getPiAgentDir(): Promise<string> {
    const { getAgentDir } = await loadPiCodingAgent();
    return getAgentDir();
}

export async function buildAgentSessionOptions(
    cwd: string,
    base: Partial<CreateAgentSessionOptions> = {},
): Promise<CreateAgentSessionOptions> {
    const agentDir = await getPiAgentDir();
    const { SessionManager, SettingsManager } = await loadPiCodingAgent();
    const { getAuthStorage } = await import('./auth');

    const config = vscode.workspace.getConfiguration('pi-agent');
    const sync = isSyncWithPiCli();

    let sessionManager = base.sessionManager;
    if (!sessionManager) {
        const customPath = config.get<string>('sessionStoragePath', '').trim();
        if (!sync && customPath) {
            sessionManager = SessionManager.create(cwd, customPath);
        } else {
            sessionManager = SessionManager.create(cwd);
        }
    }

    const opts: CreateAgentSessionOptions = {
        cwd,
        agentDir,
        authStorage: base.authStorage ?? (await getAuthStorage()),
        modelRegistry: base.modelRegistry,
        sessionManager,
        settingsManager: SettingsManager.create(cwd, agentDir),
        ...base,
    };

    if (!sync) {
        const allowedTools = config.get<string[]>('allowedTools', []);
        if (allowedTools.length > 0) {
            opts.tools = allowedTools;
        }
    }

    return opts;
}

/** Remove extension-only API keys so AuthStorage (~/.pi/agent/auth.json) is the single source. */
export async function clearExtensionApiKeySecrets(secrets: vscode.SecretStorage): Promise<number> {
    const providers = [
        'anthropic', 'openai', 'google', 'deepseek', 'azure', 'mistral', 'groq',
        'xai', 'openrouter', 'cursor',
    ];
    let cleared = 0;
    for (const provider of providers) {
        const key = `pi-agent.apiKey.${provider}`;
        const existing = await secrets.get(key);
        if (existing) {
            await secrets.delete(key);
            cleared++;
        }
    }
    return cleared;
}

export interface PiCliSettingsSummary {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
    packageCount: number;
    extensionCount: number;
}

/** Apply defaultProvider/defaultModel from ~/.pi/agent/settings.json (same as CLI). */
export async function applyPiCliDefaultModel(session: AgentSession): Promise<boolean> {
    if (!isSyncWithPiCli()) {
        return false;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const agentDir = await getPiAgentDir();
    const { SettingsManager } = await loadPiCodingAgent();
    const sm = SettingsManager.create(cwd, agentDir);
    const provider = sm.getDefaultProvider();
    const modelId = sm.getDefaultModel();
    if (!provider || !modelId) {
        return false;
    }
    const model = session.modelRegistry.find(provider, modelId);
    if (!model) {
        return false;
    }
    await session.setModel(model);
    const thinking = sm.getDefaultThinkingLevel();
    if (thinking) {
        session.setThinkingLevel(thinking);
    }
    return true;
}

export function listConfiguredProviders(session: AgentSession): string[] {
    const models = session.modelRegistry.getAvailable();
    return [...new Set(models.map((m) => String(m.provider)))].sort();
}

export async function readPiCliSettingsSummary(): Promise<PiCliSettingsSummary> {
    const agentDir = await getPiAgentDir();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const { SettingsManager } = await loadPiCodingAgent();
    const sm = SettingsManager.create(cwd, agentDir);
    const settings = sm.getGlobalSettings();
    const packages = sm.getPackages();
    const extensions = settings.extensions ?? [];
    return {
        defaultProvider: sm.getDefaultProvider() ?? settings.defaultProvider,
        defaultModel: sm.getDefaultModel() ?? settings.defaultModel,
        defaultThinkingLevel: sm.getDefaultThinkingLevel() ?? settings.defaultThinkingLevel,
        packageCount: packages.length,
        extensionCount: extensions.length,
    };
}
