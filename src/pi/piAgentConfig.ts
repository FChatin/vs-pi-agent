import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ModelInfo, PiAgentConfigData } from '../shared/protocol';
import type { PiSessionManager } from './session';
import { getPiAgentDir } from './piCliSync';
import { getAvailableModels, getModelRegistry } from './models';
import { normalizePiPackageSource } from './piPackageCatalog';
import { installPiPackage, removePiPackageBySource } from './piPackageInstall';
import { loadPiCodingAgent } from './piSdk';

export interface PiAuthProviderInfo {
    id: string;
    configured: boolean;
}

export interface PiCommandInfo {
    name: string;
    invocationName: string;
    description?: string;
    source?: string;
}

export interface PiAgentConfigSnapshot {
    agentDir: string;
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
    packages: string[];
    extensionPaths: string[];
    skillPaths: string[];
    enableSkillCommands: boolean;
    steeringMode: 'all' | 'one-at-a-time';
    followUpMode: 'all' | 'one-at-a-time';
    authProviders: PiAuthProviderInfo[];
    mcpFileExists: boolean;
    commands: PiCommandInfo[];
    availableModels: ModelInfo[];
}

function getCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

export function packageSourceToString(source: string | { source: string }): string {
    return typeof source === 'string' ? source : source.source;
}

async function createSettingsManager() {
    const { SettingsManager } = await loadPiCodingAgent();
    const cwd = getCwd();
    const agentDir = await getPiAgentDir();
    return { sm: SettingsManager.create(cwd, agentDir), cwd, agentDir };
}

export function emptyPiAgentConfig(): PiAgentConfigData {
    return {
        packages: [],
        extensionPaths: [],
        skillPaths: [],
        enableSkillCommands: true,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        authProviders: [],
        mcpFileExists: false,
        commands: [],
        availableModels: [],
    };
}

function snapshotToConfigData(snap: PiAgentConfigSnapshot): PiAgentConfigData {
    return {
        packages: snap.packages,
        extensionPaths: snap.extensionPaths,
        skillPaths: snap.skillPaths,
        enableSkillCommands: snap.enableSkillCommands,
        steeringMode: snap.steeringMode,
        followUpMode: snap.followUpMode,
        authProviders: snap.authProviders,
        mcpFileExists: snap.mcpFileExists,
        commands: snap.commands,
        availableModels: snap.availableModels,
    };
}

/** Read ~/.pi/agent/settings.json when SDK load fails (settings UI still usable). */
function readSettingsJsonFallback(agentDir: string): PiAgentConfigData {
    const base = emptyPiAgentConfig();
    const settingsPath = path.join(agentDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) {
        return base;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
        const packages = Array.isArray(raw.packages)
            ? raw.packages.map((p) => packageSourceToString(p as string | { source: string }))
            : [];
        const extensionPaths = Array.isArray(raw.extensions)
            ? raw.extensions.filter((x): x is string => typeof x === 'string')
            : [];
        const skillPaths = Array.isArray(raw.skills)
            ? raw.skills.filter((x): x is string => typeof x === 'string')
            : [];
        return {
            ...base,
            packages,
            extensionPaths,
            skillPaths,
            enableSkillCommands: typeof raw.enableSkillCommands === 'boolean'
                ? raw.enableSkillCommands
                : base.enableSkillCommands,
            steeringMode: raw.steeringMode === 'all' ? 'all' : 'one-at-a-time',
            followUpMode: raw.followUpMode === 'all' ? 'all' : 'one-at-a-time',
            authProviders: readAuthProviders(agentDir),
            mcpFileExists: fs.existsSync(path.join(agentDir, 'mcp.json')),
        };
    } catch {
        return base;
    }
}

/** Load config for settings panel; never throws — returns partial data + error message on failure. */
export async function loadPiAgentConfigForSettings(
    sessionManager?: PiSessionManager,
): Promise<{ config: PiAgentConfigData; error?: string }> {
    try {
        const snap = await loadPiAgentConfigSnapshot(sessionManager);
        return { config: snapshotToConfigData(snap) };
    } catch (err: any) {
        const agentDir = await getPiAgentDir();
        return {
            config: readSettingsJsonFallback(agentDir),
            error: err?.message ?? String(err),
        };
    }
}

