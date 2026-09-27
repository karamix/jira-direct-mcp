import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'node:http';
import { JiraClient } from './jira-client.js';

const port = Number(process.env.PORT ?? 3000);
const writeEnabled = process.env.MCP_WRITE_ENABLED === 'true';

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
  if (!mcpBearer) {
    return true;
  }

  const authorization = req.headers.authorization;

  if (!authorization) {
    return false;
  }

  return authorization === `Bearer ${mcpBearer}`;
}

const issueKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);

function createServer() {
  const server = new McpServer({
    name: 'jira-direct',
    version: '0.1.0'
  });

  server.registerTool('jira_search', {
    title: 'Search Jira',
    description: 'Search Jira Cloud using JQL. Read-only.',
    inputSchema: {
      jql: z.string().min(1),
      maxResults: z.number().int().min(1).max(100).optional()
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    }
  }, async ({ jql, maxResults }) => {
    const result = await jira.search(jql, maxResults ?? 50);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });

  server.registerTool('jira_get_issue', {
    title: 'Get Jira issue',
    description: 'Retrieve a Jira issue and selected fields. Read-only.',
    inputSchema: {
      issueKey: issueKeySchema,
      fields: z.array(z.string()).optional()
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    }
  }, async ({ issueKey, fields }) => {
    const result = await jira.getIssue(issueKey, fields);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });

  server.registerTool('jira_get_changelog', {
    title: 'Get Jira changelog',
    description: 'Retrieve issue history/changelog. Read-only.',
    inputSchema: {
      issueKey: issueKeySchema,
      startAt: z.number().int().min(0).optional(),
      maxResults: z.number().int().min(1).max(100).optional()
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    }
  }, async ({ issueKey, startAt, maxResults }) => {
    const result = await jira.getChangelog(
      issueKey,
      startAt ?? 0,
      maxResults ?? 100
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });

  server.registerTool('jira_get_comments', {
    title: 'Get Jira comments',
    description: 'Retrieve issue comments. Read-only.',
    inputSchema: {
      issueKey: issueKeySchema,
      startAt: z.number().int().min(0).optional(),
      maxResults: z.number().int().min(1).max(100).optional()
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    }
  }, async ({ issueKey, startAt, maxResults }) => {
    const result = await jira.getComments(
      issueKey,
      startAt ?? 0,
      maxResults ?? 100
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });

  server.registerTool('jira_get_project', {
    title: 'Get Jira project',
    description: 'Retrieve Jira project metadata. Read-only.',
    inputSchema: {
      projectKey: z.string().min(1)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    }
  }, async ({ projectKey }) => {
    const result = await jira.getProject(projectKey);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });

  server.registerTool('jira_get_issue_links', {
    title: 'Get Jira issue links',
    description: 'Retrieve issue links/dependencies. Read-only.',
    inputSchema: {
      issueKey: issueKeySchema
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    }
  }, async ({ issueKey }) => {
    const result = await jira.getIssueLinks(issueKey);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });

  server.registerTool('jira_get_transitions', {
    title: 'Get Jira transitions',
    description: 'Retrieve currently available workflow transitions for a Jira issue. Read-only.',
    inputSchema: {
      issueKey: issueKeySchema
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    }
  }, async ({ issueKey }) => {
    const result = await jira.getTransitions(issueKey);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  });

  if (writeEnabled) {
    server.registerTool('jira_add_comment', {
      title: 'Add Jira comment',
      description: 'Add a comment to a Jira issue. Enabled only when MCP_WRITE_ENABLED=true.',
      inputSchema: {
        issueKey: issueKeySchema,
        body: z.string().min(1).max(10000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    }, async ({ issueKey, body }) => {
      const result = await jira.addComment(issueKey, body);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    });

    server.registerTool('jira_update_issue', {
      title: 'Update Jira issue',
      description: 'Update a restricted allowlist of Jira issue fields. Enabled only when MCP_WRITE_ENABLED=true.',
      inputSchema: {
        issueKey: issueKeySchema,
        fields: z.object({
          summary: z.string().min(1).max(255).optional(),
          description: z.string().max(20000).optional(),
          priority: z.string().min(1).max(100).optional(),
          labels: z.array(
            z.string().min(1).max(255)
          ).max(50).optional()
        }).strict().refine(
          fields => Object.keys(fields).length > 0,
          {
            message: 'At least one allowed field must be supplied'
          }
        )
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true
      }
    }, async ({ issueKey, fields }) => {
      const result = await jira.updateIssue(issueKey, fields);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            issueKey,
            updatedFields: Object.keys(fields),
            result
          }, null, 2)
        }]
      };
    });

    server.registerTool('jira_transition_issue', {
      title: 'Transition Jira issue',
      description: 'Transition a Jira issue using an available workflow transition. Enabled only when MCP_WRITE_ENABLED=true.',
      inputSchema: {
        issueKey: issueKeySchema,
        transitionId: z.string().min(1).max(100)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false
      }
    }, async ({ issueKey, transitionId }) => {
      const available = await jira.getTransitions(issueKey);

      const transition = available.transitions?.find(
        (item: any) => String(item.id) === transitionId
      );

      if (!transition) {
        throw new Error(
          `Transition ${transitionId} is not currently available for ${issueKey}`
        );
      }

      await jira.transitionIssue(issueKey, transitionId);

      const issue = await jira.getIssue(issueKey, ['status']);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            issueKey,
            transition: {
              id: transition.id,
              name: transition.name,
              to: transition.to?.name ?? null
            },
            issue
          }, null, 2)
        }]
      };
    });

    server.registerTool('jira_create_issue', {
      title: 'Create Jira issue',
      description: 'Create one Jira issue using a restricted set of fields. Enabled only when MCP_WRITE_ENABLED=true.',
      inputSchema: {
        projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        issueTypeName: z.string().min(1).max(100),
        summary: z.string().min(1).max(255),
        description: z.string().max(20000).optional(),
        priority: z.string().min(1).max(100).optional(),
        labels: z.array(
          z.string().min(1).max(255)
        ).max(50).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false
      }
    }, async ({
      projectKey,
      issueTypeName,
      summary,
      description,
      priority,
      labels
    }) => {
      const result = await jira.createIssue({
        projectKey,
        issueTypeName,
        summary,
        description,
        priority,
        labels
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    });
  }

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'application/json'
    });

    res.end(JSON.stringify({
      ok: true,
      service: 'jira-direct-mcp',
      rovo: false,
      writeEnabled
    }));

    return;
  }

  if (
    req.url !== '/mcp' ||
    !['POST', 'GET', 'DELETE'].includes(req.method ?? '')
  ) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (!authorized(req)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer'
    });

    res.end(JSON.stringify({
      error: 'unauthorized'
    }));

    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  const server = createServer();

  await server.connect(transport);
  await transport.handleRequest(req, res);
});

httpServer.listen(port, () => {
  console.log(
    `jira-direct-mcp listening on http://localhost:${port} ` +
    `(writes: ${writeEnabled ? 'enabled' : 'disabled'})`
  );
});
