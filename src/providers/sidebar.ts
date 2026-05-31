import * as vscode from 'vscode';
import { PiSessionManager } from '../pi/session';
import type { ClientMessage, ServerMessage, TabInfo } from '../shared/protocol';
import { DiffManager } from './diff';
import { CheckpointManager } from './checkpoint';
import { openPlanDocument, type PlanDocumentProvider } from './plan-document';
import { mergePlanWithRpivTodos } from '../pi/planDocumentMerge';
import { extractRpivTodoTasks, rpivTasksToPlanTodos } from '../pi/rpivTodoSync';
import { ExtensionUiBridge } from '../pi/extensionUiBridge';
import {
    composePrompt,
    processFilePaths,
    processPastedImages,
    type PastedImageInput,
} from '../pi/fileAttachments';
import {
    type PendingAttachment,
    type QueuedPrompt,
    toPendingAttachment,
    toPendingTextFileAttachment,
    toPreviewList,
} from '../pi/pendingAttachments';

interface MessageMeta {
    thinkingDurationSec: number;
    messageEndTime: number;
}

interface PendingApproval {
    resolve: (approved: boolean) => void;
}

interface TabState {
    id: string;
    name: string;
    session: PiSessionManager;
    diffManager: DiffManager;
    checkpointManager: CheckpointManager;
    turnCounter: number;
    suspendedMessages: any[];
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    agentStartTime: number;
    messageMeta: Map<number, MessageMeta>;
    hasNotification: boolean;
    pendingApprovals: Map<string, PendingApproval>;
    queuedMessages: QueuedPrompt[];
    pendingAttachments: PendingAttachment[];
    isStreaming: boolean;
    queueDrainInFlight: boolean;
    lastPlanEditorHash: string;
}

let tabIdCounter = 0;
function nextTabId(): string {
    return `tab-${++tabIdCounter}`;
}

function hashPlanMarkdown(markdown: string): string {
    let h = 0;
    for (let i = 0; i < markdown.length; i++) {
        h = (h * 31 + markdown.charCodeAt(i)) | 0;
    }
    return `${markdown.length}:${h}`;
}

