import { marked } from 'marked';
import type {
    ClientMessage,
    ServerMessage,
    SerializedAgentState,
    FileChangeInfo,
    TabInfo,
    ToolCallPendingInfo,
    SkillInfo,
    SlashCommandListItem,
    PlanModeInfo,
    PiExtensionChromeSnapshot,
    ContextUsageInfo,
    SessionTokenStats,
    PendingAttachmentPreview,
    ConnectionStatus,
} from '../shared/protocol';
import { dismissExtensionUi, initExtensionUiHost, showExtensionUiRequest } from './extensionUi';
import { isImageFilePath, parseUserMessageForDisplay } from '../shared/attachmentMessageDisplay';
import { shouldHideMessageInChat, stripPlanContentForChatDisplay } from '../shared/planMessageFilter';
import { renderComposerAttachmentChip, renderMessageAttachmentChip } from './attachmentChipHtml';
import { bindChatFileDrop } from './chatFileDrop';
import {
    bindFileMentionMenu,
    handleAtMenuKeydown,
    hideAtMenu,
    isAtMenuVisible,
    updateAtMenu,
} from './fileMentionMenu';
import { readImageFileAsItem } from './fileDropReaders';

import { vscode } from './vscodeApi';
const iconsBaseUri = document.getElementById('app')?.dataset.iconsUri ?? '';

// ── State ──

const state: {
    messages: any[];
    isStreaming: boolean;
    model?: { provider: string; id: string; name?: string };
    thinkingLevel?: string;
    tools: string[];
    sessionId?: string;
    sessionName?: string;
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    contextUsage?: ContextUsageInfo;
    sessionTokens?: SessionTokenStats;
    fileChanges: FileChangeInfo[];
    rollbackPoint: number | null;
    availableModels: any[];
    recentModels: { provider: string; id: string; name?: string }[];
    tabs: TabInfo[];
    activeTabId: string;
    skills: SkillInfo[];
    slashCommands: SlashCommandListItem[];
    queuedMessages: string[];
    steeringMessages: string[];
    followUpMessages: string[];
    pendingAttachments: PendingAttachmentPreview[];
    planMode: PlanModeInfo;
    piExtensionChrome?: PiExtensionChromeSnapshot;
    connectionStatus: ConnectionStatus;
} = {
    messages: [],
    isStreaming: false,
    tools: [],
    streamingText: '',
    streamingThinking: '',
    isThinking: false,
    thinkingStartTime: 0,
    streamingThinkingDuration: 0,
    availableModels: [],
    recentModels: [],
    fileChanges: [],
    rollbackPoint: null,
    tabs: [],
    activeTabId: '',
    skills: [],
    slashCommands: [],
    queuedMessages: [],
    steeringMessages: [],
    followUpMessages: [],
    pendingAttachments: [],
    planMode: emptyPlanMode(),
    connectionStatus: { phase: 'idle' },
};

function emptyPlanMode(): PlanModeInfo {
    return {
        enabled: false,
        hasPlan: false,
        awaitingAction: false,
        statusLabel: 'off',
        planMarkdown: '',
        todos: [],
    };
}

function lastAssistantMessage(messages: any[] | undefined): any | undefined {
    if (!messages?.length) {
        return undefined;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant') {
            return messages[i];
        }
    }
    return undefined;
}

function failedConnectionFromAssistant(msg: any | undefined): ConnectionStatus | undefined {
    if (!msg || msg.stopReason !== 'error') {
        return undefined;
    }
    const message =
        typeof msg.errorMessage === 'string' && msg.errorMessage.trim()
            ? msg.errorMessage.trim()
            : 'Request failed';
    return { phase: 'failed', message };
}

// ── Marked config ──

const renderer = new marked.Renderer();

let codeBlockId = 0;
renderer.code = function ({ text, lang }: { text: string; lang?: string | undefined }) {
    const id = `cb-${++codeBlockId}`;
    const langLabel = lang ? `<span class="code-lang">${escHtml(lang)}</span>` : '';
    return `<div class="code-block-wrapper">
        <div class="code-block-header">${langLabel}<button class="copy-btn" data-code-id="${id}">Copy</button></div>
        <pre class="code-block-pre" id="${id}"><code class="code-block-code">${escHtml(text)}</code></pre>
    </div>`;
};

renderer.codespan = function ({ text }: { text: string }) {
    return `<code>${text}</code>`;
};

marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
});

function renderMarkdown(text: string): string {
    if (!text) return '';
    return marked.parse(text) as string;
}

import { applySessionList, onAppShellRebuilt, requestSessionPanelToggle, setSessionPanelOpen } from './sessionPanel';

// ── Message handling ──

window.addEventListener('message', (event) => {
    handleMessage(event.data as ServerMessage);
});

function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
        case 'ready':
            vscode.postMessage({ type: 'getState' });
            vscode.postMessage({ type: 'getSkills' });
            vscode.postMessage({ type: 'getSlashCommands' });
            vscode.postMessage({ type: 'getModels' });
            break;
        case 'stateSync':
            applyStateSync(msg.state);
            break;
        case 'agentEvent':
            handleAgentEvent(msg.event);
            break;
        case 'models':
            state.availableModels = msg.models ?? [];
            if (msg.current) {
                state.model = msg.current;
                addToRecentModels(msg.current.provider, msg.current.id, msg.current.name);
            }
            if (msg.thinkingLevel) state.thinkingLevel = msg.thinkingLevel;
            break;
        case 'fileChange':
            state.fileChanges.push(msg.change);
            renderChangedFilesBar();
            renderInlineFileChange(msg.change);
            break;
        case 'confirmResult':
            handleConfirmResult(msg.action, msg.confirmed, msg.payload);
            break;
        case 'toolCallPending':
            renderToolApprovalCard(msg.pending);
            break;
        case 'toolCallResolved':
            removeToolApprovalCard(msg.toolCallId);
            break;
        case 'skills':
            state.skills = msg.skills;
            break;
        case 'slashCommands':
            state.slashCommands = msg.commands;
            break;
        case 'error':
            showError(msg.message);
            break;
        case 'extensionUiRequest':
            showExtensionUiRequest(msg.request);
            break;
        case 'extensionUiDismiss':
            dismissExtensionUi(msg.id);
            break;
        case 'piExtensionChrome':
            state.piExtensionChrome = msg.chrome;
            updatePlanPanel();
            updateExtensionChromeStrip();
            break;
        case 'setComposerText': {
            const input = document.getElementById('input') as HTMLTextAreaElement | null;
            if (input && msg.text) {
                input.value = msg.text;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
            }
            break;
        }
        case 'toast':
            showToast(msg.message, msg.variant === 'error' ? 'error' : 'info');
            break;
        case 'sessionPanel':
            setSessionPanelOpen(msg.open);
            break;
        case 'sessionList':
            applySessionList(msg.data);
            break;
    }
}

function handleConfirmResult(action: string, confirmed: boolean, payload?: any): void {
    if (!confirmed) return;
    switch (action) {
        case 'restoreCheckpoint':
            if (payload?.messageIndex !== undefined) {
                vscode.postMessage({ type: 'restoreCheckpoint', messageIndex: payload.messageIndex });
            }
            break;
        case 'redoCheckpoint':
            vscode.postMessage({ type: 'redoCheckpoint' });
            break;
    }
}

function applyStateSync(s: SerializedAgentState): void {
    const prevTab = state.activeTabId;
    const prevStreamingText = state.streamingText;
    const prevStreamingThinking = state.streamingThinking;
    const prevIsThinking = state.isThinking;
    state.messages = s.messages ?? [];
    state.isStreaming = s.isStreaming;
    state.model = s.model;
    state.thinkingLevel = s.thinkingLevel;
    state.tools = s.tools ?? [];
    state.sessionId = s.sessionId;
    state.sessionName = s.sessionName;
    state.contextUsage = s.contextUsage;
    state.sessionTokens = s.sessionTokens;
    state.fileChanges = s.fileChanges ?? [];
    state.rollbackPoint = s.rollbackPoint ?? null;
    state.tabs = s.tabs ?? [];
    state.activeTabId = s.activeTabId ?? '';
    state.streamingText = s.streamingText ?? '';
    state.streamingThinking = s.streamingThinking ?? '';
    state.isThinking = s.isThinking ?? false;
    state.thinkingStartTime = s.thinkingStartTime ?? 0;
    state.streamingThinkingDuration = s.streamingThinkingDuration ?? 0;
    // During live streaming the webview often has fresher partial text than RPC stateSync.
    if (s.isStreaming) {
        if (prevStreamingText.length > state.streamingText.length) {
            state.streamingText = prevStreamingText;
        }
        if (prevStreamingThinking.length > state.streamingThinking.length) {
            state.streamingThinking = prevStreamingThinking;
        }
        if (prevIsThinking && !state.isThinking) {
            state.isThinking = prevIsThinking;
        }
    }
    state.queuedMessages = s.queuedMessages ?? [];
    state.steeringMessages = s.steeringMessages ?? [];
    state.followUpMessages = s.followUpMessages ?? [];
    state.pendingAttachments = s.pendingAttachments ?? [];
    state.planMode = s.planMode ?? state.planMode;
    state.piExtensionChrome = s.piExtensionChrome ?? state.piExtensionChrome;
    document.getElementById('mode-switch')?.classList.remove('mode-switch--pending');
    document.querySelectorAll('#mode-switch [data-mode]').forEach((b) => {
        (b as HTMLButtonElement).disabled = false;
    });
    state.connectionStatus = s.connectionStatus ?? { phase: 'idle' };
    const tabSwitched = prevTab !== state.activeTabId;

    if (tabSwitched || !skeletonBuilt) {
        render();
        userHasScrolled = false;
        scrollToBottom(true);
        updateScrollButton();
    } else {
        updateTabs();
        updateStreamingUI();
        updateMessages();
        updateInputArea();
        updateModeSwitch();
        updateChangedFiles();
        updateQueuedMessageBanner();
        updatePendingMessagesInChat();
        updateAttachmentsStrip();
        updateConnectionBanner();
        updatePlanPanel();
        if (state.isStreaming) {
            if (state.isThinking) {
                setStreamPhase('thinking');
            } else if (state.streamingText) {
                setStreamPhase('writing');
            } else {
                setStreamPhase('waiting');
            }
        } else {
            setStreamPhase('idle');
        }
        updateScrollButton();
    }
}

function handleAgentEvent(event: any): void {
    switch (event.type) {
        case 'message_start': {
            const msg = event.message;
            if (msg?.role === 'user') {
                appendUserMessageImmediate(msg);
            }
            break;
        }
        case 'queue_update':
            state.steeringMessages = Array.isArray(event.steering)
                ? event.steering.map(String)
                : [];
            state.followUpMessages = Array.isArray(event.followUp)
                ? event.followUp.map(String)
                : [];
            updatePendingMessagesInChat();
            break;
        case 'message_update':
            if (state.isStreaming && event.assistantMessageEvent) {
                handleStreamingDelta(event.assistantMessageEvent);
            }
            if (event.message?.role === 'assistant') {
                syncThinkingFromAssistantMessage(event.message);
                scheduleStreamingRender();
            }
            break;
        case 'message_end':
            if (event.message?.role === 'assistant') {
                syncThinkingFromAssistantMessage(event.message);
                if (event.message.stopReason === 'toolUse') {
                    state.streamingThinking = '';
                    state.isThinking = false;
                }
                scheduleStreamingRender();
            }
            break;
        case 'context_usage':
            if (event.usage) {
                state.contextUsage = {
                    tokens: event.usage.tokens ?? null,
                    contextWindow: event.usage.contextWindow ?? 0,
                    percent: event.usage.percent ?? null,
                };
            }
            break;
        case 'agent_start':
            state.connectionStatus = { phase: 'idle' };
            state.isStreaming = true;
            state.streamingText = '';
            state.streamingThinking = '';
            state.isThinking = false;
            streamingThinkingUserOpen = false;
            clearStreamingToolArtifacts();
            setStreamPhase('waiting');
            userHasScrolled = false;
            updateInputArea();
            updateConnectionBanner();
            updateStreamingUI();
            break;
        case 'agent_end': {
            const willRetry = event.willRetry === true;
            if (willRetry) {
                const lastAssistant = lastAssistantMessage(event.messages);
                state.connectionStatus = {
                    phase: 'retrying',
                    message:
                        (typeof lastAssistant?.errorMessage === 'string'
                            ? lastAssistant.errorMessage
                            : undefined) ?? 'Connection lost — retrying…',
                };
                state.isStreaming = true;
            } else {
                const failed = failedConnectionFromAssistant(
                    lastAssistantMessage(event.messages),
                );
                state.connectionStatus = failed ?? { phase: 'idle' };
                state.isStreaming = false;
                state.streamingText = '';
                state.streamingThinking = '';
                state.isThinking = false;
                setStreamPhase('idle');
                if (failed?.message) {
                    showError(failed.message);
                }
            }
            updateStreamingUI();
            updateInputArea();
            updateConnectionBanner();
            updateModeSwitch();
            updatePlanPanel();
            break;
        }
        case 'auto_retry_start':
            state.connectionStatus = {
                phase: 'retrying',
                message: event.errorMessage ?? 'Connection error',
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
            };
            state.isStreaming = true;
            updateInputArea();
            updateConnectionBanner();
            break;
        case 'auto_retry_end':
            if (event.success) {
                state.connectionStatus = { phase: 'idle' };
            } else {
                state.connectionStatus = {
                    phase: 'failed',
                    message:
                        event.finalError ??
                        'Could not reach the model after multiple attempts.',
                    attempt: event.attempt,
                };
                state.isStreaming = false;
                if (state.connectionStatus.message) {
                    showError(state.connectionStatus.message);
                }
            }
            updateInputArea();
            updateConnectionBanner();
            break;
        case 'compaction_end':
            if (event.errorMessage && !event.willRetry) {
                state.connectionStatus = {
                    phase: 'failed',
                    message: event.errorMessage,
                };
                showError(event.errorMessage);
                updateConnectionBanner();
            }
            break;
        case 'tool_execution_start':
            setStreamPhase('tool', event.toolName ?? 'tool');
            renderToolStart(event);
            break;
        case 'tool_execution_update':
            renderToolUpdate(event);
            break;
        case 'tool_execution_end':
            renderToolEnd(event);
            if (state.isThinking) {
                setStreamPhase('thinking');
            } else if (state.streamingText) {
                setStreamPhase('writing');
            } else {
                setStreamPhase('waiting');
            }
            break;
    }
}

