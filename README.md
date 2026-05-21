# Jira MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that brings Jira ticket context directly into Claude Code. Fetch complete ticket information including descriptions, comments, attachments, and linked Figma designs without leaving your development environment.

## Overview

When working on development tasks, context switching between Jira and your code editor breaks flow and wastes time. This MCP server solves that by:

- **Fetching complete ticket context** - Get descriptions, comments, status, and metadata instantly
- **Downloading attachments** - Image attachments are downloaded and displayed inline
- **Auto-fetching Figma designs** - Linked Figma URLs are automatically detected and exported as images
- **Enabling natural queries** - Search tickets with JQL directly from Claude Code

## Features

| Feature | Description |
|---------|-------------|
| Full Ticket Details | Summary, description, status, priority, assignee, reporter, sprint, parent |
| Comments | All comments with author and timestamp |
| Attachments | Auto-download image attachments (PNG, JPG, GIF, WebP) |
| Linked Issues | View related tickets and their relationships |
| Figma Integration | Auto-detect and export Figma designs linked in tickets |
| JQL Search | Search across your Jira instance with powerful queries |

## Installation

### Prerequisites

- Node.js 18+
- [Claude Code](https://claude.ai/code) CLI
- Jira Cloud account with API access

### Step 1: Add to Claude Code

```bash
claude mcp add --transport stdio jira -- npx -y @rui.branco/jira-mcp
```

### Step 2: Get Your Jira API Token

1. Go to [Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **"Create API token"**
3. Enter a label (e.g., "Claude Code MCP")
4. Click **"Create"**
5. Copy the token (you won't be able to see it again)

### Step 3: Configure Credentials

Run the setup with your credentials:

```bash
npx @rui.branco/jira-mcp setup "your@email.com" "YOUR_API_TOKEN" "https://company.atlassian.net"
```

| Parameter | Description | Example |
|-----------|-------------|---------|
| Email | Your Atlassian account email | `john@company.com` |
| API Token | The token you created in Step 2 | `ATATT3xFfGF0...` |
| Base URL | Your Jira instance URL | `https://company.atlassian.net` |

Or run interactively (will prompt for each value):

```bash
npx @rui.branco/jira-mcp setup
```

### Step 4: Verify

Restart Claude Code and run `/mcp` to verify the server is connected.

### Alternative: Manual Installation

If you prefer to install manually:

```bash
git clone https://github.com/rui-branco/jira-mcp.git ~/.config/jira-mcp
cd ~/.config/jira-mcp && npm install
node setup.js
```

Then add to Claude Code:

```bash
claude mcp add --transport stdio jira -- node $HOME/.config/jira-mcp/index.js
```

## Usage

### Fetch a Ticket

```
> Get ticket PROJ-123

# Returns full ticket with description, comments, attachments, and Figma designs
```

### Search Tickets

```
> Search for my open tickets

# Uses JQL: assignee = currentUser() AND status != Done
```

### Add Comments with Mentions

Use `@FirstName LastName` syntax to mention users in comments:

```
> Add a comment to PROJ-123: "@John Doe Please review this implementation"

# The mention is automatically resolved and the user gets notified
```

### Example Output

```
# PROJ-123: Implement user authentication

Status: In Progress | Type: Story | Priority: High
Assignee: John Doe | Reporter: Jane Smith

## Description
Implement OAuth2 authentication flow...

## Comments (2)
### Jane Smith - Jan 15, 2025
Please ensure we support Google SSO...

## Attachments (1)
- mockup.png (image/png, 245KB)
  [Image displayed inline]

## Figma Designs (1)
### Auth Flow Design - Login Screen
- Exported 3 image(s):
  - Login Form: ~/.config/figma-mcp/exports/...
  - Error States: ~/.config/figma-mcp/exports/...
  - Success State: ~/.config/figma-mcp/exports/...
```

## Figma Integration

This MCP automatically detects Figma URLs in ticket descriptions and comments. When [figma-mcp](https://github.com/rui-branco/figma-mcp) is configured:

- Figma links are automatically fetched
- Large frames are split into sections for better readability
- Images are exported at 2x scale for clarity
- All images are displayed inline in Claude Code

To enable Figma integration:
1. Install and configure [figma-mcp](https://github.com/rui-branco/figma-mcp)
2. Restart Claude Code
3. Figma links will be auto-fetched when you get a ticket

## API Reference

### Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `jira_get_myself` | Get the current authenticated user's accountId and info (use for assigning tickets) | none |
| `jira_get_ticket` | Fetch a ticket by key with description, comments, attachments, and Figma designs | `issueKey` (required), `downloadImages`, `fetchFigma` |
| `jira_search` | Search tickets using JQL | `jql` (required), `maxResults` |
| `jira_add_comment` | Add a comment to a ticket (supports @mentions) | `issueKey` (required), `comment` (required) |
| `jira_reply_comment` | Reply to a specific comment with quote and mention | `issueKey` (required), `commentId` (required), `reply` (required) |
| `jira_edit_comment` | Edit an existing comment (supports @mentions) | `issueKey` (required), `commentId` (required), `comment` (required) |
| `jira_delete_comment` | Delete a comment (irreversible) | `issueKey` (required), `commentId` (required) |
| `jira_transition` | Change ticket status by name or ID (auto-handles intermediate steps) | `issueKey` (required), `targetStatus` or `transitionId` |
| `jira_update_ticket` | Update ticket fields (summary, description, assignee, priority, labels) | `issueKey` (required), plus optional field parameters |

### Confluence Tools

This MCP also exposes Confluence via the same Atlassian credentials. On Atlassian Cloud, the API token you configured for Jira works for Confluence too, and the Confluence base URL is derived as `<jiraBaseUrl>/wiki` — **no extra setup required**. Just use the `confluence_*` tools below against any configured instance.

For Server / Data Center deployments where Confluence lives on a different host, set `confluenceBaseUrl` explicitly on the stored instance in `config.json`.

| Tool | Description | Parameters |
|------|-------------|------------|
| `confluence_get_spaces` | List global spaces (`key`, `name`, `id`) | `instance` |
| `confluence_get_space` | Get a single space with description and homepage | `spaceKey` (required), `instance` |
| `confluence_create_space` | Create a new global space | `spaceKey` (required), `name` (required), `description`, `instance` |
| `confluence_update_space` | Update a space's name and/or description | `spaceKey` (required), `name`, `description`, `instance` |
| `confluence_delete_space` | Delete a space (async on Cloud) | `spaceKey` (required), `instance` |
| `confluence_search` | CQL text search (`text ~ "<query>" AND type = <type>`) | `query` (required), `spaceKey`, `type`, `limit`, `instance` |
| `confluence_get_recent_pages` | Pages modified in the last N days | `sinceDays` (default 30), `spaceKey`, `limit`, `instance` |
| `confluence_get_space_root_pages` | Top-level pages in a space with `childTypes.page` | `spaceKey` (required), `limit`, `instance` |
| `confluence_get_page_children` | Direct child pages of a page | `pageId` (required), `limit`, `instance` |
| `confluence_get_page` | Full page with `body.view`, `body.storage` and (by default) v2 `body.atlas_doc_format` merged in | `pageId` (required), `includeAdf`, `instance` |
| `confluence_get_comments` | List comments on a page | `pageId` (required), `limit`, `instance` |
| `confluence_add_comment` | Add a footer comment (plain text wrapped into storage XHTML by default) | `pageId` (required), `body` (required), `format` (`text`/`storage`), `instance` |
| `confluence_update_page` | Update title/body; auto-bumps version if not supplied | `pageId` (required), `title`, `body` (storage XHTML), `version`, `instance` |
| `confluence_create_page` | Create a page with optional parent | `spaceKey`, `title`, `body` (storage XHTML) (all required), `parentId`, `instance` |
| `confluence_delete_page` | Delete a page | `pageId` (required), `instance` |
| `confluence_get_labels` | List labels on a page | `pageId` (required), `instance` |
| `confluence_add_label` | Add a label to a page | `pageId` (required), `label` (required), `instance` |
| `confluence_remove_label` | Remove a label from a page | `pageId` (required), `label` (required), `instance` |
| `confluence_list_attachments` | List attachments on a page | `pageId` (required), `limit`, `instance` |
| `confluence_upload_attachment` | Upload a file from disk or base64 content | `pageId` (required), `filePath` or `fileContent`+`fileName`, `comment`, `instance` |
| `confluence_download_attachment` | Download an attachment by filename to the local attachment dir | `pageId` (required), `filename` (required), `instance` |

**Why ADF for `confluence_get_page`?** The v1 `body.atlas_doc_format` expand is unreliable on modern Cloud pages — table cell background colors and some newer node types only survive the v2 `/api/v2/pages/<id>?body-format=atlas_doc_format` endpoint. `confluence_get_page` therefore does both requests in parallel and merges the v2 ADF body onto the v1 response, so callers get `body.view`, `body.storage` and `body.atlas_doc_format` in one shot.

### Configuration

Config stored at `~/.config/jira-mcp/config.json`:

```json
{
  "email": "your@email.com",
  "token": "YOUR_API_TOKEN",
  "baseUrl": "https://company.atlassian.net"
}
```

## Error Handling

The server provides clear error messages:

| Error | Meaning |
|-------|---------|
| `Figma API rate limit exceeded` | Too many Figma requests, wait a few minutes |
| `Figma access denied` | Check Figma token or file permissions |
| `Figma not configured` | Install and configure figma-mcp |

## Security

- API tokens are stored locally in `~/.config/jira-mcp/config.json`
- Config files are excluded from git via `.gitignore`
- Tokens are never logged or transmitted except to Jira/Figma APIs
- Attachments are downloaded to `~/.config/jira-mcp/attachments/`

## Safety & Observability

Four opt-in controls limit what an agent can do without your approval and give you a trail when something goes wrong. All four are off by default for existing installs — drop the relevant config block into `~/.config/jira-mcp/config.json` to turn them on.

### Per-tool scopes

Restrict which tools each instance can call. Useful for "this Atlassian instance is read-only" or "this one only allows comments".

```json
{
  "instances": [
    {
      "name": "prod",
      "email": "you@company.com",
      "token": "...",
      "baseUrl": "https://company.atlassian.net",
      "scopes": { "preset": "read-only" }
    },
    {
      "name": "sandbox",
      "email": "you@company.com",
      "token": "...",
      "baseUrl": "https://sandbox.atlassian.net",
      "scopes": { "preset": "no-destructive", "deny": ["jira_remove_attachment"] }
    }
  ]
}
```

Presets: `read-only`, `comments-only`, `no-destructive`, `unrestricted`. You can combine a preset with `allow: [...]` and `deny: [...]` — deny wins. If `scopes` is present, an unknown tool name fails closed. If `scopes` is omitted, the instance behaves as before (no restrictions).

### Dry-run mode

For any mutating tool call, return the HTTP request that *would* be sent without actually calling Atlassian. Useful for previewing what an agent is about to do.

Three layers of precedence (most-specific wins):

1. **Per call:** pass `dryRun: true` to any mutating tool.
2. **Per instance:** add `"dryRun": true` to an instance in `config.json`.
3. **Environment:** export `JIRA_MCP_DRY_RUN=1` before launching Claude Code.

Read tools ignore the flag. The response looks like:

```json
{
  "dryRun": true,
  "plan": [{ "api": "jira", "method": "POST", "endpoint": "/issue/PROJ-1/comment", "body": { ... } }]
}
```

For multi-step tools (e.g. `jira_transition` with intermediate statuses) only the first write is captured.

### Audit log

Every write attempt — successful, failed, denied by scope, denied by rate limit, or dry-run — is appended as a JSON line to `~/.config/jira-mcp/audit.log`. Token-like fields (`token`, `authorization`, `password`, `apiKey`, `fileContent`, etc.) are redacted before they hit disk. Rotates at 10 MB, keeps 5 historical files.

Disable with `"audit": { "enabled": false }` at the top level of `config.json`.

### Rate limiting

Layered in-memory token buckets prevent runaway loops. Defaults:

- **global:** 60 writes/minute
- **per-instance:** 30 writes/minute
- **destructive tools** (`*_delete_*`, `jira_remove_*`, `confluence_delete_*`): 5/minute

On limit hit the tool call fails immediately with a `Rate limit exceeded` error — no sleeping, no queueing. Reads bypass the limiter entirely. Dry-runs don't consume tokens.

Override or disable in `config.json`:

```json
{
  "rateLimit": {
    "enabled": true,
    "global": 120,
    "perInstance": 60,
    "destructive": 10
  }
}
```

## License

MIT

## Related

- [figma-mcp](https://github.com/rui-branco/figma-mcp) - Figma MCP server for Claude Code
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP specification