function makeTabState(
    id: string,
    session: PiSessionManager,
    diffManager: DiffManager,
    checkpointManager: CheckpointManager,
): TabState {
    return {
        id,
        name: 'New Agent',
        session,
        diffManager,
        checkpointManager,
        turnCounter: 0,
        suspendedMessages: [],
        streamingText: '',
        streamingThinking: '',
        isThinking: false,
        thinkingStartTime: 0,
        streamingThinkingDuration: 0,
        agentStartTime: 0,
        messageMeta: new Map(),
        hasNotification: false,
        pendingApprovals: new Map(),
        queuedMessages: [],
        pendingAttachments: [],
        isStreaming: false,
        queueDrainInFlight: false,
        lastPlanEditorHash: '',
    };
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _outputChannel: vscode.OutputChannel;

    private _tabs = new Map<string, TabState>();
    private _activeTabId = '';
    private _tabSubscriptions = new Map<string, (() => void)[]>();
    private _planDocument: PlanDocumentProvider;
    private readonly _extensionUi = new ExtensionUiBridge();
    private _lastAttachKey = '';
    private _lastAttachMs = 0;
    private readonly _pastedStorageDir: string;

    constructor(
        extensionUri: vscode.Uri,
        initialSession: PiSessionManager,
        initialDiffManager: DiffManager,
        initialCheckpointManager: CheckpointManager,
        outputChannel: vscode.OutputChannel,
        planDocument: PlanDocumentProvider,
        pastedStorageDir: string,
    ) {
        this._planDocument = planDocument;
        this._extensionUri = extensionUri;
        this._outputChannel = outputChannel;
        this._pastedStorageDir = pastedStorageDir;

        const id = nextTabId();
        const tab = makeTabState(id, initialSession, initialDiffManager, initialCheckpointManager);
        this._tabs.set(id, tab);
        this._activeTabId = id;
        this._subscribeTab(tab);
        tab.session.setExtensionUiBridge(this._extensionUi);
    }

    private get _activeTab(): TabState {
        return this._tabs.get(this._activeTabId)!;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);
        this._extensionUi.setPost((m) => this._post(m));

        webviewView.webview.onDidReceiveMessage((msg: ClientMessage) => {
            this._handleMessage(msg);
        });

        webviewView.onDidDispose(() => {
            for (const [, unsubs] of this._tabSubscriptions) {
                for (const unsub of unsubs) unsub();
            }
            this._tabSubscriptions.clear();
        });

        this._post({ type: 'ready' });
        this.sendStateSync();
    }

    private _subscribeTab(tab: TabState): void {
        const unsubs: (() => void)[] = [];

        unsubs.push(
            tab.session.events.onAll((event) => {
                this._handleTabEvent(tab, event);
            }),
        );

        unsubs.push(
            tab.diffManager.onFileChange((change) => {
                if (tab.id === this._activeTabId) {
                    this._post({ type: 'fileChange', change });
                }
            }),
        );

        tab.session.setToolApprovalHandler(async (toolCallId, toolName, args) => {
            return this._requestToolApproval(tab, toolCallId, toolName, args);
        });

        this._tabSubscriptions.set(tab.id, unsubs);
    }

    private _unsubscribeTab(tabId: string): void {
        const unsubs = this._tabSubscriptions.get(tabId);
        if (unsubs) {
            for (const unsub of unsubs) unsub();
            this._tabSubscriptions.delete(tabId);
        }
    }

    private _handleTabEvent(tab: TabState, event: any): void {
        const isActive = tab.id === this._activeTabId;

        if (event.type === 'agent_start') {
            tab.isStreaming = true;
            tab.streamingText = '';
            tab.streamingThinking = '';
            tab.isThinking = false;
            tab.thinkingStartTime = 0;
            tab.streamingThinkingDuration = 0;
            tab.agentStartTime = Date.now();
            if (isActive) {
                vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', true);
            }
        }

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
            const msgs = tab.session.getMessages();
            let assistantOrdinal = 0;
            let lastOrdinal = -1;
            for (let i = 0; i < msgs.length; i++) {
                if (msgs[i].role === 'assistant') {
                    lastOrdinal = assistantOrdinal;
                    assistantOrdinal++;
                }
            }
            if (lastOrdinal >= 0) {
                tab.messageMeta.set(lastOrdinal, {
                    thinkingDurationSec: tab.streamingThinkingDuration,
                    messageEndTime: Date.now(),
                });
            }
            tab.streamingThinkingDuration = 0;
        }

        if (event.type === 'agent_end') {
            const willRetry = event.willRetry === true;
            if (!willRetry) {
                tab.isStreaming = false;
                tab.streamingText = '';
                tab.streamingThinking = '';
                tab.isThinking = false;
                tab.thinkingStartTime = 0;
                tab.streamingThinkingDuration = 0;
                tab.agentStartTime = 0;
                if (isActive) {
                    vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', false);
                } else {
                    tab.hasNotification = true;
                }
            }
        }

        if (event.type === 'message_update' && event.assistantMessageEvent) {
            const ae = event.assistantMessageEvent;
            switch (ae.type) {
                case 'thinking_start':
                    tab.isThinking = true;
                    tab.streamingThinking = '';
                    tab.thinkingStartTime = Date.now();
                    tab.streamingThinkingDuration = 0;
                    break;
                case 'thinking_delta':
                    tab.streamingThinking += ae.delta ?? '';
                    break;
                case 'thinking_end':
                    tab.isThinking = false;
                    if (tab.thinkingStartTime > 0) {
                        tab.streamingThinkingDuration = Math.round(
                            (Date.now() - tab.thinkingStartTime) / 1000
                        );
                    }
                    break;
                case 'text_delta':
                    tab.streamingText += ae.delta ?? '';
                    break;
            }
        }

        this._updateTabName(tab);

        if (isActive) {
            this._post({ type: 'agentEvent', event: safeSerialize(event) });

            if (
                event.type === 'agent_start' ||
                event.type === 'agent_end' ||
                event.type === 'message_end' ||
                event.type === 'turn_end' ||
                event.type === 'tool_execution_end'
            ) {
                this.sendStateSync();
            }
        } else if (
            event.type === 'agent_start' ||
            event.type === 'agent_end' ||
            event.type === 'turn_end'
        ) {
            this.sendStateSync();
        }

    }

    private _updateTabName(tab: TabState): void {
        const sessionName = tab.session.session?.sessionName;
        if (sessionName && tab.name !== sessionName) {
            tab.name = sessionName;
        }
    }

    /** Stop generation in the active chat tab (webview Stop / Esc). */
    async abortActiveTab(): Promise<void> {
        const tab = this._tabs.get(this._activeTabId);
        if (!tab) {
            return;
        }
        await this._abortActiveTab(tab);
    }

    private _startTurn(tab: TabState): void {
        if (tab.checkpointManager.rollbackPoint !== null) {
            tab.checkpointManager.discardSuspended();
            tab.diffManager.discardSuspended();
            tab.suspendedMessages = [];
        }
        tab.turnCounter++;
        const turnIdx = tab.turnCounter;
        tab.checkpointManager.startTurn(turnIdx);
        tab.diffManager.setCurrentTurn(turnIdx);
    }

    private async _dispatchPrompt(
        tab: TabState,
        userText: string,
        attachments: PendingAttachment[],
    ): Promise<void> {
        const { text, images } = composePrompt(userText, attachments);
        if (!text && images.length === 0) {
            return;
        }
        await tab.session.prompt(text, images.length > 0 ? images : undefined);
    }

    /** Drain queue when tab and Pi session are both idle (covers missed agent_end / stale UI). */
    private _maybeDrainQueuedMessages(tab: TabState, isActive: boolean): void {
        if (tab.queueDrainInFlight || tab.isStreaming) {
            return;
        }
        if (tab.session.session?.isStreaming) {
            return;
        }
        if (tab.queuedMessages.length === 0) {
            return;
        }
        tab.queueDrainInFlight = true;
        void this._runNextQueuedPrompt(tab, isActive).finally(() => {
            tab.queueDrainInFlight = false;
        });
    }

    private _uiIsStreaming(tab: TabState): boolean {
        return tab.isStreaming;
    }

    private async _runNextQueuedPrompt(tab: TabState, isActive: boolean): Promise<void> {
        const item = tab.queuedMessages.shift();
        if (!item) {
            if (isActive) {
                this.sendStateSync();
            }
            return;
        }
        const { text, images } = composePrompt(item.text, item.attachments);
        if (!text && images.length === 0) {
            await this._runNextQueuedPrompt(tab, isActive);
            return;
        }

        this._startTurn(tab);
        tab.isStreaming = true;
        if (isActive) {
            vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', true);
            this.sendStateSync();
        }
        try {
            await tab.session.prompt(text, images.length > 0 ? images : undefined);
        } catch (err: unknown) {
            tab.isStreaming = false;
            tab.queuedMessages.unshift(item);
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`Queued prompt failed: ${msg}`);
            if (isActive) {
                this._post({ type: 'error', message: msg });
                vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', false);
                this.sendStateSync();
            }
        } finally {
            if (!tab.session.session?.isStreaming && !tab.isStreaming) {
                this._maybeDrainQueuedMessages(tab, isActive);
            }
        }
    }

    private async _abortActiveTab(tab: TabState): Promise<void> {
        tab.isStreaming = false;
        tab.streamingText = '';
        tab.streamingThinking = '';
        tab.isThinking = false;
        tab.thinkingStartTime = 0;
        tab.streamingThinkingDuration = 0;
        tab.agentStartTime = 0;
        if (tab.id === this._activeTabId) {
            vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', false);
            this.sendStateSync();
        }

        try {
            await tab.session.abort();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`Abort: ${msg}`);
            if (tab.id === this._activeTabId) {
                this._post({ type: 'error', message: msg });
            }
        } finally {
            tab.isStreaming = false;
            if (tab.id === this._activeTabId) {
                vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', false);
                this.sendStateSync();
            }
        }
    }

    sendStateSync(): void {
        const tab = this._activeTab;
        if (!tab) return;

        const state = tab.session.serializeState();
        state.isStreaming = this._uiIsStreaming(tab);
        if (tab.suspendedMessages.length > 0) {
            state.messages = [
                ...state.messages,
                ...tab.suspendedMessages.map((m: any) => safeSerialize(m)),
            ];
        }
        state.fileChanges = tab.diffManager.fileChanges;
        state.rollbackPoint = tab.checkpointManager.rollbackPoint;
        state.tabs = this._getTabInfos();
        state.activeTabId = this._activeTabId;
        state.streamingText = tab.streamingText;
        state.streamingThinking = tab.streamingThinking;
        state.isThinking = tab.isThinking;
        state.thinkingStartTime = tab.thinkingStartTime;
        state.streamingThinkingDuration = tab.streamingThinkingDuration;
        state.queuedMessages = tab.queuedMessages.map((q) => {
            const suffix =
                q.attachments.length > 0 ? ` [+${q.attachments.length} attachment(s)]` : '';
            return `${q.text}${suffix}`;
        });
        state.pendingAttachments = toPreviewList(tab.pendingAttachments);

        const planMode = tab.session.getPlanModeInfo();
        const session = tab.session.session;
        const rpivTasks = extractRpivTodoTasks(session);
        const mergedPlan = mergePlanWithRpivTodos(planMode.planMarkdown, rpivTasks);
        state.planMode = {
            ...planMode,
            planMarkdown: mergedPlan,
            todos: rpivTasks.length > 0 ? rpivTasksToPlanTodos(rpivTasks) : planMode.todos,
        };
        const sessionId = session?.sessionId ?? 'default';
        this._planDocument.setPlanContent(sessionId, mergedPlan);
        const planBody = mergedPlan.trim();
        if (planMode.hasPlan && planBody) {
            const hash = hashPlanMarkdown(planBody);
            if (tab.lastPlanEditorHash !== hash) {
                tab.lastPlanEditorHash = hash;
                void openPlanDocument(this._planDocument, sessionId);
            }
        } else if (!planMode.hasPlan) {
            tab.lastPlanEditorHash = '';
        }

        let assistantOrdinal = 0;
        for (let i = 0; i < state.messages.length; i++) {
            if (state.messages[i].role === 'assistant') {
                const meta = tab.messageMeta.get(assistantOrdinal);
                if (meta) {
                    state.messages[i]._thinkingDurationSec = meta.thinkingDurationSec;
                    state.messages[i]._messageEndTime = meta.messageEndTime;
                }
                assistantOrdinal++;
            }
        }
        this._post({ type: 'stateSync', state });
        this._maybeDrainQueuedMessages(tab, true);
    }

    /** Attach local paths (Explorer tree drop or legacy webview path). */
    async attachPaths(paths: string[]): Promise<void> {
        const tab = this._activeTab;
        const unique = [...new Set(paths.filter((p) => p.trim().length > 0))];
        if (unique.length === 0) {
            return;
        }

        const key = unique.sort().join('\0');
        const now = Date.now();
        if (key === this._lastAttachKey && now - this._lastAttachMs < 400) {
            return;
        }
        this._lastAttachKey = key;
        this._lastAttachMs = now;

        const cwd =
            tab.session.session?.cwd ??
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
            process.cwd();
        const processed = await processFilePaths(unique, cwd);
        if (processed.length === 0) {
            vscode.window.showWarningMessage(
                'vs-pi-agent: dropped files could not be read or are unsupported.',
            );
            return;
        }
        const existing = new Set(tab.pendingAttachments.map((a) => a.displayName));
        for (const item of processed) {
            if (existing.has(item.displayName)) {
                continue;
            }
            existing.add(item.displayName);
            tab.pendingAttachments.push(toPendingAttachment(item));
        }
        this.sendStateSync();
    }

    async pickAttachmentsDialog(): Promise<void> {
        const tab = this._activeTab;
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach',
            title: 'Attach files or images',
        });
        if (!uris?.length) {
            return;
        }
        await this.attachPaths(uris.map((u) => u.fsPath));
    }

    async attachPastedImages(items: PastedImageInput[]): Promise<void> {
        if (!items.length) {
            return;
        }
        const tab = this._activeTab;
        const processed = await processPastedImages(items, this._pastedStorageDir);
        for (const item of processed) {
            tab.pendingAttachments.push(toPendingAttachment(item));
        }
        this.sendStateSync();
    }

    async attachDroppedTextFiles(files: { name: string; text: string }[]): Promise<void> {
        const tab = this._activeTab;
        let added = false;
        for (const file of files) {
            if (!file.text?.trim()) {
                continue;
            }
            tab.pendingAttachments.push(toPendingTextFileAttachment(file.name, file.text));
            added = true;
        }
        if (added) {
            this.sendStateSync();
        }
    }

    private _getTabInfos(): TabInfo[] {
        return [...this._tabs.entries()].map(([id, tab]) => ({
            id,
            name: tab.name,
            isActive: id === this._activeTabId,
            isStreaming: tab.isStreaming,
            hasNotification: tab.hasNotification,
        }));
    }

    private _post(message: ServerMessage): void {
        this._view?.webview.postMessage(message);
    }

    private async _handleMessage(msg: ClientMessage): Promise<void> {
        try {
            const tab = this._activeTab;

            switch (msg.type) {
                case 'prompt': {
                    const attachments = [...tab.pendingAttachments];
                    tab.pendingAttachments = [];
                    this._startTurn(tab);
                    await this._dispatchPrompt(tab, msg.text, attachments);
                    this.sendStateSync();
                    break;
                }
                case 'steer': {
                    const attachments = [...tab.pendingAttachments];
                    tab.pendingAttachments = [];
                    const { text, images } = composePrompt(msg.text, attachments);
                    await tab.session.steer(text, images.length > 0 ? images : undefined);
                    this.sendStateSync();
                    break;
                }
                case 'pickAttachments':
                    await this.pickAttachmentsDialog();
                    break;
                case 'addPastedImages':
                    await this.attachPastedImages(msg.items ?? []);
                    break;
                case 'addDroppedTextFiles':
                    await this.attachDroppedTextFiles(msg.files ?? []);
                    break;
                case 'dropFilePaths':
                    await this.attachPaths(msg.paths ?? []);
                    break;
                case 'dropAttachFailed': {
                    const types = msg.mimeTypes ?? [];
                    const fromExplorer =
                        types.includes('text/uri-list') ||
                        types.includes('application/vnd.code.uri-list');
                    if (fromExplorer) {
                        void vscode.window.showInformationMessage(
                            'vs-pi-agent: From Explorer, hold Shift while dropping on the message box. Or right-click the file → Add to Chat.',
                        );
                    }
                    break;
                }
                case 'searchWorkspaceFiles': {
                    const { searchWorkspaceFiles } = await import('../pi/workspaceFileSearch');
                    const files = await searchWorkspaceFiles(msg.query ?? '');
                    this._post({
                        type: 'workspaceFiles',
                        requestId: msg.requestId,
                        files,
                    });
                    break;
                }
                case 'removeAttachment':
                    tab.pendingAttachments = tab.pendingAttachments.filter((a) => a.id !== msg.id);
                    this.sendStateSync();
                    break;
                case 'queueMessage': {
                    const trimmed = msg.text.trim();
                    const attachments = [...tab.pendingAttachments];
                    tab.pendingAttachments = [];
                    if (!trimmed && attachments.length === 0) {
                        break;
                    }
                    if (!this._uiIsStreaming(tab)) {
                        this._startTurn(tab);
                        tab.isStreaming = true;
                        if (tab.id === this._activeTabId) {
                            vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', true);
                        }
                        try {
                            await this._dispatchPrompt(tab, trimmed, attachments);
                        } finally {
                            if (!tab.session.session?.isStreaming) {
                                tab.isStreaming = false;
                                if (tab.id === this._activeTabId) {
                                    vscode.commands.executeCommand(
                                        'setContext',
                                        'pi-agent.isStreaming',
                                        false,
                                    );
                                }
                            }
                        }
                        this.sendStateSync();
                        break;
                    }
                    tab.queuedMessages.push({ text: trimmed, attachments });
                    this.sendStateSync();
                    break;
                }
                case 'editQueuedMessage':
                    if (msg.index >= 0 && msg.index < tab.queuedMessages.length && msg.text.trim()) {
                        const prev = tab.queuedMessages[msg.index];
                        tab.queuedMessages[msg.index] = { text: msg.text.trim(), attachments: prev.attachments };
                    }
                    this.sendStateSync();
                    break;
                case 'removeQueuedMessage':
                    if (msg.index >= 0 && msg.index < tab.queuedMessages.length) {
                        tab.queuedMessages.splice(msg.index, 1);
                    }
                    this.sendStateSync();
                    break;
                case 'cancelQueue':
                    tab.queuedMessages = [];
                    this.sendStateSync();
                    break;
                case 'followUp':
                    await tab.session.submitInput(msg.text, { mode: 'followUp' });
                    break;
                case 'abort':
                    await this._abortActiveTab(tab);
                    break;
                case 'getModels': {
                    const models = tab.session.getModels();
                    const current = tab.session.getCurrentModel();
                    const thinkingLevel = tab.session.getThinkingLevel();
                    this._post({ type: 'models', models, current, thinkingLevel });
                    break;
                }
                case 'setModel':
                    await tab.session.setModel(msg.provider, msg.modelId);
                    this.sendStateSync();
                    break;
                case 'setThinkingLevel':
                    tab.session.setThinkingLevel(msg.level);
                    this.sendStateSync();
                    break;
                case 'newSession':
                    await tab.session.newSession();
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.turnCounter = 0;
                    tab.suspendedMessages = [];
                    tab.name = 'New Agent';
                    tab.isStreaming = false;
                    tab.streamingText = '';
                    tab.streamingThinking = '';
                    tab.isThinking = false;
                    tab.thinkingStartTime = 0;
                    tab.streamingThinkingDuration = 0;
                    tab.agentStartTime = 0;
                    tab.messageMeta.clear();
                    tab.queuedMessages = [];
                    tab.pendingAttachments = [];
                    tab.lastPlanEditorHash = '';
                    this.sendStateSync();
                    break;
                case 'loadSession':
                    await tab.session.loadSession(msg.sessionPath);
                    tab.diffManager.clearAll();
                    tab.checkpointManager.clearAll();
                    tab.turnCounter = 0;
                    tab.suspendedMessages = [];
                    tab.isStreaming = false;
                    tab.streamingText = '';
                    tab.streamingThinking = '';
                    tab.isThinking = false;
                    tab.thinkingStartTime = 0;
                    tab.streamingThinkingDuration = 0;
                    tab.agentStartTime = 0;
                    tab.messageMeta.clear();
                    tab.queuedMessages = [];
                    tab.lastPlanEditorHash = '';
                    this._updateTabName(tab);
                    this.sendStateSync();
                    break;
                case 'getSessions': {
                    const sessions = await tab.session.getSessions();
                    const currentId = tab.session.session?.sessionId;
                    this._post({ type: 'sessions', sessions, currentSessionId: currentId });
                    break;
                }
                case 'getState':
                    this.sendStateSync();
                    break;
                case 'getSlashCommands': {
                    const { listSlashCommandsForUi } = await import('../pi/slashCommands');
                    const commands = await listSlashCommandsForUi(tab.session.session);
                    this._post({ type: 'slashCommands', commands });
                    break;
                }
                case 'getSkills': {
                    const skills = tab.session.getSkills();
                    this._post({ type: 'skills', skills });
                    break;
                }
                case 'approveToolCall':
                    this._resolveToolApproval(tab, msg.toolCallId, true);
                    break;
                case 'rejectToolCall':
                    this._resolveToolApproval(tab, msg.toolCallId, false);
                    break;
                case 'openFile': {
                    const { openAttachmentFile } = await import('../pi/openAttachment');
                    await openAttachmentFile(msg.filePath);
                    break;
                }
                case 'openDiff':
                    await tab.diffManager.openDiff(msg.filePath, msg.toolCallId);
                    break;
                case 'undoFileChange':
                    await tab.diffManager.undoFileChange(msg.filePath, msg.toolCallId);
                    this.sendStateSync();
                    break;
                case 'restoreCheckpoint': {
                    const restored = await tab.checkpointManager.restoreCheckpoint(msg.messageIndex);
                    tab.diffManager.suspendChangesAfter(msg.messageIndex);

                    const allMsgs = tab.session.getMessages();
                    const cutoff = this._findCutoffIndex(allMsgs, msg.messageIndex);
                    if (cutoff >= 0 && cutoff < allMsgs.length) {
                        tab.suspendedMessages = allMsgs.slice(cutoff);
                        tab.session.setMessages(allMsgs.slice(0, cutoff));
                    }

                    if (restored.length > 0) {
                        vscode.window.showInformationMessage(
                            `Restored ${restored.length} file(s) to checkpoint.`
                        );
                    }
                    this.sendStateSync();
                    break;
                }
                case 'redoCheckpoint': {
                    const redone = await tab.checkpointManager.redoCheckpoint();
                    tab.diffManager.redoChanges();

                    if (tab.suspendedMessages.length > 0) {
                        const current = tab.session.getMessages();
                        tab.session.setMessages([...current, ...tab.suspendedMessages]);
                        tab.suspendedMessages = [];
                    }

                    if (redone.length > 0) {
                        vscode.window.showInformationMessage(
                            `Re-applied ${redone.length} file(s).`
                        );
                    }
                    this.sendStateSync();
                    break;
                }
                case 'confirmAction': {
                    const answer = await vscode.window.showWarningMessage(
                        msg.message,
                        { modal: true },
                        'Yes',
                    );
                    this._post({
                        type: 'confirmResult',
                        action: msg.action,
                        confirmed: answer === 'Yes',
                        payload: msg.payload,
                    });
                    break;
                }
                case 'createTab':
                    await this._createTab();
                    break;
                case 'closeTab':
                    await this._closeTab(msg.tabId);
                    break;
                case 'switchTab':
                    this._switchTab(msg.tabId);
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('pi-agent.openSettings');
                    break;
                case 'setAgentMode': {
                    const mode = msg.mode;
                    if (mode !== 'agent' && mode !== 'plan') {
                        throw new Error('Invalid agent mode');
                    }
                    await tab.session.setAgentMode(mode);
                    this.sendStateSync();
                    break;
                }
                case 'implementPlan': {
                    if (tab.checkpointManager.rollbackPoint !== null) {
                        tab.checkpointManager.discardSuspended();
                        tab.diffManager.discardSuspended();
                        tab.suspendedMessages = [];
                    }
                    tab.turnCounter++;
                    const turnIdx = tab.turnCounter;
                    tab.checkpointManager.startTurn(turnIdx);
                    tab.diffManager.setCurrentTurn(turnIdx);
                    tab.isStreaming = true;
                    tab.streamingText = '';
                    tab.streamingThinking = '';
                    tab.isThinking = false;
                    tab.agentStartTime = Date.now();
                    if (tab.id === this._activeTabId) {
                        vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', true);
                        this.sendStateSync();
                    }
                    try {
                        await tab.session.implementPlan();
                    } catch (err) {
                        tab.isStreaming = false;
                        if (tab.id === this._activeTabId) {
                            vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', false);
                            this.sendStateSync();
                        }
                        throw err;
                    }
                    this.sendStateSync();
                    break;
                }
                case 'openPlanDocument':
                    await openPlanDocument(
                        this._planDocument,
                        tab.session.session?.sessionId,
                    );
                    break;
                case 'extensionUiResponse':
                    this._extensionUi.handleResponse({
                        id: msg.id,
                        cancelled: msg.cancelled,
                        value: msg.value,
                        confirmed: msg.confirmed,
                    });
                    break;
            }
        } catch (err: any) {
            this._post({ type: 'error', message: err.message ?? String(err) });
        }
    }

    private _requestToolApproval(tab: TabState, toolCallId: string, toolName: string, args: any): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            tab.pendingApprovals.set(toolCallId, { resolve });

            if (tab.id === this._activeTabId) {
                this._post({
                    type: 'toolCallPending',
                    pending: { toolCallId, toolName, args: safeSerialize(args) },
                });
            }
        });
    }

    private _resolveToolApproval(tab: TabState, toolCallId: string, approved: boolean): void {
        const pending = tab.pendingApprovals.get(toolCallId);
        if (pending) {
            tab.pendingApprovals.delete(toolCallId);
            pending.resolve(approved);
            if (tab.id === this._activeTabId) {
                this._post({ type: 'toolCallResolved', toolCallId });
            }
        }
    }

    private async _createTab(): Promise<void> {
        const newSession = new PiSessionManager(this._outputChannel);
        await newSession.initialize();

        const newCheckpoint = new CheckpointManager();
        const newDiff = new DiffManager(newSession, newCheckpoint);

        const id = nextTabId();
        const tab = makeTabState(id, newSession, newDiff, newCheckpoint);
        newSession.setExtensionUiBridge(this._extensionUi);
        this._tabs.set(id, tab);
        this._subscribeTab(tab);

        this._activeTabId = id;
        this.sendStateSync();
    }

    private async _closeTab(tabId: string): Promise<void> {
        if (this._tabs.size <= 1) return;

        const tab = this._tabs.get(tabId);
        if (!tab) return;

        const wasActive = tabId === this._activeTabId;

        this._unsubscribeTab(tabId);
        tab.diffManager.dispose();
        tab.checkpointManager.dispose();
        await tab.session.dispose();
        this._tabs.delete(tabId);

        if (wasActive) {
            this._activeTabId = this._tabs.keys().next().value!;
        }

        this.sendStateSync();
    }

    private _switchTab(tabId: string): void {
        if (!this._tabs.has(tabId) || tabId === this._activeTabId) return;

        this._activeTabId = tabId;

        const tab = this._activeTab;
        tab.hasNotification = false;
        vscode.commands.executeCommand('setContext', 'pi-agent.isStreaming', tab.isStreaming);

        this.sendStateSync();
    }

    private _findCutoffIndex(messages: any[], rollbackPoint: number): number {
        let userMsgCount = 0;
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === 'user') {
                userMsgCount++;
                if (userMsgCount > rollbackPoint) {
                    return i;
                }
            }
        }
        return -1;
    }

    private _getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'main.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'styles', 'main.css')
        );
        const iconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'icons')
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>vs-pi-agent</title>
</head>
<body>
    <div id="app" data-icons-uri="${iconsUri}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function safeSerialize(obj: any): any {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { type: obj?.type, _serializationFailed: true };
    }
}