function handleStreamingDelta(ae: any): void {
    switch (ae.type) {
        case 'thinking_start':
            state.isThinking = true;
            if (state.streamingThinking.trim().length > 0) {
                state.streamingThinking += '\n\n';
            }
            state.thinkingStartTime = Date.now();
            state.streamingThinkingDuration = 0;
            setStreamPhase('thinking');
            break;
        case 'thinking_delta':
            state.streamingThinking += ae.delta ?? '';
            setStreamPhase('thinking');
            break;
        case 'thinking_end':
            state.isThinking = false;
            if (state.thinkingStartTime > 0) {
                state.streamingThinkingDuration = Math.round((Date.now() - state.thinkingStartTime) / 1000);
            }
            setStreamPhase(state.streamingText ? 'writing' : 'waiting');
            break;
        case 'text_start':
            setStreamPhase('writing');
            break;
        case 'text_delta':
            state.streamingText += ae.delta ?? '';
            setStreamPhase('writing');
            break;
        case 'text_end':
            break;
    }
    scheduleStreamingRender();
}

let streamRenderPending = false;
/** User expanded streaming thinking — preserve across delta re-renders. */
let streamingThinkingUserOpen = false;

type StreamPhase = 'idle' | 'thinking' | 'tool' | 'writing' | 'waiting';
let streamPhase: StreamPhase = 'idle';
let streamPhaseDetail = '';

function setStreamPhase(phase: StreamPhase, detail = ''): void {
    streamPhase = phase;
    streamPhaseDetail = detail;
    updateStreamActivityBar();
}

function streamActivityLabel(): string {
    switch (streamPhase) {
        case 'thinking':
            return 'Thinking…';
        case 'tool':
            return streamPhaseDetail ? `Running ${streamPhaseDetail}…` : 'Running tool…';
        case 'writing':
            return 'Writing response…';
        case 'waiting':
            return streamPhaseDetail || 'Working…';
        default:
            return state.isStreaming ? 'Pi is working…' : '';
    }
}

function streamingThinkingBlockVisible(): boolean {
    const streamingThinkingText = state.streamingThinking.trim();
    return (
        state.isStreaming &&
        (state.isThinking || Boolean(streamingThinkingText)) &&
        !assistantMessageAlreadyShowsThinking(streamingThinkingText)
    );
}

function updateStreamActivityBar(): void {
    const bar = document.getElementById('stream-activity');
    const container = document.getElementById('streaming-message');
    if (!bar || !container) {
        return;
    }
    const label = streamActivityLabel();
    const active = state.isStreaming;
    // Live reasoning uses the expandable thinking block; hide the duplicate status pill.
    const hideForThinkingBlock =
        streamingThinkingBlockVisible() && streamPhase === 'thinking';
    container.classList.toggle('streaming-active', active);
    bar.classList.toggle('stream-activity--idle', !active || hideForThinkingBlock);
    bar.classList.toggle('stream-activity--thinking', streamPhase === 'thinking');
    bar.classList.toggle('stream-activity--tool', streamPhase === 'tool');
    bar.classList.toggle('stream-activity--writing', streamPhase === 'writing');
    if (!active) {
        return;
    }
    const labelEl = bar.querySelector('.stream-activity-label');
    if (labelEl && labelEl.textContent !== label) {
        labelEl.textContent = label;
    }
}

let scrollFollowPending = false;

/** Scroll only when the user is already following the stream (avoids layout jump spam). */
function scrollIfFollowing(): void {
    if (userHasScrolled) {
        return;
    }
    if (scrollFollowPending) {
        return;
    }
    scrollFollowPending = true;
    requestAnimationFrame(() => {
        scrollFollowPending = false;
        if (userHasScrolled) {
            return;
        }
        if (isNearBottom()) {
            scrollToBottom();
        }
    });
}

function scheduleStreamingRender(): void {
    if (streamRenderPending) {
        return;
    }
    streamRenderPending = true;
    requestAnimationFrame(() => {
        streamRenderPending = false;
        renderStreamingContent();
        updateStreamActivityBar();
    });
}

function messageFingerprint(msg: any): string {
    const role = msg?.role ?? '';
    const text = extractText(msg);
    const ts = msg?.timestamp ?? '';
    return `${role}:${text}:${ts}`;
}

function appendUserMessageImmediate(msg: any): void {
    const fp = messageFingerprint(msg);
    const last = state.messages[state.messages.length - 1];
    if (last && messageFingerprint(last) === fp) {
        return;
    }
    if (last?._optimistic && last.role === 'user' && extractText(last) === extractText(msg)) {
        state.messages[state.messages.length - 1] = msg;
        updateMessages();
        return;
    }
    state.messages.push(msg);
    appendChatMessageDom(msg, state.messages.length - 1);
    scrollToBottom();
}

function appendOptimisticUserMessage(text: string, attachmentCount: number): void {
    const suffix =
        attachmentCount > 0 ? `\n\n[+${attachmentCount} attachment(s)]` : '';
    const content = text + suffix;
    const msg = { role: 'user', content, _optimistic: true };
    state.messages.push(msg);
    appendChatMessageDom(msg, state.messages.length - 1);
    scrollToBottom();
}

function appendChatMessageDom(msg: any, index: number): void {
    const container = document.getElementById('messages');
    const streamingEl = document.getElementById('streaming-message');
    if (!container || !streamingEl || shouldHideMessageInChat(msg)) {
        return;
    }
    const welcome = container.querySelector('.welcome');
    welcome?.remove();
    let userMsgCount = 0;
    for (let i = 0; i <= index && i < state.messages.length; i++) {
        if (state.messages[i]?.role === 'user') {
            userMsgCount++;
        }
    }
    const turnNumber = msg.role === 'user' ? userMsgCount : undefined;
    const msgEl = renderMessage(msg, index, turnNumber);

    if (msg.role === 'user') {
        const turn = el('div', 'chat-turn');
        const turnBody = el('div', 'chat-turn-body');
        turn.appendChild(msgEl);
        turn.appendChild(turnBody);
        container.insertBefore(turn, streamingEl);
    } else {
        const turns = container.querySelectorAll('.chat-turn');
        const lastTurn = turns[turns.length - 1] as HTMLElement | undefined;
        const turnBody = lastTurn?.querySelector('.chat-turn-body');
        if (turnBody) {
            turnBody.appendChild(msgEl);
        } else {
            container.insertBefore(msgEl, streamingEl);
        }
    }

    markLatestUserMessageGroup();
    bindUserPromptStickyCollapse();
    bindCopyButtons();
    bindCheckpointButtons();
    bindRedoButtons();
    bindDiffButtons();
    bindToolClickable();
    bindAttachmentOpenClicks();
    bindMessageActionButtons();
}

// ── Rendering ──

let skeletonBuilt = false;

function render(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = '';
    skeletonBuilt = false;

    // Header: tab-strip (dynamic) + header-right (static)
    const header = el('div', 'header');
    const tabStrip = el('div', 'tab-strip');
    header.appendChild(tabStrip);
    const modeSwitch = el('div', 'mode-switch');
    modeSwitch.id = 'mode-switch';
    header.appendChild(modeSwitch);

    const headerActions = el('div', 'header-right');
    headerActions.innerHTML = `
        <button class="icon-btn" id="btn-new-tab" title="New Agent"><img class="header-icon-img" src="${iconsBaseUri}/new.svg" alt="new"></button>
        <button class="icon-btn" id="btn-sessions" title="Resume session"><img class="header-icon-img" src="${iconsBaseUri}/list.svg" alt="resume session"></button>
        <button class="icon-btn" id="btn-settings" title="Settings"><img class="header-icon-img" src="${iconsBaseUri}/settings.svg" alt="settings"></button>
    `;
    header.appendChild(headerActions);
    app.appendChild(header);

    // Messages container (persistent, children managed by updateMessages)
    const messagesContainer = el('div', 'messages');
    messagesContainer.id = 'messages';
    const pendingMessages = el('div', 'pending-messages');
    pendingMessages.id = 'pending-messages';
    pendingMessages.style.display = 'none';
    messagesContainer.appendChild(pendingMessages);
    const streamingContainer = el('div', 'streaming-message message-group-assistant');
    streamingContainer.id = 'streaming-message';
    const streamActivity = el('div', 'stream-activity stream-activity--idle');
    streamActivity.id = 'stream-activity';
    streamActivity.setAttribute('aria-live', 'polite');
    streamActivity.setAttribute('aria-atomic', 'true');
    streamActivity.innerHTML =
        '<span class="stream-activity-dot" aria-hidden="true"></span><span class="stream-activity-label"></span>';
    streamingContainer.appendChild(streamActivity);
    messagesContainer.appendChild(streamingContainer);
    const spacer = el('div', 'messages-spacer');
    messagesContainer.appendChild(spacer);
    app.appendChild(messagesContainer);

    // Scroll-to-bottom button (static)
    const scrollWrap = el('div', 'scroll-btn-wrap');
    const scrollBtn = el('button', 'scroll-bottom-btn');
    scrollBtn.id = 'btn-scroll-bottom';
    scrollBtn.title = 'Scroll to bottom';
    scrollBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3L8 13M8 13L3 8M8 13L13 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    scrollWrap.appendChild(scrollBtn);
    app.appendChild(scrollWrap);

    // Input container: changed-files slot + queued section + slash menu + input-area (persistent textarea) + footer
    const inputContainer = el('div', 'input-container');
    const planPanel = el('div', 'plan-panel');
    planPanel.id = 'plan-panel';
    inputContainer.appendChild(planPanel);
    const chromeStrip = el('div', 'extension-chrome-strip');
    chromeStrip.id = 'extension-chrome-strip';
    chromeStrip.style.display = 'none';
    inputContainer.appendChild(chromeStrip);
    const extensionUiHost = el('div', 'extension-ui-host');
    extensionUiHost.id = 'extension-ui-host';
    extensionUiHost.style.display = 'none';
    inputContainer.appendChild(extensionUiHost);
    const queuedSection = document.createElement('details');
    queuedSection.className = 'queued-section';
    queuedSection.id = 'queued-section';
    queuedSection.style.display = 'none';
    inputContainer.appendChild(queuedSection);
    const slashMenu = el('div', 'slash-menu');
    slashMenu.id = 'slash-menu';
    slashMenu.style.display = 'none';
    inputContainer.appendChild(slashMenu);
    const atMenu = el('div', 'at-menu');
    atMenu.id = 'at-menu';
    atMenu.style.display = 'none';
    inputContainer.appendChild(atMenu);
    const attachmentsStrip = el('div', 'attachments-strip');
    attachmentsStrip.id = 'attachments-strip';
    attachmentsStrip.style.display = 'none';
    inputContainer.appendChild(attachmentsStrip);
    const dropShiftHint = el('div', 'drop-shift-hint');
    dropShiftHint.id = 'drop-shift-hint';
    dropShiftHint.hidden = true;
    inputContainer.appendChild(dropShiftHint);
    const composerEditBanner = el('div', 'composer-edit-banner');
    composerEditBanner.id = 'composer-edit-banner';
    composerEditBanner.style.display = 'none';
    inputContainer.appendChild(composerEditBanner);
    const area = el('div', 'input-area');
    area.innerHTML = `
        <div class="composer-toolbar">
            <div class="composer-toolbar-left">
                <button id="btn-attach" class="composer-action-btn composer-action-btn--ghost" type="button" title="Attach files · @ paths · Shift+drop from Explorer">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 8.5L7.2 14.8a3.5 3.5 0 01-5-5l6.8-6.8a2.5 2.5 0 013.5 3.5L5.7 12.3a1.5 1.5 0 01-2.1-2.1l6.1-6.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                </button>
            </div>
            <textarea id="input" placeholder="Ask Pi anything..." rows="1"></textarea>
            <div class="composer-toolbar-right">
                <button id="btn-steer" class="composer-action-btn composer-action-btn--ghost" type="button" title="Steer (Ctrl+Enter)" hidden>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button id="btn-send" class="composer-action-btn composer-action-btn--primary" type="button" title="Send (Enter)" aria-label="Send message">
                    <span class="composer-btn-icon composer-btn-icon--send" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2.5v11M8 2.5L4 6.5M8 2.5l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                    <span class="composer-btn-icon composer-btn-icon--stop" aria-hidden="true" hidden><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg></span>
                </button>
            </div>
        </div>`;
    inputContainer.appendChild(area);
    app.appendChild(inputContainer);

    // Bind stable event listeners (these elements persist for the lifetime of the skeleton)
    bindStableEvents();
    initExtensionUiHost();
    bindScrollListener();
    scrollBtn.addEventListener('click', () => {
        userHasScrolled = false;
        scrollToBottom(true);
        updateScrollButton();
    });

    skeletonBuilt = true;

    onAppShellRebuilt();

    // Populate all dynamic sections
    updateTabs();
    updateModeSwitch();
    updatePlanPanel();
    updateMessages();
    updateInputArea();
        updateConnectionBanner();
        updateChangedFiles();
        scrollToBottom();
}

function updateModeSwitch(): void {
    const root = document.getElementById('mode-switch');
    if (!root) return;

    const pm = state.planMode ?? emptyPlanMode();
    const active = pm.enabled ? 'plan' : 'agent';
    const canImplement =
        pm.hasPlan && (pm.statusLabel === 'ready' || (!pm.enabled && pm.statusLabel === 'off'));
    const implementBtn =
        canImplement && !state.isStreaming
            ? '<button type="button" class="mode-action-btn" id="btn-implement-plan">Implement</button>'
            : '';

    const planReadyDot =
        pm.statusLabel === 'ready'
            ? '<span class="mode-ready-dot" title="Plan ready"></span>'
            : '';

    root.innerHTML = `
        <div class="mode-switch-row">
            <div class="mode-segment" role="tablist" aria-label="Agent mode">
                <button type="button" class="mode-segment-btn ${active === 'agent' ? 'active' : ''}" data-mode="agent">Agent</button>
                <button type="button" class="mode-segment-btn ${active === 'plan' ? 'active' : ''}" data-mode="plan">
                    <span class="mode-segment-label">Plan</span>${planReadyDot}
                </button>
            </div>
            ${implementBtn}
        </div>
    `;

    root.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLButtonElement).dataset.mode as 'agent' | 'plan';
            const pm = state.planMode ?? emptyPlanMode();
            if ((mode === 'plan') === pm.enabled) return;
            root.classList.add('mode-switch--pending');
            root.querySelectorAll('[data-mode]').forEach((b) => {
                (b as HTMLButtonElement).disabled = true;
            });
            vscode.postMessage({ type: 'setAgentMode', mode });
        });
    });
    document.getElementById('btn-implement-plan')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'implementPlan' });
    });
}

