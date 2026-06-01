import * as vscode from 'vscode';
import { getPiAgentDir, readPiCliSettingsSummary } from './piSettingsJson';

export { getPiAgentDir } from './piCliPaths';
export { readPiCliSettingsSummary } from './piSettingsJson';

export const SYNC_WITH_PI_CLI_KEY = 'syncWithPiCli';

/** Pi config always follows ~/.pi/agent when using CLI RPC backend. */
export function isSyncWithPiCli(): boolean {
    return vscode.workspace.getConfiguration('pi-agent').get<boolean>(SYNC_WITH_PI_CLI_KEY, true);
}

/** Remove extension-only API keys so ~/.pi/agent/auth.json is the single source. */
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

export async function applyPiCliDefaultModel(sessionManager: {
    setModel: (provider: string, modelId: string) => Promise<void>;
    setThinkingLevel: (level: string) => void;
}): Promise<boolean> {
    if (!isSyncWithPiCli()) {
        return false;
    }
    const summary = readPiCliSettingsSummary();
    if (!summary.defaultProvider || !summary.defaultModel) {
        return false;
    }
    await sessionManager.setModel(summary.defaultProvider, summary.defaultModel);
    if (summary.defaultThinkingLevel) {
        sessionManager.setThinkingLevel(summary.defaultThinkingLevel);
    }
    return true;
}

export function listConfiguredProviders(models: Array<{ provider: string }>): string[] {
    return [...new Set(models.map((m) => m.provider))].sort();
}
