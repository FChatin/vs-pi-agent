# vs-pi-agent

Pi coding agent in VS Code — sidebar chat, session management, diffs, checkpoints, and full Pi CLI integration.

**Repository:** [github.com/FChatin/vs-pi-agent](https://github.com/FChatin/vs-pi-agent)

## How it works

The extension spawns the Pi CLI as a local subprocess and communicates with it over **stdin/stdout JSONL RPC**. Everything runs through the real CLI — no bundled SDK.

```
VS Code ←→ Extension ←→ RPC bridge ←→ pi CLI subprocess
                                     ↳ reads ~/.pi/agent/config
                                     ↳ writes session logs to ~/.pi/agent/sessions/
```

## Requirements

- [Pi CLI](https://github.com/badlogic/pi-mono) installed and on PATH
- VS Code 1.100+
- Model provider credentials — see [Authentication](#authentication)

## Quick start

1. Install the extension (VSIX or development build below).
2. Make sure `pi` is installed: `npm i -g @earendil-works/pi-coding-agent`
3. Open the **vs-pi-agent** sidebar.
4. Configure a provider:
   - **Settings → Configure provider (/login)**, or
   - type `/login` in chat, or
   - Command Palette → **vs-pi-agent: Login (/login)**
5. Pick a model from the status bar or with `/model`.
6. Start chatting.

## Features

- **Sidebar chat** — send prompts, receive streaming responses, attach files
- **Slash commands** — `/login`, `/logout`, `/model`, `/new`, `/reload`, `/compact`, `/resume`, `/session`
- **Plan mode** — `/plan` triggers Pi's plan/agent mode if `pi-plan-mode` is installed
- **File diffs** — review pending changes before and after each turn
- **Checkpoints** — undo/restore file state at turn boundaries
- **Session management** — browse, resume, and switch between sessions in `~/.pi/agent/sessions/`
- **MCP servers** — load MCP configs from `mcp.json` (requires `pi-mcp-adapter`)
- **Recommended packages** — first-launch prompt to install `pi-plan-mode` and `pi-mcp-adapter`

## Authentication

Credentials are stored in `~/.pi/agent/auth.json` (same file Pi CLI uses). The extension never commits secrets to the workspace.

| Method | How |
|--------|-----|
| **Settings UI** | **vs-pi-agent: Open Settings** → **Configure provider (/login)** |
| **Chat** | `/login` and `/logout` |
| **Command Palette** | **vs-pi-agent: Login (/login)** / **Logout (/logout)** |
| **Manual** | Settings → **Open auth.json**, or edit the file directly |
| **Environment** | e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` |

## Configuration

**Use Pi CLI configuration** is enabled by default. The extension reads and writes `~/.pi/agent` — `settings.json`, `auth.json`, `mcp.json`, packages, skills, and sessions.

Open **vs-pi-agent: Open Settings** to manage:

- Default provider and model
- Pi packages
- Extension and skill paths
- MCP servers
- Tool auto-approve and session options

## Commands

| Command | Description |
|---------|-------------|
| **vs-pi-agent: Focus Chat** | `Cmd/Ctrl+Shift+L` |
| **vs-pi-agent: New Chat** | `Cmd/Ctrl+Shift+N` |
| **vs-pi-agent: Login (/login)** | Configure provider auth |
| **vs-pi-agent: Logout (/logout)** | Remove stored credentials |
| **vs-pi-agent: Open Settings** | Full Pi agent configuration |
| **vs-pi-agent: Select Model** | Model picker |
| **vs-pi-agent: Reload Session** | Reload packages, skills, extensions |

## Install from source

```bash
git clone https://github.com/FChatin/vs-pi-agent.git
cd vs-pi-agent
npm install
npm run compile
```

**VSIX:** `npm run package` → *Extensions → Install from VSIX…*

## Development

```bash
npm run compile
npm run watch      # optional
npm run test:unit
```

Press **F5** for Extension Development Host.

## License

MIT — see [LICENSE](LICENSE).