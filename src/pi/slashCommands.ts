import * as vscode from 'vscode';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { SlashCommandListItem } from '../shared/protocol';
import type { PiSessionManager } from './session';
import { createVscodeOAuthCallbacks } from './oauthCallbacks';
import { getAuthStorage } from './auth';

/** Built-in Pi slash commands (same set as terminal `pi`). */
export const PI_BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
    { name: 'login', description: 'Configure provider authentication' },
    { name: 'logout', description: 'Remove stored credentials' },
    { name: 'model', description: 'Select model' },
    { name: 'new', description: 'Start a new session' },
    { name: 'reload', description: 'Reload extensions, skills, packages' },
    { name: 'settings', description: 'Open Pi settings' },
    { name: 'compact', description: 'Compact session context' },
    { name: 'resume', description: 'Resume another session' },
    { name: 'session', description: 'Show session info' },
];

function isApiKeyLoginProvider(providerId: string, oauthIds: Set<string>): boolean {
    if (oauthIds.has(providerId)) {
        return false;
    }
    return true;
}

export async function listSlashCommandsForUi(session?: AgentSession): Promise<SlashCommandListItem[]> {
    const items: SlashCommandListItem[] = PI_BUILTIN_SLASH_COMMANDS.map((c) => ({
        invocation: `/${c.name}`,
        name: c.name,
        description: c.description,
        source: 'builtin' as const,
    }));

    if (session?.extensionRunner) {
        for (const cmd of session.extensionRunner.getRegisteredCommands()) {
            items.push({
                invocation: `/${cmd.invocationName}`,
                name: cmd.invocationName,
                description: cmd.description,
                source: 'extension',
            });
        }
    }

    try {
        const skills = session?.resourceLoader.getSkills().skills ?? [];
        for (const skill of skills) {
            items.push({
                invocation: `/skill:${skill.name}`,
                name: `skill:${skill.name}`,
                description: skill.description,
                source: 'skill',
            });
        }
    } catch {
        // ignore
    }

    return items;
}

/**
 * Handle Pi built-in slash commands before sending text to the LLM.
 * Extension-registered commands (pi.registerCommand) are left to AgentSession.prompt().
 */
export async function tryHandleBuiltinSlashCommand(
    manager: PiSessionManager,
    text: string,
): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
        return false;
    }

    const session = manager.session;
    if (!session) {
        vscode.window.showWarningMessage('Pi session is not ready yet.');
        return true;
    }

    const space = trimmed.indexOf(' ');
    const command = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
    const args = space === -1 ? '' : trimmed.slice(space + 1).trim();

    switch (command) {
        case 'login':
            await runPiLoginFlow(session);
            return true;
        case 'logout':
            await runPiLogoutFlow(session);
            return true;
        case 'model':
            await manager.showModelPicker(args || undefined);
            return true;
        case 'new':
            await manager.newSession();
            vscode.window.showInformationMessage('New Pi session started.');
            return true;
        case 'reload':
            await manager.reloadPiAgentResources();
            vscode.window.showInformationMessage('Pi session reloaded.');
            return true;
        case 'settings':
            await vscode.commands.executeCommand('pi-agent.openSettings');
            return true;
        case 'compact':
            await session.compact(args || undefined);
            vscode.window.showInformationMessage('Session compacted.');
            return true;
        case 'resume':
            await runResumeFlow(manager);
            return true;
        case 'session': {
            const model = session.model;
            const name = session.sessionName ?? session.sessionId ?? 'current';
            const msg = model
                ? `Session: ${name}\nModel: ${model.provider}/${model.id}\nThinking: ${session.thinkingLevel ?? 'off'}`
                : `Session: ${name}`;
            vscode.window.showInformationMessage(msg, { modal: true });
            return true;
        }
        default:
            return false;
    }
}

