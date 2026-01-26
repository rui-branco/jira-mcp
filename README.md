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

### Quick Setup

```bash
# Clone the repository
git clone https://github.com/rui-branco/jira-mcp.git
cd jira-mcp

# Install dependencies
npm install

# Run interactive setup
node setup.js
```

The setup will prompt for:
1. **Jira email** - Your Atlassian account email
2. **API token** - Generate at [Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
3. **Base URL** - Your Jira instance (e.g., `https://company.atlassian.net`)

### Alternative: Command-Line Setup

```bash
node setup.js "your@email.com" "YOUR_API_TOKEN" "https://company.atlassian.net"
```

### Claude Code Configuration

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "jira": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/jira-mcp/index.js"]
    }
  }
}
```

Restart Claude Code to load the MCP server.

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
| `jira_get_ticket` | Fetch a ticket by key | `issueKey` (required), `downloadImages`, `fetchFigma` |
| `jira_search` | Search with JQL | `jql` (required), `maxResults` |

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

## License

MIT

## Related

- [figma-mcp](https://github.com/rui-branco/figma-mcp) - Figma MCP server for Claude Code
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP specification
