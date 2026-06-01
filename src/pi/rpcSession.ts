import * as vscode from 'vscode';
import type { ImageContent } from '../shared/piTypes';
import type {
    ContextUsageInfo,
    ModelInfo,
    PlanModeInfo,
    SerializedAgentState,
    SessionInfo,
    SessionTokenStats,
    SkillInfo,
    SlashCommandListItem,
} from '../shared/protocol';
import { EventRouter } from './events';
import { listAllPiSessionsAsync, listPiSessionsForCwdAsync } from './sessionCatalog';
import { resolvePiCliInvocation } from './piCliPaths';
import { applyPiCliDefaultModel } from './piCliSync';
import { PiRpcBridge } from './piRpcBridge';
import { PiExtensionChrome } from './piExtensionChrome';
import { RpcExtensionUiHandler } from './rpcExtensionUi';
import type { PiAgentEvent, RpcExtensionUIRequest, RpcSessionStats } from './rpcTypes';
import { readPlanModeInfoFromContext } from './planModeState';
import { tryHandleBashPrefix } from './slashCommands';
import { isVscodeOnlySlash, tryHandleSlashCommand } from './slashCommandRouter';
import { buildImplementPlanPrompt } from './planModeState';
import type { ExtensionUiBridge } from './extensionUiBridge';
import type { ToolApprovalHandler } from './types';
import {
    enrichUserMessagesWithForkEntryIds,
    findPrecedingUserMessageIndex,
    userMessagePlainText,
} from './messageForkIds';
import { readSessionDisplayName, readSessionJsonlEntries } from './sessionJsonl';
import { readPiSettingsJson } from './piSettingsJson';

