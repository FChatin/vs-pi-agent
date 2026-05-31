import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { PlanModeInfo, PlanTodoItem } from '../shared/protocol';

const PLAN_STATE_ENTRY = 'plan-mode-state';
/** Built-in pi-coding-agent example extension uses this type. */
const PLAN_STATE_ENTRY_LEGACY = 'plan-mode';
const PROPOSED_PLAN_MESSAGE = 'proposed-plan';
const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
interface RawPlanModeState {
    enabled?: boolean;
    latestPlan?: string;
    awaitingAction?: boolean;
}

/** Latest persisted plan-mode snapshot (matches @narumitw/pi-plan-mode restoreState). */
function readLatestPlanStateEntry(session: AgentSession): RawPlanModeState | undefined {
    let last: RawPlanModeState | undefined;
    try {
        for (const entry of session.sessionManager.getEntries()) {
            if (entry.type !== 'custom' || !entry.data) {
                continue;
            }
            if (entry.customType === PLAN_STATE_ENTRY) {
                last = entry.data as RawPlanModeState;
            } else if (entry.customType === PLAN_STATE_ENTRY_LEGACY) {
                const legacy = entry.data as { enabled?: boolean; todos?: unknown[]; executing?: boolean };
                last = {
                    enabled: legacy.enabled === true,
                    awaitingAction: false,
                    latestPlan: undefined,
                };
            }
        }
    } catch {
        // ignore
    }
    return last;
}

export function readPlanModeInfo(session: AgentSession | undefined): PlanModeInfo {
    if (!session) {
        return emptyPlanMode();
    }

    const persisted = readLatestPlanStateEntry(session);
    let raw: RawPlanModeState = persisted ?? { enabled: false, awaitingAction: false };

    const fromMessages = extractPlanFromMessages(session.messages ?? []);
    const fromBranch = extractPlanFromBranch(session);
    const planMarkdown = (raw.latestPlan?.trim() || fromBranch || fromMessages || '').trim();
    // Trust persisted plan-mode-state only — do not infer from tools (stale plan_mode_question after /plan exit).
    const enabled = raw.enabled === true;
    const awaitingAction = raw.awaitingAction === true;
    const hasPlan = planMarkdown.length > 0;

    let statusLabel: PlanModeInfo['statusLabel'] = 'off';
    if (enabled && hasPlan && awaitingAction) {
        statusLabel = 'ready';
    } else if (enabled) {
        statusLabel = 'planning';
    }

    return {
        enabled,
        hasPlan,
        awaitingAction,
        statusLabel,
        planMarkdown,
        todos: parsePlanTodos(planMarkdown),
    };
}

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

function extractPlanFromBranch(session: AgentSession): string {
    let last = '';
    try {
        for (const entry of session.sessionManager.getBranch()) {
            if (entry.type !== 'custom_message' || entry.customType !== PROPOSED_PLAN_MESSAGE) {
                continue;
            }
            const content = (entry as { content?: unknown }).content;
            if (typeof content === 'string') {
                last = stripProposedPlanDisplay(content);
            }
        }
    } catch {
        // ignore
    }
    return last;
}

function extractPlanFromMessages(messages: any[]): string {
    let last = '';
    for (const msg of messages) {
        if (msg?.customType === PROPOSED_PLAN_MESSAGE) {
            const c = msg.content;
            if (typeof c === 'string') {
                last = stripProposedPlanDisplay(c);
            }
        }
        if (msg?.role === 'assistant') {
            const text = messageText(msg);
            const match = PROPOSED_PLAN_PATTERN.exec(text);
            if (match?.[1]) {
                last = match[1].trim();
            }
        }
    }
    return last;
}

function stripProposedPlanDisplay(content: string): string {
    return content.replace(/^\*\*Proposed Plan\*\*\s*/i, '').trim();
}

function messageText(msg: any): string {
    const content = msg.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n');
    }
    return '';
}

/** Markdown checkboxes and numbered steps under common headings. */
export function parsePlanTodos(markdown: string): PlanTodoItem[] {
    if (!markdown.trim()) {
        return [];
    }

    const lines = markdown.split('\n');
    const todos: PlanTodoItem[] = [];
    let id = 0;

    for (const line of lines) {
        const checkbox = /^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
        if (checkbox) {
            todos.push({
                id: `todo-${++id}`,
                text: checkbox[3].trim(),
                done: checkbox[2].toLowerCase() === 'x',
            });
            continue;
        }

        const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
        if (numbered) {
            todos.push({
                id: `step-${numbered[1]}`,
                text: numbered[2].trim(),
                done: false,
            });
        }
    }

    return todos;
}

export function buildImplementPlanPrompt(planMarkdown: string): string {
    return (
        'Plan mode is now disabled. Full tool access is restored. ' +
        `Implement this proposed plan now:\n\n${planMarkdown}`
    );
}
