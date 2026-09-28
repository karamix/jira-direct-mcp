import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'node:http';
import 'dotenv/config';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
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

const requestContext = new AsyncLocalStorage<http.IncomingMessage>();
const publicUrl = (
  process.env.MCP_PUBLIC_URL ??
  'https://jira-direct-mcp.onrender.com'
).replace(/\/$/, '');

const oauthIssuer = publicUrl;
const oauthResource = publicUrl;
const oauthScope = 'jira:read';

type OAuthPayload = {
  iss: string;
  aud: string;
  scope: string;
  type: 'access_token' | 'refresh_token';
  jti: string;
  iat: number;
  exp: number;
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
};

const authorizationCodes = new Map<string, AuthorizationCode>();
const refreshTokens = new Set<string>();

const CHATGPT_STABLE_REDIRECT =
  'https://chatgpt.com/connector_platform_oauth_redirect';

const CHATGPT_CALLBACK_REDIRECT =
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlJson(value: unknown): string {
  return base64url(JSON.stringify(value));
}

function signValue(value: string): string {
  if (!mcpBearer) {
    throw new Error('MCP_BEARER_TOKEN is required for OAuth');
  }

  return base64url(
    crypto
      .createHmac('sha256', mcpBearer)
      .update(value)
      .digest()
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return (
    left.length === right.length &&
    crypto.timingSafeEqual(left, right)
  );
}

function createSignedToken(payload: OAuthPayload): string {
  const encoded = base64urlJson(payload);
  return `${encoded}.${signValue(encoded)}`;
}

function verifySignedToken(token: string): OAuthPayload | null {
  const parts = token.split('.');

  if (parts.length !== 2) {
    return null;
  }

  const [encoded, signature] = parts;

  if (!constantTimeEqual(signature, signValue(encoded))) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as OAuthPayload;

    const now = Math.floor(Date.now() / 1000);

    if (!payload || typeof payload !== 'object') {
      return null;
    }

    if (payload.iss !== oauthIssuer) {
      return null;
    }

    if (payload.aud !== oauthResource) {
      return null;
    }

    if (typeof payload.exp !== 'number' || payload.exp <= now) {
      return null;
    }

    if (typeof payload.jti !== 'string' || payload.jti.length < 16) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function validRedirectUri(uri: string): boolean {
  return (
    uri === CHATGPT_STABLE_REDIRECT ||
    CHATGPT_CALLBACK_REDIRECT.test(uri)
  );
}

function validScope(scope: string): boolean {
  const requested = scope.split(' ').filter(Boolean);

  return (
    requested.length > 0 &&
    requested.every(value => value === oauthScope || value === 'offline_access')
  );
}

function validChatGPTClient(clientId: string): boolean {
  return (
    clientId === 'https://chatgpt.com/oauth/client.json' ||
    /^https:\/\/chatgpt\.com\/oauth\/[A-Za-z0-9_-]+\/client\.json$/.test(clientId)
  );
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function oauthJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(body));
}

function oauthError(
  res: http.ServerResponse,
  status: number,
  error: string,
  description: string,
  redirectUri: string,
  state: string
): void {
  if (redirectUri && validRedirectUri(redirectUri)) {
    const redirect = new URL(redirectUri);

    redirect.searchParams.set('error', error);
    redirect.searchParams.set('error_description', description);
    redirect.searchParams.set('iss', oauthIssuer);

    if (state) {
      redirect.searchParams.set('state', state);
    }

    res.writeHead(302, {
      Location: redirect.toString(),
      'Cache-Control': 'no-store'
    });

    res.end();
    return;
  }

  oauthJson(res, status, {
    error,
    error_description: description
  });
}

function oauthAccessToken(): string {
  const now = Math.floor(Date.now() / 1000);

  return createSignedToken({
    iss: oauthIssuer,
    aud: oauthResource,
    scope: oauthScope,
    type: 'access_token',
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 60 * 60,
  });
}

function oauthRefreshToken(): string {
  const now = Math.floor(Date.now() / 1000);

  return createSignedToken({
    iss: oauthIssuer,
    aud: oauthResource,
    scope: oauthScope,
    type: 'refresh_token',
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 60 * 60 * 24 * 30,
  });
}

function parseBearer(req: http.IncomingMessage): string | null {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }

  return authorization.slice('Bearer '.length).trim();
}


function authorized(req: http.IncomingMessage): boolean {
  if (!mcpBearer) {
    return false;
  }

  const authorization = req.headers.authorization;

  if (!authorization) {
    return false;
  }

  if (authorization === `Bearer ${mcpBearer}`) {
    return true;
  }

  return oauthAuthorized(req);
}