export async function loadPiAgentConfigSnapshot(
    sessionManager?: PiSessionManager,
): Promise<PiAgentConfigSnapshot> {
    const { sm, agentDir } = await createSettingsManager();
    const packages = sm.getPackages().map(packageSourceToString);
    const extensionPaths = sm.getExtensionPaths();
    const skillPaths = sm.getSkillPaths();

    let availableModels: ModelInfo[] = [];
    try {
        const registry = sessionManager?.session?.modelRegistry ?? await getModelRegistry();
        availableModels = getAvailableModels(registry);
    } catch {
        availableModels = [];
    }

    const commands = await listPiCommands(sessionManager);

    return {
        agentDir,
        defaultProvider: sm.getDefaultProvider(),
        defaultModel: sm.getDefaultModel(),
        defaultThinkingLevel: sm.getDefaultThinkingLevel(),
        packages,
        extensionPaths,
        skillPaths,
        enableSkillCommands: sm.getEnableSkillCommands(),
        steeringMode: sm.getSteeringMode(),
        followUpMode: sm.getFollowUpMode(),
        authProviders: readAuthProviders(agentDir),
        mcpFileExists: fs.existsSync(path.join(agentDir, 'mcp.json')),
        commands,
        availableModels,
    };
}

function readAuthProviders(agentDir: string): PiAuthProviderInfo[] {
    const authPath = path.join(agentDir, 'auth.json');
    if (!fs.existsSync(authPath)) {
        return [];
    }
    try {
        const raw = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
        return Object.keys(raw).sort().map((id) => ({
            id,
            configured: raw[id] !== null && raw[id] !== undefined && raw[id] !== '',
        }));
    } catch {
        return [];
    }
}

async function listPiCommands(sessionManager?: PiSessionManager): Promise<PiCommandInfo[]> {
    const runner = sessionManager?.session?.extensionRunner;
    if (!runner) {
        // Avoid discoverAndLoadExtensions on every settings refresh (slow; can time out).
        return [];
    }
    return runner.getRegisteredCommands().map((c) => ({
        name: c.name,
        invocationName: c.invocationName,
        description: c.description,
        source: c.sourceInfo?.source,
    }));
}

async function persistSettingsManager(sm: Awaited<ReturnType<typeof createSettingsManager>>['sm']): Promise<void> {
    await sm.flush();
    const errors = sm.drainErrors();
    if (errors.length > 0) {
        const msg = errors.map((e) => `${e.scope}: ${e.error.message}`).join('; ');
        throw new Error(msg);
    }
}

