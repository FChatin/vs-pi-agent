import type { RpivTask } from './rpivTodoSync';

export const PLAN_PROGRESS_HEADING = '## Progress';

const PROGRESS_HEADING_RE = /^##\s+Progress\s*$/im;

/** Plan body without the auto-synced Progress section. */
export function stripPlanProgressSection(markdown: string): string {
    const lines = markdown.split('\n');
    const out: string[] = [];
    let inProgress = false;

    for (const line of lines) {
        if (PROGRESS_HEADING_RE.test(line.trim())) {
            inProgress = true;
            continue;
        }
        if (inProgress && /^##\s+/.test(line.trim())) {
            inProgress = false;
        }
        if (!inProgress) {
            out.push(line);
        }
    }

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function formatRpivTasksMarkdown(tasks: RpivTask[]): string {
    if (tasks.length === 0) {
        return '_No tasks yet._';
    }

    const lines: string[] = [
        '_Synced from agent todo tool — updates while implementing._',
        '',
    ];

    for (const task of tasks) {
        const checked = task.status === 'completed' ? 'x' : ' ';
        let label = task.subject.trim();
        if (task.status === 'in_progress') {
            label = `**${label}** _(in progress)_`;
        }
        lines.push(`- [${checked}] ${label}`);
        if (task.description?.trim()) {
            lines.push(`  - ${task.description.trim()}`);
        }
    }

    return lines.join('\n');
}

/** Original plan + live Progress section for Pi Plan.md editor. */
export function mergePlanWithRpivTodos(basePlan: string, tasks: RpivTask[]): string {
    const base = stripPlanProgressSection(basePlan).trim();
    if (tasks.length === 0) {
        return base;
    }

    const progress = formatRpivTasksMarkdown(tasks);
    if (!base) {
        return `${PLAN_PROGRESS_HEADING}\n\n${progress}`;
    }

    return `${base}\n\n${PLAN_PROGRESS_HEADING}\n\n${progress}`;
}
