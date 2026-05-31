import * as vscode from 'vscode';
import type { AgentSession, AgentSessionEvent, SessionManager, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { ImageContent } from '@earendil-works/pi-ai';
import type {
    SerializedAgentState,
    ModelInfo,
    SessionInfo,
    ContextUsageInfo,
    SessionTokenStats,
    SkillInfo,
} from '../shared/protocol';
import { EventRouter } from './events';
import { disposeAuthStorage } from './auth';
import { getModelRegistry, getAvailableModels, findModel, disposeModelRegistry } from './models';
import {
    applyPiCliDefaultModel,
    buildAgentSessionOptions,
    isSyncWithPiCli,
    listConfiguredProviders,
} from './piCliSync';
import { logExtensionLoadResult } from './piExtensionDiagnostics';
import { tryHandleBashPrefix, tryHandleBuiltinSlashCommand } from './slashCommands';
import { getPiExtensionPath, getPiSdkEntryPath, loadPiCodingAgent } from './piSdk';
import { buildImplementPlanPrompt, readPlanModeInfo } from './planModeState';
import { syncKemdiWithPiSession } from './kemdiPiSync';
import type { ExtensionUiBridge } from './extensionUiBridge';
import type { PlanModeInfo } from '../shared/protocol';
import * as path from 'path';
import { pathToFileURL } from 'url';

export type ToolApprovalHandler = (toolCallId: string, toolName: string, args: any) => Promise<boolean>;

export class PiSessionManager {
    private _session: AgentSession | undefined;
    private _sessionManager: SessionManager | undefined;
    private _modelRegistry: ModelRegistry | undefined;
    private _unsubscribe: (() => void) | undefined;
    private _outputChannel: vscode.OutputChannel;
    private _toolApprovalHandler: ToolApprovalHandler | undefined;
    private _extensionUiBridge: ExtensionUiBridge | undefined;
    readonly events = new EventRouter();

    constructor(outputChannel: vscode.OutputChannel) {
        this._outputChannel = outputChannel;
    }

    get session(): AgentSession | undefined {
        return this._session;
    }

    get isReady(): boolean {
        return this._session !== undefined;
    }

    async initialize(): Promise<void> {
        this._outputChannel.appendLine('Initializing Pi session...');
        const { createAgentSession } = await loadPiCodingAgent();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        this._modelRegistry = await getModelRegistry();

        const opts = await buildAgentSessionOptions(cwd, {
            modelRegistry: this._modelRegistry,
        });
        this._sessionManager = opts.sessionManager;

        const { session, modelFallbackMessage, extensionsResult } = await createAgentSession(opts);
        logExtensionLoadResult(this._outputChannel, extensionsResult);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());

        if (modelFallbackMessage) {
            this._outputChannel.appendLine(`Model fallback: ${modelFallbackMessage}`);
        }

        this._syncModelRegistryFromSession();
        this._applyDefaultSettings(session);
        await applyPiCliDefaultModel(session);
        this._installToolApprovalHook(session);

        const model = session.model;
        const providers = listConfiguredProviders(session);
        this._outputChannel.appendLine(
            `Pi session initialized. Providers: ${providers.join(', ') || 'none'}. ` +
            `Model: ${model ? `${getProviderId(model)}/${model.id}` : 'none'}`,
        );
        await this._syncKemdiIfPresent(cwd);
        this._attachExtensionUi();
    }

    /** Wire webview UI for plan_mode_question and other extension dialogs. */
    setExtensionUiBridge(bridge: ExtensionUiBridge | undefined): void {
        this._extensionUiBridge = bridge;
        this._attachExtensionUi();
    }

    private _attachExtensionUi(): void {
        this._extensionUiBridge?.attach(this._session);
    }

    private async _syncKemdiIfPresent(cwd: string): Promise<void> {
        try {
            await syncKemdiWithPiSession(this._session, cwd);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`Kemdi model sync skipped: ${msg}`);
        }
    }

    private _syncModelRegistryFromSession(): void {
        if (this._session?.modelRegistry) {
            this._modelRegistry = this._session.modelRegistry;
        }
    }

    private _applyDefaultSettings(session: AgentSession): void {
        if (isSyncWithPiCli()) {
            return;
        }

        const config = vscode.workspace.getConfiguration('pi-agent');

        const thinkingLevel = config.get<string>('thinkingLevel', 'off');
        if (thinkingLevel && thinkingLevel !== 'off') {
            session.setThinkingLevel(thinkingLevel as any);
        }

        const defaultModel = config.get<string>('defaultModel', '');
        if (defaultModel && this._modelRegistry) {
            const available = getAvailableModels(this._modelRegistry);
            const match = available.find(m => m.id === defaultModel);
            if (match) {
                const model = findModel(this._modelRegistry, match.provider, match.id);
                if (model) {
                    session.setModel(model).catch((err: any) => {
                        this._outputChannel.appendLine(`Failed to set default model: ${err.message}`);
                    });
                }
            }
        }
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

    /**
     * Route user input: bash (!), built-in slash commands, then extension slash / LLM via prompt().
     */
    async submitInput(
        text: string,
        options: { mode: 'prompt' | 'steer' | 'followUp'; streamingBehavior?: 'steer' | 'followUp' } = {
            mode: 'prompt',
        },
        images?: ImageContent[],
    ): Promise<void> {
        if (!this._session) {
            throw new Error('Session not initialized');
        }

        const trimmed = text.trim();
        if (!trimmed && (!images || images.length === 0)) {
            return;
        }

        if (await tryHandleBashPrefix(this, trimmed)) {
            return;
        }

        if (trimmed.startsWith('/')) {
            const handledBuiltin = await tryHandleBuiltinSlashCommand(this, trimmed);
            if (handledBuiltin) {
                return;
            }
        }

        const session = this._session;
        if (options.mode === 'steer') {
            await session.steer(text, images);
            return;
        }
        if (options.mode === 'followUp') {
            await session.followUp(text, images);
            return;
        }
        if (session.isStreaming) {
            await session.prompt(text, {
                streamingBehavior: options.streamingBehavior ?? 'steer',
                images,
            });
            return;
        }
        await session.prompt(text, { images });
    }

    async abort(): Promise<void> {
        if (!this._session) {
            return;
        }
        if (this._session.isBashRunning) {
            this._session.abortBash();
        }
        if (this._session.isRetrying) {
            this._session.abortRetry();
        }
        const timeoutMs = 12_000;
        await Promise.race([
            this._session.abort(),
            new Promise<void>((_, reject) => {
                setTimeout(() => reject(new Error('Stop timed out after 12s')), timeoutMs);
            }),
        ]);
    }

    /** Reload extensions, skills, and settings from ~/.pi/agent (after settings panel edits). */
    async reloadPiAgentResources(): Promise<void> {
        if (!this._session) {
            return;
        }
        try {
            await this._session.reload();
            await applyPiCliDefaultModel(this._session);
            this._installToolApprovalHook(this._session);
            this._attachExtensionUi();
            this._outputChannel.appendLine('Pi agent resources reloaded from ~/.pi/agent');
        } catch (err: any) {
            this._outputChannel.appendLine(`Pi reload failed: ${err.message ?? err}`);
            throw err;
        }
    }

    async setModel(provider: string, modelId: string): Promise<void> {
        if (!this._session || !this._modelRegistry) {
            throw new Error('Session not initialized');
        }
        const model = findModel(this._modelRegistry, provider, modelId);
        if (!model) {
            throw new Error(`Model not found: ${provider}/${modelId}`);
        }
        await this._session.setModel(model);
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        await this._syncKemdiIfPresent(cwd);
    }

    setThinkingLevel(level: string): void {
        if (!this._session) { return; }
        this._session.setThinkingLevel(level as any);
    }

    cycleThinkingLevel(): string | undefined {
        if (!this._session) { return undefined; }
        return this._session.cycleThinkingLevel();
    }

    async newSession(): Promise<void> {
        if (!this._session) { return; }
        this._unsubscribe?.();
        this._session.dispose();

        const { createAgentSession } = await loadPiCodingAgent();
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

        const opts = await buildAgentSessionOptions(cwd, {
            modelRegistry: this._modelRegistry,
        });
        this._sessionManager = opts.sessionManager;

        const { session, extensionsResult } = await createAgentSession(opts);
        logExtensionLoadResult(this._outputChannel, extensionsResult);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());
        this._syncModelRegistryFromSession();
        this._applyDefaultSettings(session);
        await applyPiCliDefaultModel(session);
        this._installToolApprovalHook(session);
        this._attachExtensionUi();
    }

    async getSessions(): Promise<SessionInfo[]> {
        const { SessionManager: SM } = await loadPiCodingAgent();
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const sessions = await SM.list(cwd);
        return sessions.map((s: any) => ({
            id: s.id ?? s.sessionId ?? '',
            name: s.name ?? s.sessionName,
            path: s.path ?? s.filePath ?? '',
            lastModified: s.lastModified ?? s.modifiedAt,
        }));
    }

    async loadSession(sessionPath: string): Promise<void> {
        if (!this._session) { return; }
        this._unsubscribe?.();
        this._session.dispose();

        const { createAgentSession, SessionManager: SM } = await loadPiCodingAgent();
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        this._sessionManager = await SM.open(sessionPath, undefined);

        const opts = await buildAgentSessionOptions(cwd, {
            modelRegistry: this._modelRegistry,
            sessionManager: this._sessionManager,
        });

        const { session, extensionsResult } = await createAgentSession(opts);
        logExtensionLoadResult(this._outputChannel, extensionsResult);

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());
        this._syncModelRegistryFromSession();
        await applyPiCliDefaultModel(session);
        this._installToolApprovalHook(session);
        this._attachExtensionUi();
    }

    getModels(): ModelInfo[] {
        const registry = this._session?.modelRegistry ?? this._modelRegistry;
        if (!registry) { return []; }
        return getAvailableModels(registry);
    }

    getCurrentModel(): ModelInfo | undefined {
        const m = this._session?.model;
        if (!m) { return undefined; }
        return { provider: getProviderId(m), id: m.id, name: m.name };
    }

    getThinkingLevel(): string | undefined {
        return this._session?.thinkingLevel;
    }

    getAutoApproveTools(): boolean {
        return vscode.workspace.getConfiguration('pi-agent').get<boolean>('autoApproveTools', false);
    }

    setToolApprovalHandler(handler: ToolApprovalHandler | undefined): void {
        this._toolApprovalHandler = handler;
    }

    private _installToolApprovalHook(session: AgentSession): void {
        try {
            const runner = session.extensionRunner;
            if (!runner) return;

            const origEmitToolCall = runner.emitToolCall.bind(runner);
            const self = this;

            runner.emitToolCall = async (event: any) => {
                const origResult = await origEmitToolCall(event);
                if (origResult?.block) return origResult;
                if (self.getAutoApproveTools()) return origResult;
                if (!self._toolApprovalHandler) return origResult;

                const approved = await self._toolApprovalHandler(
                    event.toolCallId,
                    event.toolName,
                    event.input,
                );
                if (!approved) {
                    return { block: true, reason: 'User rejected tool call' };
                }
                return origResult;
            };
        } catch {
            this._outputChannel.appendLine('Tool approval hook: extension runner not available, skipping');
        }
    }

    getSkills(): SkillInfo[] {
        if (!this._session) return [];
        try {
            const { skills } = this._session.resourceLoader.getSkills();
            return skills.map((s: any) => ({
                name: s.name,
                description: s.description ?? '',
                filePath: s.filePath ?? '',
                source: s.sourceInfo?.source ?? '',
                disableModelInvocation: s.disableModelInvocation ?? false,
            }));
        } catch {
            return [];
        }
    }

    getActiveToolNames(): string[] {
        return this._session?.getActiveToolNames() ?? [];
    }

    getMessages(): any[] {
        return this._session?.state?.messages ?? [];
    }

    getPlanModeInfo(): PlanModeInfo {
        return readPlanModeInfo(this._session);
    }

    async setAgentMode(mode: 'agent' | 'plan'): Promise<void> {
        const session = this._session;
        if (!session) {
            throw new Error('Session not initialized');
        }

        const planActive = this.getPlanModeInfo().enabled;

        if (mode === 'plan') {
            if (!planActive) {
                await session.prompt('/plan');
            }
            return;
        }

        if (planActive) {
            await session.prompt('/plan exit');
        }
    }

    /** Exit plan mode (if active) then start implementation with saved plan text. */
    async implementPlan(): Promise<void> {
        const session = this._session;
        if (!session) {
            throw new Error('Session not initialized');
        }

        const info = this.getPlanModeInfo();
        const plan = info.planMarkdown.trim();
        if (!plan) {
            throw new Error('No proposed plan to implement');
        }

        if (info.enabled) {
            await session.prompt('/plan exit');
        }

        const promptText = buildImplementPlanPrompt(plan);
        this._outputChannel.appendLine('Plan implement: starting agent turn (plan mode off, full tools).');
        await session.sendUserMessage(promptText);
    }

    setMessages(msgs: any[]): void {
        if (this._session?.state) {
            this._session.state.messages = msgs;
        }
    }

    serializeState(): SerializedAgentState {
        const s = this._session;
        if (!s) {
            return {
                messages: [],
                isStreaming: false,
                tools: [],
            };
        }
        const model = s.model;
        return {
            messages: s.messages.map(safeSerialize),
            model: model ? { provider: getProviderId(model), id: model.id, name: model.name } : undefined,
            thinkingLevel: s.thinkingLevel,
            isStreaming: s.isStreaming,
            tools: s.getActiveToolNames(),
            sessionId: s.sessionId,
            sessionName: s.sessionName,
            contextUsage: this._getContextUsage(),
            sessionTokens: this._getSessionTokenStats(),
            planMode: readPlanModeInfo(s),
        };
    }

    private _getSessionTokenStats(): SessionTokenStats {
        const empty: SessionTokenStats = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
        };
        const session = this._session;
        if (!session?.getSessionStats) {
            return empty;
        }
        try {
            const stats = session.getSessionStats();
            return {
                input: stats.tokens.input,
                output: stats.tokens.output,
                cacheRead: stats.tokens.cacheRead,
                cacheWrite: stats.tokens.cacheWrite,
                cost: stats.cost,
            };
        } catch {
            return empty;
        }
    }

    private _getContextUsage(): ContextUsageInfo | undefined {
        const usage = this._session?.getContextUsage?.();
        if (!usage) { return undefined; }
        return {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
        };
    }

    async showModelPicker(searchTerm?: string): Promise<void> {
        const session = this._session;
        if (!session) {
            vscode.window.showWarningMessage('Session not initialized');
            return;
        }

        if (searchTerm?.trim()) {
            const exact = await this._findModelReference(searchTerm.trim());
            if (exact) {
                await this.setModel(exact.provider, exact.modelId);
                vscode.window.showInformationMessage(`Model: ${exact.provider}/${exact.modelId}`);
                return;
            }
        }

        let models = this.getModels();
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
            vscode.window.showWarningMessage('No models match. Try /login or check ~/.pi/agent.');
            return;
        }

        const items = models.map((m) => ({
            label: m.name ?? m.id,
            description: m.provider,
            model: m,
        }));
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: searchTerm ? `Model matching "${searchTerm}"` : 'Select a model',
        });
        if (pick) {
            await this.setModel(pick.model.provider, pick.model.id);
        }
    }

    private async _findModelReference(
        reference: string,
    ): Promise<{ provider: string; modelId: string } | undefined> {
        const session = this._session;
        if (!session) {
            return undefined;
        }
        const extPath = getPiExtensionPath();
        if (!extPath) {
            return undefined;
        }
        const resolverPath = path.join(
            path.dirname(getPiSdkEntryPath(extPath)),
            'core',
            'model-resolver.js',
        );
        const { findExactModelReferenceMatch } = await import(pathToFileURL(resolverPath).href);
        const match = findExactModelReferenceMatch(reference, session.modelRegistry.getAvailable());
        if (!match) {
            return undefined;
        }
        return { provider: String(match.provider), modelId: match.id };
    }

    async dispose(): Promise<void> {
        this._unsubscribe?.();
        this._session?.dispose();
        this._session = undefined;
        this.events.clear();
    }

    static async disposeGlobal(): Promise<void> {
        disposeAuthStorage();
        disposeModelRegistry();
    }
}

function getProviderId(model: any): string {
    return String(model.provider);
}

function safeSerialize(obj: any): any {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { _serializationFailed: true, type: obj?.type };
    }
}