/** Plan markdown/todos live in the editor; composer shows live status from Pi extension chrome. */
function updatePlanPanel(): void {
    const panel = document.getElementById('plan-panel');
    if (!panel) return;

    const pm = state.planMode;
    const chrome = state.piExtensionChrome;
    const planWidget = chrome?.widgets.find((w) => w.key === 'plan-mode-plan');
    const widgetLines = planWidget?.lines?.filter((l) => l.trim()) ?? [];
    const planStatus = chrome?.statuses.find((s) => s.key === 'plan-mode')?.text?.trim();

    const showHint = pm.enabled && !pm.hasPlan && !state.isStreaming;
    const showWidget = pm.enabled && widgetLines.length > 0;

    if (!showHint && !showWidget) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }

    panel.style.display = '';
    if (showWidget) {
        const preview = widgetLines.slice(0, 6).map((l) => escHtml(l)).join('<br>');
        const more = widgetLines.length > 6 ? `<div class="plan-panel-more">+${widgetLines.length - 6} more lines in editor</div>` : '';
        panel.innerHTML = `
            <div class="plan-panel-header">
                <span class="plan-panel-title">Plan</span>
                <span class="plan-panel-status">${escHtml(planStatus || (pm.statusLabel === 'ready' ? 'Ready to implement' : 'In progress'))}</span>
            </div>
            <div class="plan-panel-preview">${preview}${more}</div>
            <button type="button" class="plan-panel-open" id="btn-open-plan-doc">Open plan in editor</button>
        `;
        document.getElementById('btn-open-plan-doc')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'openPlanDocument' });
        });
        return;
    }

    panel.innerHTML = `
        <div class="plan-panel-header plan-panel-hint-only">
            <span class="plan-panel-title">Plan</span>
            <span class="plan-panel-status">${escHtml(planStatus || 'Exploring… When ready, the plan opens in the editor automatically.')}</span>
        </div>
    `;
}

function updateExtensionChromeStrip(): void {
    const host = document.getElementById('extension-chrome-strip');
    if (!host) return;

    const chrome = state.piExtensionChrome;
    const belowWidgets =
        chrome?.widgets.filter(
            (w) => w.key !== 'plan-mode-plan' && w.placement === 'belowEditor' && w.lines?.length,
        ) ?? [];

    if (belowWidgets.length === 0) {
        host.style.display = 'none';
        host.innerHTML = '';
        return;
    }

    host.style.display = '';
    host.innerHTML = belowWidgets
        .map(
            (w) =>
                `<div class="extension-chrome-widget"><div class="extension-chrome-widget-title">${escHtml(w.key)}</div>${w.lines!.map((l) => `<div class="extension-chrome-widget-line">${escHtml(l)}</div>`).join('')}</div>`,
        )
        .join('');
}

function markLatestUserMessageGroup(): void {
    document.querySelectorAll('.message-group-user--latest').forEach((node) => {
        node.classList.remove('message-group-user--latest');
    });
    const groups = document.querySelectorAll('.message-group-user');
    const last = groups[groups.length - 1];
    last?.classList.add('message-group-user--latest');
}

const USER_PROMPT_STICKY_LINE_CLAMP = 3;

type UserPromptCollapseState = { expanded: boolean; clampable: boolean };

let userPromptStickyObserver: IntersectionObserver | null = null;
const userPromptCollapseByGroup = new WeakMap<HTMLElement, UserPromptCollapseState>();

function teardownUserPromptStickyCollapse(): void {
    userPromptStickyObserver?.disconnect();
    userPromptStickyObserver = null;
}

function userPromptContentNeedsClamp(content: HTMLElement): boolean {
    const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
    const maxHeight =
        Number.isFinite(lineHeight) && lineHeight > 0
            ? lineHeight * USER_PROMPT_STICKY_LINE_CLAMP
            : 52;
    return content.scrollHeight > maxHeight + 4;
}

function applyUserPromptCollapse(group: HTMLElement, collapseState: UserPromptCollapseState): void {
    const stuck = group.classList.contains('user-prompt-stuck');
    const collapsed = stuck && !collapseState.expanded;
    const content = group.querySelector('.message-content') as HTMLElement | null;
    const attachments = group.querySelector('.message-attachments') as HTMLElement | null;
    const toggle = group.querySelector('.user-prompt-expand-toggle') as HTMLButtonElement | null;

    content?.classList.toggle('user-prompt-text--collapsed', collapsed);
    attachments?.classList.toggle('user-prompt-attachments--hidden', collapsed);
    group.classList.toggle('user-prompt-expanded', collapseState.expanded);
    if (toggle) {
        toggle.textContent = collapseState.expanded ? 'Show less' : 'Show more';
        toggle.setAttribute('aria-expanded', collapseState.expanded ? 'true' : 'false');
    }
}

function updateUserPromptStickyState(group: HTMLElement, stuck: boolean): void {
    group.classList.toggle('user-prompt-stuck', stuck);
    const collapseState = userPromptCollapseByGroup.get(group);
    if (!collapseState) {
        return;
    }
    if (!stuck) {
        collapseState.expanded = false;
    }
    applyUserPromptCollapse(group, collapseState);
}

function bindUserPromptStickyCollapse(): void {
    const container = document.getElementById('messages');
    if (!container) {
        return;
    }

    teardownUserPromptStickyCollapse();
    userPromptStickyObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const sentinel = entry.target as HTMLElement;
                const group = sentinel.nextElementSibling;
                if (!(group instanceof HTMLElement) || !group.classList.contains('message-group-user')) {
                    continue;
                }
                updateUserPromptStickyState(group, !entry.isIntersecting);
            }
        },
        { root: container, threshold: [0] },
    );

    document.querySelectorAll('.chat-turn').forEach((turnNode) => {
        const turn = turnNode as HTMLElement;
        const group = turn.querySelector('.message-group-user') as HTMLElement | null;
        if (!group) {
            return;
        }

        const content = group.querySelector('.message-content') as HTMLElement | null;
        turn.querySelector('.user-sticky-sentinel')?.remove();
        group.querySelector('.user-prompt-expand-toggle')?.remove();
        group.classList.remove('user-prompt-clampable', 'user-prompt-stuck', 'user-prompt-expanded');
        content?.classList.remove('user-prompt-text--collapsed');
        group.querySelector('.message-attachments')?.classList.remove('user-prompt-attachments--hidden');

        if (!content || !userPromptContentNeedsClamp(content)) {
            userPromptCollapseByGroup.delete(group);
            return;
        }

        const collapseState: UserPromptCollapseState = { expanded: false, clampable: true };
        userPromptCollapseByGroup.set(group, collapseState);
        group.classList.add('user-prompt-clampable');

        const sentinel = el('div', 'user-sticky-sentinel');
        turn.insertBefore(sentinel, group);
        userPromptStickyObserver!.observe(sentinel);

        const toggle = el('button', 'user-prompt-expand-toggle') as HTMLButtonElement;
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Show more';
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            const state = userPromptCollapseByGroup.get(group);
            if (!state) {
                return;
            }
            state.expanded = !state.expanded;
            applyUserPromptCollapse(group, state);
        });
        group.querySelector('.user-prompt-card')?.appendChild(toggle);

        const containerRect = container.getBoundingClientRect();
        const stuckNow = sentinel.getBoundingClientRect().bottom <= containerRect.top + 1;
        updateUserPromptStickyState(group, stuckNow);
    });
}

function updateMessages(): void {
    const container = document.getElementById('messages');
    if (!container) return;

    captureThinkingOpenState();
    captureToolsOpenState();

    const streamingEl = document.getElementById('streaming-message');
    const spacerEl = container.querySelector('.messages-spacer');

    // Remove message nodes only (keep pending steering/follow-up strip).
    for (const child of [...container.childNodes]) {
        if (child === streamingEl || child === spacerEl) {
            break;
        }
        if ((child as HTMLElement).id === 'pending-messages') {
            continue;
        }
        container.removeChild(child);
    }

    codeBlockId = 0;

    if (state.messages.length === 0 && !state.isStreaming) {
        container.insertBefore(buildWelcome(), streamingEl);
    } else {
        let userMsgCount = 0;
        const rollbackUserIdx = state.rollbackPoint;
        let dimming = false;
        let redoPlaced = false;
        let currentTurn: HTMLElement | null = null;
        let turnBody: HTMLElement | null = null;
        let turnThinkingParts: string[] = [];
        let turnThinkingDurationSec = 0;
        let turnUserMsgCount = 0;
        let turnToolItems: Array<{ msg: any; index: number }> = [];

        const flushTurnTools = (completedTurn = false): void => {
            if (!turnBody || turnToolItems.length === 0) {
                if (completedTurn) {
                    turnToolItems = [];
                }
                return;
            }
            if (completedTurn || !state.isStreaming) {
                turnBody
                    .querySelector(`details.tools-block[data-tools-key="turn:${turnUserMsgCount}"]`)
                    ?.remove();
                turnBody.appendChild(
                    buildMergedToolsBlock(turnToolItems, state.messages, turnUserMsgCount),
                );
                turnToolItems = [];
            }
        };

        const flushTurnThinking = (completedTurn = false): void => {
            if (!turnBody || turnThinkingParts.length === 0) {
                if (completedTurn) {
                    turnThinkingParts = [];
                    turnThinkingDurationSec = 0;
                }
                return;
            }
            if (completedTurn || !state.isStreaming) {
                prependMergedTurnThinking(
                    turnBody,
                    turnThinkingParts,
                    turnThinkingDurationSec,
                    `turn:${turnUserMsgCount}`,
                );
                turnThinkingParts = [];
                turnThinkingDurationSec = 0;
            }
        };

        for (let i = 0; i < state.messages.length; i++) {
            const msg = state.messages[i];
            if (shouldHideMessageInChat(msg)) {
                continue;
            }
            const role = msg.role ?? 'unknown';

            if (role === 'user') {
                flushTurnTools(true);
                flushTurnThinking(true);
                userMsgCount++;
                turnUserMsgCount = userMsgCount;
                if (rollbackUserIdx !== null && userMsgCount > rollbackUserIdx) {
                    dimming = true;
                }

                currentTurn = el('div', 'chat-turn');
                turnBody = el('div', 'chat-turn-body');

                const msgEl = renderMessage(msg, i, userMsgCount);
                if (dimming) {
                    msgEl.classList.add('dimmed');
                }
                currentTurn.appendChild(msgEl);
                currentTurn.appendChild(turnBody);
                container.insertBefore(currentTurn, streamingEl);

                if (dimming && !redoPlaced && rollbackUserIdx !== null) {
                    const redoWrap = el('div', 'redo-anchor');
                    const redoBtn = el('button', 'redo-btn');
                    redoBtn.title = 'Redo changes';
                    redoBtn.textContent = 'Redo';
                    redoWrap.appendChild(redoBtn);
                    turnBody.appendChild(redoWrap);
                    redoPlaced = true;
                }
                continue;
            }

            if (role === 'toolResult' || role === 'tool') {
                const toolName = msg.toolName ?? '';
                if (toolName === 'edit' || toolName === 'write') {
                    const matchingChange = findFileChangeForToolResult(msg);
                    if (matchingChange) {
                        if (!state.isStreaming) {
                            const diffEl = buildDiffCard(matchingChange, msg);
                            if (dimming) {
                                diffEl.classList.add('dimmed');
                            }
                            if (turnBody) {
                                turnBody.appendChild(diffEl);
                            } else {
                                container.insertBefore(diffEl, streamingEl);
                            }
                        }
                        continue;
                    }
                }
                turnToolItems.push({ msg, index: i });
                continue;
            }

            if (turnBody && role === 'assistant') {
                const think = extractThinking(msg).trim();
                if (think) {
                    turnThinkingParts.push(think);
                }
                if (msg._thinkingDurationSec) {
                    turnThinkingDurationSec += msg._thinkingDurationSec;
                }
            }

            const msgEl = renderMessage(
                msg,
                i,
                undefined,
                turnBody ? { suppressThinking: true } : undefined,
            );
            if (dimming) {
                msgEl.classList.add('dimmed');
            }

            if (turnBody) {
                turnBody.appendChild(msgEl);
            } else {
                container.insertBefore(msgEl, streamingEl);
            }
        }
        flushTurnTools(!state.isStreaming);
        flushTurnThinking(!state.isStreaming);
    }

    if (!state.isStreaming) {
        clearStreamingToolArtifacts();
    }

    markLatestUserMessageGroup();
    bindUserPromptStickyCollapse();

    bindCopyButtons();
    bindCheckpointButtons();
    bindRedoButtons();
    bindDiffButtons();
    bindToolClickable();
    bindAttachmentOpenClicks();
    bindMessageActionButtons();

    const pendingEl = document.getElementById('pending-messages');
    if (pendingEl && streamingEl && pendingEl.nextSibling !== streamingEl) {
        container.insertBefore(pendingEl, streamingEl);
    }
    updatePendingMessagesInChat();
}

function updateTabs(): void {
    const tabStrip = document.querySelector('.tab-strip');
    if (!tabStrip) return;
    tabStrip.innerHTML = '';

    for (const tab of state.tabs) {
        const tabEl = el('div', `tab${tab.isActive ? ' tab-active' : ''}${tab.isStreaming ? ' tab-streaming' : ''}`);
        tabEl.dataset.tabId = tab.id;

        const icon = el('span', 'tab-icon');
        if (tab.isStreaming) {
            icon.innerHTML = '<span class="tab-spinner"></span>';
        } else if (tab.hasNotification) {
            icon.innerHTML = `<img class="tab-icon-img" src="${iconsBaseUri}/notification.svg" alt="notification">`;
        } else {
            icon.innerHTML = `<img class="tab-icon-img" src="${iconsBaseUri}/chat.svg" alt="chat">`;
        }

        const name = el('span', 'tab-name');
        const displayName = tab.name.length > 20
            ? tab.name.substring(0, 18) + '...'
            : tab.name;
        name.textContent = displayName;
        name.title = tab.name;

        tabEl.appendChild(icon);
        tabEl.appendChild(name);

        if (state.tabs.length > 1) {
            const closeBtn = el('button', 'tab-close');
            closeBtn.innerHTML = '&times;';
            closeBtn.title = 'Close tab';
            closeBtn.dataset.tabId = tab.id;
            tabEl.appendChild(closeBtn);
        }

        tabStrip.appendChild(tabEl);
    }

    bindTabEvents();
}

function hasSendableInput(text: string): boolean {
    return Boolean(text.trim()) || state.pendingAttachments.length > 0;
}

function updateAttachmentsStrip(): void {
    const strip = document.getElementById('attachments-strip');
    const container = document.querySelector('.input-container');
    if (!strip) return;

    const has = state.pendingAttachments.length > 0;
    container?.classList.toggle('has-attachments', has);

    if (!has) {
        strip.style.display = 'none';
        strip.innerHTML = '';
        return;
    }
    strip.style.display = '';
    strip.innerHTML = state.pendingAttachments
        .map((a) => renderComposerAttachmentChip(a, escHtml, escAttr))
        .join('');

    strip.querySelectorAll('.attachment-remove').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = (btn as HTMLElement).dataset.id;
            if (id) {
                vscode.postMessage({ type: 'removeAttachment', id });
            }
        });
    });

    bindAttachmentOpenClicks();
}

