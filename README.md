# Jira Direct MCP

A small read-only-first MCP server that talks directly to Jira Cloud REST API and does not use Atlassian Rovo.

## Current scope

- `jira_search` — JQL search
- `jira_get_issue` — issue details
- `jira_get_changelog` — issue history
- `jira_get_comments` — issue comments
- `jira_get_project` — project metadata
- `jira_get_issue_links` — dependency/issue links

Write operations are intentionally not implemented in v0.1.

## Architecture

ChatGPT / OpenAI MCP client → this MCP server → Jira Cloud REST API.

Rovo is not in the request path.

## Configuration

Copy `.env.example` to `.env` and set:

- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `MCP_BEARER_TOKEN` for local/testing protection

Atlassian supports API-token basic authentication for scripts and bots. For a production ChatGPT-facing MCP server, use OAuth 2.1 MCP authorization rather than a static bearer token.

## Run

```bash
npm install
npm run build
npm start
```

Health check:

```text
GET /health
```

MCP endpoint:

```text
POST /mcp
```
