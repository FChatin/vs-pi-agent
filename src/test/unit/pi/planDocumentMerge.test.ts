import { describe, it, expect } from 'vitest';
import { mergePlanWithRpivTodos, stripPlanProgressSection } from '../../../pi/planDocumentMerge';
import type { RpivTask } from '../../../pi/rpivTodoSync';

describe('planDocumentMerge', () => {
    it('strips existing Progress section', () => {
        const md = '# Plan\n\nStep 1\n\n## Progress\n\n- [x] old\n\n## Other\n\nTail';
        expect(stripPlanProgressSection(md)).not.toContain('## Progress');
        expect(stripPlanProgressSection(md)).toContain('## Other');
    });

    it('appends Progress with checkbox tasks', () => {
        const tasks: RpivTask[] = [
            { id: 1, subject: 'Update globals.css', status: 'completed' },
            { id: 2, subject: 'Wire components', status: 'in_progress' },
        ];
        const merged = mergePlanWithRpivTodos('# My plan\n\n- [ ] step', tasks);
        expect(merged).toContain('## Progress');
        expect(merged).toContain('- [x] Update globals.css');
        expect(merged).toContain('in progress');
    });
});