function updateComposerToolbar(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const text = input?.value.trim() ?? '';
    const canSend = hasSendableInput(text);

    const steerBtn = document.getElementById('btn-steer');
    const sendBtn = document.getElementById('btn-send') as HTMLButtonElement | null;

    if (steerBtn) {
        steerBtn.hidden = !state.isStreaming;
    }
    if (sendBtn) {
        const showStop = state.isStreaming && !composerEdit && !canSend;
        const showInterruptSend = state.isStreaming && !composerEdit && canSend;
        sendBtn.classList.toggle('composer-action-btn--as-stop', showStop);
        sendBtn.classList.toggle('composer-action-btn--as-queue', showInterruptSend);
        const sendIcon = sendBtn.querySelector('.composer-btn-icon--send') as HTMLElement | null;
        const stopIcon = sendBtn.querySelector('.composer-btn-icon--stop') as HTMLElement | null;
        if (sendIcon) {
            sendIcon.hidden = showStop;
        }
        if (stopIcon) {
            stopIcon.hidden = !showStop;
        }
        if (composerEdit) {
            sendBtn.title = 'Send as new (⌘↵ fork)';
            sendBtn.setAttribute('aria-label', 'Send as new message');
        } else if (showStop) {
            sendBtn.title = 'Stop (Esc)';
            sendBtn.setAttribute('aria-label', 'Stop generation');
        } else if (showInterruptSend) {
            sendBtn.title = 'Send now (interrupt current work)';
            sendBtn.setAttribute('aria-label', 'Send now and interrupt current work');
        } else {
            sendBtn.title = 'Send (Enter)';
            sendBtn.setAttribute('aria-label', 'Send message');
        }
        const disabled = !state.isStreaming && !canSend;
        sendBtn.toggleAttribute('disabled', disabled);
        sendBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }
}

function submitWhileStreaming(mode: 'queue' | 'interrupt'): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const text = input?.value.trim() ?? '';
    if (!hasSendableInput(text)) {
        return;
    }
    const attachmentCount = state.pendingAttachments.length;
    const slashOnly = attachmentCount === 0 && text.startsWith('/');
    state.pendingAttachments = [];
    updateAttachmentsStrip();
    if (slashOnly) {
        vscode.postMessage({ type: 'slashCommand', text });
    } else {
        if (text || attachmentCount > 0) {
            appendOptimisticUserMessage(text, attachmentCount);
        }
        vscode.postMessage({
            type: mode === 'interrupt' ? 'interruptAndSend' : 'queueMessage',
            text,
        });
    }
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }
    updateComposerToolbar();
}

function requestAbort(): void {
    state.isStreaming = false;
    state.streamingText = '';
    state.streamingThinking = '';
    state.isThinking = false;
    state.connectionStatus = { phase: 'idle' };
    setStreamPhase('idle');
    updateStreamingUI();
    updateInputArea();
    updateConnectionBanner();
    vscode.postMessage({ type: 'abort' });
}

function handleSendButtonClick(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (state.isStreaming) {
        const text = input?.value.trim() ?? '';
        if (hasSendableInput(text)) {
            submitWhileStreaming('interrupt');
        } else {
            requestAbort();
        }
        return;
    }
    sendMessage();
}

function handleSteerButtonClick(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const text = input?.value.trim() ?? '';
    if (!hasSendableInput(text)) {
        return;
    }
    vscode.postMessage({ type: 'steer', text });
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }
    updateComposerToolbar();
}

function updateInputArea(): void {
    updateComposerEditBanner();
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (input) {
        input.placeholder = composerEdit
            ? 'Enter = send as new · ⌘↵ = fork & send · Esc = cancel'
            : state.isStreaming
            ? 'Enter to queue · ↑ send now · Ctrl+Enter steer · Esc stop...'
            : state.planMode.enabled
              ? 'Plan mode: describe what to build (read-only until you implement)...'
              : 'Ask Pi anything...';
    }

    updateComposerToolbar();
    updateQueuedMessageBanner();
    updateConnectionBanner();
}

function updateConnectionBanner(): void {
    const container = document.querySelector('.input-container');
    if (!container) {
        return;
    }

    const existing = document.getElementById('connection-banner');
    const cs = state.connectionStatus ?? { phase: 'idle' };

    if (cs.phase === 'idle') {
        existing?.remove();
        return;
    }

    const attemptLabel =
        cs.phase === 'retrying' && cs.attempt != null && cs.maxAttempts != null
            ? ` (${cs.attempt}/${cs.maxAttempts})`
            : cs.phase === 'retrying' && cs.attempt != null
              ? ` (attempt ${cs.attempt})`
              : '';

    const title =
        cs.phase === 'retrying'
            ? `Reconnecting${attemptLabel}…`
            : 'Connection failed';

    const detailText = cs.message ? truncate(cs.message, 200) : '';

    let banner = existing;
    if (!banner) {
        banner = el('div', `connection-banner connection-banner-${cs.phase}`);
        banner.id = 'connection-banner';
        const inputArea = container.querySelector('.input-area');
        if (inputArea) {
            container.insertBefore(banner, inputArea);
        } else {
            container.appendChild(banner);
        }
    } else {
        banner.className = `connection-banner connection-banner-${cs.phase}`;
    }

    banner.replaceChildren();

    if (cs.phase === 'retrying') {
        banner.append(
            el('span', 'connection-banner-spinner'),
            Object.assign(el('span', 'connection-banner-title'), { textContent: title }),
        );
        if (detailText) {
            const detailEl = el('span', 'connection-banner-detail');
            detailEl.textContent = detailText;
            banner.append(detailEl);
        }
        return;
    }

    banner.append(Object.assign(el('span', 'connection-banner-title'), { textContent: title }));
    if (detailText) {
        const detailEl = el('span', 'connection-banner-detail');
        detailEl.textContent = detailText;
        banner.append(detailEl);
    }
    appendDismissButton(banner, 'connection-banner-dismiss', () => {
        state.connectionStatus = { phase: 'idle' };
        updateConnectionBanner();
    });
}

let queuedEditingIndex = -1;

/** When set, composer is editing a sent user message (resend via banner). */
interface ComposerEditState {
    messageIndex: number;
    entryId?: string;
    originalText: string;
}
let composerEdit: ComposerEditState | null = null;

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function updateQueuedMessageBanner(): void {
    const section = document.getElementById('queued-section') as HTMLDetailsElement | null;
    if (!section) return;

    if (state.queuedMessages.length === 0) {
        section.style.display = 'none';
        section.innerHTML = '';
        queuedEditingIndex = -1;
        return;
    }

    section.style.display = '';
    section.open = true;

    const count = state.queuedMessages.length;
    section.innerHTML = `
        <summary class="queued-summary">
            <span class="queued-chevron">&#9656;</span>
            <span class="queued-count">${count} Queued</span>
        </summary>
        <div class="queued-list">
            ${state.queuedMessages.map((msg, i) => {
                if (i === queuedEditingIndex) {
                    return `<div class="queued-item queued-item-editing" data-index="${i}">
                        <span class="queued-item-icon">&#9675;</span>
                        <input class="queued-edit-input" data-index="${i}" type="text" value="${escAttr(msg)}">
                        <button class="queued-edit-save" data-index="${i}" title="Save">&#10003;</button>
                        <button class="queued-edit-cancel" data-index="${i}" title="Cancel">&#10005;</button>
                    </div>`;
                }
                return `<div class="queued-item" data-index="${i}">
                    <span class="queued-item-icon">&#9675;</span>
                    <span class="queued-item-text">${escHtml(msg)}</span>
                    <span class="queued-item-actions">
                        <button class="queued-item-btn queued-item-edit" data-index="${i}" title="Edit"><img class="queued-btn-icon" src="${iconsBaseUri}/pencil.svg" alt="edit"></button>
                        <button class="queued-item-btn queued-item-delete" data-index="${i}" title="Remove"><img class="queued-btn-icon" src="${iconsBaseUri}/trash.svg" alt="remove"></button>
                    </span>
                </div>`;
            }).join('')}
        </div>
    `;

    bindQueuedItemEvents(section);
}

function bindQueuedItemEvents(section: HTMLElement): void {
    section.querySelectorAll('.queued-item-delete').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                if (queuedEditingIndex === idx) queuedEditingIndex = -1;
                else if (queuedEditingIndex > idx) queuedEditingIndex--;
                vscode.postMessage({ type: 'removeQueuedMessage', index: idx });
            }
        });
    });

    section.querySelectorAll('.queued-item-edit').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                queuedEditingIndex = idx;
                updateQueuedMessageBanner();
                const input = section.querySelector(`.queued-edit-input[data-index="${idx}"]`) as HTMLInputElement | null;
                if (input) {
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            }
        });
    });

    section.querySelectorAll('.queued-edit-save').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            const input = section.querySelector(`.queued-edit-input[data-index="${idx}"]`) as HTMLInputElement | null;
            if (idx >= 0 && input && input.value.trim()) {
                queuedEditingIndex = -1;
                vscode.postMessage({ type: 'editQueuedMessage', index: idx, text: input.value.trim() });
            }
        });
    });

    section.querySelectorAll('.queued-edit-cancel').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            queuedEditingIndex = -1;
            updateQueuedMessageBanner();
        });
    });

    section.querySelectorAll('.queued-edit-input').forEach((input) => {
        input.addEventListener('keydown', (e) => {
            const ke = e as KeyboardEvent;
            const idx = parseInt((input as HTMLElement).dataset.index ?? '-1', 10);
            if (ke.key === 'Enter') {
                ke.preventDefault();
                const val = (input as HTMLInputElement).value.trim();
                if (idx >= 0 && val) {
                    queuedEditingIndex = -1;
                    vscode.postMessage({ type: 'editQueuedMessage', index: idx, text: val });
                }
            }
            if (ke.key === 'Escape') {
                ke.preventDefault();
                queuedEditingIndex = -1;
                updateQueuedMessageBanner();
            }
        });
    });
}

function updatePendingMessagesInChat(): void {
    const container = document.getElementById('pending-messages');
    if (!container) {
        return;
    }

    const steering = state.steeringMessages ?? [];
    const followUp = state.followUpMessages ?? [];
    if (steering.length === 0 && followUp.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
    }

    container.style.display = '';
    const rows: string[] = [];
    for (const text of steering) {
        rows.push(
            `<div class="pending-message pending-message--steer">
                <span class="pending-message-indicator" aria-hidden="true"></span>
                <span class="pending-message-label">Steering</span>
                <span class="pending-message-text">${escHtml(text)}</span>
            </div>`,
        );
    }
    for (const text of followUp) {
        rows.push(
            `<div class="pending-message pending-message--followup">
                <span class="pending-message-indicator" aria-hidden="true"></span>
                <span class="pending-message-label">Follow-up</span>
                <span class="pending-message-text">${escHtml(text)}</span>
            </div>`,
        );
    }
    container.innerHTML = rows.join('');
    if (!userHasScrolled) {
        scrollToBottom();
    }
}

function buildWelcome(): HTMLElement {
    const w = el('div', 'welcome');
    w.innerHTML = `
        <div class="welcome-icon">&pi;</div>
        <div class="welcome-title">vs-pi-agent</div>
        <div class="welcome-subtitle">Ask anything. Pi can read, write, and execute code for you.</div>
        <div class="welcome-hints">
            <div class="welcome-hint">Type a message to start</div>
            <div class="welcome-hint"><kbd>Ctrl+Shift+L</kbd> Focus chat</div>
            <div class="welcome-hint"><kbd>Ctrl+Shift+N</kbd> New session</div>
            <div class="welcome-hint"><kbd>Enter</kbd> Send · while running, <kbd>Enter</kbd> queue · ↑ interrupt</div>
        </div>
    `;
    return w;
}

// ── Changed Files section ──

function getFileIcon(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const icons: Record<string, string> = {
        ts: '&#128312;', tsx: '&#128312;',
        js: '&#128313;', jsx: '&#128313;',
        json: '&#128312;',
        css: '&#128309;', scss: '&#128309;',
        html: '&#128992;',
        md: '&#128310;',
        py: '&#128311;',
        svg: '&#128993;',
    };
    return icons[ext] ?? '&#128196;';
}

function buildChangedFilesSection(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'changed-files-section';
    details.id = 'changed-files-bar';

    const fileMap = new Map<string, FileChangeInfo>();
    for (const c of state.fileChanges) {
        fileMap.set(c.filePath, c);
    }
    const uniqueFiles = [...fileMap.values()];
    const count = uniqueFiles.length;

    const summary = document.createElement('summary');
    summary.className = 'changed-files-summary';
    const undoRedoBtn = state.rollbackPoint !== null
        ? `<button class="changed-files-link" id="btn-redo" title="Redo changes">Redo</button>`
        : `<button class="changed-files-link" id="btn-undo" title="Undo last change">Undo</button>`;
    summary.innerHTML = `
        <span class="changed-files-arrow">&#9656;</span>
        <span class="changed-files-count">${count} File${count !== 1 ? 's' : ''}</span>
        <span class="changed-files-spacer"></span>
        ${undoRedoBtn}
        <button class="changed-files-review-btn" id="btn-review-all" title="Review all changes">Review</button>
    `;
    details.appendChild(summary);

    const list = el('div', 'changed-files-list');
    for (const change of uniqueFiles) {
        const fileName = change.filePath.split('/').pop() ?? change.filePath;
        const item = el('div', 'changed-file-item');
        item.dataset.filepath = change.filePath;
        item.dataset.toolcallid = change.toolCallId;

        let statsHtml = '';
        if (change.addedLines > 0) statsHtml += `<span class="cf-stat-add">+${change.addedLines}</span>`;
        if (change.removedLines > 0) statsHtml += `<span class="cf-stat-del">-${change.removedLines}</span>`;

        item.innerHTML = `
            <span class="cf-icon">${getFileIcon(change.filePath)}</span>
            <span class="cf-name">${escHtml(fileName)}</span>
            <span class="cf-stats">${statsHtml}</span>
        `;
        list.appendChild(item);
    }
    details.appendChild(list);

    return details;
}

function updateChangedFiles(): void {
    const container = document.querySelector('.input-container');
    if (!container) return;

    const existing = document.getElementById('changed-files-bar') as HTMLDetailsElement | null;
    const wasOpen = existing?.open ?? false;

    if (state.fileChanges.length === 0) {
        existing?.remove();
        return;
    }

    const newSection = buildChangedFilesSection();
    if (wasOpen) {
        (newSection as HTMLDetailsElement).open = true;
    }

    if (existing) {
        existing.replaceWith(newSection);
    } else {
        container.insertBefore(newSection, container.firstChild);
    }

    bindChangedFileItems();

    const undoBtn = document.getElementById('btn-undo');
    undoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        let lastUserTurn = 0;
        for (const msg of state.messages) {
            if ((msg.role ?? 'unknown') === 'user') lastUserTurn++;
        }
        if (lastUserTurn < 1) return;
        vscode.postMessage({
            type: 'confirmAction',
            action: 'restoreCheckpoint',
            message: 'Undo changes from the last turn?',
            payload: { messageIndex: lastUserTurn - 1 },
        });
    });

    const redoBtn = document.getElementById('btn-redo');
    redoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        vscode.postMessage({
            type: 'confirmAction',
            action: 'redoCheckpoint',
            message: 'Re-apply the rolled-back changes?',
        });
    });

    const reviewBtn = document.getElementById('btn-review-all');
    reviewBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const seen = new Set<string>();
        for (const change of state.fileChanges) {
            if (!seen.has(change.filePath)) {
                seen.add(change.filePath);
                vscode.postMessage({ type: 'openDiff', filePath: change.filePath, toolCallId: change.toolCallId });
            }
        }
    });
}

