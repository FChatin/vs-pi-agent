import { describe, expect, it } from 'vitest';
import { scoreFileMatch } from '../../../shared/workspaceFileSearchScore';

describe('scoreFileMatch', () => {
    it('prefers exact path matches', () => {
        const exact = scoreFileMatch(
            { relativePath: 'src/foo/bar.ts', basename: 'bar.ts' },
            'src/foo/bar.ts',
        );
        const loose = scoreFileMatch(
            { relativePath: 'other/baz.ts', basename: 'baz.ts' },
            'bar',
        );
        expect(exact).toBeGreaterThan(loose);
    });
});
