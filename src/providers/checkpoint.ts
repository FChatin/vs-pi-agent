import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface CheckpointEntry {
    filesBefore: Map<string, string | null>;
}

interface SuspendedEntry {
    filesBefore: Map<string, string | null>;
    filesAfter: Map<string, string | null>;
}

export class CheckpointManager implements vscode.Disposable {
    private _checkpoints = new Map<number, CheckpointEntry>();
    private _suspended = new Map<number, SuspendedEntry>();
    private _currentTurn = -1;
    private _rollbackPoint: number | null = null;

    get rollbackPoint(): number | null {
        return this._rollbackPoint;
    }

    startTurn(messageIndex: number): void {
        if (this._rollbackPoint !== null) {
            this.discardSuspended();
        }
        this._currentTurn = messageIndex;
        if (!this._checkpoints.has(messageIndex)) {
            this._checkpoints.set(messageIndex, { filesBefore: new Map() });
        }
    }

    recordFileState(filePath: string, content: string | null): void {
        if (this._currentTurn < 0) return;
        const entry = this._checkpoints.get(this._currentTurn);
        if (!entry) return;
        const absPath = this._resolveAbsolute(filePath);
        if (!entry.filesBefore.has(absPath)) {
            entry.filesBefore.set(absPath, content);
        }
    }

    async restoreCheckpoint(messageIndex: number): Promise<string[]> {
        const restoredFiles: string[] = [];
        const turnsToUndo = [...this._checkpoints.keys()]
            .filter(idx => idx > messageIndex)
            .sort((a, b) => a - b);

        const filesToRestore = new Map<string, string | null>();

        for (const turnIdx of turnsToUndo) {
            const entry = this._checkpoints.get(turnIdx);
            if (!entry) continue;
            for (const [filePath, content] of entry.filesBefore) {
                if (!filesToRestore.has(filePath)) {
                    filesToRestore.set(filePath, content);
                }
            }
        }

        // Capture current on-disk state before restoring, so we can redo later
        for (const turnIdx of turnsToUndo) {
            const entry = this._checkpoints.get(turnIdx);
            if (!entry) continue;

            const filesAfter = new Map<string, string | null>();
            for (const [filePath] of entry.filesBefore) {
                try {
                    if (fs.existsSync(filePath)) {
                        filesAfter.set(filePath, fs.readFileSync(filePath, 'utf-8'));
                    } else {
                        filesAfter.set(filePath, null);
                    }
                } catch {
                    filesAfter.set(filePath, null);
                }
            }

            this._suspended.set(turnIdx, {
                filesBefore: entry.filesBefore,
                filesAfter,
            });
            this._checkpoints.delete(turnIdx);
        }

        // Restore files to their pre-edit state
        for (const [filePath, content] of filesToRestore) {
            try {
                if (content === null) {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        restoredFiles.push(filePath);
                    }
                } else {
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    fs.writeFileSync(filePath, content, 'utf-8');
                    restoredFiles.push(filePath);
                }
            } catch {
                // best-effort
            }
        }

        this._rollbackPoint = messageIndex;
        return restoredFiles;
    }

    async redoCheckpoint(): Promise<string[]> {
        if (this._rollbackPoint === null) return [];

        const redoneFiles: string[] = [];
        const turnsToRedo = [...this._suspended.keys()].sort((a, b) => a - b);

        for (const turnIdx of turnsToRedo) {
            const entry = this._suspended.get(turnIdx)!;

            // Write back the "after" state
            for (const [filePath, content] of entry.filesAfter) {
                try {
                    if (content === null) {
                        if (fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                            redoneFiles.push(filePath);
                        }
                    } else {
                        const dir = path.dirname(filePath);
                        if (!fs.existsSync(dir)) {
                            fs.mkdirSync(dir, { recursive: true });
                        }
                        fs.writeFileSync(filePath, content, 'utf-8');
                        redoneFiles.push(filePath);
                    }
                } catch {
                    // best-effort
                }
            }

            // Move back to active checkpoints
            this._checkpoints.set(turnIdx, { filesBefore: entry.filesBefore });
        }

        this._suspended.clear();
        this._rollbackPoint = null;
        return redoneFiles;
    }

    discardSuspended(): void {
        this._suspended.clear();
        this._rollbackPoint = null;
    }

    getCheckpointTurns(): number[] {
        return [...this._checkpoints.keys()].sort((a, b) => a - b);
    }

    clearAll(): void {
        this._checkpoints.clear();
        this._suspended.clear();
        this._currentTurn = -1;
        this._rollbackPoint = null;
    }

    dispose(): void {
        this.clearAll();
    }

    private _resolveAbsolute(filePath: string): string {
        if (path.isAbsolute(filePath)) return filePath;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return root ? path.join(root, filePath) : path.resolve(filePath);
    }
}