function renderChangedFilesBar(): void {
    const existing = document.getElementById('changed-files-bar');
    if (existing) {
        const fileMap = new Map<string, FileChangeInfo>();
        for (const c of state.fileChanges) {
            fileMap.set(c.filePath, c);
        }
        const count = fileMap.size;
        const countEl = existing.querySelector('.changed-files-count');
        if (countEl) {
            countEl.textContent = `${count} File${count !== 1 ? 's' : ''}`;
        }
    }
}

function renderInlineFileChange(change: FileChangeInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    const existing = document.getElementById(`diff-${change.toolCallId}`);
    if (existing) return;

    const card = buildDiffCard(change);

    const loadingCard = document.getElementById(`tool-${change.toolCallId}`);
    if (loadingCard) {
        loadingCard.replaceWith(card);
    } else {
        container.appendChild(card);
    }

    bindDiffButtons();
    scrollIfFollowing();
}

// ── Inline diff card ──

function buildDiffCard(change: FileChangeInfo, msg?: any): HTMLElement {
    const wrapper = el('div', 'tool-card-wrapper');

    const card = el('div', 'diff-card');
    card.id = `diff-${change.toolCallId}`;

    const fileName = change.filePath.split('/').pop() ?? change.filePath;
    const dirPath = change.filePath.split('/').slice(0, -1).join('/');

    let statsHtml = '';
    if (change.addedLines > 0 || change.removedLines > 0) {
        statsHtml = `<span class="diff-stats">`;
        if (change.addedLines > 0) statsHtml += `<span class="diff-stat-add">+${change.addedLines}</span>`;
        if (change.removedLines > 0) statsHtml += `<span class="diff-stat-del">-${change.removedLines}</span>`;
        statsHtml += `</span>`;
    }

    card.innerHTML = `
        <div class="diff-file-header" data-filepath="${escHtml(change.filePath)}" data-toolcallid="${escHtml(change.toolCallId)}">
            <span class="diff-file-icon">${change.isNew ? '&#10010;' : '&#9998;'}</span>
            <span class="diff-file-name">${escHtml(fileName)}</span>
            ${dirPath ? `<span class="diff-file-dir">${escHtml(dirPath)}</span>` : ''}
            ${statsHtml}
            ${change.isNew ? '<span class="diff-new-badge">NEW</span>' : ''}
        </div>
    `;

    if (change.diff) {
        const diffView = el('div', 'diff-view');
        diffView.innerHTML = renderDiffLines(change.diff);
        card.appendChild(diffView);
    }

    wrapper.appendChild(card);

    const ts = msg?.timestamp;
    if (ts) {
        const footer = el('div', 'tool-footer');
        footer.textContent = formatTimestamp(ts);
        wrapper.appendChild(footer);
    }

    return wrapper;
}

function renderDiffLines(diff: string): string {
    const lines = diff.split('\n');
    const htmlLines: string[] = [];

    for (const line of lines) {
        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            continue;
        }
        if (line.startsWith('@@')) {
            htmlLines.push(`<div class="diff-line diff-line-hunk">${escHtml(line)}</div>`);
        } else if (line.startsWith('+')) {
            htmlLines.push(`<div class="diff-line diff-line-add">${escHtml(line)}</div>`);
        } else if (line.startsWith('-')) {
            htmlLines.push(`<div class="diff-line diff-line-del">${escHtml(line)}</div>`);
        } else {
            htmlLines.push(`<div class="diff-line diff-line-ctx">${escHtml(line)}</div>`);
        }
    }

    return htmlLines.join('');
}

// ── Message rendering ──

function buildMessageAttachmentChips(
    files: { displayName: string; path: string }[],
): HTMLElement {
    const row = el('div', 'message-attachments');
    for (const f of files) {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderMessageAttachmentChip(
            f.displayName,
            f.path,
            isImageFilePath(f.path),
            escHtml,
            escAttr,
        );
        const chip = wrap.firstElementChild as HTMLElement;
        if (chip) {
            row.appendChild(chip);
        }
    }
    return row;
}

function bindAttachmentOpenClicks(): void {
    const postOpen = (filePath?: string) => {
        if (filePath?.trim()) {
            vscode.postMessage({ type: 'openFile', filePath: filePath.trim() });
        }
    };

    document
        .querySelectorAll('.message-attachment-chip[data-filepath]:not([data-open-bound])')
        .forEach((node) => {
            const el = node as HTMLElement;
            el.setAttribute('data-open-bound', '1');
            el.addEventListener('click', () => postOpen(el.dataset.filepath));
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    postOpen(el.dataset.filepath);
                }
            });
        });

    document.querySelectorAll('.attachment-chip[data-filepath]:not([data-open-bound])').forEach((node) => {
        const chip = node as HTMLElement;
        chip.setAttribute('data-open-bound', '1');
        const open = (e: Event) => {
            if ((e.target as HTMLElement).closest('.attachment-remove')) {
                return;
            }
            postOpen(chip.dataset.filepath);
        };
        chip.addEventListener('click', open);
        chip.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open(e);
            }
        });
    });

    document.querySelectorAll('.message-image[data-filepath]:not([data-open-bound])').forEach((node) => {
        const img = node as HTMLImageElement;
        img.setAttribute('data-open-bound', '1');
        img.addEventListener('click', () => postOpen(img.dataset.filepath));
    });
}

function resolveImageOpenPath(
    img: { name?: string },
    imagePathsByBase: Map<string, string>,
): string | undefined {
    let filePath = img.name?.trim();
    if (!filePath) {
        return undefined;
    }
    if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
        return filePath;
    }
    const base = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? filePath.toLowerCase();
    return imagePathsByBase.get(base) ?? imagePathsByBase.get(filePath.toLowerCase());
}

function showToast(message: string, variant: 'info' | 'error' = 'info'): void {
    let toast = document.getElementById('chat-toast');
    if (!toast) {
        toast = el('div', 'chat-toast');
        toast.id = 'chat-toast';
        document.getElementById('app')?.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `chat-toast chat-toast--${variant}`;
    toast.style.display = '';
    if (toastTimer) {
        clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
        toast!.style.display = 'none';
    }, 2200);
}

function copyPlainText(text: string): void {
    const t = text.trim();
    if (!t) {
        return;
    }
    void navigator.clipboard.writeText(t).then(() => {
        showToast('Copied to clipboard');
    });
}

function getUserMessagePlainForCopy(msg: any): string {
    const raw = extractText(msg);
    const { displayText } = parseUserMessageForDisplay(raw);
    return displayText || raw;
}

function getAssistantPlainForCopy(msg: any): string {
    let text = extractText(msg);
    if (text) {
        text = stripPlanContentForChatDisplay(text);
    }
    return text;
}

function findLastUserMessageIndex(): number {
    for (let i = state.messages.length - 1; i >= 0; i--) {
        if ((state.messages[i]?.role ?? '') === 'user') {
            return i;
        }
    }
    return -1;
}

function findPrecedingUserIndex(assistantIndex: number): number {
    for (let i = Math.min(assistantIndex, state.messages.length - 1); i >= 0; i--) {
        if ((state.messages[i]?.role ?? '') === 'user') {
            return i;
        }
    }
    return -1;
}

function loadLastUserMessageToComposer(): void {
    const idx = findLastUserMessageIndex();
    if (idx < 0) {
        return;
    }
    const msg = state.messages[idx];
    const text = getUserMessagePlainForCopy(msg);
    const entryId = typeof msg._forkEntryId === 'string' ? msg._forkEntryId : undefined;
    startComposerEdit(idx, text, entryId);
}

function startComposerEdit(messageIndex: number, text: string, entryId?: string): void {
    composerEdit = { messageIndex, entryId, originalText: text };
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (input) {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(text.length, text.length);
    }
    updateComposerEditBanner();
    updateInputArea();
}

function clearComposerEdit(): void {
    composerEdit = null;
    updateComposerEditBanner();
    updateInputArea();
}

function updateComposerEditBanner(): void {
    const banner = document.getElementById('composer-edit-banner');
    if (!banner) {
        return;
    }
    if (!composerEdit) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    banner.style.display = '';
    const hasFork = !!composerEdit.entryId;
    banner.innerHTML = `
        <span class="composer-edit-label">Editing · Enter = new · ⌘↵ = fork</span>
        <div class="composer-edit-actions">
            <button type="button" class="composer-edit-btn" data-send-mode="new" title="Send as new message (Enter)">Send as new</button>
            <button type="button" class="composer-edit-btn composer-edit-btn--fork" data-send-mode="fork" title="Fork from this point (⌘↵)" ${hasFork ? '' : 'disabled'}>Fork &amp; send</button>
            <button type="button" class="composer-edit-btn composer-edit-btn--ghost" data-cancel-edit>Cancel</button>
        </div>
    `;
    if (!hasFork) {
        banner.querySelector('[data-send-mode="fork"]')?.setAttribute(
            'title',
            'Fork unavailable for this message — use Send as new',
        );
    }
    banner.querySelectorAll('[data-send-mode]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const mode = (btn as HTMLElement).dataset.sendMode as 'new' | 'fork';
            if (mode) {
                submitComposerEdit(mode);
            }
        });
    });
    banner.querySelector('[data-cancel-edit]')?.addEventListener('click', (e) => {
        e.preventDefault();
        clearComposerEdit();
    });
}

function submitComposerEdit(mode: 'new' | 'fork'): void {
    if (!composerEdit) {
        return;
    }
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const text = input?.value.trim() ?? '';
    if (!text) {
        showToast('Message is empty', 'error');
        return;
    }
    const { messageIndex, entryId } = composerEdit;
    composerEdit = null;
    updateComposerEditBanner();
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }
    appendOptimisticUserMessage(text, 0);
    vscode.postMessage({
        type: 'resendUserMessage',
        messageIndex,
        text,
        mode,
        entryId,
    });
}

function postResendUserMessage(messageIndex: number, text: string, mode: 'new' | 'fork', entryId?: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
        return;
    }
    appendOptimisticUserMessage(trimmed, 0);
    vscode.postMessage({ type: 'resendUserMessage', messageIndex, text: trimmed, mode, entryId });
}

function postRegenerateAssistant(assistantMessageIndex: number, mode: 'new' | 'fork'): void {
    vscode.postMessage({ type: 'regenerateAssistant', assistantMessageIndex, mode });
}

function buildMessageActions(role: 'user' | 'assistant', index: number, msg: any): HTMLElement {
    const bar = el('div', 'message-actions');
    bar.dataset.msgIndex = String(index);
    bar.dataset.role = role;

    const copyBtn = el('button', 'msg-action');
    copyBtn.type = 'button';
    copyBtn.dataset.action = 'copy';
    copyBtn.title = 'Copy';
    copyBtn.textContent = '⎘';
    copyBtn.classList.add('msg-action--icon');

    bar.appendChild(copyBtn);

    if (role === 'user') {
        const editBtn = el('button', 'msg-action');
        editBtn.type = 'button';
        editBtn.dataset.action = 'edit';
        editBtn.title = 'Edit in composer';
        editBtn.innerHTML = `<img class="msg-action-icon" src="${iconsBaseUri}/pencil.svg" alt="">`;
        bar.appendChild(editBtn);

        const resendNew = el('button', 'msg-action');
        resendNew.type = 'button';
        resendNew.dataset.action = 'resend-new';
        resendNew.title = 'Send again (new message at end)';
        resendNew.textContent = 'Resend';
        bar.appendChild(resendNew);

        const resendFork = el('button', 'msg-action msg-action--fork');
        resendFork.type = 'button';
        resendFork.dataset.action = 'resend-fork';
        resendFork.title = 'Fork from here and send';
        resendFork.textContent = 'Fork';
        if (!msg._forkEntryId) {
            resendFork.disabled = true;
            resendFork.title = 'Fork unavailable — use Resend';
        }
        bar.appendChild(resendFork);
    } else {
        const regenNew = el('button', 'msg-action msg-action--icon');
        regenNew.type = 'button';
        regenNew.dataset.action = 'regenerate-new';
        regenNew.title = 'Regenerate response';
        regenNew.textContent = '↻';
        bar.appendChild(regenNew);
    }

    return bar;
}

function bindMessageActionButtons(): void {
    document.querySelectorAll('.message-actions:not([data-actions-bound])').forEach((bar) => {
        bar.setAttribute('data-actions-bound', '1');
        const index = parseInt((bar as HTMLElement).dataset.msgIndex ?? '-1', 10);
        const role = (bar as HTMLElement).dataset.role;
        if (index < 0) {
            return;
        }
        const msg = state.messages[index];
        if (!msg) {
            return;
        }

        bar.querySelectorAll('.msg-action').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const action = (btn as HTMLElement).dataset.action;
                if (action === 'copy') {
                    const text =
                        role === 'user' ? getUserMessagePlainForCopy(msg) : getAssistantPlainForCopy(msg);
                    copyPlainText(text);
                    return;
                }
                if (action === 'edit' && role === 'user') {
                    const text = getUserMessagePlainForCopy(msg);
                    const entryId =
                        typeof msg._forkEntryId === 'string' ? msg._forkEntryId : undefined;
                    startComposerEdit(index, text, entryId);
                    return;
                }
                if (action === 'resend-new' && role === 'user') {
                    const text = getUserMessagePlainForCopy(msg);
                    postResendUserMessage(index, text, 'new', msg._forkEntryId);
                    return;
                }
                if (action === 'resend-fork' && role === 'user') {
                    const text = getUserMessagePlainForCopy(msg);
                    const entryId =
                        typeof msg._forkEntryId === 'string' ? msg._forkEntryId : undefined;
                    if (!entryId) {
                        showToast('Fork unavailable for this message', 'error');
                        return;
                    }
                    postResendUserMessage(index, text, 'fork', entryId);
                    return;
                }
                if (action === 'regenerate-new' && role === 'assistant') {
                    postRegenerateAssistant(index, 'new');
                    return;
                }
            });
        });
    });
}

type RenderMessageOptions = {
    /** Hide per-message Thought rows (turn-level merge handles thinking). */
    suppressThinking?: boolean;
};