/** Same interactive flow as chat `/login` — usable from settings and command palette. */
export async function runPiLoginFlow(session: AgentSession): Promise<void> {
    const authType = await vscode.window.showQuickPick(
        [
            { label: 'Use a subscription (OAuth)', id: 'oauth' as const },
            { label: 'Use an API key', id: 'api_key' as const },
        ],
        { title: 'Pi /login', placeHolder: 'Authentication method' },
    );
    if (!authType) {
        return;
    }

    const providers = getLoginProviderOptions(session, authType.id);
    if (providers.length === 0) {
        vscode.window.showWarningMessage(
            authType.id === 'oauth'
                ? 'No OAuth providers available.'
                : 'No API-key providers available.',
        );
        return;
    }

    const pick = await vscode.window.showQuickPick(
        providers.map((p) => ({
            label: p.name,
            description: p.id,
            provider: p,
        })),
        { title: 'Pi /login — select provider', placeHolder: 'Provider' },
    );
    if (!pick) {
        return;
    }

    const { id, name, authType: providerAuthType } = pick.provider;
    const authStorage = await getAuthStorage();

    try {
        if (providerAuthType === 'oauth') {
            const oauthProviders = authStorage.getOAuthProviders();
            const oauth = oauthProviders.find((p) => p.id === id);
            if (!oauth) {
                throw new Error(`OAuth provider "${id}" not found`);
            }
            await authStorage.login(id as any, createVscodeOAuthCallbacks());
            session.modelRegistry.refresh();
            vscode.window.showInformationMessage(`Logged in to ${name}. Credentials saved to ~/.pi/agent/auth.json`);
        } else {
            const key = await vscode.window.showInputBox({
                title: `API key for ${name}`,
                prompt: `Enter API key for ${id}`,
                password: true,
                ignoreFocusOut: true,
            });
            if (!key?.trim()) {
                return;
            }
            authStorage.set(id, { type: 'api_key', key: key.trim() });
            session.modelRegistry.refresh();
            vscode.window.showInformationMessage(`Saved API key for ${name}.`);
        }
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg !== 'Login cancelled') {
            vscode.window.showErrorMessage(`Login failed: ${msg}`);
        }
    }
}

function getLoginProviderOptions(
    session: AgentSession,
    authType: 'oauth' | 'api_key',
): Array<{ id: string; name: string; authType: 'oauth' | 'api_key' }> {
    const authStorage = session.modelRegistry.authStorage;
    const oauthProviders = authStorage.getOAuthProviders();
    const oauthIds = new Set(oauthProviders.map((p) => p.id));

    const options: Array<{ id: string; name: string; authType: 'oauth' | 'api_key' }> = [];

    if (authType === 'oauth') {
        for (const p of oauthProviders) {
            options.push({ id: p.id, name: p.name, authType: 'oauth' });
        }
    } else {
        const modelProviders = new Set(session.modelRegistry.getAll().map((m) => String(m.provider)));
        for (const providerId of modelProviders) {
            if (!isApiKeyLoginProvider(providerId, oauthIds)) {
                continue;
            }
            options.push({
                id: providerId,
                name: session.modelRegistry.getProviderDisplayName(providerId),
                authType: 'api_key',
            });
        }
    }

    return options.sort((a, b) => a.name.localeCompare(b.name));
}

/** Same interactive flow as chat `/logout`. */
export async function runPiLogoutFlow(session: AgentSession): Promise<void> {
    const authStorage = session.modelRegistry.authStorage;
    const stored = authStorage.list();
    if (stored.length === 0) {
        vscode.window.showInformationMessage(
            'No stored credentials. /logout only removes ~/.pi/agent/auth.json entries.',
        );
        return;
    }

    const pick = await vscode.window.showQuickPick(
        stored.map((id) => ({
            label: session.modelRegistry.getProviderDisplayName(id),
            description: id,
            id,
        })),
        { title: 'Pi /logout', placeHolder: 'Remove credentials for…' },
    );
    if (!pick) {
        return;
    }

    authStorage.logout(pick.id);
    session.modelRegistry.refresh();
    vscode.window.showInformationMessage(`Removed credentials for ${pick.label}.`);
}

async function runResumeFlow(manager: PiSessionManager): Promise<void> {
    const sessions = await manager.getSessions();
    if (sessions.length === 0) {
        vscode.window.showInformationMessage('No saved sessions for this workspace.');
        return;
    }

    const pick = await vscode.window.showQuickPick(
        sessions.map((s) => ({
            label: s.name ?? s.id,
            description: s.path,
            session: s,
        })),
        { title: 'Pi /resume', placeHolder: 'Select session' },
    );
    if (!pick?.session.path) {
        return;
    }

    await manager.loadSession(pick.session.path);
    vscode.window.showInformationMessage(`Resumed session: ${pick.label}`);
}

export async function tryHandleBashPrefix(manager: PiSessionManager, text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('!')) {
        return false;
    }
    const session = manager.session;
    if (!session) {
        return false;
    }
    const isExcluded = trimmed.startsWith('!!');
    const command = isExcluded ? trimmed.slice(2).trim() : trimmed.slice(1).trim();
    if (!command) {
        return false;
    }
    if (session.isBashRunning) {
        vscode.window.showWarningMessage('A bash command is already running. Press Escape to stop generation first.');
        return true;
    }
    try {
        await session.executeBash(command, undefined, { excludeFromContext: isExcluded });
    } catch (err: any) {
        vscode.window.showErrorMessage(`Bash failed: ${err?.message ?? err}`);
    }
    return true;
}
