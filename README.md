# vs-pi-agent

Pi coding agent in VS Code — sidebar chat, tools, multi-tab sessions, diffs, checkpoints, and sync with `~/.pi/agent`.

**Repository:** [github.com/FChatin/vs-pi-agent](https://github.com/FChatin/vs-pi-agent)

## Pi CLI: optional, not required

The extension bundles the Pi SDK (`@earendil-works/pi-coding-agent`). It does **not** shell out to the `pi` terminal command.

You can use vs-pi-agent on a machine with **no Pi CLI installed**. Auth, settings, packages, skills, and sessions still live under `~/.pi/agent` (default).

Installing [Pi CLI](https://github.com/badlogic/pi-mono) separately is **recommended** if you also want the terminal TUI, or to share the same config between VS Code and the shell.

## Requirements

- VS Code 1.100+
- Node.js 18+ — only needed when installing Pi packages via npm (recommended packages, MCP adapter, plan mode)
- Model provider credentials — see [Authentication](#authentication)

## Quick start

1. Install the extension (VSIX or development build below).
2. Open the **vs-pi-agent** sidebar.
3. Configure a provider:
   - **Settings → Configure provider (/login)**, or
   - type `/login` in chat, or
   - Command Palette → **vs-pi-agent: Login (/login)**
4. Pick a model from the status bar or with `/model`.
5. Start chatting.

On first launch you may be prompted to install [recommended Pi packages](#recommended-packages) (plan mode, MCP). Node.js/npm must be available for that step.

## Authentication

Credentials are stored in `~/.pi/agent/auth.json` (same file Pi CLI uses). The extension never commits secrets to the workspace.

| Method | How |
|--------|-----|
| **Settings UI** | **vs-pi-agent: Open Settings** → **Configure provider (/login)** |
| **Chat** | `/login` and `/logout` |
| **Command Palette** | **vs-pi-agent: Login (/login)** / **Logout (/logout)** |
| **Manual** | Settings → **Open auth.json**, or edit the file directly |
| **Environment** | e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` |

OAuth subscriptions (Claude Pro/Max, ChatGPT Codex, GitHub Copilot) work through the same `/login` flow — browser auth opens from VS Code.

After login, use **Reload session** in settings (or `/reload` in chat) if models do not appear immediately.

## Configuration

By default **Use Pi CLI configuration** (`pi-agent.syncWithPiCli`) is enabled: the extension reads and writes `~/.pi/agent` — `settings.json`, `auth.json`, `mcp.json`, packages, skills, and sessions.

Open **vs-pi-agent: Open Settings** to manage:

- Default provider and model (`settings.json`)
- Pi packages (`npm:…` installs into `~/.pi/agent`)
- Extension and skill paths
- MCP servers (requires `pi-mcp-adapter` package)
- Tool auto-approve and session options

Turn off Pi CLI sync for extension-only VS Code settings (`pi-agent.apiProvider`, SecretStorage API keys, custom session path). Auth for the agent runtime still resolves from `auth.json` and environment variables.

## Recommended packages

Not bundled in the VSIX. Install into `~/.pi/agent` (same as `pi install`):

| Package | Purpose |
|---------|---------|
| `npm:@narumitw/pi-plan-mode` | Plan/Agent mode, `/plan`, interactive question cards |
| `npm:pi-mcp-adapter` | MCP servers from `mcp.json` |

Install via the first-launch prompt, **vs-pi-agent: Install Recommended Packages**, or the package catalog in settings.

Settings: `pi-agent.promptRecommendedPackages`, `pi-agent.autoInstallRecommendedPackages`.

## Commands

| Command | Description |
|---------|-------------|
| **vs-pi-agent: Focus Chat** | `Cmd/Ctrl+Shift+L` |
| **vs-pi-agent: New Chat** | `Cmd/Ctrl+Shift+N` |
| **vs-pi-agent: Login (/login)** | Configure provider auth |
| **vs-pi-agent: Logout (/logout)** | Remove stored credentials |
| **vs-pi-agent: Open Settings** | Full Pi agent configuration |
| **vs-pi-agent: Select Model** | Model picker |
| **vs-pi-agent: Install Recommended Packages** | Plan mode + MCP adapter |
| **vs-pi-agent: Reload Session** | Reload packages, skills, extensions |

## Install from source

```bash
git clone https://github.com/FChatin/vs-pi-agent.git
cd vs-pi-agent
npm install
npm run compile
```

**VSIX:** `npm run package` → *Extensions: Install from VSIX…*

## Development

```bash
npm run compile
npm run watch      # optional
npm run test:unit
```

Press **F5** for Extension Development Host.
```bash
```

## Publish VSIX

```bash
npm run package
# vs-pi-agent-<version>.vsix → Open VSX / Marketplace / GitHub Releases
```

## License

MIT — see [LICENSE](LICENSE).
