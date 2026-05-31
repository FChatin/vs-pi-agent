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
    ContextUsageInfo,
    SessionTokenStats,
    PendingAttachmentPreview,
} from '../shared/protocol';
import { dismissExtensionUi, initExtensionUiHost, showExtensionUiRequest } from './extensionUi';
import { isImageFilePath, parseUserMessageForDisplay } from '../shared/attachmentMessageDisplay';
import { shouldHideMessageInChat, stripPlanContentForChatDisplay } from '../shared/planMessageFilter';
import { renderFooterTokenSummary } from './tokenStatsBar';
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
    pendingAttachments: PendingAttachmentPreview[];
    planMode: PlanModeInfo;
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
    pendingAttachments: [],
    planMode: emptyPlanMode(),
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
            updateFooterModel();
            if (pendingModelPicker) {
                pendingModelPicker = false;
                showModelPicker();
            }
            break;
        case 'sessions':
            renderSessionList(msg.sessions, msg.currentSessionId);
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
    state.queuedMessages = s.queuedMessages ?? [];
    state.pendingAttachments = s.pendingAttachments ?? [];
    state.planMode = s.planMode ?? state.planMode;
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
        updateAttachmentsStrip();
        updatePlanPanel();
        refreshFooterTokenStats();
        if (state.isStreaming) {
            ensurePreparingPlaceholder();
        } else {
            removePreparingPlaceholder();
        }
        updateScrollButton();
    }
}

function handleAgentEvent(event: any): void {
    switch (event.type) {
        case 'message_update':
            if (event.assistantMessageEvent) {
                handleStreamingDelta(event.assistantMessageEvent);
            }
            break;
        case 'agent_start':
            state.isStreaming = true;
            state.streamingText = '';
            state.streamingThinking = '';
            state.isThinking = false;
            userHasScrolled = false;
            updateInputArea();
            updateStreamingUI();
            showPreparingPlaceholder();
            break;
        case 'agent_end':
            state.isStreaming = false;
            state.streamingText = '';
            state.streamingThinking = '';
            state.isThinking = false;
            dismissSteerToast();
            updateStreamingUI();
            updateInputArea();
            updateModeSwitch();
            updatePlanPanel();
            refreshFooterTokenStats();
            break;
        case 'tool_execution_start':
            removePreparingPlaceholder();
            renderToolStart(event);
            break;
        case 'tool_execution_update':
            renderToolUpdate(event);
            break;
        case 'tool_execution_end':
            renderToolEnd(event);
            showPreparingPlaceholder();
            break;
    }
}