export async function updatePiDefaults(
    fields: { provider?: string; model?: string; thinkingLevel?: string },
    sessionManager?: PiSessionManager,
): Promise<void> {
    const { sm } = await createSettingsManager();
    if (fields.provider !== undefined && fields.model !== undefined) {
        sm.setDefaultModelAndProvider(fields.provider, fields.model);
    } else {
        if (fields.provider !== undefined) {
            sm.setDefaultProvider(fields.provider);
        }
        if (fields.model !== undefined) {
            sm.setDefaultModel(fields.model);
        }
    }
    if (fields.thinkingLevel !== undefined) {
        sm.setDefaultThinkingLevel(fields.thinkingLevel as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh');
    }
    await persistSettingsManager(sm);
    await applyDefaultsToActiveSession(sessionManager);
}

export async function setPiPackages(packages: string[], sessionManager?: PiSessionManager): Promise<void> {
    const { sm } = await createSettingsManager();
    sm.setPackages(packages);
    await persistSettingsManager(sm);
    schedulePiSessionReload(sessionManager);
}

export async function addPiPackage(
    source: string,
    sessionManager?: PiSessionManager,
    outputChannel?: import('vscode').OutputChannel,
): Promise<void> {
    const normalized = normalizePiPackageSource(source);
    const { sm } = await createSettingsManager();
    const current = sm.getPackages().map(packageSourceToString);
    if (current.includes(normalized)) {
        return;
    }
    await installPiPackage(normalized, sessionManager, outputChannel);
}

export async function removePiPackageAt(
    index: number,
    sessionManager?: PiSessionManager,
    outputChannel?: import('vscode').OutputChannel,
): Promise<void> {
    const { sm } = await createSettingsManager();
    const packages = sm.getPackages().map(packageSourceToString);
    const source = packages[index];
    if (!source) {
        throw new Error('Invalid package index');
    }
    await removePiPackageBySource(source, sessionManager, outputChannel);
}

export async function setPiExtensionPaths(paths: string[], sessionManager?: PiSessionManager): Promise<void> {
    const { sm } = await createSettingsManager();
    sm.setExtensionPaths(paths);
    await persistSettingsManager(sm);
}

export async function addPiExtensionPath(filePath: string, sessionManager?: PiSessionManager): Promise<void> {
    const trimmed = filePath.trim();
    if (!trimmed) {
        throw new Error('Extension path is empty');
    }
    const { sm } = await createSettingsManager();
    const paths = [...sm.getExtensionPaths()];
    if (!paths.includes(trimmed)) {
        paths.push(trimmed);
    }
    sm.setExtensionPaths(paths);
    await persistSettingsManager(sm);
}

export async function removePiExtensionPathAt(index: number, sessionManager?: PiSessionManager): Promise<void> {
    const { sm } = await createSettingsManager();
    const paths = [...sm.getExtensionPaths()];
    if (index < 0 || index >= paths.length) {
        throw new Error('Invalid extension path index');
    }
    paths.splice(index, 1);
    sm.setExtensionPaths(paths);
    await persistSettingsManager(sm);
}

export async function setPiSkillPaths(paths: string[], sessionManager?: PiSessionManager): Promise<void> {
    const { sm } = await createSettingsManager();
    sm.setSkillPaths(paths);
    await persistSettingsManager(sm);
}

export async function addPiSkillPath(skillPath: string, sessionManager?: PiSessionManager): Promise<void> {
    const trimmed = skillPath.trim();
    if (!trimmed) {
        throw new Error('Skill path is empty');
    }
    const { sm } = await createSettingsManager();
    const paths = [...sm.getSkillPaths()];
    if (!paths.includes(trimmed)) {
        paths.push(trimmed);
    }
    sm.setSkillPaths(paths);
    await persistSettingsManager(sm);
}

export async function removePiSkillPathAt(index: number, sessionManager?: PiSessionManager): Promise<void> {
    const { sm } = await createSettingsManager();
    const paths = [...sm.getSkillPaths()];
    if (index < 0 || index >= paths.length) {
        throw new Error('Invalid skill path index');
    }
    paths.splice(index, 1);
    sm.setSkillPaths(paths);
    await persistSettingsManager(sm);
}

export async function setPiEnableSkillCommands(
    enabled: boolean,
    sessionManager?: PiSessionManager,
): Promise<void> {
    const { sm } = await createSettingsManager();
    sm.setEnableSkillCommands(enabled);
    await persistSettingsManager(sm);
    schedulePiSessionReload(sessionManager);
}

export async function setPiSteeringMode(
    mode: 'all' | 'one-at-a-time',
    sessionManager?: PiSessionManager,
): Promise<void> {
    const { sm } = await createSettingsManager();
    sm.setSteeringMode(mode);
    await persistSettingsManager(sm);
    await applyDefaultsToActiveSession(sessionManager);
}

export async function setPiFollowUpMode(
    mode: 'all' | 'one-at-a-time',
    sessionManager?: PiSessionManager,
): Promise<void> {
    const { sm } = await createSettingsManager();
    sm.setFollowUpMode(mode);
    await persistSettingsManager(sm);
    await applyDefaultsToActiveSession(sessionManager);
}

export async function openPiAgentFile(file: 'settings' | 'auth' | 'mcp'): Promise<void> {
    const agentDir = await getPiAgentDir();
    const names: Record<typeof file, string> = {
        settings: 'settings.json',
        auth: 'auth.json',
        mcp: 'mcp.json',
    };
    const filePath = path.join(agentDir, names[file]);
    if (!fs.existsSync(filePath) && file !== 'settings') {
        fs.writeFileSync(filePath, file === 'mcp' ? '{\n  "mcpServers": {}\n}\n' : '{}\n', 'utf8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
}

async function applyDefaultsToActiveSession(sessionManager?: PiSessionManager): Promise<void> {
    const session = sessionManager?.session;
    if (!session) {
        return;
    }
    const { applyPiCliDefaultModel } = await import('./piCliSync');
    await applyPiCliDefaultModel(session);
}

/** Apply ~/.pi/agent changes to the live session without blocking the settings UI. */
export function schedulePiSessionReload(
    sessionManager: PiSessionManager | undefined,
    outputChannel?: import('vscode').OutputChannel,
): void {
    if (!sessionManager) {
        return;
    }
    void sessionManager.reloadPiAgentResources().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel?.appendLine(`Pi session reload (background): ${msg}`);
    });
}