function oauthAuthorized(req: http.IncomingMessage): boolean {
  const token = parseBearer(req);

  if (!token) {
    return false;
  }

  const payload = verifySignedToken(token);

  if (!payload || payload.type !== 'access_token') {
    return false;
  }

  return (
    typeof payload.scope === 'string' &&
    payload.scope.split(' ').includes(oauthScope)
  );
}


const oauthChallenge = {
  'mcp/www_authenticate': [
    `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource", scope="${oauthScope}", error="invalid_token", error_description="OAuth authorization required"`
  ]
};

function toolAuthorized(): boolean {
  const req = requestContext.getStore();

  if (!req) {
    return false;
  }

  return authorized(req);
}

function authenticationRequired() {
  return {
    content: [{
      type: 'text',
      text: 'Authentication required. Please connect Jira Direct.'
    }],
    _meta: oauthChallenge,
    isError: true
  };
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
    },
    _meta: {
      securitySchemes: [
        {
          type: 'oauth2',
          scopes: ['jira:read']
        }
      ]
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
    },
    _meta: {
      securitySchemes: [
        {
          type: 'oauth2',
          scopes: ['jira:read']
        }
      ]
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
    },
    _meta: {
      securitySchemes: [
        {
          type: 'oauth2',
          scopes: ['jira:read']
        }
      ]
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
    },
    _meta: {
      securitySchemes: [
        {
          type: 'oauth2',
          scopes: ['jira:read']
        }
      ]
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
    },
    _meta: {
      securitySchemes: [
        {
          type: 'oauth2',
          scopes: ['jira:read']
        }
      ]
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
    },
    _meta: {
      securitySchemes: [
        {
          type: 'oauth2',
          scopes: ['jira:read']
        }
      ]
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
    },
    _meta: {
      securitySchemes: [
        {
          type: 'oauth2',
          scopes: ['jira:read']
        }
      ]
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

  if (
    req.url === '/.well-known/oauth-protected-resource' &&
    req.method === 'GET'
  ) {
    oauthJson(res, 200, {
      resource: oauthResource,
      authorization_servers: [oauthIssuer],
      scopes_supported: [oauthScope],
      resource_documentation: `${publicUrl}/health`
    });

    return;
  }

  if (
    req.url === '/.well-known/oauth-authorization-server' &&
    req.method === 'GET'
  ) {
    oauthJson(res, 200, {
      issuer: oauthIssuer,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${oauthIssuer}/oauth/authorize`,
      token_endpoint: `${oauthIssuer}/oauth/token`,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [oauthScope, 'offline_access']
    });

    return;
  }

  if (req.url?.startsWith('/oauth/authorize') && req.method === 'GET') {
    if (!mcpBearer) {
      oauthJson(res, 500, {
        error: 'server_error',
        error_description: 'MCP_BEARER_TOKEN is not configured'
      });
      return;
    }

    const requestUrl = new URL(req.url, publicUrl);

    const clientId = requestUrl.searchParams.get('client_id') ?? '';
    const redirectUri = requestUrl.searchParams.get('redirect_uri') ?? '';
    const responseType = requestUrl.searchParams.get('response_type') ?? '';
    const codeChallenge = requestUrl.searchParams.get('code_challenge') ?? '';
    const codeChallengeMethod =
      requestUrl.searchParams.get('code_challenge_method') ?? '';
    const resource = requestUrl.searchParams.get('resource') ?? '';
    const state = requestUrl.searchParams.get('state') ?? '';
    const scope = requestUrl.searchParams.get('scope') ?? oauthScope;

    if (!validChatGPTClient(clientId)) {
      oauthJson(res, 400, {
        error: 'invalid_client',
        error_description: 'Unsupported OAuth client'
      });
      return;
    }

    if (!validRedirectUri(redirectUri)) {
      oauthJson(res, 400, {
        error: 'invalid_request',
        error_description: 'Invalid redirect_uri'
      });
      return;
    }

    if (responseType !== 'code') {
      oauthError(
        res,
        400,
        'unsupported_response_type',
        'Only response_type=code is supported',
        redirectUri,
        state
      );
      return;
    }

    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      oauthError(
        res,
        400,
        'invalid_request',
        'PKCE S256 is required',
        redirectUri,
        state
      );
      return;
    }

    if (!validScope(scope)) {
      oauthError(
        res,
        400,
        'invalid_scope',
        'Unsupported OAuth scope',
        redirectUri,
        state
      );
      return;
    }

    if (resource !== oauthResource) {
      oauthError(
        res,
        400,
        'invalid_target',
        'Invalid resource',
        redirectUri,
        state
      );
      return;
    }

    if (!scope.split(' ').includes(oauthScope)) {
      oauthError(
        res,
        400,
        'invalid_scope',
        'The jira:read scope is required',
        redirectUri,
        state
      );
      return;
    }

    const form = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Jira Direct authorization</title>
          <style>
            body {
              font-family: system-ui, sans-serif;
              max-width: 520px;
              margin: 60px auto;
              padding: 0 20px;
              line-height: 1.5;
            }
            input {
              width: 100%;
              padding: 10px;
              margin: 8px 0 16px;
              box-sizing: border-box;
            }
            button {
              padding: 10px 18px;
              cursor: pointer;
            }
            .scope {
              background: #f4f4f4;
              padding: 10px;
              border-radius: 6px;
            }
          </style>
        </head>
        <body>
          <h1>Authorize Jira Direct</h1>
          <p>
            ChatGPT is requesting read-only access to your Jira workspace.
          </p>
          <p class="scope">
            Requested scope: <strong>jira:read</strong>
          </p>
          <form method="POST" action="/oauth/authorize">
            <input type="hidden" name="client_id" value="${htmlEscape(clientId)}">
            <input type="hidden" name="redirect_uri" value="${htmlEscape(redirectUri)}">
            <input type="hidden" name="response_type" value="code">
            <input type="hidden" name="code_challenge" value="${htmlEscape(codeChallenge)}">
            <input type="hidden" name="code_challenge_method" value="S256">
            <input type="hidden" name="resource" value="${htmlEscape(resource)}">
            <input type="hidden" name="scope" value="${htmlEscape(scope)}">
            <input type="hidden" name="state" value="${htmlEscape(state)}">

            <label for="secret">Connection secret</label>
            <input
              id="secret"
              name="connection_secret"
              type="password"
              autocomplete="current-password"
              required
            >

            <button type="submit">Authorize</button>
          </form>
        </body>
      </html>
    `;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    });

    res.end(form);
    return;
  }

  if (req.url === '/oauth/authorize' && req.method === 'POST') {
    if (!mcpBearer) {
      oauthJson(res, 500, {
        error: 'server_error',
        error_description: 'MCP_BEARER_TOKEN is not configured'
      });
      return;
    }

    const chunks = [];

    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const params = new URLSearchParams(
      Buffer.concat(chunks).toString('utf8')
    );

    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const responseType = params.get('response_type') ?? '';
    const codeChallenge = params.get('code_challenge') ?? '';
    const codeChallengeMethod =
      params.get('code_challenge_method') ?? '';
    const resource = params.get('resource') ?? '';
    const state = params.get('state') ?? '';
    const scope = params.get('scope') ?? oauthScope;
    const connectionSecret = params.get('connection_secret') ?? '';

    if (!validChatGPTClient(clientId) || !validRedirectUri(redirectUri)) {
      oauthJson(res, 400, {
        error: 'invalid_request',
        error_description: 'Invalid OAuth client or redirect URI'
      });
      return;
    }

    if (
      responseType !== 'code' ||
      !codeChallenge ||
      codeChallengeMethod !== 'S256'
    ) {
      oauthError(
        res,
        400,
        'invalid_request',
        'PKCE S256 is required',
        redirectUri,
        state
      );
      return;
    }

    if (resource !== oauthResource) {
      oauthError(
        res,
        400,
        'invalid_target',
        'Invalid resource',
        redirectUri,
        state
      );
      return;
    }

    if (connectionSecret !== mcpBearer) {
      oauthError(
        res,
        403,
        'access_denied',
        'Invalid connection secret',
        redirectUri,
        state
      );
      return;
    }

    const code = base64url(crypto.randomBytes(32));
    const now = Math.floor(Date.now() / 1000);

    for (const [storedCode, storedAuthorization] of authorizationCodes) {
      if (storedAuthorization.expiresAt <= now) {
        authorizationCodes.delete(storedCode);
      }
    }

    authorizationCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      resource,
      scope,
      expiresAt: now + 300
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('iss', oauthIssuer);

    if (state) {
      redirect.searchParams.set('state', state);
    }

    res.writeHead(302, {
      Location: redirect.toString(),
      'Cache-Control': 'no-store'
    });

    res.end();
    return;
  }

  if (req.url === '/oauth/token' && req.method === 'POST') {
    if (!mcpBearer) {
      oauthJson(res, 500, {
        error: 'server_error',
        error_description: 'MCP_BEARER_TOKEN is not configured'
      });
      return;
    }

    const chunks = [];

    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const params = new URLSearchParams(
      Buffer.concat(chunks).toString('utf8')
    );

    const grantType = params.get('grant_type') ?? '';
    const clientId = params.get('client_id') ?? '';
    const resource = params.get('resource') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';

    if (!validChatGPTClient(clientId)) {
      oauthJson(res, 400, {
        error: 'invalid_client',
        error_description: 'Unsupported OAuth client'
      });
      return;
    }

    if (resource !== oauthResource) {
      oauthJson(res, 400, {
        error: 'invalid_target',
        error_description: 'Invalid resource'
      });
      return;
    }

    if (grantType === 'authorization_code') {
      const code = params.get('code') ?? '';
      const codeVerifier = params.get('code_verifier') ?? '';

      const stored = authorizationCodes.get(code);

      if (!stored || stored.expiresAt <= Math.floor(Date.now() / 1000)) {
        if (stored) {
          authorizationCodes.delete(code);
        }

        oauthJson(res, 400, {
          error: 'invalid_grant',
          error_description: 'Invalid or expired authorization code'
        });
        return;
      }

      authorizationCodes.delete(code);

      if (
        stored.clientId !== clientId ||
        stored.redirectUri !== redirectUri ||
        stored.resource !== resource
      ) {
        oauthJson(res, 400, {
          error: 'invalid_grant',
          error_description: 'Authorization code binding mismatch'
        });
        return;
      }

      if (!codeVerifier) {
        oauthJson(res, 400, {
          error: 'invalid_grant',
          error_description: 'code_verifier is required'
        });
        return;
      }

      const expectedChallenge = base64url(
        crypto
          .createHash('sha256')
          .update(codeVerifier, 'ascii')
          .digest()
      );

      if (!constantTimeEqual(expectedChallenge, stored.codeChallenge)) {
        oauthJson(res, 400, {
          error: 'invalid_grant',
          error_description: 'PKCE verification failed'
        });
        return;
      }

      const accessToken = oauthAccessToken();
      const refreshToken = oauthRefreshToken();

      refreshTokens.add(refreshToken);

      oauthJson(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: oauthScope
      });

      return;
    }

    if (grantType === 'refresh_token') {
      const suppliedRefreshToken = params.get('refresh_token') ?? '';

      const refreshPayload = verifySignedToken(suppliedRefreshToken);

      if (
        !refreshPayload ||
        refreshPayload.type !== 'refresh_token' ||
        !refreshTokens.has(suppliedRefreshToken)
      ) {
        oauthJson(res, 400, {
          error: 'invalid_grant',
          error_description: 'Invalid or expired refresh token'
        });
        return;
      }

      refreshTokens.delete(suppliedRefreshToken);

      const accessToken = oauthAccessToken();
      const refreshToken = oauthRefreshToken();

      refreshTokens.add(refreshToken);

      oauthJson(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: oauthScope
      });

      return;
    }

    oauthJson(res, 400, {
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code and refresh_token are supported'
    });

    return;
  }

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
      'WWW-Authenticate': `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource", scope="jira:read", error="invalid_token", error_description="OAuth authorization required"`
    });

    res.end(JSON.stringify({
      error: 'unauthorized',
      error_description: 'OAuth authorization required'
    }));

    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  const server = createServer();

  // ChatGPT OAuth compatibility: MCP SDK 1.30.1 serializes
  // securitySchemes only under _meta. OpenAI expects the root-level
  // securitySchemes field as well. Wrap the SDK's existing tools/list
  // handler without replacing the SDK's request-handler registration.
  const requestHandlers = (server.server as any)._requestHandlers;
  const existingToolsListHandler = requestHandlers.get('tools/list');

  if (!existingToolsListHandler) {
    throw new Error('MCP tools/list handler is not installed');
  }

  requestHandlers.set('tools/list', async (request: any, extra: any) => {
    const result = await existingToolsListHandler(request, extra);

    return {
      ...result,
      tools: result.tools.map((tool: any) => ({
        ...tool,
        ...(tool._meta?.securitySchemes
          ? { securitySchemes: tool._meta.securitySchemes }
          : {})
      }))
    };
  });

  await server.connect(transport);
  await requestContext.run(req, async () => {
    await transport.handleRequest(req, res);
  });
});

httpServer.listen(port, () => {
  console.log(
    `jira-direct-mcp listening on http://localhost:${port} ` +
    `(writes: ${writeEnabled ? 'enabled' : 'disabled'})`
  );
});
