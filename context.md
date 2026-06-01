# Git Repository Cursor Scan — Final Report

**Repository:** /Users/modernambalaj/Desktop/pi-vscode-extension  
**Scan Date:** 2026-06-01  
**Verdict:** ✅ CLEAN — No cursor-agent/Cursor AI references found

---

## Scan Coverage

| Check | Method | Result |
|-------|--------|--------|
| All commit messages (non-merge) | `git log --all --format="%H\|%s\|%b\|%ae\|%an"` | 0 matches |
| All merge commit bodies | `git log --all --merges` | 0 matches |
| Author emails/names | `git log --all --format="%ae\|%an"` | 0 matches |
| Git notes | `git notes list` | No notes exist |
| Tags | `git tag -l` | No cursor tags |
| Branches (local + remote) | `git branch -a` | No cursor branches |
| Reflog entries | `git reflog` | 0 matches |
| Unreachable commits | `git fsck --unreachable` | 0 matches |
| Pack file content | `git cat-file --batch-all-objects` | 0 cursor objects |
| Binary objects | `grep -rli "cursor" .git/` | 0 matches |
| Git log by code presence | `git log -p -S "cursor"` | 3 commits found |

---

## What the "cursor" Matches Actually Are

The `git log -p -S "cursor"` detected 3 commits that contain the word `cursor`. All are legitimate, non-Cursor-AI references:

### Commit `5e97f83` — "Remove git hook and CI workflows" (Jun 1 2026)
**Removed text from README.md:**
```markdown
>Optional — keep Cursor from adding `cursoragent` as a GitHub co-author:
- This was a note in README advising to run `git config core.hooksPath .githooks`
- The `.githooks/prepare-commit-msg` hook was also deleted in this commit
```

### Commit `a73d844` — "Release v0.2.39" (Jun 1 2026)
**Previous README text:**
```markdown
>Optional — keep Cursor from adding `cursoragent` as a GitHub co-author:
```

### Commit `f1f1138` — "Initial release v0.2.38" (May 31 2026)
**Original README had the same reference.**

This reference was about **Cursor IDE** (the text editor by Anysphere), not Cursor AI agent. The hook was designed to prevent Cursor IDE from automatically adding `cursoragent@users.noreply.github.com` as a co-author on commits — a known behavior of the Cursor editor.

**This was removed entirely.** The hook no longer exists in the repository.

---

## Source Code "cursor" References (Legitimate)

The grep found `cursor` in source files. These are all standard technical usage:

### `src/pi/mcpConfig.ts` (line ~70)
```typescript
const IMPORT_PATHS: Record<string, string[]> = {
    cursor: [path.join(os.homedir(), '.cursor', 'mcp.json')],
    'claude-code': [path.join(os.homedir(), '.claude', 'mcp.json'), ...],
    windsurf: [path.join(os.homedir(), '.windsurf', 'mcp.json')],
    codex: [path.join(os.homedir(), '.codex', 'config.json')],
};
```
**Purpose:** Import MCP server configs from other IDEs (Cursor IDE, Claude Code, WindSurf, Codex). This is standard cross-editor compatibility.

### `src/pi/piCliSync.ts` (line ~18)
```typescript
const providers = [
    'anthropic', 'openai', 'google', 'deepseek', 'azure', 'mistral', 'groq',
    'xai', 'openrouter', 'cursor',
];
```
**Purpose:** List of supported API key providers. `cursor` here refers to Cursor IDE's API endpoint (cursor.sh).

### `src/webview/settings.ts` (formatMcpImportLabel function)
```typescript
const labels: Record<string, string> = {
    cursor: 'editor-mcp',
    'claude-code': 'claude-mcp',
    windsurf: 'windsurf-mcp',
    codex: 'codex-mcp',
};
```
**Purpose:** Human-readable labels for imported MCP sources.

### `out/extension.js` (compiled output)
Contains the same patterns — compiled from TypeScript sources above.

### `node_modules/@types/*`
TypeScript type definitions for Node.js `cursor` management in TTY streams. Not related.

### `out/webview/main.js`
UI code tracking cursor position in text inputs. Not related.

---

## History Sanitization Status

| Item | Status |
|------|--------|
| `cursoragent` commit author identity | ✅ Does not exist |
| `cursoragent` commit co-author trailer | ✅ Hook deleted |
| `cursoragent` in git notes | ✅ No notes exist |
| `cursoragent` in refs | ✅ No refs found |
| `cursoragent` in reflog | ✅ No entries |
| `cursoragent` in pack objects | ✅ No traces |
| Historical README reference to Cursor IDE | ✅ Removed |
| `.githooks/prepare-commit-msg` hook | ✅ Deleted |

---

## Verdict

**✅ CLEAN — Repository is free of Cursor AI / cursoragent references.**

The only "cursor" mentions in history were:
1. A now-deleted note about preventing **Cursor IDE** from auto-adding a co-author
2. Standard MCP config import paths for **Cursor IDE** (`.cursor/mcp.json`)
3. API provider identifiers that include **Cursor IDE**

None of these involve the Cursor AI coding agent product, `cursoragent` as a GitHub identity, or any Cursor AI-specific automation.