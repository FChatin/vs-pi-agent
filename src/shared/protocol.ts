export interface ContextUsageInfo {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}

/** Cumulative session tokens from Pi getSessionStats() (all assistant turns). */
export interface SessionTokenStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}

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

import type { ExtensionUiRequestPayload } from './extensionUi';

export type McpScopeId = 'global' | 'project' | 'projectPi';

export type McpConnectionStatus =
    | 'disabled'
    | 'unknown'
    | 'idle'
    | 'cached'
    | 'connected'
    | 'failed'
    | 'testing';

export interface McpToolSummary {
    name: string;
    description?: string;
}

export interface McpServerSummary {
    name: string;
    scope: McpScopeId | 'import';
    importSource?: string;
    enabled: boolean;
    canToggle: boolean;
    ownerPath: string;
    transport: 'stdio' | 'http' | 'unknown';
    commandPreview?: string;
    url?: string;
    directTools?: boolean | string[];
    tools: McpToolSummary[];
    toolCount: number;
    cacheStatus: 'fresh' | 'stale' | 'none';
    status: McpConnectionStatus;
    statusMessage?: string;
}

export interface McpConfigPathInfo {
    id: McpScopeId;
    label: string;
    path: string;
    exists: boolean;
}

export interface McpSettingsSnapshot {
    hasMcpAdapter: boolean;
    disableProxyTool: boolean;
    globalDirectTools?: boolean;
    toolPrefix?: string;
    configPaths: McpConfigPathInfo[];
    importSources: string[];
    servers: McpServerSummary[];
}

