import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { attachJsonlLineReader, serializeJsonLine } from './jsonl';
import { piCliChildEnv, resolvePiCliInvocation } from './piCliPaths';
import type {
    PiAgentEvent,
    PiRpcOutbound,
    RpcCommand,
    RpcExtensionUIResponse,
    RpcImageContent,
    RpcResponse,
    RpcSessionState,
    RpcSlashCommand,
} from './rpcTypes';

export type PiRpcBridgeListener = (event: PiRpcOutbound) => void;

interface PendingRequest {
    resolve: (response: RpcResponse) => void;
    reject: (error: Error) => void;
}

export class PiRpcBridge {
    private _process: ChildProcessWithoutNullStreams | null = null;
    private _stopReading: (() => void) | null = null;
    private _listeners = new Set<PiRpcBridgeListener>();
    private _pending = new Map<string, PendingRequest>();
    private _requestId = 0;
    private _stderr = '';
    private _exitError: Error | null = null;

    on(listener: PiRpcBridgeListener): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    private _emit(event: PiRpcOutbound): void {
        for (const listener of this._listeners) {
            try {
                listener(event);
            } catch {
                /* listener error */
            }
        }
    }

    async start(cwd: string, extraArgs: string[] = []): Promise<void> {
        if (this._process) {
            return;
        }

        const invocation = await resolvePiCliInvocation();
        const args = ['--mode', 'rpc', ...extraArgs];

        this._exitError = null;
        this._stderr = '';

        const child = spawn(invocation.nodePath, [invocation.cliJsPath, ...args], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: piCliChildEnv(invocation),
        });
        this._process = child;

        child.stderr.on('data', (data: Buffer) => {
            this._stderr += data.toString();
        });

        child.on('exit', (code, signal) => {
            if (code !== 0 && code !== null) {
                this._exitError = new Error(
                    `Pi RPC process exited (code=${code}, signal=${signal}). Stderr: ${this._stderr.slice(-2000)}`,
                );
            }
            this._rejectPending(this._exitError ?? new Error('Pi RPC process exited'));
        });

        child.on('error', (error) => {
            this._exitError = new Error(`Pi RPC process error: ${error.message}`);
            this._rejectPending(this._exitError);
        });

        child.stdin.on('error', (error) => {
            this._exitError = new Error(`Pi RPC stdin error: ${error.message}`);
            this._rejectPending(this._exitError);
        });

        this._stopReading = attachJsonlLineReader(child.stdout, (line) => {
            this._handleLine(line);
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        if (child.exitCode !== null) {
            throw this._exitError ?? new Error(`Pi RPC exited immediately (code=${child.exitCode})`);
        }
    }

    get isStarted(): boolean {
        return this._process !== null;
    }

    getStderr(): string {
        return this._stderr;
    }

    writeLine(obj: unknown): void {
        const stdin = this._process?.stdin;
        if (!stdin?.writable) {
            throw new Error('Pi RPC stdin is not writable');
        }
        stdin.write(serializeJsonLine(obj));
    }

    sendExtensionUiResponse(response: RpcExtensionUIResponse): void {
        this.writeLine(response);
    }

    async stop(): Promise<void> {
        this._stopReading?.();
        this._stopReading = null;

        if (this._process) {
            try {
                this._process.stdin.end();
            } catch {
                /* ignore */
            }
            this._process.kill('SIGTERM');
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    this._process?.kill('SIGKILL');
                    resolve();
                }, 2000);
                this._process?.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
            this._process = null;
        }

