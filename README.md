# vs-pi-agent

Pi coding agent in VS Code — sidebar chat, diffs, checkpoints, plan mode, and Pi CLI sync.

**Repository:** [github.com/FChatin/vs-pi-agent](https://github.com/FChatin/vs-pi-agent)

## Requirements

- **Pi CLI** must be installed (`npm install -g pi-agent` or `brew install pi-agent`)
- VS Code or VSCodium

The extension communicates with Pi via `pi --mode rpc`. It does not bundle the SDK — everything runs through the CLI. No Pi CLI = extension won't work.

## Features

**Chat & agents** — send messages, receive streaming responses, view thinking steps  
**Diff & undo** — see unified diffs for every file change; undo or redo changes per turn  
**Checkpoints** — roll back to any previous turn; redo after rollback  
**Plan mode** — Pi drafts a plan in a VS Code document; apply complete sections with one click  
**Attachments** — drag files or paste images directly into chat  
**Slash commands** — `/login`, `/logout`, `/model`, `/new`, `/settings`, `/reload`, `/compact`, `/resume`, `/session`  
**MCP config import** — bring MCP server configs from Cursor, Zed, or VS Code  
**Settings panel** — configure auth, thinking level, workspace scope, sync mode  
**Status bar** — connection status at a glance  
**Session catalog** — list, resume, or switch between sessions  
**Checkpoint + Todo merge** — Pi-managed plan todos merged into VS Code with task markers  

## Configuration

| Setting | Default | Description |
|---|---|---|
| `pi-agent.authProvider` | `pi-cli` | Authentication provider (`pi-cli`) |
| `pi-agent.syncWithPiCli` | `true` | Use `~/.pi/agent` for config, sessions, skills |
| `pi-agent.cliPath` | auto | Force a specific `pi` binary path |
| `pi-agent.thinkingLevel` | `off` | Thinking level (`off`, `fast`, `deep`) |
| `pi-agent.workspaceScope` | `current` | Session scope (`current` or `all`) |
| `pi-agent.tools` | built-in | Enabled tool groups |
| `pi-agent.modelProvider` | auto | Preferred model provider |
| `pi-agent.modelId` | auto | Preferred model |
| `pi-agent.maxTokens` | auto | Max tokens per response |
| `pi-agent.autoApproveTools` | `ask` | Tool auto-approval (`ask`, `all`, `none`) |
| `pi-agent.promptTemplates` | `[]` | Custom prompt prefixes |
| `pi-agent.mcpConfigImportPaths` | `[]` | Paths to import MCP configs from |

## Architecture

```
VS Code extension
    │
    └─── starts ──────────>  pi --mode rpc  (Pi CLI subprocess)
                               │
                               ├──  /login  →  Pi CLI handles auth
                               ├──  /model  →  Pi CLI manages providers
                               ├──  thinking →  streaming events over JSON-RPC
                               └──  tools  →  executed by Pi CLI
```

Extension writes to `~/.pi/agent/settings.json` (same as CLI). Sessions, skills, and packages live under `~/.pi/agent`.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open sidebar | `Ctrl+Shift+P` → "Pi: Open Chat" |
| New session | `Ctrl+Shift+P` → "Pi: New Session" |
| Resume session | `Ctrl+Shift+P` → "Pi: Resume Session" |
| Apply plan section | `Ctrl+Shift+A` |
| Reject plan section | `Ctrl+Shift+R` |

## Quick start

1. Install Pi CLI: `npm install -g pi-agent`
2. Install extension: **Install from VSIX** in VS Code Extensions
3. Set provider: `/login` or Settings → **Configure provider**
4. Start chatting

## Version history

### v0.2.40
- Pi CLI RPC mode (Pi CLI required, no SDK bundling)
- Settings panel with auth flow, thinking level, MCP import
- Diff & undo per file-edit turn
- Checkpoint & rollback per conversation turn
- Plan mode with VS Code document integration
- MCP config import from Cursor / Zed / VS Code