function renderMessage(
    msg: any,
    index: number,
    turnNumber?: number,
    options?: RenderMessageOptions,
): HTMLElement {
    const role = msg.role ?? 'unknown';

    if (role === 'toolResult' || role === 'tool') {
        const toolName = msg.toolName ?? '';
        if (toolName === 'edit' || toolName === 'write') {
            const matchingChange = findFileChangeForToolResult(msg);
            if (matchingChange) {
                return buildDiffCard(matchingChange, msg);
            }
        }
        return buildToolResultCard(msg, state.messages, index);
    }

    if (role === 'user') {
        const group = el('div', 'message-group-user');
        const card = el('div', 'user-prompt-card');
        card.appendChild(buildMessageActions('user', index, msg));

        const wrapper = el('div', `message message-${role}`);
        if (turnNumber !== undefined && !state.isStreaming) {
            const checkpointBtn = el('button', 'checkpoint-btn');
            checkpointBtn.title = 'Restore to this checkpoint';
            checkpointBtn.dataset.turn = String(turnNumber);
            checkpointBtn.innerHTML = '&#8634;';
            wrapper.appendChild(checkpointBtn);
        }
        const rawText = extractText(msg);
        const { displayText, fileAttachments: parsedFiles } = parseUserMessageForDisplay(rawText);
        if (displayText) {
            const content = el('div', 'message-content');
            content.innerHTML = renderMarkdown(displayText);
            wrapper.appendChild(content);
        }
        const fileAttachments = [...parsedFiles];
        const imagePathsByBase = new Map<string, string>();
        for (const f of fileAttachments) {
            if (isImageFilePath(f.path)) {
                imagePathsByBase.set(f.displayName.toLowerCase(), f.path);
            }
        }

        for (const img of extractImages(msg)) {
            const openPath = resolveImageOpenPath(img, imagePathsByBase);
            if (!openPath) {
                continue;
            }
            const displayName = openPath.split(/[/\\]/).pop() || 'image';
            if (!fileAttachments.some((f) => f.path.toLowerCase() === openPath.toLowerCase())) {
                fileAttachments.push({ displayName, path: openPath });
            }
        }

        if (fileAttachments.length > 0) {
            wrapper.appendChild(buildMessageAttachmentChips(fileAttachments));
        }
        card.appendChild(wrapper);
        group.appendChild(card);

        const footer = buildMessageFooter(msg, index);
        if (footer) {
            group.appendChild(footer);
        }

        return group;
    }

    // Assistant messages: wrap in a styled container
    const group = el('div', 'message-group-assistant');
    const wrapper = el('div', `message message-${role}`);
    let hasVisibleAssistantContent = false;

    if (Array.isArray(msg.content)) {
        const thinkingMerged = extractThinking(msg).trim();
        if (!options?.suppressThinking && thinkingMerged) {
            wrapper.appendChild(
                buildThinkingBlock(thinkingMerged, false, msg._thinkingDurationSec, `${index}:0`),
            );
            hasVisibleAssistantContent = true;
        }
        for (let i = 0; i < msg.content.length; i++) {
            const block = msg.content[i];
            if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
                continue;
            } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                let blockText = stripPlanContentForChatDisplay(block.text);
                if (blockText.trim()) {
                    const content = el('div', 'message-content');
                    content.innerHTML = renderMarkdown(blockText);
                    wrapper.appendChild(content);
                    hasVisibleAssistantContent = true;
                }
            }
        }
    } else {
        const thinking = extractThinking(msg);
        let text = extractText(msg);
        if (text) {
            text = stripPlanContentForChatDisplay(text);
        }
        if (!options?.suppressThinking && thinking.trim()) {
            wrapper.appendChild(
                buildThinkingBlock(thinking, false, msg._thinkingDurationSec, `${index}:0`),
            );
            hasVisibleAssistantContent = true;
        }
        if (text) {
            const content = el('div', 'message-content');
            content.innerHTML = renderMarkdown(text);
            wrapper.appendChild(content);
            hasVisibleAssistantContent = true;
        }
    }

    const isAssistantError = role === 'assistant' && msg.stopReason === 'error';
    const errorText =
        isAssistantError &&
        typeof msg.errorMessage === 'string' &&
        msg.errorMessage.trim()
            ? msg.errorMessage.trim()
            : '';

    if (!hasVisibleAssistantContent && !errorText) {
        const empty = el('div');
        empty.style.display = 'none';
        return empty;
    }

    if (errorText) {
        const errBlock = el('div', 'message-error');
        errBlock.textContent = errorText;
        wrapper.appendChild(errBlock);
    }

    group.appendChild(wrapper);
    group.appendChild(buildMessageActions('assistant', index, msg));

    const footer = buildMessageFooter(msg, index);
    if (footer) {
        group.appendChild(footer);
    }

    return group;
}

function extractToolCalls(msg: any): any[] {
    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) return msg.toolCalls;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return msg.tool_calls;
    if (Array.isArray(msg.content)) {
        const tcs = msg.content.filter((c: any) => c.type === 'toolCall' || c.type === 'tool_call' || c.type === 'tool_use');
        if (tcs.length > 0) return tcs;
    }
    return [];
}

function findFileChangeForToolResult(msg: any): FileChangeInfo | undefined {
    const id = msg.toolCallId ?? msg.tool_call_id;
    if (id) {
        const match = state.fileChanges.find(c => c.toolCallId === id);
        if (match) return match;
    }
    return undefined;
}

function ensureStreamingMessageShell(container: HTMLElement): void {
    if (container.querySelector('.message.message-assistant')) {
        return;
    }
    const msg = el('div', 'message message-assistant');
    msg.innerHTML = `
        <details class="thinking-block" id="streaming-thinking">
            <summary class="thinking-summary">
                <span class="thinking-indicator"></span>
                <span class="thinking-label">Thinking…</span>
                <span class="thinking-chevron">&#9656;</span>
            </summary>
            <div class="thinking-content"></div>
        </details>
        <div class="message-content" id="streaming-text"></div>
    `;
    const firstTool = container.querySelector(
        '.tool-card, .tool-card-wrapper, .diff-card, .tool-approval-card',
    );
    if (firstTool) {
        container.insertBefore(msg, firstTool);
    } else {
        const activity = document.getElementById('stream-activity');
        if (activity) {
            activity.insertAdjacentElement('afterend', msg);
        } else {
            container.prepend(msg);
        }
    }
    const created = document.getElementById('streaming-thinking') as HTMLDetailsElement | null;
    created?.addEventListener('toggle', () => {
        streamingThinkingUserOpen = created.open;
    });
}

function renderStreamingContent(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    const streamingThinkingText = state.streamingThinking.trim();
    const showThinkingBlock = streamingThinkingBlockVisible();
    const showText = Boolean(state.streamingText);

    if (!showThinkingBlock && !showText) {
        return;
    }

    ensureStreamingMessageShell(container);

    const thinkingEl = document.getElementById('streaming-thinking') as HTMLDetailsElement | null;
    if (thinkingEl) {
        thinkingEl.style.display = showThinkingBlock ? '' : 'none';
        if (showThinkingBlock) {
            const contentEl = thinkingEl.querySelector('.thinking-content');
            if (contentEl) {
                if (streamingThinkingText) {
                    contentEl.innerHTML = renderMarkdown(streamingThinkingText);
                } else {
                    contentEl.innerHTML =
                        '<p class="thinking-placeholder">Reasoning in progress…</p>';
                }
            }
            const labelEl = thinkingEl.querySelector('.thinking-label');
            if (state.isThinking) {
                thinkingEl.classList.add('active');
                if (labelEl) labelEl.textContent = 'Thinking…';
            } else {
                thinkingEl.classList.remove('active');
                if (labelEl) {
                    const dur = state.streamingThinkingDuration;
                    labelEl.textContent =
                        dur > 0
                            ? `Thought for ${dur} second${dur !== 1 ? 's' : ''}`
                            : 'Thought';
                }
            }
            if (streamingThinkingUserOpen) {
                thinkingEl.open = true;
            }
        }
    }

    const textEl = document.getElementById('streaming-text');
    if (textEl) {
        textEl.style.display = showText ? '' : 'none';
        if (showText) {
            if (state.isStreaming) {
                textEl.textContent = state.streamingText;
            } else {
                textEl.innerHTML = renderMarkdown(state.streamingText);
            }
        }
    }

    bindCopyButtons();
    scrollIfFollowing();
}

// ── Tool rendering ──

function getToolIcon(name: string): string {
    const iconFiles: Record<string, string> = {
        bash: 'terminal.svg',
        python: 'code.svg',
        read: 'text.svg',
        write: 'pencil.svg',
        edit: 'pencil.svg',
        glob: 'magnifying-glass.svg',
        grep: 'magnifying-glass.svg',
        list: 'folder.svg',
    };
    const file = iconFiles[name.toLowerCase()] ?? 'bolt.svg';
    return `<img class="tool-icon-img" src="${iconsBaseUri}/${file}" alt="${escHtml(name)}">`;
}

function getToolLabel(name: string, args: any): string {
    switch (name.toLowerCase()) {
        case 'bash':
            return args?.command ? truncate(args.command, 60) : 'Execute command';
        case 'read':
            return args?.path ? `Read ${truncate(args.path, 50)}` : 'Read file';
        case 'write':
            return args?.path ? `Write ${truncate(args.path, 50)}` : 'Write file';
        case 'edit':
            return args?.path ? `Edit ${truncate(args.path, 50)}` : 'Edit file';
        case 'glob':
            return args?.pattern ? `Glob ${truncate(args.pattern, 50)}` : 'Find files';
        case 'grep':
            return args?.pattern ? `Grep ${truncate(args.pattern, 50)}` : 'Search files';
        default:
            return name;
    }
}

function extractToolResultText(result: any): string {
    if (result === undefined || result === null) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
        return result
            .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof result === 'object') {
        if (Array.isArray(result.content)) {
            const text = result.content
                .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
                .filter(Boolean)
                .join('\n');
            if (text) return text;
        }
        if (result.text) return result.text;
        if (result.output) return result.output;
    }
    return JSON.stringify(result, null, 2);
}

function formatToolArgs(args: any): string {
    if (!args || typeof args !== 'object') return '';
    const entries = Object.entries(args);
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}: ${val}`;
    }).join('\n');
}

function buildStatusHtml(status: string): string {
    if (status === 'done') return '';
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    return `<span class="tool-status ${status}">${label}</span>`;
}

function buildToolCard(tc: any): HTMLElement {
    const card = el('div', 'tool-card');
    const name = tc.name ?? tc.toolName ?? tc.function?.name ?? 'unknown';
    const args = tc.args ?? tc.arguments ?? tc.input ?? tc.function?.arguments;
    const parsedArgs = typeof args === 'string' ? tryParseJSON(args) : args;
    const statusClass = tc._status ?? 'pending';

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(name)}</span>
            <span class="tool-name">${escHtml(getToolLabel(name, parsedArgs))}</span>
            ${buildStatusHtml(statusClass)}
        </div>
    `;

    if (tc._result !== undefined) {
        const text = extractToolResultText(tc._result);
        if (text) {
            const result = el('pre', 'tool-result');
            result.textContent = text;
            card.appendChild(result);
        }
    }

    return card;
}

function buildToolFooter(msg: any, allMessages: any[], msgIndex: number): HTMLElement | null {
    const parts: string[] = [];
    const ts = msg.timestamp;
    if (ts) parts.push(formatTimestamp(ts));

    const precedingAssistant = findPrecedingAssistant(allMessages, msgIndex);
    if (precedingAssistant?.usage) {
        const u = precedingAssistant.usage;
        if (u.input > 0) parts.push(`${u.input.toLocaleString()} in`);
        if (u.output > 0) parts.push(`${u.output.toLocaleString()} out`);
    }

    if (parts.length === 0) return null;
    const footer = el('div', 'tool-footer');
    footer.textContent = parts.join(' · ');
    return footer;
}

function findPrecedingAssistant(messages: any[], beforeIndex: number): any | null {
    for (let i = beforeIndex - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return messages[i];
        if (messages[i].role === 'user') return null;
    }
    return null;
}

function buildToolResultCard(msg: any, allMessages: any[], msgIndex: number): HTMLElement {
    const isError = msg.isError ?? false;
    const toolName = msg.toolName ?? '';
    const toolCallId = msg.toolCallId ?? '';
    const nameLower = toolName.toLowerCase();

    const matchingCall = findToolCallInMessages(allMessages, msgIndex, toolCallId);
    const args = matchingCall?.arguments ?? matchingCall?.args ?? matchingCall?.input ?? {};
    const parsedArgs = typeof args === 'string' ? tryParseJSON(args) : args;
    const label = toolName ? getToolLabel(toolName, parsedArgs) : 'Tool Result';
    const icon = getToolIcon(toolName ?? '');
    const isBash = nameLower === 'bash';
    const isRead = nameLower === 'read';
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';

    const resultContent = extractText(msg);
    const hasBody = !!(resultContent || isBash) && !isRead;

    const footer = buildToolFooter(msg, allMessages, msgIndex);

    if (hasBody) {
        const wrapper = el('div', 'tool-card-wrapper');

        const details = document.createElement('details');
        details.className = 'tool-card tool-expandable';

        details.innerHTML = `
            <summary class="tool-header">
                <span class="tool-icon">${icon}</span>
                <span class="tool-name">${escHtml(label)}</span>
                ${buildStatusHtml(isError ? 'error' : 'done')}
                <span class="tool-expand-arrow">&#9656;</span>
            </summary>
        `;

        const body = el('div', 'tool-body');
        const result = el('pre', 'tool-result');
        result.textContent = resultContent || '(no output)';
        if (!resultContent) result.classList.add('empty');
        body.appendChild(result);
        details.appendChild(body);
        wrapper.appendChild(details);

        if (footer) wrapper.appendChild(footer);
        return wrapper;
    }

    const wrapper = el('div', 'tool-card-wrapper');

    const card = el('div', `tool-card${isRead ? ' tool-clickable' : ''}`);
    if (isRead && filePath) card.dataset.filepath = filePath;

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${icon}</span>
            <span class="tool-name">${escHtml(label)}</span>
            ${buildStatusHtml(isError ? 'error' : 'done')}
        </div>
    `;

    wrapper.appendChild(card);
    if (footer) wrapper.appendChild(footer);
    return wrapper;
}

function findToolCallInMessages(messages: any[], beforeIndex: number, toolCallId: string): any | undefined {
    if (!toolCallId) return undefined;
    for (let i = beforeIndex - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        const tcs = extractToolCalls(m);
        for (const tc of tcs) {
            if ((tc.id ?? tc.toolCallId) === toolCallId) return tc;
        }
    }
    return undefined;
}

const toolsOpenByKey = new Map<string, boolean>();

function captureToolsOpenState(): void {
    document.querySelectorAll('details.tools-block[data-tools-key]').forEach((node) => {
        const el = node as HTMLDetailsElement;
        const key = el.dataset.toolsKey;
        if (key) {
            toolsOpenByKey.set(key, el.open);
        }
    });
}

function clearStreamingToolArtifacts(): void {
    const container = document.getElementById('streaming-message');
    if (!container) {
        return;
    }
    container
        .querySelectorAll(
            '.tool-card, .tool-card-wrapper, .tool-expandable, .diff-card, .tool-approval-card',
        )
        .forEach((node) => node.remove());
}

function buildMergedToolRow(msg: any, msgIndex: number, allMessages: any[]): HTMLElement {
    const isError = msg.isError ?? false;
    const toolName = msg.toolName ?? '';
    const toolCallId = msg.toolCallId ?? '';
    const nameLower = toolName.toLowerCase();

    const matchingCall = findToolCallInMessages(allMessages, msgIndex, toolCallId);
    const args = matchingCall?.arguments ?? matchingCall?.args ?? matchingCall?.input ?? {};
    const parsedArgs = typeof args === 'string' ? tryParseJSON(args) : args;
    const label = toolName ? getToolLabel(toolName, parsedArgs) : 'Tool Result';
    const icon = getToolIcon(toolName ?? '');
    const isBash = nameLower === 'bash';
    const isRead = nameLower === 'read';
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';

    const resultContent = extractText(msg);
    const hasBody = !!(resultContent || isBash) && !isRead;

    if (hasBody) {
        const details = document.createElement('details');
        details.className = 'tools-item tools-item-expandable';

        details.innerHTML = `
            <summary class="tool-header">
                <span class="tool-icon">${icon}</span>
                <span class="tool-name">${escHtml(label)}</span>
                ${buildStatusHtml(isError ? 'error' : 'done')}
                <span class="tool-expand-arrow">&#9656;</span>
            </summary>
        `;

        const body = el('div', 'tool-body');
        const result = el('pre', 'tool-result');
        result.textContent = resultContent || '(no output)';
        if (!resultContent) {
            result.classList.add('empty');
        }
        body.appendChild(result);
        details.appendChild(body);
        return details;
    }

    const row = el('div', `tools-item tool-card${isRead ? ' tool-clickable' : ''}`);
    if (isRead && filePath) {
        row.dataset.filepath = filePath;
    }
    row.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${icon}</span>
            <span class="tool-name">${escHtml(label)}</span>
            ${buildStatusHtml(isError ? 'error' : 'done')}
        </div>
    `;
    return row;
}

