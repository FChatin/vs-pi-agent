import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ModelInfo, PiAgentConfigData } from '../shared/protocol';
import type { PiChatSession } from './slashCommands';
import { getPiAgentDir } from './piCliPaths';
import { normalizePiPackageSource } from './piPackageCatalog';
import { installPiPackage, removePiPackageBySource } from './piPackageInstall';
import {
    getPiPackagesFromSettings,
    readPiSettingsJson,
    writePiSettingsJson,
    type PiSettingsJson,
} from './piSettingsJson';

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
    const agentDir = getPiAgentDir();
    const cwd = getCwd();
    return { agentDir, cwd, settings: readPiSettingsJson() };
}

async function persistSettings(settings: PiSettingsJson): Promise<void> {
    writePiSettingsJson(() => settings);
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
    sessionManager?: PiChatSession,
): Promise<{ config: PiAgentConfigData; error?: string }> {
    try {
        const snap = await loadPiAgentConfigSnapshot(sessionManager);
        return { config: snapshotToConfigData(snap) };
    } catch (err: any) {
        const agentDir = getPiAgentDir();
        return {
            config: readSettingsJsonFallback(agentDir),
            error: err?.message ?? String(err),
        };
    }
}

export async function loadPiAgentConfigSnapshot(
    sessionManager?: PiChatSession,
): Promise<PiAgentConfigSnapshot> {
    const { settings, agentDir } = await createSettingsManager();
    const packages = getPiPackagesFromSettings();
    const extensionPaths = settings.extensions ?? [];
    const skillPaths = settings.skills ?? [];

    let availableModels: ModelInfo[] = [];
    if (sessionManager) {
        availableModels = sessionManager.getModels();
    }

    const commands = await listPiCommands(sessionManager);

    return {
        agentDir,
        defaultProvider: settings.defaultProvider,
        defaultModel: settings.defaultModel,
        defaultThinkingLevel: settings.defaultThinkingLevel,
        packages,
        extensionPaths,
        skillPaths,
        enableSkillCommands: settings.enableSkillCommands ?? true,
        steeringMode: settings.steeringMode === 'all' ? 'all' : 'one-at-a-time',
        followUpMode: settings.followUpMode === 'all' ? 'all' : 'one-at-a-time',
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

async function listPiCommands(sessionManager?: PiChatSession): Promise<PiCommandInfo[]> {
    if (sessionManager) {
        const cmds = await sessionManager.listSlashCommands();
        return cmds.map((c) => ({
            name: c.name,
            invocationName: c.name,
            description: c.description,
            source: c.source,
        }));
    }
    return [];
}

async function persistSettingsManager(_sm: unknown): Promise<void> {
    /* settings persisted via writePiSettingsJson */
}

export async function updatePiDefaults(
    fields: { provider?: string; model?: string; thinkingLevel?: string },
    sessionManager?: PiChatSession,
): Promise<void> {
    writePiSettingsJson((current) => {
        const next = { ...current };
        if (fields.provider !== undefined) {
            next.defaultProvider = fields.provider;
        }
        if (fields.model !== undefined) {
            next.defaultModel = fields.model;
        }
        if (fields.thinkingLevel !== undefined) {
            next.defaultThinkingLevel = fields.thinkingLevel;
        }
        return next;
    });
    await applyDefaultsToActiveSession(sessionManager);
}

export async function setPiPackages(packages: string[], sessionManager?: PiChatSession): Promise<void> {
    writePiSettingsJson((current) => ({ ...current, packages }));
    schedulePiSessionReload(sessionManager);
}

export async function addPiPackage(
    source: string,
    sessionManager?: PiChatSession,
    outputChannel?: import('vscode').OutputChannel,
): Promise<void> {
    const normalized = normalizePiPackageSource(source);
    const current = getPiPackagesFromSettings();
    if (current.includes(normalized)) {
        return;
    }
    await installPiPackage(normalized, sessionManager, outputChannel);
}

export async function removePiPackageAt(
    index: number,
    sessionManager?: PiChatSession,
    outputChannel?: import('vscode').OutputChannel,
): Promise<void> {
    const packages = getPiPackagesFromSettings();
    const source = packages[index];
    if (!source) {
        throw new Error('Invalid package index');
    }
    await removePiPackageBySource(source, sessionManager, outputChannel);
}

export async function setPiExtensionPaths(paths: string[], sessionManager?: PiChatSession): Promise<void> {
    writePiSettingsJson((current) => ({ ...current, extensions: paths }));
    void sessionManager;
}

export async function addPiExtensionPath(filePath: string, sessionManager?: PiChatSession): Promise<void> {
    const trimmed = filePath.trim();
    if (!trimmed) {
        throw new Error('Extension path is empty');
    }
    writePiSettingsJson((current) => {
        const paths = [...(current.extensions ?? [])];
        if (!paths.includes(trimmed)) {
            paths.push(trimmed);
        }
        return { ...current, extensions: paths };
    });
    void sessionManager;
}

export async function removePiExtensionPathAt(index: number, sessionManager?: PiChatSession): Promise<void> {
    writePiSettingsJson((current) => {
        const paths = [...(current.extensions ?? [])];
        if (index < 0 || index >= paths.length) {
            throw new Error('Invalid extension path index');
        }
        paths.splice(index, 1);
        return { ...current, extensions: paths };
    });
    void sessionManager;
}

export async function setPiSkillPaths(paths: string[], sessionManager?: PiChatSession): Promise<void> {
    writePiSettingsJson((current) => ({ ...current, skills: paths }));
    void sessionManager;
}

export async function addPiSkillPath(skillPath: string, sessionManager?: PiChatSession): Promise<void> {
    const trimmed = skillPath.trim();
    if (!trimmed) {
        throw new Error('Skill path is empty');
    }
    writePiSettingsJson((current) => {
        const paths = [...(current.skills ?? [])];
        if (!paths.includes(trimmed)) {
            paths.push(trimmed);
        }
        return { ...current, skills: paths };
    });
    void sessionManager;
}

export async function removePiSkillPathAt(index: number, sessionManager?: PiChatSession): Promise<void> {
    writePiSettingsJson((current) => {
        const paths = [...(current.skills ?? [])];
        if (index < 0 || index >= paths.length) {
            throw new Error('Invalid skill path index');
        }
        paths.splice(index, 1);
        return { ...current, skills: paths };
    });
    void sessionManager;
}

export async function setPiEnableSkillCommands(
    enabled: boolean,
    sessionManager?: PiChatSession,
): Promise<void> {
    writePiSettingsJson((current) => ({ ...current, enableSkillCommands: enabled }));
    schedulePiSessionReload(sessionManager);
}

export async function setPiSteeringMode(
    mode: 'all' | 'one-at-a-time',
    sessionManager?: PiChatSession,
): Promise<void> {
    writePiSettingsJson((current) => ({ ...current, steeringMode: mode }));
    await applyDefaultsToActiveSession(sessionManager);
}

export async function setPiFollowUpMode(
    mode: 'all' | 'one-at-a-time',
    sessionManager?: PiChatSession,
): Promise<void> {
    writePiSettingsJson((current) => ({ ...current, followUpMode: mode }));
    await applyDefaultsToActiveSession(sessionManager);
}

export async function openPiAgentFile(file: 'settings' | 'auth' | 'mcp'): Promise<void> {
    const agentDir = getPiAgentDir();
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

async function applyDefaultsToActiveSession(sessionManager?: PiChatSession): Promise<void> {
    if (!sessionManager) {
        return;
    }
    const { readPiCliSettingsSummary } = await import('./piCliSync');
    const summary = readPiCliSettingsSummary();
    if (summary.defaultProvider && summary.defaultModel) {
        await sessionManager.setModel(summary.defaultProvider, summary.defaultModel);
    }
    if (summary.defaultThinkingLevel) {
        sessionManager.setThinkingLevel(summary.defaultThinkingLevel);
    }
}

/** Apply ~/.pi/agent changes to the live session without blocking the settings UI. */
export function schedulePiSessionReload(
    sessionManager: PiChatSession | undefined,
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
