import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);
export interface PiCliInvocation {
    nodePath: string;
    cliJsPath: string;
    /** Directory containing the pi executable (prepended to PATH for child processes). */
    binDir: string;
}

/** Default Pi agent config dir (same as Pi CLI). */
export function getPiAgentDir(): string {
    const env = process.env.PI_CODING_AGENT_DIR?.trim();
    if (env) {
        return env;
    }
    return path.join(os.homedir(), '.pi', 'agent');
}

export { encodePiSessionCwd, getPiSessionDirForCwd } from './sessionCatalog';

/** Workspace folder for Pi session scope (realpath when possible, matches CLI resolvePath). */
export function resolvePiWorkspaceCwd(sessionCwd?: string): string {
    if (sessionCwd?.trim()) {
        try {
            return fs.realpathSync(sessionCwd);
        } catch {
            return path.resolve(sessionCwd);
        }
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) {
        try {
            return fs.realpathSync(folder);
        } catch {
            return path.resolve(folder);
        }
    }
    return process.cwd();
}

export async function resolvePiCliPath(): Promise<string> {
    const configured = vscode.workspace.getConfiguration('pi-agent').get<string>('cliPath', '').trim();
    if (configured) {
        if (!fs.existsSync(configured)) {
            throw new Error(`pi CLI not found at configured path: ${configured}`);
        }
        return configured;
    }

    try {
        const { stdout } = await execFileAsync('which', ['pi'], { timeout: 5000 });
        const found = stdout.trim();
        if (found) {
            return found;
        }
    } catch {
        /* fall through */
    }

    const candidates = [
        path.join(os.homedir(), '.nvm/versions/node/v22.22.2/bin/pi'),
        '/opt/homebrew/bin/pi',
        '/usr/local/bin/pi',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error('pi CLI not found on PATH. Install pi globally or set pi-agent.cliPath.');
}

function resolveSiblingNode(binDir: string): string | undefined {
    const name = process.platform === 'win32' ? 'node.exe' : 'node';
    const sibling = path.join(binDir, name);
    return fs.existsSync(sibling) ? sibling : undefined;
}

/**
 * Resolve the pi `cli.js` entry (not the `pi` shell wrapper).
 * VS Code must spawn `node cli.js --mode rpc` so native modules use pi's Node, not the extension host.
 */
async function resolvePiCliJsPath(
    nodePath: string,
    cliPath: string,
    binDir: string,
): Promise<string> {
    try {
        const resolved = fs.realpathSync(cliPath);
        if (resolved.endsWith('.js') && fs.existsSync(resolved)) {
            return resolved;
        }
    } catch {
        /* fall through */
    }

    const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    };

    try {
        const { stdout } = await execFileAsync(
            nodePath,
            [
                '-p',
                "require('path').join(require.resolve('@earendil-works/pi-coding-agent/package.json'), '../dist/cli.js')",
            ],
            { timeout: 10_000, env },
        );
        const cliJs = stdout.trim();
        if (cliJs && fs.existsSync(cliJs)) {
            return cliJs;
        }
    } catch {
        /* fall through */
    }

    if (cliPath.endsWith('.js') && fs.existsSync(cliPath)) {
        return cliPath;
    }

    throw new Error(
        `Could not resolve pi cli.js from ${cliPath}. Set pi-agent.cliPath to your global pi binary or install @earendil-works/pi-coding-agent globally.`,
    );
}

/**
 * Resolve the Node.js binary and cli.js entry for pi.
 * VS Code/Cursor extension hosts embed Node 20; pi's `#!/usr/bin/env node` shebang would pick
 * that runtime and break native modules (better-sqlite3) compiled for the user's global Node.
 */
export async function resolvePiCliInvocation(): Promise<PiCliInvocation> {
    const cliPath = await resolvePiCliPath();
    const configuredNode = vscode.workspace.getConfiguration('pi-agent').get<string>('nodePath', '').trim();
    const binDir = path.dirname(cliPath);

    let nodePath = configuredNode;
    if (nodePath && !fs.existsSync(nodePath)) {
        throw new Error(`pi-agent.nodePath not found: ${nodePath}`);
    }
    if (!nodePath) {
        nodePath = resolveSiblingNode(binDir);
    }
    if (!nodePath) {
        throw new Error(
            `Could not find Node.js next to pi (${binDir}). Set pi-agent.nodePath to your global Node binary (e.g. ~/.nvm/versions/node/v22.x/bin/node).`,
        );
    }

    const cliJsPath = await resolvePiCliJsPath(nodePath, cliPath, binDir);
    return { nodePath, cliJsPath, binDir };
}

/** Child-process env: user's pi Node wins over the extension host's embedded Node. */
export function piCliChildEnv(invocation: PiCliInvocation): NodeJS.ProcessEnv {
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const existing = process.env[pathKey] ?? '';
    const prefix = invocation.binDir;
    const merged = existing.includes(prefix) ? existing : `${prefix}${path.delimiter}${existing}`;
    return { ...process.env, [pathKey]: merged };
}

export async function verifyPiCliAvailable(outputChannel: vscode.OutputChannel): Promise<boolean> {
    try {
        const invocation = await resolvePiCliInvocation();
        const { stdout: nodeVer } = await execFileAsync(invocation.nodePath, ['--version'], { timeout: 8000 });
        const { stdout: piVer } = await execFileAsync(
            invocation.nodePath,
            [invocation.cliJsPath, '--version'],
            { timeout: 8000, env: piCliChildEnv(invocation) },
        );
        outputChannel.appendLine(
            `Pi CLI OK: ${invocation.cliJsPath} (pi ${piVer.trim()}, Node ${nodeVer.trim()} via ${invocation.nodePath})`,
        );
        return true;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Pi CLI check failed: ${msg}`);
        vscode.window.showErrorMessage(`vs-pi-agent: pi CLI not available. ${msg}`);
        return false;
    }
}

export { listPiSessionsForCwd, listAllPiSessions } from './sessionCatalog';

export async function runPiCliCommand(
    args: string[],
    cwd: string,
    outputChannel?: vscode.OutputChannel,
): Promise<{ stdout: string; stderr: string }> {
    const invocation = await resolvePiCliInvocation();
    outputChannel?.appendLine(`[pi] ${invocation.nodePath} ${invocation.cliJsPath} ${args.join(' ')}`);
    const { stdout, stderr } = await execFileAsync(invocation.nodePath, [invocation.cliJsPath, ...args], {
        cwd,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: piCliChildEnv(invocation),
    });
    if (stderr.trim()) {
        outputChannel?.appendLine(`[pi stderr] ${stderr.trim()}`);
    }
    return { stdout, stderr };
}