function handleStreamingDelta(ae: any): void {
    switch (ae.type) {
        case 'thinking_start':
            state.isThinking = true;
            state.streamingThinking = '';
            state.thinkingStartTime = Date.now();
            state.streamingThinkingDuration = 0;
            break;
        case 'thinking_delta':
            state.streamingThinking += ae.delta ?? '';
            dismissSteerToast();
            break;
        case 'thinking_end':
            state.isThinking = false;
            if (state.thinkingStartTime > 0) {
                state.streamingThinkingDuration = Math.round((Date.now() - state.thinkingStartTime) / 1000);
            }
            break;
        case 'text_start':
            break;
        case 'text_delta':
            state.streamingText += ae.delta ?? '';
            dismissSteerToast();
            break;
        case 'text_end':
            break;
    }
    renderStreamingContent();
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
        <button class="icon-btn" id="btn-sessions" title="Sessions"><img class="header-icon-img" src="${iconsBaseUri}/list.svg" alt="sessions"></button>
        <button class="icon-btn" id="btn-settings" title="Settings"><img class="header-icon-img" src="${iconsBaseUri}/settings.svg" alt="settings"></button>
    `;
    header.appendChild(headerActions);
    app.appendChild(header);

    // Messages container (persistent, children managed by updateMessages)
    const messagesContainer = el('div', 'messages');
    messagesContainer.id = 'messages';
    const streamingContainer = el('div', 'streaming-message message-group-assistant');
    streamingContainer.id = 'streaming-message';
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
    const area = el('div', 'input-area');
    area.innerHTML = `<textarea id="input" placeholder="Ask Pi anything..." rows="1"></textarea>`;
    inputContainer.appendChild(area);
    const footer = el('div', 'input-footer');
    inputContainer.appendChild(footer);
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

    // Populate all dynamic sections
    updateTabs();
    updateModeSwitch();
    updatePlanPanel();
    updateMessages();
    updateInputArea();
        updateChangedFiles();
        scrollToBottom();
}

function updateModeSwitch(): void {
    const root = document.getElementById('mode-switch');
    if (!root) return;

    const pm = state.planMode ?? emptyPlanMode();
    const active = pm.enabled ? 'plan' : 'agent';
    const badge =
        pm.statusLabel === 'ready'
            ? '<span class="mode-badge ready">ready</span>'
            : '';
    const canImplement =
        pm.hasPlan && (pm.statusLabel === 'ready' || (!pm.enabled && pm.statusLabel === 'off'));
    const implementBtn =
        canImplement && !state.isStreaming
            ? '<button type="button" class="mode-implement-btn" id="btn-implement-plan">Implement plan</button>'
            : '';

    root.innerHTML = `
        <div class="mode-switch-row">
            <div class="mode-switch-inner" role="tablist" aria-label="Agent mode">
                <button type="button" class="mode-btn ${active === 'agent' ? 'active' : ''}" data-mode="agent">Agent</button>
                <button type="button" class="mode-btn ${active === 'plan' ? 'active' : ''}" data-mode="plan">Plan ${badge}</button>
            </div>
            ${implementBtn}
        </div>
    `;

    root.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLButtonElement).dataset.mode as 'agent' | 'plan';
            const pm = state.planMode ?? emptyPlanMode();
            if ((mode === 'plan') === pm.enabled) return;
            if (mode === 'agent') {
                state.planMode = {
                    ...pm,
                    enabled: false,
                    awaitingAction: false,
                    statusLabel: 'off',
                };
            } else {
                state.planMode = {
                    ...pm,
                    enabled: true,
                    awaitingAction: false,
                    statusLabel: pm.hasPlan ? 'ready' : 'planning',
                };
            }
            updateModeSwitch();
            updatePlanPanel();
            updateInputArea();
            vscode.postMessage({ type: 'setAgentMode', mode });
        });
    });
    document.getElementById('btn-implement-plan')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'implementPlan' });
    });
}

/** Plan markdown/todos live in the editor only — no duplicate panel above input. */
function updatePlanPanel(): void {
    const panel = document.getElementById('plan-panel');
    if (!panel) return;

    const pm = state.planMode;
    const showHint = pm.enabled && !pm.hasPlan && !state.isStreaming;
    if (!showHint) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }

    panel.style.display = '';
    panel.innerHTML = `
        <div class="plan-panel-header plan-panel-hint-only">
            <span class="plan-panel-title">Plan</span>
            <span class="plan-panel-status">Exploring… When ready, the plan opens in the editor automatically.</span>
        </div>
    `;
}

function updateMessages(): void {
    const container = document.getElementById('messages');
    if (!container) return;

    const streamingEl = document.getElementById('streaming-message');
    const spacerEl = container.querySelector('.messages-spacer');

    // Remove all children before #streaming-message (the message nodes)
    while (container.firstChild && container.firstChild !== streamingEl) {
        container.removeChild(container.firstChild);
    }

    codeBlockId = 0;

    if (state.messages.length === 0 && !state.isStreaming) {
        container.insertBefore(buildWelcome(), streamingEl);
    } else {
        let userMsgCount = 0;
        const rollbackUserIdx = state.rollbackPoint;
        let dimming = false;
        let redoPlaced = false;

        for (let i = 0; i < state.messages.length; i++) {
            const msg = state.messages[i];
            if (shouldHideMessageInChat(msg)) {
                continue;
            }
            const role = msg.role ?? 'unknown';

            if (role === 'user') {
                userMsgCount++;
                if (rollbackUserIdx !== null && userMsgCount > rollbackUserIdx) {
                    dimming = true;
                }
            }

            const msgEl = renderMessage(msg, i, role === 'user' ? userMsgCount : undefined);
            if (dimming) {
                msgEl.classList.add('dimmed');
            }

            container.insertBefore(msgEl, streamingEl);

            if (role === 'user' && dimming && !redoPlaced && rollbackUserIdx !== null) {
                const redoWrap = el('div', 'redo-anchor');
                const redoBtn = el('button', 'redo-btn');
                redoBtn.title = 'Redo changes';
                redoBtn.textContent = 'Redo';
                redoWrap.appendChild(redoBtn);
                container.insertBefore(redoWrap, streamingEl);
                redoPlaced = true;
            }
        }
    }

    bindCopyButtons();
    bindCheckpointButtons();
    bindRedoButtons();
    bindDiffButtons();
    bindToolClickable();
    bindAttachmentOpenClicks();
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

/** Update token stats in the input footer only (no duplicate top bar). */
function refreshFooterTokenStats(): void {
    const footer = document.querySelector('.input-footer');
    if (!footer) {
        return;
    }
    const html = renderFooterTokenSummary(state.contextUsage, state.sessionTokens);
    const existing = footer.querySelector('.footer-token-stats');
    if (!html.trim()) {
        existing?.remove();
        return;
    }
    if (existing) {
        existing.outerHTML = html;
        return;
    }
    const modelEl = footer.querySelector('.footer-model');
    if (modelEl) {
        modelEl.insertAdjacentHTML('afterend', html);
    }
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

function updateInputArea(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (input) {
        input.placeholder = state.isStreaming
            ? 'Type to queue a message, Ctrl+Enter to steer, Esc to stop...'
            : state.planMode.enabled
              ? 'Plan mode: describe what to build (read-only until you implement)...'
              : 'Ask Pi anything...';
    }

    const footer = document.querySelector('.input-footer');
    if (!footer) return;

    const modelName = state.model?.name ?? state.model?.id ?? '';
    const footerTokens = renderFooterTokenSummary(state.contextUsage, state.sessionTokens);

    const steerBtnHtml = state.isStreaming
        ? `<button id="btn-steer" class="steer-btn" title="Steer (Ctrl+Enter)"><img class="steer-icon-img" src="${iconsBaseUri}/chevrons.svg" alt="steer"></button>`
        : '';

    footer.innerHTML = `
        <button id="btn-attach" class="attach-btn" type="button" title="Attach files · @ for workspace paths · Explorer: hold Shift while dropping here">&#128206;</button>
        <span class="footer-drop-tip" title="From Explorer: hold Shift while dropping on the message box. Or right-click → Add to Chat (no Shift).">Explorer: <kbd>Shift</kbd>+drop</span>
        <span class="footer-model">${escHtml(modelName)}</span>
        ${footerTokens}
        <span class="footer-spacer"></span>
        ${state.isStreaming ? '<button id="btn-abort" class="abort-btn" title="Stop generation (Esc)">&#9632; Stop</button>' : ''}
        ${steerBtnHtml}
        <button id="btn-send" class="send-btn" title="${state.isStreaming ? 'Queue' : 'Send'}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3L8 13M8 3L3 8M8 3L13 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    `;

    document.getElementById('btn-attach')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'pickAttachments' });
    });

    // Rebind the dynamic footer elements
    const sendBtn = document.getElementById('btn-send');
    sendBtn?.addEventListener('click', () => {
        if (state.isStreaming) {
            const text = input?.value.trim() ?? '';
            if (hasSendableInput(text)) {
                vscode.postMessage({ type: 'queueMessage', text });
                if (input) { input.value = ''; input.style.height = 'auto'; }
            } else {
                vscode.postMessage({ type: 'abort' });
            }
        } else {
            sendMessage();
        }
    });

    const steerBtn = document.getElementById('btn-steer');
    steerBtn?.addEventListener('click', () => {
        const text = input?.value.trim() ?? '';
        if (hasSendableInput(text)) {
            vscode.postMessage({ type: 'steer', text });
            if (input) { input.value = ''; input.style.height = 'auto'; }
            showSteerToast(text || '(attachments)');
        }
    });

    const abortBtn = document.getElementById('btn-abort');
    abortBtn?.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));

    document.querySelector('.footer-model')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleModelPicker();
    });

    updateQueuedMessageBanner();
}