const RPC_BUILTIN_SLASH: ReadonlyArray<{ name: string; description: string }> = [
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

export class RpcSessionShim {
    isStreaming = false;
    isBashRunning = false;
    isRetrying = false;
    retryAttempt = 0;
    sessionId = '';
    sessionName?: string;
    sessionFile?: string;
    thinkingLevel = 'off';
    model?: { provider: string; id: string; name?: string };
    cwd: string;
    contextUsage?: ContextUsageInfo;
    activeToolNames: string[] = [];

    constructor(cwd: string) {
        this.cwd = cwd;
    }

    getContextUsage(): ContextUsageInfo | undefined {
        return this.contextUsage;
    }

    getActiveToolNames(): string[] {
        return this.activeToolNames;
    }
}

export class PiRpcSessionManager {
    readonly events = new EventRouter();
    private readonly _outputChannel: vscode.OutputChannel;
    private readonly _bridge = new PiRpcBridge();
    private readonly _rpcUi = new RpcExtensionUiHandler(this._bridge);
    readonly extensionChrome = new PiExtensionChrome();
    private _shim: RpcSessionShim | undefined;
    private _unsubscribe: (() => void) | undefined;
    private _messages: any[] = [];
    private _cachedModels: ModelInfo[] = [];
    private _cachedSkills: SkillInfo[] = [];
    private _cachedCommands: SlashCommandListItem[] = [];
    private _sessionStats: SessionTokenStats | undefined;
    private _extensionUiBridge: ExtensionUiBridge | undefined;
    private _postChatError: ((message: string) => void) | undefined;

    constructor(outputChannel: vscode.OutputChannel) {
        this._outputChannel = outputChannel;
    }

    get session(): RpcSessionShim | undefined {
        return this._shim;
    }

    getSessionTokenStats(): SessionTokenStats | undefined {
        return this._sessionStats;
    }

    get isReady(): boolean {
        return this._bridge.isStarted;
    }

    get rpcExtensionUi(): RpcExtensionUiHandler {
        return this._rpcUi;
    }

    setExtensionUiBridge(_bridge: ExtensionUiBridge | undefined): void {
        this._extensionUiBridge = _bridge;
    }

    setPostChatError(fn: (message: string) => void): void {
        this._postChatError = fn;
    }

    postChatError(message: string): void {
        this._postChatError?.(message);
    }

    setToolApprovalHandler(_handler: ToolApprovalHandler | undefined): void {
        this._outputChannel.appendLine(
            'Tool approval is handled inside the Pi CLI process (pi-agent.autoApproveTools / Pi settings).',
        );
    }

    getExtensionLoadIssues() {
        return [];
    }

    getLoadedExtensionCount(): number {
        return 0;
    }

    async initialize(): Promise<void> {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        this._shim = new RpcSessionShim(cwd);

        const config = vscode.workspace.getConfiguration('pi-agent');
        const args: string[] = [];
        const thinking = config.get<string>('thinkingLevel', 'off');
        if (thinking && thinking !== 'off') {
            args.push('--thinking', thinking);
        }

        this._outputChannel.appendLine('Starting Pi CLI in RPC mode (pi --mode rpc)…');
        const invocation = await resolvePiCliInvocation();
        this._outputChannel.appendLine(
            `  Node: ${invocation.nodePath} | CLI: ${invocation.cliJsPath}`,
        );
        await this._bridge.start(cwd, args);
        this._rpcUi.setChrome(this.extensionChrome);

        this._unsubscribe = this._bridge.on((event) => {
            this._onBridgeEvent(event);
        });

        await this._applyRpcModesFromSettings();
        await this._refreshState();
        await this._refreshMessages();
        await this._refreshModelsAndSkills();
        await this._refreshSessionStats();
        await applyPiCliDefaultModel(this);

        const state = this._shim;
        this._outputChannel.appendLine(
            `Pi RPC ready. Model: ${state?.model ? `${state.model.provider}/${state.model.id}` : 'none'}`,
        );
    }

    private async _applyRpcModesFromSettings(): Promise<void> {
        const settings = readPiSettingsJson();
        try {
            const steering = settings.steeringMode === 'all' ? 'all' : 'one-at-a-time';
            const followUp = settings.followUpMode === 'all' ? 'all' : 'one-at-a-time';
            await this._bridge.setSteeringMode(steering);
            await this._bridge.setFollowUpMode(followUp);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`RPC steering/follow-up mode: ${msg}`);
        }
    }

    private _onBridgeEvent(event: PiAgentEvent | RpcExtensionUIRequest): void {
        if (event.type === 'extension_ui_request') {
            this._rpcUi.handleRequest(event as RpcExtensionUIRequest);
            return;
        }

        const agentEvent = event as PiAgentEvent;
        this.events.dispatch(agentEvent);

        if (agentEvent.type === 'agent_start' && this._shim) {
            this._shim.isStreaming = true;
            this._shim.isRetrying = false;
        }
        if (agentEvent.type === 'auto_retry_start' && this._shim) {
            this._shim.isRetrying = true;
            const attempt = agentEvent.attempt;
            if (typeof attempt === 'number') {
                this._shim.retryAttempt = attempt;
            }
        }
        if (agentEvent.type === 'auto_retry_end' && this._shim) {
            this._shim.isRetrying = false;
        }
        if (agentEvent.type === 'agent_end' && this._shim) {
            this._shim.isStreaming = false;
            void this.syncFromRpc();
        }
        if (agentEvent.type === 'message_end') {
            void this._refreshMessages();
        }
        if (agentEvent.type === 'context_usage' && this._shim) {
            const usage = agentEvent.usage as RpcSessionStats['contextUsage'] | undefined;
            if (usage) {
                this._shim.contextUsage = {
                    tokens: usage.tokens ?? null,
                    contextWindow: usage.contextWindow ?? 0,
                    percent: usage.percent ?? null,
                };
            }
        }
        if (agentEvent.type === 'tools_changed' && this._shim) {
            const tools = agentEvent.tools;
            if (Array.isArray(tools)) {
                this._shim.activeToolNames = tools.map(String);
            }
        }
    }

    /** Refresh messages + session state from Pi RPC (await before UI stateSync). */
    async syncFromRpc(): Promise<void> {
        await this._refreshMessages();
        await Promise.all([this._refreshState(), this._refreshSessionStats()]);
        await this._refreshModelsAndSkills();
    }

    private async _refreshState(): Promise<void> {
        if (!this._shim) {
            return;
        }
        try {
            const state = await this._bridge.getState();
            this._shim.isStreaming = state.isStreaming;
            this._shim.sessionId = state.sessionId;
            this._shim.sessionFile = state.sessionFile;
            this._shim.thinkingLevel = state.thinkingLevel;
            const displayName =
                state.sessionName?.trim() ||
                readSessionDisplayName(state.sessionFile) ||
                undefined;
            this._shim.sessionName = displayName;
            if (state.model) {
                this._shim.model = {
                    provider: String(state.model.provider),
                    id: state.model.id,
                    name: state.model.name,
                };
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`RPC get_state failed: ${msg}`);
        }
    }

    private async _refreshSessionStats(): Promise<void> {
        try {
            const stats = await this._bridge.getSessionStats();
            this._sessionStats = {
                input: stats.tokens.input,
                output: stats.tokens.output,
                cacheRead: stats.tokens.cacheRead,
                cacheWrite: stats.tokens.cacheWrite,
                cost: stats.cost,
            };
            if (stats.contextUsage && this._shim) {
                this._shim.contextUsage = {
                    tokens: stats.contextUsage.tokens ?? null,
                    contextWindow: stats.contextUsage.contextWindow,
                    percent: stats.contextUsage.percent ?? null,
                };
            }
        } catch {
            /* ignore */
        }
    }

    private async _refreshMessages(): Promise<void> {
        try {
            this._messages = (await this._bridge.getMessages()) as any[];
            await this._attachForkEntryIds();
        } catch {
            /* ignore */
        }
    }

    private async _attachForkEntryIds(): Promise<void> {
        try {
            const forkMessages = await this._bridge.getForkMessages();
            enrichUserMessagesWithForkEntryIds(this._messages, forkMessages);
        } catch {
            /* fork list optional */
        }
    }

    /** Run a Pi CLI slash command over RPC and refresh chat when the CLI goes idle. */
    async runCliSlashCommand(text: string): Promise<void> {
        if (!this._bridge.isStarted) {
            throw new Error('Pi RPC not started');
        }
        const trimmed = text.trim();
        if (isVscodeOnlySlash(trimmed)) {
            await tryHandleSlashCommand(this, trimmed);
            return;
        }
        let settled = false;
        const done = new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    unsub();
                    resolve();
                }
            }, 30_000);
            const unsub = this._bridge.on((event) => {
                if (event.type === 'agent_end') {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        unsub();
                        resolve();
                    }
                }
            });
        });
        await this._bridge.prompt(text);
        await done;
        await this.syncFromRpc();
    }

    async prompt(text: string, images?: ImageContent[]): Promise<void> {
        await this.submitInput(text, { mode: 'prompt' }, images);
    }

    async steer(text: string, images?: ImageContent[]): Promise<void> {
        await this.submitInput(text, { mode: 'steer' }, images);
    }

    async followUp(text: string, images?: ImageContent[]): Promise<void> {
        await this.submitInput(text, { mode: 'followUp' }, images);
    }

    async submitInput(
        text: string,
        options: { mode: 'prompt' | 'steer' | 'followUp'; streamingBehavior?: 'steer' | 'followUp' } = {
            mode: 'prompt',
        },
        images?: ImageContent[],
    ): Promise<void> {
        if (!this._bridge.isStarted) {
            throw new Error('Pi RPC not started');
        }

        const trimmed = text.trim();
        if (!trimmed && (!images || images.length === 0)) {
            return;
        }

        if (await tryHandleBashPrefix(this, trimmed)) {
            return;
        }

        if (trimmed.startsWith('/')) {
            await tryHandleSlashCommand(this, trimmed);
            return;
        }

        const rpcImages = images as any[] | undefined;
        if (options.mode === 'steer') {
            await this._bridge.steer(text, rpcImages);
            return;
        }
        if (options.mode === 'followUp') {
            await this._bridge.followUp(text, rpcImages);
            return;
        }
        if (this._shim?.isStreaming) {
            const behavior = options.streamingBehavior ?? 'steer';
            await this._bridge.prompt(text, rpcImages, behavior);
            return;
        }
        await this._bridge.prompt(text, rpcImages);
    }

    async abort(): Promise<void> {
        if (!this._bridge.isStarted) {
            return;
        }
        if (this._shim?.isBashRunning) {
            await this._bridge.abortBash();
        }
        if (this._shim?.isRetrying) {
            await this._bridge.abortRetry();
        }
        const timeoutMs = 12_000;
        try {
            await Promise.race([
                this._bridge.abort(),
                new Promise<void>((_, reject) => {
                    setTimeout(() => reject(new Error('Stop timed out after 12s')), timeoutMs);
                }),
            ]);
        } finally {
            if (this._shim) {
                this._shim.isStreaming = false;
                this._shim.isRetrying = false;
            }
            try {
                await this.syncFromRpc();
            } catch {
                /* best-effort refresh after stop */
            }
        }
    }

    async runBash(command: string, excludeFromContext: boolean): Promise<void> {
        if (this._shim?.isBashRunning) {
            vscode.window.showWarningMessage('A bash command is already running.');
            return;
        }
        if (!this._shim) {
            return;
        }
        this._shim.isBashRunning = true;
        try {
            await this._bridge.bash(command, excludeFromContext);
            await this._refreshMessages();
        } finally {
            this._shim.isBashRunning = false;
        }
    }

    async compact(customInstructions?: string): Promise<void> {
        await this._bridge.compact(customInstructions);
        await this._refreshMessages();
        await this._refreshSessionStats();
    }

    async reloadPiAgentResources(): Promise<void> {
        const cwd = this._shim?.cwd ?? process.cwd();
        await this._bridge.stop();
        await this._bridge.start(cwd, []);
        await this._applyRpcModesFromSettings();
        await this._refreshState();
        await this._refreshMessages();
        await this._refreshModelsAndSkills();
        this._outputChannel.appendLine('Pi RPC process restarted (reload)');
    }

    async setModel(provider: string, modelId: string): Promise<void> {
        await this._bridge.setModel(provider, modelId);
        await this._refreshState();
    }

    setThinkingLevel(level: string): void {
        void this._bridge.setThinkingLevel(level);
        if (this._shim) {
            this._shim.thinkingLevel = level;
        }
    }

    cycleThinkingLevel(): string | undefined {
        void this._bridge.cycleThinkingLevel().then((r) => {
            if (r && this._shim) {
                this._shim.thinkingLevel = r.level;
            }
        });
        return this._shim?.thinkingLevel;
    }

    async cycleModel(): Promise<{ model: { provider: string; id: string }; thinkingLevel: string } | null> {
        const result = await this._bridge.cycleModel();
        await this._refreshState();
        return result;
    }

    async newSession(): Promise<void> {
        await this._bridge.newSession();
        await this.syncFromRpc();
        await applyPiCliDefaultModel(this);
        await this.syncFromRpc();
    }

    async getSessions(scope: 'current' | 'all' = 'current'): Promise<SessionInfo[]> {
        const { resolvePiWorkspaceCwd } = await import('./piCliPaths');
        const cwd = resolvePiWorkspaceCwd(this._shim?.cwd);
        return scope === 'all' ? listAllPiSessionsAsync() : listPiSessionsForCwdAsync(cwd);
    }

    async loadSession(sessionPath: string): Promise<boolean> {
        try {
            const result = await this._bridge.switchSession(sessionPath);
            if (result.cancelled) {
                return false;
            }
            await this.syncFromRpc();
            await applyPiCliDefaultModel(this);
            return true;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (/working directory does not exist|cwd from session file does not exist/i.test(message)) {
                const cwd = this._shim?.cwd ?? process.cwd();
                const choice = await vscode.window.showWarningMessage(
                    'This session was created in a folder that no longer exists. Pi RPC cannot resume it in a different folder yet.',
                    { modal: true, detail: message },
                    'OK',
                );
                if (choice) {
                    this._outputChannel.appendLine(`Resume blocked (missing cwd): ${message}`);
                }
                return false;
            }
            throw err;
        }
    }

    async forkFromMessage(entryId: string): Promise<{ text: string; cancelled: boolean }> {
        const result = await this._bridge.fork(entryId);
        await this._refreshState();
        await this._refreshMessages();
        return result;
    }

    /** Resend edited user text: new turn at end, or fork from that message first. */
    async resendUserMessage(
        messageIndex: number,
        text: string,
        mode: 'new' | 'fork',
        entryId?: string,
    ): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) {
            throw new Error('Message is empty');
        }
        const msg = this._messages[messageIndex];
        if (!msg || msg.role !== 'user') {
            throw new Error('Not a user message');
        }

        if (mode === 'fork') {
            const id =
                entryId ||
                (typeof msg._forkEntryId === 'string' ? msg._forkEntryId : undefined);
            if (!id) {
                throw new Error('Cannot fork: no entry id for this message. Try “Send as new message”.');
            }
            const forked = await this.forkFromMessage(id);
            if (forked.cancelled) {
                return;
            }
        }

        await this.submitInput(trimmed, {
            mode: 'prompt',
            streamingBehavior: 'steer',
        });
        await this.syncFromRpc();
    }

    /** Regenerate assistant reply for the user turn before `assistantMessageIndex`. */
    async regenerateAssistant(
        assistantMessageIndex: number,
        mode: 'new' | 'fork',
    ): Promise<void> {
        const assistant = this._messages[assistantMessageIndex];
        if (!assistant || assistant.role !== 'assistant') {
            throw new Error('Not an assistant message');
        }
        const userIdx = findPrecedingUserMessageIndex(this._messages, assistantMessageIndex);
        if (userIdx < 0) {
            throw new Error('No user message found for this turn');
        }
        const userText = userMessagePlainText(this._messages[userIdx]);
        if (!userText) {
            throw new Error('User message is empty');
        }
        const entryId =
            typeof (this._messages[userIdx] as { _forkEntryId?: string })._forkEntryId === 'string'
                ? (this._messages[userIdx] as { _forkEntryId: string })._forkEntryId
                : undefined;

        await this.resendUserMessage(userIdx, userText, mode, entryId);
    }

    async cloneSession(): Promise<{ cancelled: boolean }> {
        const result = await this._bridge.clone();
        await this._refreshState();
        await this._refreshMessages();
        return result;
    }

    async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
        return this._bridge.getForkMessages();
    }

    async exportHtml(outputPath?: string): Promise<{ path: string }> {
        return this._bridge.exportHtml(outputPath);
    }

    async setSessionName(name: string): Promise<void> {
        await this._bridge.setSessionName(name);
        if (this._shim) {
            this._shim.sessionName = name;
        }
    }

    async applySteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
        await this._bridge.setSteeringMode(mode);
    }

    async applyFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
        await this._bridge.setFollowUpMode(mode);
    }

    getModels(): ModelInfo[] {
        return this._cachedModels;
    }

    private async _refreshModelsAndSkills(): Promise<void> {
        try {
            const models = await this._bridge.getAvailableModels();
            this._cachedModels = models.map((m) => ({
                provider: m.provider,
                id: m.id,
                name: m.id,
            }));
        } catch {
            this._cachedModels = [];
        }
        this._cachedSkills = await this.getSkillsAsync();
        try {
            this._cachedCommands = await this.listSlashCommands();
        } catch {
            this._cachedCommands = [];
        }
    }

    async listSlashCommands(): Promise<SlashCommandListItem[]> {
        const items: SlashCommandListItem[] = RPC_BUILTIN_SLASH.map((c) => ({
            invocation: `/${c.name}`,
            name: c.name,
            description: c.description,
            source: 'builtin' as const,
        }));
        const commands = await this._bridge.getCommands();
        for (const cmd of commands) {
            items.push({
                invocation: `/${cmd.name}`,
                name: cmd.name,
                description: cmd.description,
                source: cmd.source,
            });
        }
        return items;
    }

    getCurrentModel(): ModelInfo | undefined {
        const m = this._shim?.model;
        if (!m) {
            return undefined;
        }
        return { provider: m.provider, id: m.id, name: m.name };
    }

    getThinkingLevel(): string | undefined {
        return this._shim?.thinkingLevel;
    }

    getAutoApproveTools(): boolean {
        return vscode.workspace.getConfiguration('pi-agent').get<boolean>('autoApproveTools', false);
    }

    getSkills(): SkillInfo[] {
        return this._cachedSkills;
    }

    async getSkillsAsync(): Promise<SkillInfo[]> {
        const commands = await this._bridge.getCommands();
        return commands
            .filter((c) => c.source === 'skill')
            .map((c) => ({
                name: c.name.replace(/^skill:/, ''),
                description: c.description ?? '',
                filePath: '',
                source: c.source,
                disableModelInvocation: false,
            }));
    }

    getActiveToolNames(): string[] {
        return this._shim?.activeToolNames ?? [];
    }

    getMessages(): any[] {
        return this._messages;
    }

    getPlanModeInfo(): PlanModeInfo {
        const jsonlEntries = readSessionJsonlEntries(this._shim?.sessionFile);
        return readPlanModeInfoFromContext({
            messages: this._messages,
            jsonlEntries,
            activeToolNames: this._shim?.activeToolNames,
        });
    }

    async setAgentMode(mode: 'agent' | 'plan'): Promise<void> {
        const cmd = mode === 'plan' ? '/plan' : '/plan exit';
        await this._bridge.prompt(cmd);
        // Plan extension updates jsonl + chrome shortly after slash handling.
        await new Promise((resolve) => setTimeout(resolve, 400));
        await this.syncFromRpc();
    }

    async implementPlan(): Promise<void> {
        const plan = this.getPlanModeInfo().planMarkdown.trim();
        if (!plan) {
            throw new Error('No proposed plan to implement');
        }
        await this._bridge.prompt('/plan exit');
        await this._bridge.prompt(buildImplementPlanPrompt(plan));
    }

    setMessages(msgs: any[]): void {
        this._messages = msgs;
    }

    serializeState(): SerializedAgentState {
        const shim = this._shim;
        return {
            messages: this._messages.map(safeSerialize),
            model: shim?.model
                ? { provider: shim.model.provider, id: shim.model.id, name: shim.model.name }
                : undefined,
            thinkingLevel: shim?.thinkingLevel,
            isStreaming: shim?.isStreaming ?? false,
            tools: shim?.activeToolNames ?? [],
            sessionId: shim?.sessionId,
            sessionName: shim?.sessionName,
            contextUsage: shim?.contextUsage,
            sessionTokens: this._sessionStats,
            planMode: this.getPlanModeInfo(),
        };
    }

    async showModelPicker(searchTerm?: string): Promise<void> {
        await this._refreshModelsAndSkills();
        let models = this._cachedModels;
        if (searchTerm?.trim()) {
            const q = searchTerm.trim().toLowerCase();
            models = models.filter(
                (m) =>
                    m.id.toLowerCase().includes(q) ||
                    m.provider.toLowerCase().includes(q) ||
                    (m.name?.toLowerCase().includes(q) ?? false),
            );
        }
        if (models.length === 0) {
            vscode.window.showWarningMessage('No models from Pi RPC. Check ~/.pi/agent auth.');
            return;
        }
        const pick = await vscode.window.showQuickPick(
            models.map((m) => ({ label: m.name ?? m.id, description: m.provider, model: m })),
            { placeHolder: 'Select model' },
        );
        if (pick) {
            await this.setModel(pick.model.provider, pick.model.id);
        }
    }

    async showForkPicker(): Promise<void> {
        const messages = await this.getForkMessages();
        if (messages.length === 0) {
            vscode.window.showInformationMessage('No messages available to fork from.');
            return;
        }
        const pick = await vscode.window.showQuickPick(
            messages.map((m) => ({
                label: m.text.slice(0, 120) || m.entryId,
                description: m.entryId,
                entryId: m.entryId,
            })),
            { title: 'Fork session from message', placeHolder: 'Select fork point' },
        );
        if (!pick) {
            return;
        }
        const result = await this.forkFromMessage(pick.entryId);
        if (result.cancelled) {
            vscode.window.showInformationMessage('Fork cancelled by extension.');
        } else {
            vscode.window.showInformationMessage('Forked to new session branch.');
        }
    }

    async dispose(): Promise<void> {
        this._unsubscribe?.();
        this._rpcUi.dispose();
        await this._bridge.stop();
        this._shim = undefined;
        this.events.clear();
    }

    static async disposeGlobal(): Promise<void> {
        /* no global state */
    }
}

function safeSerialize(obj: unknown): unknown {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { _serializationFailed: true };
    }
}

export async function createPiChatSession(outputChannel: vscode.OutputChannel): Promise<PiRpcSessionManager> {
    const rpc = new PiRpcSessionManager(outputChannel);
    await rpc.initialize();
    return rpc;
}
