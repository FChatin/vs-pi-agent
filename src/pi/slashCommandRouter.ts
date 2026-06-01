import * as vscode from 'vscode';
import type { PiChatSession } from './slashCommands';
import { tryHandleBuiltinSlashCommand } from './slashCommands';
import type { PiRpcSessionManager } from './rpcSession';

export type SettingsFocusSection =
    | 'mcp'
    | 'packages'
    | 'auth'
    | 'defaults'
    | 'skills'
    | 'extensions'
    | 'commands';

/** Slash commands that need a VS Code panel instead of Pi TUI (RPC has no terminal UI). */
const GUI_SLASH: Record<string, SettingsFocusSection | 'settings' | 'sessions' | 'fork'> = {
    mcp: 'mcp',
    config: 'packages',
    packages: 'packages',
    settings: 'settings',
    fork: 'fork',
    'setup-custom-providers': 'defaults',
    profile: 'defaults',
};

function parseSlash(text: string): { command: string; args: string } {
    const trimmed = text.trim();
    const space = trimmed.indexOf(' ');
    const command = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
    const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
    return { command, args };
}

async function openSettingsSection(section: SettingsFocusSection | 'settings'): Promise<void> {
    const { SettingsPanel } = await import('../providers/settings-panel');
    if (section === 'settings') {
        await vscode.commands.executeCommand('pi-agent.openSettings');
        return;
    }
    SettingsPanel.showWithSection(section);
}

/**
 * Route slash input: GUI actions, VS Code builtins, then Pi CLI via RPC prompt.
 * Returns true when the line was handled (do not send to the model as plain text).
 */
export async function tryHandleSlashCommand(manager: PiChatSession, text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
        return false;
    }

    const { command } = parseSlash(trimmed);

    const gui = GUI_SLASH[command];
    if (gui) {
        if (gui === 'settings') {
            await vscode.commands.executeCommand('pi-agent.openSettings');
            return true;
        }
        if (gui === 'fork') {
            await manager.showForkPicker();
            return true;
        }
        await openSettingsSection(gui);
        vscode.window.setStatusBarMessage(`vs-pi-agent: /${command} → settings`, 3000);
        return true;
    }

    if (await tryHandleBuiltinSlashCommand(manager, trimmed)) {
        return true;
    }

    // Extension / skill / prompt-template commands — same as typing in pi terminal
    await runCliSlashCommand(manager, trimmed);
    return true;
}

/** Send slash to Pi RPC and wait for the CLI to finish handling it. */
export async function runCliSlashCommand(manager: PiChatSession, text: string): Promise<void> {
    const rpc = manager as PiRpcSessionManager;
    if (typeof rpc.runCliSlashCommand === 'function') {
        await rpc.runCliSlashCommand(text);
        return;
    }
    await manager.submitInput(text, { mode: 'prompt' });
}
