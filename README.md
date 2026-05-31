# vs-pi-agent

Sidebar chat for the [Pi coding agent](https://github.com/badlogic/pi-mono): multi-tab sessions, tools, diffs, checkpoints, plan mode, and `~/.pi/agent` sync.

UI icons and branding in `media/` are original SVG assets for this extension (not third-party icon packs).

**Repository:** [github.com/FChatin/vs-pi-agent](https://github.com/FChatin/vs-pi-agent)

## Requirements

- Node.js 18+ (for `npm` when installing Pi packages)
- VS Code 1.100+
- Pi credentials: `~/.pi/agent/auth.json`, env vars, or extension settings (SecretStorage only — never committed)

### Recommended Pi CLI packages (not in the VSIX)

The extension UI expects these in `~/.pi/agent/settings.json` (same as `pi install`):

| Package | Purpose |
|---------|---------|
| `npm:@narumitw/pi-plan-mode` | Plan/Agent mode, `/plan`, question cards |
| `npm:pi-mcp-adapter` | MCP servers from `mcp.json` |

On first launch you get a prompt to install them. Command: **vs-pi-agent: Install Recommended Packages**.  
Settings: `pi-agent.promptRecommendedPackages`, `pi-agent.autoInstallRecommendedPackages`.

## Install

```bash
git clone https://github.com/FChatin/vs-pi-agent.git
cd vs-pi-agent
npm install
npm run compile
```

**From VSIX:** `npm run package` → *Extensions: Install from VSIX…*

## Development

```bash
npm run compile
npm run watch      # optional
npm run test:unit
```

Press **F5** for Extension Development Host.

## Publish VSIX

```bash
npm run package
# vs-pi-agent-<version>.vsix → Open VSX / Marketplace / GitHub Releases
```


## License

MIT — see [LICENSE](LICENSE).
