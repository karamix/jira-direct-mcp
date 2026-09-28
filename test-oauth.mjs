import 'dotenv/config';
import crypto from 'node:crypto';

const base = 'http://127.0.0.1:3000';
const clientId = 'https://chatgpt.com/oauth/client.json';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const resource = base;
const scope = 'jira:read offline_access';

const secret = process.env.MCP_BEARER_TOKEN;

if (!secret) throw new Error('MCP_BEARER_TOKEN is not configured');

const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
const state = crypto.randomBytes(16).toString('base64url');

const params = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  resource,
  scope,
  state
});

console.log('1. GET authorization endpoint');

const authResponse = await fetch(`${base}/oauth/authorize?${params}`);
console.log(`   HTTP ${authResponse.status}`);

if (authResponse.status !== 200) {
  throw new Error(`Authorization endpoint failed: HTTP ${authResponse.status}`);
}

console.log('   PASS: authorization page available');

console.log('2. POST authorization with connection secret');

const form = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  resource,
  scope,
  state,
  connection_secret: secret
});

const authorizeResponse = await fetch(`${base}/oauth/authorize`, {
  method: 'POST',
  headers: {'Content-Type': 'application/x-www-form-urlencoded'},
  body: form,
  redirect: 'manual'
});

console.log(`   HTTP ${authorizeResponse.status}`);

if (authorizeResponse.status !== 302) {
  throw new Error(`Authorization failed: HTTP ${authorizeResponse.status}`);
}

const location = authorizeResponse.headers.get('location');
if (!location) throw new Error('Authorization response has no Location header');

const callback = new URL(location);
const code = callback.searchParams.get('code');
const returnedState = callback.searchParams.get('state');
const returnedIss = callback.searchParams.get('iss');

if (!code) throw new Error('Authorization response contains no code');
if (returnedState !== state) throw new Error('State mismatch');
if (returnedIss !== base) throw new Error('Issuer mismatch');

console.log('   PASS: authorization code issued');
console.log('   PASS: state verified');
console.log('   PASS: issuer verified');

console.log('3. Exchange authorization code for tokens');

const tokenResponse = await fetch(`${base}/oauth/token`, {
  method: 'POST',
  headers: {'Content-Type': 'application/x-www-form-urlencoded'},
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    resource,
    code_verifier: verifier
  })
});

console.log(`   HTTP ${tokenResponse.status}`);

const tokenBody = await tokenResponse.json();

if (!tokenResponse.ok) {
  throw new Error(`Token exchange failed: ${tokenBody.error ?? 'unknown error'}`);
}

if (!tokenBody.access_token) throw new Error('No access token returned');
if (!tokenBody.refresh_token) throw new Error('No refresh token returned');

console.log('   PASS: access token issued');
console.log('   PASS: refresh token issued');
console.log(`   scope: ${tokenBody.scope}`);
console.log(`   expires_in: ${tokenBody.expires_in}`);

const accessToken = tokenBody.access_token;

console.log('4. Initialize MCP using OAuth access token');

const mcpResponse = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'oauth-test-client',
        version: '1.0.0'
      }
    }
  })
});

console.log(`   HTTP ${mcpResponse.status}`);

const mcpText = await mcpResponse.text();

if (!mcpResponse.ok) {
  throw new Error(`MCP initialize failed: HTTP ${mcpResponse.status}`);
}

if (!mcpText.includes('"serverInfo"')) {
  throw new Error('MCP initialize response missing serverInfo');
}

console.log('   PASS: OAuth access token accepted by MCP');
console.log('   PASS: MCP initialize succeeded');

console.log('');
console.log('OAUTH LOCAL FLOW: ALL CHECKS PASSED');

console.log('5. Call tools/list using OAuth access token');

const toolsResponse = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  })
});

console.log(`   HTTP ${toolsResponse.status}`);

const toolsText = await toolsResponse.text();

if (!toolsResponse.ok) {
  throw new Error(`tools/list failed: HTTP ${toolsResponse.status}`);
}

const dataLine = toolsText
  .split('\n')
  .find(line => line.startsWith('data: '));

if (!dataLine) {
  throw new Error('tools/list response contains no SSE data');
}

const toolsResult = JSON.parse(dataLine.slice(6));

if (toolsResult.error) {
  throw new Error(`tools/list returned JSON-RPC error: ${toolsResult.error.message}`);
}

const tools = toolsResult.result?.tools ?? [];

console.log(`   Tools returned: ${tools.length}`);

const expectedTools = [
  'jira_search',
  'jira_get_issue',
  'jira_get_changelog',
  'jira_get_comments',
  'jira_get_project',
  'jira_get_issue_links',
  'jira_get_transitions'
];

if (tools.length !== expectedTools.length) {
  throw new Error(
    `Expected ${expectedTools.length} tools, received ${tools.length}`
  );
}

for (const name of expectedTools) {
  const tool = tools.find(t => t.name === name);

  if (!tool) {
    throw new Error(`Missing expected tool: ${name}`);
  }

  const schemes = tool._meta?.securitySchemes;

  if (!Array.isArray(schemes)) {
    throw new Error(`${name}: missing _meta.securitySchemes`);
  }

  const oauth = schemes.find(s => s.type === 'oauth2');

  if (!oauth) {
    throw new Error(`${name}: missing oauth2 security scheme`);
  }

  if (!Array.isArray(oauth.scopes) || !oauth.scopes.includes('jira:read')) {
    throw new Error(`${name}: missing jira:read scope`);
  }

  console.log(`   PASS: ${name} — oauth2 / jira:read`);
}

console.log('');
console.log('TOOLS/LIST OAUTH CHECK: ALL 7 TOOLS PASSED');
