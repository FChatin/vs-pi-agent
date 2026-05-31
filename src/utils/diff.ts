/**
 * Minimal unified diff implementation. Produces a unified diff string
 * from two text inputs using a simple LCS-based line diff.
 */

export interface DiffStats {
    added: number;
    removed: number;
}

export function computeUnifiedDiff(
    oldText: string,
    newText: string,
    filePath: string,
    contextLines = 3,
): { diff: string; stats: DiffStats } {
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);

    const edits = myersDiff(oldLines, newLines);

    let added = 0;
    let removed = 0;
    for (const e of edits) {
        if (e.type === 'add') added++;
        else if (e.type === 'del') removed++;
    }

    const hunks = buildHunks(edits, oldLines, newLines, contextLines);
    if (hunks.length === 0) {
        return { diff: '', stats: { added: 0, removed: 0 } };
    }

    const lines: string[] = [
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
    ];

    for (const hunk of hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
        lines.push(...hunk.lines);
    }

    return { diff: lines.join('\n'), stats: { added, removed } };
}

type EditOp = { type: 'eq'; oldIdx: number; newIdx: number }
    | { type: 'del'; oldIdx: number }
    | { type: 'add'; newIdx: number };

function myersDiff(a: string[], b: string[]): EditOp[] {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const vSize = 2 * max + 1;
    const v = new Int32Array(vSize);
    v.fill(-1);
    const offset = max;
    v[offset + 1] = 0;

    const trace: Int32Array[] = [];

    outer:
    for (let d = 0; d <= max; d++) {
        const snap = new Int32Array(v);
        trace.push(snap);
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
                x = v[offset + k + 1];
            } else {
                x = v[offset + k - 1] + 1;
            }
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                break outer;
            }
        }
    }

    const ops: EditOp[] = [];
    let x = n;
    let y = m;

    for (let d = trace.length - 1; d > 0; d--) {
        const prev = trace[d - 1];
        const k = x - y;
        let prevK: number;
        if (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) {
            prevK = k + 1;
        } else {
            prevK = k - 1;
        }
        const prevX = prev[offset + prevK];
        const prevY = prevX - prevK;

        while (x > prevX && y > prevY) {
            x--;
            y--;
            ops.push({ type: 'eq', oldIdx: x, newIdx: y });
        }

        if (x === prevX && y > prevY) {
            y--;
            ops.push({ type: 'add', newIdx: y });
        } else if (y === prevY && x > prevX) {
            x--;
            ops.push({ type: 'del', oldIdx: x });
        }
    }

    while (x > 0 && y > 0) {
        x--;
        y--;
        ops.push({ type: 'eq', oldIdx: x, newIdx: y });
    }
    while (x > 0) {
        x--;
        ops.push({ type: 'del', oldIdx: x });
    }
    while (y > 0) {
        y--;
        ops.push({ type: 'add', newIdx: y });
    }

    ops.reverse();
    return ops;
}

interface Hunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
}

function buildHunks(edits: EditOp[], oldLines: string[], newLines: string[], ctx: number): Hunk[] {
    const changeIndices: number[] = [];
    for (let i = 0; i < edits.length; i++) {
        if (edits[i].type !== 'eq') changeIndices.push(i);
    }
    if (changeIndices.length === 0) return [];

    const groups: number[][] = [];
    let currentGroup: number[] = [changeIndices[0]];

    for (let i = 1; i < changeIndices.length; i++) {
        if (changeIndices[i] - changeIndices[i - 1] <= ctx * 2 + 1) {
            currentGroup.push(changeIndices[i]);
        } else {
            groups.push(currentGroup);
            currentGroup = [changeIndices[i]];
        }
    }
    groups.push(currentGroup);

    const hunks: Hunk[] = [];
    for (const group of groups) {
        const start = Math.max(0, group[0] - ctx);
        const end = Math.min(edits.length - 1, group[group.length - 1] + ctx);

        const lines: string[] = [];
        let oldStart = Infinity;
        let newStart = Infinity;
        let oldCount = 0;
        let newCount = 0;

        for (let i = start; i <= end; i++) {
            const op = edits[i];
            if (op.type === 'eq') {
                lines.push(` ${oldLines[op.oldIdx] ?? ''}`);
                oldStart = Math.min(oldStart, op.oldIdx + 1);
                newStart = Math.min(newStart, op.newIdx + 1);
                oldCount++;
                newCount++;
            } else if (op.type === 'del') {
                lines.push(`-${oldLines[op.oldIdx] ?? ''}`);
                oldStart = Math.min(oldStart, op.oldIdx + 1);
                oldCount++;
            } else {
                lines.push(`+${newLines[op.newIdx] ?? ''}`);
                newStart = Math.min(newStart, op.newIdx + 1);
                newCount++;
            }
        }

        if (oldStart === Infinity) oldStart = 1;
        if (newStart === Infinity) newStart = 1;

        hunks.push({ oldStart, oldCount, newStart, newCount, lines });
    }

    return hunks;
}

function splitLines(text: string): string[] {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}