function buildMergedToolsBlock(
    items: Array<{ msg: any; index: number }>,
    allMessages: any[],
    turnUserMsgCount: number,
): HTMLElement {
    const details = document.createElement('details');
    details.className = 'tools-block';
    const toolsKey = `turn:${turnUserMsgCount}`;
    details.dataset.toolsKey = toolsKey;
    if (toolsOpenByKey.has(toolsKey)) {
        details.open = toolsOpenByKey.get(toolsKey)!;
    }

    const count = items.length;
    const summary = document.createElement('summary');
    summary.className = 'tools-summary';
    summary.innerHTML = `
        <span class="tools-indicator"></span>
        <span class="tools-label">Used ${count} tool${count !== 1 ? 's' : ''}</span>
        <span class="tools-chevron">&#9656;</span>
    `;

    const list = el('div', 'tools-list');
    for (const item of items) {
        list.appendChild(buildMergedToolRow(item.msg, item.index, allMessages));
    }

    details.appendChild(summary);
    details.appendChild(list);
    details.addEventListener('toggle', () => {
        toolsOpenByKey.set(toolsKey, details.open);
    });
    return details;
}

function renderToolStart(event: any): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if ((event.toolName ?? '').toLowerCase() === 'todo') {
        return;
    }

    // Simple tools: status bar only — avoid stacking dozens of rows during streaming.
    const nameLower = (event.toolName ?? '').toLowerCase();
    if (nameLower !== 'edit' && nameLower !== 'write') {
        return;
    }

    if ((event.toolName === 'edit' || event.toolName === 'write') && event.args?.path) {
        const card = el('div', 'diff-card loading');
        card.id = `tool-${event.toolCallId}`;
        const fileName = (event.args.path as string).split('/').pop() ?? event.args.path;
        card.innerHTML = `
            <div class="diff-file-header">
                <span class="diff-file-icon">&#9998;</span>
                <span class="diff-file-name">${escHtml(fileName)}</span>
                <span class="tool-status running">running</span>
            </div>
        `;
        container.appendChild(card);
        scrollIfFollowing();
    }
}

function renderToolUpdate(event: any): void {
    const card = document.getElementById(`tool-${event.toolCallId}`);
    if (!card) return;
    if (card.classList.contains('diff-card')) return;
    const text = extractToolResultText(event.partialResult);
    if (!text) return;
    let resultEl = card.querySelector('.tool-result') as HTMLElement | null;
    if (!resultEl) {
        resultEl = el('pre', 'tool-result');
        card.appendChild(resultEl);
    }
    resultEl.textContent = text;
    scrollIfFollowing();
}

function renderToolEnd(event: any): void {
    const card = document.getElementById(`tool-${event.toolCallId}`);
    if (!card) return;

    if (card.classList.contains('diff-card')) {
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            statusEl.textContent = event.isError ? 'error' : 'done';
            statusEl.className = `tool-status ${event.isError ? 'error' : 'done'}`;
        }
        return;
    }

    const toolName = (card as HTMLElement).dataset.toolName ?? '';
    const text = extractToolResultText(event.result);
    const isBash = toolName.toLowerCase() === 'bash';
    const hasBody = !!(text || isBash);

    if (hasBody) {
        const details = document.createElement('details');
        details.className = card.className.replace('tool-card', 'tool-card tool-expandable');
        details.id = card.id;
        details.dataset.toolName = toolName;
        if (card.dataset.filepath) details.dataset.filepath = card.dataset.filepath;

        const headerEl = card.querySelector('.tool-header');
        const nameHtml = headerEl?.innerHTML ?? '';

        details.innerHTML = `<summary class="tool-header">${nameHtml}</summary>`;

        const statusEl = details.querySelector('.tool-status');
        if (statusEl) {
            if (event.isError) {
                statusEl.textContent = 'error';
                statusEl.className = 'tool-status error';
            } else {
                statusEl.remove();
            }
        }

        const arrow = el('span', 'tool-expand-arrow');
        arrow.innerHTML = '&#9656;';
        details.querySelector('summary')?.appendChild(arrow);

        const body = el('div', 'tool-body');
        const resultEl = el('pre', 'tool-result');
        resultEl.textContent = text || '(no output)';
        if (!text) resultEl.classList.add('empty');
        body.appendChild(resultEl);
        details.appendChild(body);

        card.replaceWith(details);
        bindToolClickable();
    } else {
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            if (event.isError) {
                statusEl.textContent = 'error';
                statusEl.className = 'tool-status error';
            } else {
                statusEl.remove();
            }
        }
    }
}

// ── Tool approval cards ──

