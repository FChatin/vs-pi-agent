import { describe, expect, it } from 'vitest';
import {
    buildSessionDisplayList,
    buildSessionTree,
    buildSessionTreePrefix,
    encodePiSessionCwd,
    flattenSessionTree,
    getPiSessionDirForCwd,
} from '../../../pi/sessionCatalog';
import type { SessionInfo } from '../../../shared/protocol';

function session(
    id: string,
    path: string,
    parentSessionPath?: string,
    lastModified = 1000,
): SessionInfo {
    return {
        id,
        name: id,
        path,
        parentSessionPath,
        lastModified,
        messageCount: 1,
        firstMessage: `message ${id}`,
    };
}

describe('encodePiSessionCwd', () => {
    it('matches Pi CLI session directory encoding', () => {
        const cwd = '/Users/modernambalaj/Desktop/pi-vscode-extension';
        expect(encodePiSessionCwd(cwd)).toBe('--Users-modernambalaj-Desktop-pi-vscode-extension--');
        expect(getPiSessionDirForCwd(cwd, '/tmp/agent')).toBe(
            '/tmp/agent/sessions/--Users-modernambalaj-Desktop-pi-vscode-extension--',
        );
    });
});

describe('sessionCatalog tree', () => {
    it('builds parent/child relationships from parentSessionPath', () => {
        const sessions = [
            session('root', '/tmp/root.jsonl', undefined, 3000),
            session('child-a', '/tmp/child-a.jsonl', '/tmp/root.jsonl', 2000),
            session('child-b', '/tmp/child-b.jsonl', '/tmp/root.jsonl', 1000),
        ];

        const roots = buildSessionTree(sessions);
        expect(roots).toHaveLength(1);
        expect(roots[0].session.id).toBe('root');
        expect(roots[0].children.map((c) => c.session.id).sort()).toEqual(['child-a', 'child-b']);
    });

    it('flattens tree with connector prefixes', () => {
        const sessions = [
            session('root', '/tmp/root.jsonl'),
            session('child', '/tmp/child.jsonl', '/tmp/root.jsonl'),
        ];
        const flat = flattenSessionTree(buildSessionTree(sessions));
        expect(flat).toHaveLength(2);
        expect(flat[0].depth).toBe(0);
        expect(flat[1].depth).toBe(1);
        expect(buildSessionTreePrefix(flat[1])).toBe('└─ ');
    });

    it('recent sort returns a flat chronological list', () => {
        const sessions = [
            session('old', '/tmp/old.jsonl', undefined, 100),
            session('new', '/tmp/new.jsonl', undefined, 200),
        ];
        const display = buildSessionDisplayList(sessions, 'recent');
        expect(display.map((d) => d.session.id)).toEqual(['new', 'old']);
        expect(display.every((d) => d.depth === 0)).toBe(true);
    });
});
