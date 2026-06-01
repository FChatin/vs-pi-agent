import type { PlanTodoItem } from '../shared/protocol';

const TODO_TOOL_NAME = 'todo';

export interface RpivTask {
    id: number;
    subject: string;
    description?: string;
    activeForm?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'deleted';
}

interface TaskDetailsShape {
    tasks: RpivTask[];
    nextId: number;
}

function isTaskDetails(value: unknown): value is TaskDetailsShape {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as TaskDetailsShape;
    return Array.isArray(v.tasks) && typeof v.nextId === 'number';
}

/** Latest `todo` tool snapshot from messages (rpiv-todo). */
export function extractRpivTodoTasks(session: { messages?: unknown[] } | undefined): RpivTask[] {
    if (!session?.messages?.length) {
        return [];
    }

    let latest: TaskDetailsShape | undefined;
    for (const msg of session.messages as any[]) {
        if (msg?.role !== 'toolResult' || msg.toolName !== TODO_TOOL_NAME) {
            continue;
        }
        if (isTaskDetails(msg.details)) {
            latest = msg.details;
        }
    }

    if (!latest) {
        return [];
    }

    return latest.tasks.filter((t) => t.status !== 'deleted');
}

export function rpivTasksToPlanTodos(tasks: RpivTask[]): PlanTodoItem[] {
    return tasks.map((t) => ({
        id: `rpiv-${t.id}`,
        text: formatTaskLine(t),
        done: t.status === 'completed',
    }));
}

function formatTaskLine(task: RpivTask): string {
    const parts = [task.subject.trim()];
    if (task.status === 'in_progress') {
        parts.push('(in progress)');
    }
    if (task.activeForm?.trim()) {
        parts.push(`— ${task.activeForm.trim()}`);
    }
    return parts.join(' ');
}