let queuedEditingIndex = -1;

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

function showSteerToast(text: string): void {
    const existing = document.getElementById('steer-toast');
    if (existing) existing.remove();

    const container = document.querySelector('.input-container');
    if (!container) return;

    const toast = el('div', 'steer-toast');
    toast.id = 'steer-toast';
    toast.innerHTML = `
        <span class="steer-toast-indicator"></span>
        <span class="steer-toast-label">Steering...</span>
        <span class="steer-toast-text">${escHtml(truncate(text, 80))}</span>
    `;

    const inputArea = container.querySelector('.input-area');
    if (inputArea) {
        container.insertBefore(toast, inputArea);
    } else {
        container.appendChild(toast);
    }
}

function dismissSteerToast(): void {
    const toast = document.getElementById('steer-toast');
    if (!toast) return;
    toast.classList.add('steer-toast-fade');
    setTimeout(() => toast.remove(), 300);
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
            <div class="welcome-hint"><kbd>Esc</kbd> Stop generation</div>
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
    scrollToBottom();
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

function renderMessage(msg: any, index: number, turnNumber?: number): HTMLElement {
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
        group.appendChild(wrapper);

        const footer = buildMessageFooter(msg, index);
        if (footer) {
            group.appendChild(footer);
        }

        return group;
    }

    // Assistant messages: wrap in a styled container
    const thinking = extractThinking(msg);
    let text = extractText(msg);
    if (role === 'assistant' && text) {
        text = stripPlanContentForChatDisplay(text);
    }

    if (!thinking && !text) {
        const empty = el('div');
        empty.style.display = 'none';
        return empty;
    }

    const group = el('div', 'message-group-assistant');

    const wrapper = el('div', `message message-${role}`);

    if (thinking) {
        wrapper.appendChild(buildThinkingBlock(thinking, false, msg._thinkingDurationSec));
    }

    if (text) {
        const content = el('div', 'message-content');
        content.innerHTML = renderMarkdown(text);
        wrapper.appendChild(content);
    }

    group.appendChild(wrapper);

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

function removePreparingPlaceholder(): void {
    document.getElementById('preparing-placeholder')?.remove();
}

function showPreparingPlaceholder(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    if (document.getElementById('preparing-placeholder')) return;
    const ph = el('div', 'preparing-placeholder');
    ph.id = 'preparing-placeholder';
    ph.textContent = 'Preparing next moves...';
    container.appendChild(ph);
    scrollToBottom();
}

function ensurePreparingPlaceholder(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    const hasRunningTool = container.querySelector('.tool-status.running');
    if (!hasRunningTool) {
        showPreparingPlaceholder();
    }
}

function renderStreamingContent(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if (!state.streamingText && !state.streamingThinking) return;
    removePreparingPlaceholder();

    if (!container.querySelector('.message')) {
        container.innerHTML = `
            <div class="message message-assistant">
                <details class="thinking-block active" open id="streaming-thinking" style="display:none">
                    <summary class="thinking-summary">
                        <span class="thinking-indicator"></span>
                        <span class="thinking-label">Thinking...</span>
                        <span class="thinking-chevron">&#9656;</span>
                    </summary>
                    <div class="thinking-content"></div>
                </details>
                <div class="message-content" id="streaming-text"></div>
            </div>
        `;
    }

    const thinkingEl = document.getElementById('streaming-thinking') as HTMLDetailsElement | null;
    if (thinkingEl) {
        if (state.streamingThinking) {
            thinkingEl.style.display = '';
            const contentEl = thinkingEl.querySelector('.thinking-content');
            if (contentEl) contentEl.innerHTML = renderMarkdown(state.streamingThinking);
            const labelEl = thinkingEl.querySelector('.thinking-label');
            if (state.isThinking) {
                thinkingEl.classList.add('active');
                if (labelEl) labelEl.textContent = 'Thinking...';
            } else {
                thinkingEl.classList.remove('active');
                if (labelEl) {
                    const dur = state.streamingThinkingDuration;
                    labelEl.textContent = dur > 0
                        ? `Thought for ${dur} second${dur !== 1 ? 's' : ''}`
                        : 'Thought';
                }
            }
        } else {
            thinkingEl.style.display = 'none';
        }
    }

    const textEl = document.getElementById('streaming-text');
    if (textEl) {
        textEl.innerHTML = renderMarkdown(state.streamingText);
    }

    bindCopyButtons();
    scrollToBottom();
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

function renderToolStart(event: any): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if ((event.toolName ?? '').toLowerCase() === 'todo') {
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
        scrollToBottom();
        return;
    }

    const parsedArgs = typeof event.args === 'string' ? tryParseJSON(event.args) : event.args;
    const nameLower = (event.toolName ?? '').toLowerCase();
    const isRead = nameLower === 'read';
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';

    const card = el('div', `tool-card${isRead ? ' tool-clickable' : ''}`);
    card.id = `tool-${event.toolCallId}`;
    card.dataset.toolName = event.toolName;
    if (isRead && filePath) card.dataset.filepath = filePath;

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(event.toolName)}</span>
            <span class="tool-name">${escHtml(getToolLabel(event.toolName, parsedArgs))}</span>
            <span class="tool-status running">running</span>
        </div>
    `;

    container.appendChild(card);
    bindToolClickable();
    scrollToBottom();
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
    scrollToBottom();
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

    removePreparingPlaceholder();

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
    scrollToBottom();
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

function buildThinkingBlock(text: string, active: boolean, durationSec?: number): HTMLElement {
    const details = document.createElement('details');
    details.className = `thinking-block${active ? ' active' : ''}`;
    let label: string;
    if (active) {
        label = 'Thinking...';
    } else if (durationSec && durationSec > 0) {
        label = `Thought for ${durationSec} second${durationSec !== 1 ? 's' : ''}`;
    } else {
        label = 'Thought';
    }
    details.innerHTML = `
        <summary class="thinking-summary">
            <span class="thinking-indicator"></span>
            <span class="thinking-label">${label}</span>
            <span class="thinking-chevron">&#9656;</span>
        </summary>
        <div class="thinking-content">${renderMarkdown(text)}</div>
    `;
    return details;
}

// ── Model picker popup ──

let pendingModelPicker = false;

function toggleModelPicker(): void {
    const existing = document.getElementById('model-picker');
    if (existing) {
        existing.remove();
        pendingModelPicker = false;
        return;
    }

    if (state.availableModels.length === 0) {
        pendingModelPicker = true;
        vscode.postMessage({ type: 'getModels' });
        return;
    }

    showModelPicker();
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

function buildModelItem(m: any): HTMLElement {
    const item = el('div', 'model-item');
    const isActive = state.model && m.id === state.model.id && m.provider === state.model.provider;
    if (isActive) item.classList.add('active');
    item.dataset.provider = m.provider;
    item.dataset.modelId = m.id;
    item.dataset.name = (m.name ?? m.id).toLowerCase();
    item.innerHTML = `
        <span class="model-item-check">${isActive ? '&#10003;' : ''}</span>
        <span class="model-item-name">${escHtml(m.name ?? m.id)}</span>
    `;
    return item;
}

function showModelPicker(): void {
    const existing = document.getElementById('model-picker');
    if (existing) existing.remove();

    const container = document.querySelector('.input-container');
    if (!container) return;

    const picker = el('div', 'model-picker');
    picker.id = 'model-picker';

    const searchInput = document.createElement('input');
    searchInput.className = 'model-search';
    searchInput.placeholder = 'Search models...';
    searchInput.type = 'text';
    picker.appendChild(searchInput);

    const list = el('div', 'model-list');

    if (state.recentModels.length > 0) {
        const recentHeader = el('div', 'model-section-header');
        recentHeader.textContent = 'Recent';
        list.appendChild(recentHeader);

        for (const r of state.recentModels) {
            const full = state.availableModels.find(
                m => m.id === r.id && m.provider === r.provider
            );
            if (full) {
                list.appendChild(buildModelItem(full));
            }
        }

        const allHeader = el('div', 'model-section-header');
        allHeader.textContent = 'All Models';
        list.appendChild(allHeader);
    }

    for (const m of state.availableModels) {
        list.appendChild(buildModelItem(m));
    }
    picker.appendChild(list);

    const thinkingRow = el('div', 'thinking-chips');
    const thinkingLabel = el('span', 'thinking-label');
    thinkingLabel.textContent = 'Thinking:';
    thinkingRow.appendChild(thinkingLabel);
    const levels = ['off', 'minimal', 'low', 'medium', 'high'];
    for (const level of levels) {
        const chip = el('button', `thinking-chip${level === state.thinkingLevel ? ' active' : ''}`);
        chip.textContent = level.charAt(0).toUpperCase() + level.slice(1);
        chip.dataset.level = level;
        thinkingRow.appendChild(chip);
    }
    picker.appendChild(thinkingRow);

    container.appendChild(picker);

    searchInput.focus();

    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        list.querySelectorAll('.model-item').forEach((item) => {
            const name = (item as HTMLElement).dataset.name ?? '';
            (item as HTMLElement).style.display = name.includes(q) ? '' : 'none';
        });
        list.querySelectorAll('.model-section-header').forEach((hdr) => {
            (hdr as HTMLElement).style.display = q ? 'none' : '';
        });
    });

    list.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest('.model-item') as HTMLElement | null;
        if (!item) return;
        const provider = item.dataset.provider!;
        const modelId = item.dataset.modelId!;
        vscode.postMessage({ type: 'setModel', provider, modelId });
        const matched = state.availableModels.find(m => m.id === modelId && m.provider === provider);
        if (matched) {
            state.model = { provider, id: modelId, name: matched.name ?? modelId };
            addToRecentModels(provider, modelId, matched.name ?? modelId);
        }
        updateFooterModel();
        closeModelPicker();
    });

    thinkingRow.addEventListener('click', (e) => {
        const chip = (e.target as HTMLElement).closest('.thinking-chip') as HTMLElement | null;
        if (!chip) return;
        vscode.postMessage({ type: 'setThinkingLevel', level: chip.dataset.level! });
        thinkingRow.querySelectorAll('.thinking-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.thinkingLevel = chip.dataset.level;
    });

    setTimeout(() => {
        document.addEventListener('click', onClickOutsidePicker);
    }, 0);
}

function onClickOutsidePicker(e: MouseEvent): void {
    const picker = document.getElementById('model-picker');
    if (picker && !picker.contains(e.target as Node)) {
        closeModelPicker();
    }
}

function closeModelPicker(): void {
    document.getElementById('model-picker')?.remove();
    document.removeEventListener('click', onClickOutsidePicker);
}

function updateFooterModel(): void {
    const el = document.querySelector('.footer-model');
    if (el) {
        el.textContent = state.model?.name ?? state.model?.id ?? '';
    }
}

// ── Session list ──

function renderSessionList(sessions: any[], currentId?: string): void {
    let panel = document.getElementById('session-panel');
    if (!panel) {
        panel = el('div', 'session-panel');
        panel.id = 'session-panel';
        const app = document.getElementById('app');
        const modelBar = document.getElementById('model-bar');
        if (app && modelBar?.nextSibling) {
            app.insertBefore(panel, modelBar.nextSibling);
        } else {
            app?.appendChild(panel);
        }
    }

    if (sessions.length === 0) {
        panel.innerHTML = '<div class="session-empty">No previous sessions</div>';
        return;
    }

    panel.innerHTML = `
        <div class="session-header">
            <span>Sessions</span>
            <button class="icon-btn" id="btn-close-sessions" title="Close">&times;</button>
        </div>
        <div class="session-list">
            ${sessions.map(s => `
                <div class="session-item ${s.id === currentId ? 'active' : ''}" data-path="${escHtml(s.path)}">
                    <span class="session-item-name">${escHtml(s.name ?? s.id)}</span>
                </div>
            `).join('')}
        </div>
    `;

    document.getElementById('btn-close-sessions')?.addEventListener('click', () => panel?.remove());
    panel.querySelectorAll('.session-item').forEach((item) => {
        item.addEventListener('click', () => {
            const sessionPath = (item as HTMLElement).dataset.path;
            if (sessionPath) {
                vscode.postMessage({ type: 'loadSession', sessionPath });
            }
        });
    });
}

function showError(message: string): void {
    const container = document.getElementById('messages');
    if (!container) return;
    const errEl = el('div', 'error-message');
    errEl.textContent = message;
    container.appendChild(errEl);
    scrollToBottom();
}

function updateStreamingUI(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    container.innerHTML = '';
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

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (state.isStreaming) {
                const text = input.value.trim();
                if (hasSendableInput(text)) {
                    if (e.ctrlKey || e.metaKey) {
                        vscode.postMessage({ type: 'steer', text });
                        showSteerToast(text || '(attachments)');
                    } else {
                        vscode.postMessage({ type: 'queueMessage', text });
                    }
                    input.value = '';
                    input.style.height = 'auto';
                }
            } else {
                sendMessage();
            }
        }
        if (e.key === 'Escape' && state.isStreaming) {
            e.preventDefault();
            vscode.postMessage({ type: 'abort' });
        }
    });

    input?.addEventListener('input', () => {
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        updateAtMenu(input);
        if (isAtMenuVisible()) {
            hideSlashMenu();
        } else {
            updateSlashMenu(input);
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
    sessionsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'getSessions' }));
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
    const text = input.value.trim();
    if (!hasSendableInput(text)) return;
    const attachments = [...state.pendingAttachments];
    input.value = '';
    input.style.height = 'auto';
    userHasScrolled = false;
    updateScrollButton();
    vscode.postMessage({ type: 'prompt', text, attachments });
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
    });
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
            .filter((c: any) => c.type === 'thinking')
            .map((c: any) => c.thinking ?? c.text ?? '')
            .join('');
    }
    return msg.thinking ?? '';
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