function renderToolApprovalCard(pending: ToolCallPendingInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    const existing = document.getElementById(`approval-${pending.toolCallId}`);
    if (existing) return;

    const card = el('div', 'tool-approval-card');
    card.id = `approval-${pending.toolCallId}`;

    const parsedArgs = typeof pending.args === 'string' ? tryParseJSON(pending.args) : pending.args;
    const label = getToolLabel(pending.toolName, parsedArgs);

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(pending.toolName)}</span>
            <span class="tool-name">${escHtml(label)}</span>
            <span class="tool-status pending">awaiting approval</span>
        </div>
        <div class="approval-args">${escHtml(formatToolArgs(parsedArgs))}</div>
        <div class="approval-actions">
            <button class="approval-btn approve" data-toolcallid="${escHtml(pending.toolCallId)}">Approve</button>
            <button class="approval-btn reject" data-toolcallid="${escHtml(pending.toolCallId)}">Reject</button>
        </div>
    `;

    container.appendChild(card);
    bindApprovalButtons();
    scrollIfFollowing();
}

function removeToolApprovalCard(toolCallId: string): void {
    document.getElementById(`approval-${toolCallId}`)?.remove();
}

function bindApprovalButtons(): void {
    document.querySelectorAll('.approval-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const toolCallId = (btn as HTMLElement).dataset.toolcallid;
            if (!toolCallId) return;
            if (btn.classList.contains('approve')) {
                vscode.postMessage({ type: 'approveToolCall', toolCallId });
            } else {
                vscode.postMessage({ type: 'rejectToolCall', toolCallId });
            }
            removeToolApprovalCard(toolCallId);
        });
    });
}

// ── Thinking block ──

const thinkingOpenByKey = new Map<string, boolean>();

function captureThinkingOpenState(): void {
    document.querySelectorAll('details.thinking-block[data-think-key]').forEach((node) => {
        const el = node as HTMLDetailsElement;
        const key = el.dataset.thinkKey;
        if (key) {
            thinkingOpenByKey.set(key, el.open);
        }
    });
}

function thinkingBlockText(block: any): string {
    if (!block || typeof block !== 'object') {
        return '';
    }
    if (block.type === 'redacted_thinking') {
        return typeof block.data === 'string' && block.data.trim()
            ? block.data
            : '[Thinking redacted by provider]';
    }
    if (block.type === 'thinking') {
        return block.thinking ?? block.text ?? '';
    }
    return '';
}

function syncThinkingFromAssistantMessage(msg: any): void {
    if (msg?.role !== 'assistant') {
        return;
    }
    const fromMsg = extractThinking(msg);
    if (fromMsg.length > state.streamingThinking.length) {
        state.streamingThinking = fromMsg;
    }
}

function assistantMessageAlreadyShowsThinking(streamingText: string): boolean {
    if (!streamingText || state.isStreaming) {
        return false;
    }
    for (let i = state.messages.length - 1; i >= 0; i--) {
        const msg = state.messages[i];
        if (msg?.role !== 'assistant') {
            continue;
        }
        const existing = extractThinking(msg).trim();
        if (!existing) {
            continue;
        }
        if (existing === streamingText || existing.includes(streamingText)) {
            return true;
        }
        return false;
    }
    return false;
}

function prependMergedTurnThinking(
    turnBody: HTMLElement,
    parts: string[],
    durationSec: number,
    thinkKey: string,
): void {
    const merged = parts.map((p) => p.trim()).filter(Boolean).join('\n\n');
    if (!merged) {
        return;
    }
    turnBody
        .querySelector(`details.thinking-block[data-think-key="${thinkKey}"]`)
        ?.remove();
    turnBody.insertBefore(
        buildThinkingBlock(merged, false, durationSec > 0 ? durationSec : undefined, thinkKey),
        turnBody.firstChild,
    );
}

function buildThinkingBlock(
    text: string,
    active: boolean,
    durationSec?: number,
    thinkKey?: string,
): HTMLElement {
    const details = document.createElement('details');
    details.className = `thinking-block${active ? ' active' : ''}`;
    if (thinkKey) {
        details.dataset.thinkKey = thinkKey;
        if (thinkingOpenByKey.has(thinkKey)) {
            details.open = thinkingOpenByKey.get(thinkKey)!;
        }
    }

    let label: string;
    if (active) {
        label = 'Thinking…';
    } else if (durationSec && durationSec > 0) {
        label = `Thought for ${durationSec} second${durationSec !== 1 ? 's' : ''}`;
    } else {
        label = 'Thought';
    }

    const summary = document.createElement('summary');
    summary.className = 'thinking-summary';
    summary.innerHTML = `
        <span class="thinking-indicator"></span>
        <span class="thinking-label">${label}</span>
        <span class="thinking-chevron">&#9656;</span>
    `;

    const content = document.createElement('div');
    content.className = 'thinking-content';
    const trimmed = text.trim();
    if (trimmed) {
        content.innerHTML = renderMarkdown(trimmed);
    } else {
        const ph = document.createElement('p');
        ph.className = 'thinking-placeholder';
        ph.textContent = 'No reasoning text was captured for this step.';
        content.appendChild(ph);
    }

    details.appendChild(summary);
    details.appendChild(content);
    details.addEventListener('toggle', () => {
        if (thinkKey) {
            thinkingOpenByKey.set(thinkKey, details.open);
        }
        if (details.id === 'streaming-thinking') {
            streamingThinkingUserOpen = details.open;
        }
    });
    return details;
}

function addToRecentModels(provider: string, id: string, name?: string): void {
    state.recentModels = state.recentModels.filter(
        m => !(m.id === id && m.provider === provider)
    );
    state.recentModels.unshift({ provider, id, name });
    if (state.recentModels.length > 5) {
        state.recentModels = state.recentModels.slice(0, 5);
    }
}

function appendDismissButton(
    container: HTMLElement,
    className: string,
    onDismiss: () => void,
): HTMLButtonElement {
    const closeBtn = el('button', className);
    closeBtn.type = 'button';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Dismiss';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDismiss();
    });
    container.appendChild(closeBtn);
    return closeBtn;
}

function showError(message: string): void {
    if (!message.trim()) {
        return;
    }
    state.connectionStatus = { phase: 'failed', message: message.trim() };
    updateConnectionBanner();

    const container = document.getElementById('messages');
    if (!container) {
        return;
    }
    const errEl = el('div', 'error-message');
    const textEl = el('span', 'error-message-text');
    textEl.textContent = message;
    errEl.appendChild(textEl);
    appendDismissButton(errEl, 'error-message-dismiss', () => {
        errEl.remove();
    });
    container.appendChild(errEl);
    scrollToBottom();
}

function updateStreamingUI(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    updateStreamActivityBar();

    const hasThinking = state.isThinking || Boolean(state.streamingThinking.trim());
    const hasPayload = Boolean(state.streamingText) || hasThinking;

    if (!state.isStreaming && !hasPayload) {
        container.querySelector('.message.message-assistant')?.remove();
        container.classList.remove('streaming-active');
        clearStreamingToolArtifacts();
        setStreamPhase('idle');
        return;
    }

    if (!state.isStreaming) {
        clearStreamingToolArtifacts();
    }

    if (hasPayload || state.isThinking) {
        renderStreamingContent();
    }
}

// ── Events ──

function bindStableEvents(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const newTabBtn = document.getElementById('btn-new-tab');
    const sessionsBtn = document.getElementById('btn-sessions');
    const settingsBtn = document.getElementById('btn-settings');

    input?.addEventListener('keydown', (e) => {
        if (handleAtMenuKeydown(e)) {
            return;
        }
        if (isSlashMenuVisible()) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                slashMenuIndex = Math.min(slashMenuIndex + 1, slashMenuItems.length - 1);
                const menu = document.getElementById('slash-menu');
                if (menu) renderSlashMenu(menu);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                slashMenuIndex = Math.max(slashMenuIndex - 1, 0);
                const menu = document.getElementById('slash-menu');
                if (menu) renderSlashMenu(menu);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                selectSlashItem(slashMenuIndex);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideSlashMenu();
                return;
            }
        }

        if (
            e.key === 'ArrowUp' &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !isSlashMenuVisible() &&
            !isAtMenuVisible() &&
            input.selectionStart === 0 &&
            input.selectionEnd === 0 &&
            input.value.length === 0
        ) {
            e.preventDefault();
            loadLastUserMessageToComposer();
            return;
        }

        if (composerEdit && e.key === 'Escape') {
            e.preventDefault();
            clearComposerEdit();
            return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (composerEdit) {
                if ((e.ctrlKey || e.metaKey) && composerEdit.entryId) {
                    submitComposerEdit('fork');
                } else {
                    submitComposerEdit('new');
                }
                return;
            }
            if (state.isStreaming) {
                const text = input.value.trim();
                if (hasSendableInput(text)) {
                    if (e.ctrlKey || e.metaKey) {
                        vscode.postMessage({ type: 'steer', text });
                        input.value = '';
                        input.style.height = 'auto';
                        updateComposerToolbar();
                    } else {
                        submitWhileStreaming('queue');
                    }
                }
            } else {
                sendMessage();
            }
        }
        if (e.key === 'Escape' && state.isStreaming) {
            e.preventDefault();
            requestAbort();
        }
    });

    input?.addEventListener('input', () => {
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        updateComposerToolbar();
        updateAtMenu(input);
        if (isAtMenuVisible()) {
            hideSlashMenu();
        } else {
            updateSlashMenu(input);
        }
    });

    document.querySelector('.input-area')?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('#btn-attach')) {
            e.preventDefault();
            vscode.postMessage({ type: 'pickAttachments' });
            return;
        }
        const sendBtn = target.closest('#btn-send') as HTMLButtonElement | null;
        if (sendBtn && !sendBtn.disabled) {
            e.preventDefault();
            handleSendButtonClick();
            return;
        }
        if (target.closest('#btn-steer')) {
            e.preventDefault();
            handleSteerButtonClick();
            return;
        }
    });

    input?.addEventListener('paste', (e) => {
        const clip = e.clipboardData;
        if (!clip) return;
        const files: File[] = [];
        for (const item of clip.items) {
            if (!item.type.startsWith('image/')) continue;
            const file = item.getAsFile();
            if (file) files.push(file);
        }
        if (files.length === 0) return;
        e.preventDefault();
        void Promise.all(files.map(readImageFileAsItem)).then((items) => {
            const ready = items.filter(
                (x): x is { mimeType: string; dataBase64: string; name?: string } => x !== null,
            );
            if (ready.length > 0) {
                vscode.postMessage({ type: 'addPastedImages', items: ready });
            }
        });
    });

    bindChatFileDrop();
    bindFileMentionMenu();

    newTabBtn?.addEventListener('click', () => vscode.postMessage({ type: 'createTab' }));
    sessionsBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        requestSessionPanelToggle();
    });
    settingsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
}

function bindTabEvents(): void {
    document.querySelectorAll('.tab').forEach((tabEl) => {
        tabEl.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.tab-close')) return;
            const tabId = (tabEl as HTMLElement).dataset.tabId;
            if (tabId && tabId !== state.activeTabId) {
                vscode.postMessage({ type: 'switchTab', tabId });
            }
        });
    });

    document.querySelectorAll('.tab-close').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = (btn as HTMLElement).dataset.tabId;
            if (tabId) {
                vscode.postMessage({ type: 'closeTab', tabId });
            }
        });
    });
}

function bindCheckpointButtons(): void {
    document.querySelectorAll('.checkpoint-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const turn = parseInt((btn as HTMLElement).dataset.turn ?? '-1', 10);
            if (turn < 1) return;
            vscode.postMessage({
                type: 'confirmAction',
                action: 'restoreCheckpoint',
                message: 'Discard all changes after this checkpoint?',
                payload: { messageIndex: turn - 1 },
            });
        });
    });
}

function bindRedoButtons(): void {
    document.querySelectorAll('.redo-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({
                type: 'confirmAction',
                action: 'redoCheckpoint',
                message: 'Re-apply the rolled-back changes?',
            });
        });
    });
}

function bindDiffButtons(): void {
    document.querySelectorAll('.diff-file-header:not([data-bound])').forEach((header) => {
        header.setAttribute('data-bound', '1');
        header.addEventListener('click', () => {
            const filePath = (header as HTMLElement).dataset.filepath;
            const toolCallId = (header as HTMLElement).dataset.toolcallid;
            if (filePath && toolCallId) {
                vscode.postMessage({ type: 'openDiff', filePath, toolCallId });
            }
        });
    });
}

function bindToolClickable(): void {
    document.querySelectorAll('.tool-clickable:not([data-click-bound])').forEach((card) => {
        card.setAttribute('data-click-bound', '1');
        const headerEl = card.querySelector('.tool-header') as HTMLElement | null;
        if (!headerEl) return;
        const nameEl = headerEl.querySelector('.tool-name') as HTMLElement | null;
        if (!nameEl) return;
        nameEl.style.cursor = 'pointer';
        nameEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const filePath = (card as HTMLElement).dataset.filepath;
            if (filePath) {
                vscode.postMessage({ type: 'openFile', filePath });
            }
        });
    });
}

function bindChangedFileItems(): void {
    document.querySelectorAll('.changed-file-item:not([data-bound])').forEach((item) => {
        item.setAttribute('data-bound', '1');
        item.addEventListener('click', () => {
            const filePath = (item as HTMLElement).dataset.filepath;
            const toolCallId = (item as HTMLElement).dataset.toolcallid;
            if (filePath && toolCallId) {
                vscode.postMessage({ type: 'openDiff', filePath, toolCallId });
            }
        });
    });
}

function sendMessage(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;
    if (composerEdit) {
        submitComposerEdit('new');
        return;
    }
    const text = input.value.trim();
    if (!hasSendableInput(text)) return;
    const attachments = [...state.pendingAttachments];
    const attachmentCount = attachments.length;
    input.value = '';
    input.style.height = 'auto';
    state.pendingAttachments = [];
    updateAttachmentsStrip();
    userHasScrolled = false;
    updateScrollButton();
    const slashOnly = attachmentCount === 0 && text.startsWith('/');
    if (slashOnly) {
        vscode.postMessage({ type: 'slashCommand', text });
        updateComposerToolbar();
        return;
    }
    if (text || attachmentCount > 0) {
        appendOptimisticUserMessage(text, attachmentCount);
    }
    vscode.postMessage({ type: 'prompt', text, attachments });
    updateComposerToolbar();
}

function bindCopyButtons(): void {
    document.querySelectorAll('.copy-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.codeId;
            if (!id) return;
            const codeEl = document.getElementById(id);
            if (!codeEl) return;
            navigator.clipboard.writeText(codeEl.textContent ?? '').then(() => {
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            });
        });
    });
}

// ── Slash command menu ──

type SlashMenuEntry = SlashCommandListItem;

let slashMenuIndex = 0;
let slashMenuItems: SlashMenuEntry[] = [];

function getSlashMenuCandidates(): SlashMenuEntry[] {
    const builtins = state.slashCommands.length > 0
        ? state.slashCommands
        : [
            { invocation: '/login', name: 'login', description: 'Configure auth', source: 'builtin' as const },
            { invocation: '/logout', name: 'logout', description: 'Remove credentials', source: 'builtin' as const },
            { invocation: '/model', name: 'model', description: 'Select model', source: 'builtin' as const },
            { invocation: '/new', name: 'new', description: 'New session', source: 'builtin' as const },
            { invocation: '/reload', name: 'reload', description: 'Reload extensions', source: 'builtin' as const },
        ];
    const skills: SlashMenuEntry[] = state.skills.map((s) => ({
        invocation: `/skill:${s.name}`,
        name: `skill:${s.name}`,
        description: s.description,
        source: 'skill' as const,
    }));
    const seen = new Set<string>();
    const merged: SlashMenuEntry[] = [];
    for (const item of [...builtins, ...skills]) {
        if (seen.has(item.invocation)) continue;
        seen.add(item.invocation);
        merged.push(item);
    }
    return merged;
}

function updateSlashMenu(input: HTMLTextAreaElement): void {
    const menu = document.getElementById('slash-menu');
    if (!menu) return;

    const text = input.value;
    const cursorPos = input.selectionStart;
    const beforeCursor = text.slice(0, cursorPos);
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/\S*)$/);

    if (!slashMatch) {
        hideSlashMenu();
        return;
    }

    const query = slashMatch[1].slice(1).toLowerCase();
    slashMenuItems = getSlashMenuCandidates().filter((item) => {
        const inv = item.invocation.slice(1).toLowerCase();
        const name = item.name.toLowerCase();
        return inv.includes(query) || name.includes(query) || (item.description?.toLowerCase().includes(query) ?? false);
    });

    if (slashMenuItems.length === 0) {
        hideSlashMenu();
        return;
    }

    slashMenuIndex = Math.min(slashMenuIndex, slashMenuItems.length - 1);
    renderSlashMenu(menu);
    menu.style.display = '';
}

function renderSlashMenu(menu: HTMLElement): void {
    menu.innerHTML = slashMenuItems.map((item, i) => {
        const active = i === slashMenuIndex ? ' slash-item-active' : '';
        const desc = item.description
            ? `<span class="slash-item-desc">${escHtml(item.description)}</span>`
            : '';
        const tag = item.source !== 'builtin'
            ? `<span class="slash-item-source">${escHtml(item.source)}</span>`
            : '';
        return `<div class="slash-item${active}" data-index="${i}">
            <span class="slash-item-name">${escHtml(item.invocation)}</span>
            ${desc}
            ${tag}
        </div>`;
    }).join('');

    menu.querySelectorAll('.slash-item').forEach((item) => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const idx = parseInt((item as HTMLElement).dataset.index ?? '0', 10);
            selectSlashItem(idx);
        });
        item.addEventListener('dblclick', (e) => {
            e.preventDefault();
            const idx = parseInt((item as HTMLElement).dataset.index ?? '0', 10);
            executeSlashCommand(idx);
        });
    });
}

/** Run a slash command immediately (same as sending it in chat). */
function executeSlashCommand(index: number): void {
    const entry = slashMenuItems[index];
    if (!entry) return;
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }
    hideSlashMenu();
    userHasScrolled = false;
    updateScrollButton();
    vscode.postMessage({ type: 'slashCommand', text: entry.invocation });
}

function selectSlashItem(index: number): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;

    const entry = slashMenuItems[index];
    if (!entry) return;

    const text = input.value;
    const cursorPos = input.selectionStart;
    const beforeCursor = text.slice(0, cursorPos);
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/\S*)$/);

    if (slashMatch) {
        const matchStart = beforeCursor.length - slashMatch[1].length;
        const replacement = `${entry.invocation} `;
        input.value = text.slice(0, matchStart) + replacement + text.slice(cursorPos);
        const newPos = matchStart + replacement.length;
        input.setSelectionRange(newPos, newPos);
    }

    hideSlashMenu();
    input.focus();
}

function hideSlashMenu(): void {
    const menu = document.getElementById('slash-menu');
    if (menu) {
        menu.style.display = 'none';
        menu.innerHTML = '';
    }
    slashMenuItems = [];
    slashMenuIndex = 0;
}

function isSlashMenuVisible(): boolean {
    const menu = document.getElementById('slash-menu');
    return !!menu && menu.style.display !== 'none' && slashMenuItems.length > 0;
}

// ── Helpers ──

function el(tag: string, className?: string): HTMLElement {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

function escHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTimestamp(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildMessageFooter(msg: any, index: number): HTMLElement | null {
    const role = msg.role ?? 'unknown';
    if (role !== 'user' && role !== 'assistant') return null;

    const parts: string[] = [];

    const ts = msg.timestamp;
    if (ts) {
        parts.push(formatTimestamp(ts));
    }

    if (role === 'user') {
        // Show input tokens from the next assistant message's usage
        for (let j = index + 1; j < state.messages.length; j++) {
            const next = state.messages[j];
            if (next.role === 'assistant' && next.usage && next.usage.input > 0) {
                parts.push(`${next.usage.input.toLocaleString()} input tokens`);
                break;
            }
            if (next.role === 'user') break;
        }
    }

    if (role === 'assistant') {
        if (msg._messageEndTime && msg.timestamp) {
            const startMs = msg.timestamp < 1e12 ? msg.timestamp * 1000 : msg.timestamp;
            const durationSec = (msg._messageEndTime - startMs) / 1000;
            const usage = msg.usage;
            if (usage && usage.output > 0 && durationSec > 0) {
                const tokPerSec = usage.output / durationSec;
                parts.push(`${tokPerSec.toFixed(1)} tok/s`);
            }
        }

        const usage = msg.usage;
        if (usage && usage.output > 0) {
            parts.push(`${usage.output.toLocaleString()} output tokens`);
        }
    }

    if (parts.length === 0) return null;

    const footer = el('div', 'message-footer');
    footer.textContent = parts.join(' · ');
    return footer;
}

function extractThinking(msg: any): string {
    if (Array.isArray(msg.content)) {
        return msg.content
            .map((c: any) => thinkingBlockText(c))
            .filter((t: string) => t.trim())
            .join('\n\n');
    }
    return typeof msg.thinking === 'string' ? msg.thinking : '';
}

function extractText(msg: any): string {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
    }
    return msg.text ?? '';
}

function extractImages(msg: any): { mimeType: string; data: string; name?: string }[] {
    if (!Array.isArray(msg.content)) {
        return [];
    }
    return msg.content
        .filter((c: any) => c.type === 'image' && typeof c.data === 'string' && c.data.length > 0)
        .map((c: any) => ({
            mimeType: c.mimeType ?? 'image/png',
            data: c.data,
            name: c.name,
        }));
}

function truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '...';
}

function tryParseJSON(s: string): any {
    try { return JSON.parse(s); } catch { return s; }
}

let userHasScrolled = false;
let isProgrammaticScroll = false;

function scrollToBottom(force = false): void {
    if (userHasScrolled && !force) return;
    const messages = document.getElementById('messages');
    if (messages) {
        isProgrammaticScroll = true;
        messages.scrollTop = messages.scrollHeight;
    }
}

function isNearBottom(): boolean {
    const messages = document.getElementById('messages');
    if (!messages) return true;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 50;
}

function updateScrollButton(): void {
    const btn = document.getElementById('btn-scroll-bottom');
    if (!btn) return;
    if (userHasScrolled) {
        btn.classList.add('visible');
    } else {
        btn.classList.remove('visible');
    }
}

function bindScrollListener(): void {
    const messages = document.getElementById('messages');
    if (!messages) return;

    // Detect user-initiated scroll intent immediately
    messages.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) {
            userHasScrolled = true;
            updateScrollButton();
        }
    }, { passive: true });

    messages.addEventListener('touchstart', () => {
        userHasScrolled = true;
        updateScrollButton();
    }, { passive: true });

    // The scroll event handles resetting when user reaches bottom
    messages.addEventListener('scroll', () => {
        if (isProgrammaticScroll) {
            isProgrammaticScroll = false;
            return;
        }
        if (isNearBottom()) {
            userHasScrolled = false;
        }
        updateScrollButton();
    });
}

// ── Init ──
render();
