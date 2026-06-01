# Research: FChatin/vs-pi-agent GitHub Repository - Cursor/Cursoragent Audit

## Summary
The FChatin/vs-pi-agent GitHub repository (github.com/FChatin/vs-pi-agent) is a VS Code extension for the Pi coding agent. Based on available public information, no evidence of cursoragent-related commits, contributors, or references was found. However, comprehensive verification requires direct API access or repository cloning.

## Findings

### 1. Repository Identification
- **Repository**: https://github.com/FChatin/vs-pi-agent
- **Owner**: FChatin (GitHub user)
- **Purpose**: VS Code extension providing sidebar chat, tools, multi-tab sessions, diffs, checkpoints, and sync with `~/.pi/agent`
- **Install count**: 2 installs (from Visual Studio Marketplace)

### 2. Contributors Analysis
**Direct API Query Not Possible via Web Search**

Web searches did not return raw API responses for the FChatin/vs-pi-agent contributors endpoint. However:
- The repository is publicly accessible at github.com/FChatin/vs-pi-agent
- Visual Studio Marketplace lists only FChatin as the publisher
- No other contributor names appeared in search results for this specific repository

Note: The main `earendil-works/pi` repository (separate project) has 209 contributors, which is NOT relevant to this audit.

### 3. Commit History Search
**Results**: No cursoragent-related commits found in public search results.

Searches for:
- `site:github.com/FChatin/vs-pi-agent cursoragent`
- `FChatin vs-pi-agent cursor cursoragent commit`

Returned no matches specifically for cursoragent in the vs-pi-agent context.

### 4. Release Notes / Changelog Search
**Results**: No cursor references in FChatin/vs-pi-agent releases.

The release changelog for the Pi coding agent (earendil-works/pi) shows recent additions like:
- Adaptive thinking support
- Image generation support
- Together AI provider
- Cloudflare AI Gateway

None of these reference cursor or cursoragent.

### 5. Related GitHub Pages / API Endpoints

| Endpoint | Status | Evidence |
|----------|--------|----------|
| Contributors API | Not publicly accessible via web search | Requires authenticated API or direct repo access |
| Commit Search | No cursoragent found | Web search returned no matches |
| Release Notes | No cursor references | Changelog shows standard feature additions |
| Issues/PRs | Not searched | Would require direct API access |

## Raw Search Evidence

### Source 1: Visual Studio Marketplace
```
vscode-pi-agent FChatin | 2 installs
Repository: github.com/FChatin/vs-pi-agent
```
Source: https://marketplace.visualstudio.com/items?itemName=FChatin.vscode-pi-agent

### Source 2: Install from Source
```bash
git clone https://github.com/FChatin/vs-pi-agent.git
cd vs-pi-agent
npm install
npm run compile
```
Source: Visual Studio Marketplace page

### Source 3: Multiple VS Code Extension Alternatives
Several other Pi-related VS Code extensions exist:
- Zetaphor/pi-vscode-extension
- cdervis/vscode-pi
- pithings/pi-vscode
- tintinweb/vscode-pi-model-chat-provider

None reference cursoragent in their documentation.

## Sources

### Kept:
- Visual Studio Marketplace (marketplace.visualstudio.com) - Primary source for extension metadata and publisher info
- GitHub repository URL confirmation - Shows the exact repository structure

### Dropped:
- General Pi agent articles - Not specific to FChatin/vs-pi-agent
- earendil-works/pi contributors page - Different repository, not relevant to this audit

## Gaps

**What Could Not Be Verified:**
1. Raw GitHub API responses for contributors endpoint
2. Direct commit search via GitHub search API (requires authentication or direct repo access)
3. Full commit message history examination
4. GitHub Issues/PRs search for cursor references

**Recommended Next Steps:**
1. Clone the repository and run:
   ```bash
   git log --all --grep="cursor" --oneline
   git log --all --author="cursoragent" --oneline
   git log --all --format="%ae" | sort | uniq
   ```
2. Query GitHub API directly:
   ```bash
   curl -H "Authorization: token YOUR_TOKEN" \
     https://api.github.com/repos/FChatin/vs-pi-agent/contributors
   curl -H "Authorization: token YOUR_TOKEN" \
     https://api.github.com/search/commits?q=author:cursoragent+repo:FChatin/vs-pi-agent
   ```
3. Check the GitHub web interface contributors page: https://github.com/FChatin/vs-pi-agent/graphs/contributors

## Supervisor Coordination

N/A - Research complete. Findings written to output file.

## Verdict

**CLEAN - No cursoragent found (with caveats)**

Based on available public information:
- ✅ No cursoragent commits found in web search results
- ✅ No cursor references in documented release notes
- ✅ Only FChatin listed as publisher/maintainer on Marketplace
- ⚠️ Direct API verification not possible via web search

**Note**: Complete verification requires direct repository access or GitHub API authentication to examine:
1. All contributor emails/usernames
2. Full commit author history
3. All commit messages for implicit references

The web-based research shows no obvious evidence of cursoragent contamination, but a definitive answer requires programmatic access to the repository.