export interface PiAgentConfigData {
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

export interface SettingsData {
    extensionVersion: string;
    syncWithPiCli: boolean;
    piAgentDir: string;
    piConfigLoadError?: string;
    piDefaultProvider?: string;
    piDefaultModel?: string;
    piDefaultThinkingLevel?: string;
    piPackageCount: number;
    piConfig?: PiAgentConfigData;
    mcpSnapshot?: McpSettingsSnapshot;
    apiProvider: string;
    apiBaseUrl: string;
    apiKeySet: boolean;
    authMethod: 'env' | 'pi-login' | 'manual' | 'none';
    defaultModel: string;
    thinkingLevel: string;
    autoApproveTools: boolean;
    allowedTools: string[];
    autoSaveSessions: boolean;
    sessionStoragePath: string;
    contextUsageWarningThreshold: number;
    /** npm: sources for recommended Pi packages not yet in settings.json */
    recommendedPackagesMissing?: string[];
}

export interface ToolCallPendingInfo {
    toolCallId: string;
    toolName: string;
    args: any;
}

export interface FileChangeInfo {
    filePath: string;
    toolCallId: string;
    toolName: string;
    isNew: boolean;
    diff?: string;
    addedLines: number;
    removedLines: number;
    turnIndex: number;
}

export interface TabInfo {
    id: string;
    name: string;
    isActive: boolean;
    isStreaming: boolean;
    hasNotification: boolean;
}

export interface PlanTodoItem {
    id: string;
    text: string;
    done: boolean;
}

export interface PlanModeInfo {
    enabled: boolean;
    hasPlan: boolean;
    awaitingAction: boolean;
    statusLabel: 'off' | 'planning' | 'ready';
    planMarkdown: string;
    todos: PlanTodoItem[];
}

export interface SerializedAgentState {
    messages: any[];
    model?: { provider: string; id: string; name?: string };
    thinkingLevel?: string;
    isStreaming: boolean;
    streamingMessage?: any;
    errorMessage?: string;
    tools: string[];
    sessionId?: string;
    sessionName?: string;
    contextUsage?: ContextUsageInfo;
    sessionTokens?: SessionTokenStats;
    fileChanges?: FileChangeInfo[];
    rollbackPoint?: number | null;
    tabs?: TabInfo[];
    activeTabId?: string;
    streamingText?: string;
    streamingThinking?: string;
    isThinking?: boolean;
    thinkingStartTime?: number;
    streamingThinkingDuration?: number;
    queuedMessages?: string[];
    pendingAttachments?: PendingAttachmentPreview[];
    planMode?: PlanModeInfo;
}

export interface PendingAttachmentPreview {
    id: string;
    displayName: string;
    isImage: boolean;
    previewDataUrl?: string;
    absolutePath?: string;
}

export interface ModelInfo {
    provider: string;
    id: string;
    name?: string;
}

export interface SkillInfo {
    name: string;
    description: string;
    filePath: string;
    source: string;
    disableModelInvocation: boolean;
}

export interface SlashCommandListItem {
    invocation: string;
    name: string;
    description?: string;
    source: 'builtin' | 'extension' | 'skill';
}

export interface SessionInfo {
    id: string;
    name?: string;
    path: string;
    lastModified?: number;
}

export interface WorkspaceFileMatch {
    relativePath: string;
    absolutePath: string;
    basename: string;
}

// Webview -> Extension messages
export type ClientMessage =
    | { type: 'prompt'; text: string; attachments?: any[] }
    | { type: 'steer'; text: string }
    | { type: 'pickAttachments' }
    | { type: 'addPastedImages'; items: { mimeType: string; dataBase64: string; name?: string }[] }
    | { type: 'addDroppedTextFiles'; files: { name: string; text: string }[] }
    | { type: 'dropFilePaths'; paths: string[] }
    | { type: 'dropAttachFailed'; mimeTypes: string[] }
    | { type: 'searchWorkspaceFiles'; requestId: string; query: string }
    | { type: 'removeAttachment'; id: string }
    | { type: 'followUp'; text: string }
    | { type: 'abort' }
    | { type: 'getModels' }
    | { type: 'setModel'; provider: string; modelId: string }
    | { type: 'setThinkingLevel'; level: string }
    | { type: 'newSession' }
    | { type: 'loadSession'; sessionPath: string }
    | { type: 'getSessions' }
    | { type: 'getState' }
    | { type: 'approveToolCall'; toolCallId: string }
    | { type: 'rejectToolCall'; toolCallId: string }
    | { type: 'openFile'; filePath: string }
    | { type: 'openDiff'; filePath: string; toolCallId: string }
    | { type: 'undoFileChange'; filePath: string; toolCallId: string }
    | { type: 'restoreCheckpoint'; messageIndex: number }
    | { type: 'redoCheckpoint' }
    | { type: 'confirmAction'; action: string; message: string; payload?: any }
    | { type: 'createTab' }
    | { type: 'closeTab'; tabId: string }
    | { type: 'switchTab'; tabId: string }
    | { type: 'openSettings' }
    | { type: 'getSkills' }
    | { type: 'getSlashCommands' }
    | { type: 'queueMessage'; text: string }
    | { type: 'editQueuedMessage'; index: number; text: string }
    | { type: 'removeQueuedMessage'; index: number }
    | { type: 'cancelQueue' }
    | { type: 'setAgentMode'; mode: 'agent' | 'plan' }
    | { type: 'implementPlan' }
    | { type: 'openPlanDocument' }
    | {
          type: 'extensionUiResponse';
          id: string;
          cancelled?: boolean;
          value?: string;
          confirmed?: boolean;
      };

// Settings webview -> Extension messages
export type SettingsClientMessage =
    | { type: 'getSettings' }
    | { type: 'updateSetting'; key: string; value: any }
    | { type: 'setApiKey'; provider: string; key: string }
    | { type: 'clearApiKey'; provider: string }
    | { type: 'getSkills' }
    | { type: 'updatePiDefaults'; provider?: string; model?: string; thinkingLevel?: string }
    | { type: 'addPiPackage'; source: string }
    | { type: 'removePiPackage'; index: number }
    | { type: 'addPiExtensionPath'; path: string }
    | { type: 'removePiExtensionPath'; index: number }
    | { type: 'addPiSkillPath'; path: string }
    | { type: 'removePiSkillPath'; index: number }
    | { type: 'setPiEnableSkillCommands'; enabled: boolean }
    | { type: 'setPiSteeringMode'; mode: 'all' | 'one-at-a-time' }
    | { type: 'setPiFollowUpMode'; mode: 'all' | 'one-at-a-time' }
    | { type: 'openPiAgentFile'; file: 'settings' | 'auth' | 'mcp' }
    | { type: 'reloadPiSession' }
    | { type: 'browsePiCatalog' }
    | { type: 'openExternalUrl'; url: string }
    | { type: 'getMcpSnapshot' }
    | { type: 'setMcpServerEnabled'; scope: McpScopeId; serverName: string; enabled: boolean }
    | { type: 'testMcpServer'; serverName: string }
    | { type: 'testAllMcpServers' }
    | { type: 'runPiLogin' }
    | { type: 'runPiLogout' };

// Extension -> Webview messages
export type ServerMessage =
    | { type: 'ready' }
    | { type: 'stateSync'; state: SerializedAgentState }
    | { type: 'agentEvent'; event: any }
    | { type: 'models'; models: ModelInfo[]; current?: ModelInfo; thinkingLevel?: string }
    | { type: 'modelChanged'; model: ModelInfo; thinkingLevel?: string }
    | { type: 'sessions'; sessions: SessionInfo[]; currentSessionId?: string }
    | { type: 'sessionChanged'; sessionId: string }
    | { type: 'fileChange'; change: FileChangeInfo }
    | { type: 'confirmResult'; action: string; confirmed: boolean; payload?: any }
    | { type: 'toolCallPending'; pending: ToolCallPendingInfo }
    | { type: 'toolCallResolved'; toolCallId: string }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'slashCommands'; commands: SlashCommandListItem[] }
    | { type: 'error'; message: string }
    | { type: 'extensionUiRequest'; request: ExtensionUiRequestPayload }
    | { type: 'extensionUiDismiss'; id: string }
    | {
          type: 'workspaceFiles';
          requestId: string;
          files: WorkspaceFileMatch[];
      };

// Extension -> Settings webview messages
export type SettingsServerMessage =
    | { type: 'settings'; data: SettingsData }
    | { type: 'settingChanged'; key: string; value: any }
    | { type: 'skills'; skills: SkillInfo[] }
    | { type: 'piConfigUpdated' }
    | { type: 'success'; message: string }
    | { type: 'error'; message: string }
    | { type: 'mcpSnapshot'; snapshot: McpSettingsSnapshot };