        this._pending.clear();
        this._listeners.clear();
    }

    private _handleLine(line: string): void {
        try {
            const data = JSON.parse(line) as RpcResponse | PiAgentEvent | PiRpcOutbound;

            if (data.type === 'response' && data.id && this._pending.has(data.id)) {
                const pending = this._pending.get(data.id)!;
                this._pending.delete(data.id);
                pending.resolve(data as RpcResponse);
                return;
            }

            this._emit(data as PiRpcOutbound);
        } catch {
            /* ignore non-JSON */
        }
    }

    private _rejectPending(error: Error): void {
        for (const pending of this._pending.values()) {
            pending.reject(error);
        }
        this._pending.clear();
    }

    private async _send(command: RpcCommand): Promise<RpcResponse> {
        if (!this._process?.stdin) {
            throw new Error('Pi RPC bridge not started');
        }
        if (this._exitError) {
            throw this._exitError;
        }
        if (this._process.exitCode !== null) {
            throw this._exitError ?? new Error('Pi RPC process exited');
        }

        const id = `req_${++this._requestId}`;
        const fullCommand = { ...command, id };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    reject(new Error(`Timeout waiting for ${command.type}`));
                }
            }, 60_000);

            this._pending.set(id, {
                resolve: (response) => {
                    clearTimeout(timeout);
                    resolve(response);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            });

            try {
                this.writeLine(fullCommand);
            } catch (err: unknown) {
                this._pending.delete(id);
                clearTimeout(timeout);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    private _data<T>(response: RpcResponse): T {
        if (!response.success) {
            throw new Error(response.error ?? 'RPC command failed');
        }
        return response.data as T;
    }

    async prompt(
        message: string,
        images?: RpcImageContent[],
        streamingBehavior?: 'steer' | 'followUp',
    ): Promise<void> {
        await this._send({ type: 'prompt', message, images, streamingBehavior });
    }

    async steer(message: string, images?: RpcImageContent[]): Promise<void> {
        await this._send({ type: 'steer', message, images });
    }

    async followUp(message: string, images?: RpcImageContent[]): Promise<void> {
        await this._send({ type: 'follow_up', message, images });
    }

    async abort(): Promise<void> {
        await this._send({ type: 'abort' });
    }

    async newSession(): Promise<{ cancelled: boolean }> {
        return this._data(await this._send({ type: 'new_session' }));
    }

    async getState(): Promise<RpcSessionState> {
        return this._data(await this._send({ type: 'get_state' }));
    }

    async setModel(provider: string, modelId: string): Promise<void> {
        this._data(await this._send({ type: 'set_model', provider, modelId }));
    }

    async cycleModel(): Promise<{ model: { provider: string; id: string }; thinkingLevel: string } | null> {
        return this._data(await this._send({ type: 'cycle_model' }));
    }

    async getAvailableModels(): Promise<Array<{ provider: string; id: string; contextWindow?: number }>> {
        const data = this._data<{ models: Array<{ provider: string; id: string; contextWindow?: number }> }>(
            await this._send({ type: 'get_available_models' }),
        );
        return data.models;
    }

    async setThinkingLevel(level: string): Promise<void> {
        await this._send({ type: 'set_thinking_level', level });
    }

    async cycleThinkingLevel(): Promise<{ level: string } | null> {
        return this._data(await this._send({ type: 'cycle_thinking_level' }));
    }

    async compact(customInstructions?: string): Promise<{ tokensBefore?: number; tokensAfter?: number }> {
        return this._data(await this._send({ type: 'compact', customInstructions }));
    }

    async bash(command: string, excludeFromContext?: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return this._data(await this._send({ type: 'bash', command, excludeFromContext }));
    }

    async abortBash(): Promise<void> {
        await this._send({ type: 'abort_bash' });
    }

    async getSessionStats(): Promise<import('./rpcTypes').RpcSessionStats> {
        return this._data(await this._send({ type: 'get_session_stats' }));
    }

    async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
        return this._data(await this._send({ type: 'switch_session', sessionPath }));
    }

    async getMessages(): Promise<unknown[]> {
        const data = this._data<{ messages: unknown[] }>(await this._send({ type: 'get_messages' }));
        return data.messages;
    }

    async getCommands(): Promise<RpcSlashCommand[]> {
        const data = this._data<{ commands: RpcSlashCommand[] }>(await this._send({ type: 'get_commands' }));
        return data.commands;
    }

    async setSessionName(name: string): Promise<void> {
        await this._send({ type: 'set_session_name', name });
    }

    async exportHtml(outputPath?: string): Promise<{ path: string }> {
        return this._data(await this._send({ type: 'export_html', outputPath }));
    }

    async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
        await this._send({ type: 'set_steering_mode', mode });
    }

    async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
        await this._send({ type: 'set_follow_up_mode', mode });
    }

    async setAutoCompaction(enabled: boolean): Promise<void> {
        await this._send({ type: 'set_auto_compaction', enabled });
    }

    async setAutoRetry(enabled: boolean): Promise<void> {
        await this._send({ type: 'set_auto_retry', enabled });
    }

    async abortRetry(): Promise<void> {
        await this._send({ type: 'abort_retry' });
    }

    async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
        return this._data(await this._send({ type: 'fork', entryId }));
    }

    async clone(): Promise<{ cancelled: boolean }> {
        return this._data(await this._send({ type: 'clone' }));
    }

    async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
        const data = this._data<{ messages: Array<{ entryId: string; text: string }> }>(
            await this._send({ type: 'get_fork_messages' }),
        );
        return data.messages;
    }

    async getLastAssistantText(): Promise<string | null> {
        const data = this._data<{ text: string | null }>(
            await this._send({ type: 'get_last_assistant_text' }),
        );
        return data.text;
    }
}
