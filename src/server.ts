import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'node:http';
import { JiraClient } from './jira-client.js';

const port = Number(process.env.PORT ?? 3000);
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const jira = new JiraClient({
  baseUrl: required('JIRA_BASE_URL'),
  email: required('JIRA_EMAIL'),
  apiToken: required('JIRA_API_TOKEN')
});

const mcpBearer = process.env.MCP_BEARER_TOKEN;

function authorized(req: http.IncomingMessage) {
  if (!mcpBearer) return true;
  return req.headers.authorization === `Bearer ${mcpBearer}`;
}

function createServer() {
  const server = new McpServer({ name: 'jira-direct', version: '0.1.0' });

  server.registerTool('jira_search', {
    title: 'Search Jira',
    description: 'Search Jira Cloud using JQL. Read-only.',
    inputSchema: {
      jql: z.string().min(1),
      maxResults: z.number().int().min(1).max(100).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ jql, maxResults }) => {
    const result = await jira.search(jql, maxResults ?? 50);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('jira_get_issue', {
    title: 'Get Jira issue',
    description: 'Retrieve a Jira issue and selected fields. Read-only.',
    inputSchema: {
      issueKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
      fields: z.array(z.string()).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ issueKey, fields }) => {
    const result = await jira.getIssue(issueKey, fields);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('jira_get_changelog', {
    title: 'Get Jira changelog',
    description: 'Retrieve issue history/changelog. Read-only.',
    inputSchema: {
      issueKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
      startAt: z.number().int().min(0).optional(),
      maxResults: z.number().int().min(1).max(100).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ issueKey, startAt, maxResults }) => {
    const result = await jira.getChangelog(issueKey, startAt ?? 0, maxResults ?? 100);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('jira_get_comments', {
    title: 'Get Jira comments',
    description: 'Retrieve issue comments. Read-only.',
    inputSchema: {
      issueKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
      startAt: z.number().int().min(0).optional(),
      maxResults: z.number().int().min(1).max(100).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ issueKey, startAt, maxResults }) => {
    const result = await jira.getComments(issueKey, startAt ?? 0, maxResults ?? 100);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('jira_get_project', {
    title: 'Get Jira project',
    description: 'Retrieve Jira project metadata. Read-only.',
    inputSchema: { projectKey: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ projectKey }) => {
    const result = await jira.getProject(projectKey);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('jira_get_issue_links', {
    title: 'Get Jira issue links',
    description: 'Retrieve issue links/dependencies. Read-only.',
    inputSchema: {
      issueKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async ({ issueKey }) => {
    const result = await jira.getIssueLinks(issueKey);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'jira-direct-mcp', rovo: false }));
    return;
  }

  if (req.url !== '/mcp' || (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
    res.end('Unauthorized');
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

httpServer.listen(port, () => {
  console.log(`jira-direct-mcp listening on http://localhost:${port}`);
});
