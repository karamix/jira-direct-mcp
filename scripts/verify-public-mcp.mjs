import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] ?? process.env.PUBLIC_MCP_URL;
const token = process.env.MCP_BEARER_TOKEN;

if (!url) {
  throw new Error(
    'Usage: MCP_BEARER_TOKEN=... node scripts/verify-public-mcp.mjs https://<quick-tunnel>.trycloudflare.com/mcp'
  );
}

if (!token) {
  throw new Error('MCP_BEARER_TOKEN is not set');
}

const client = new Client(
  { name: 'jira-direct-regression', version: '1.0.0' },
  { capabilities: {} }
);

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${token}`
    }
  }
});

const passed = [];
const failed = [];

function pass(name, detail = '') {
  passed.push(name);
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, error) {
  failed.push(name);
  console.error(
    `FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`
  );
}

function textFrom(result) {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function assertProjectRun(result) {
  const text = textFrom(result);

  if (
    !text.includes('"key": "RUN"') ||
    !text.includes('"name": "Running App"')
  ) {
    throw new Error('Expected project key RUN and name Running App');
  }
}

await client.connect(transport);

pass(
  'initialize',
  `server=${client.getServerVersion()?.name ?? 'unknown'}`
);

const listed = await client.listTools();

const expectedTools = [
  'jira_search',
  'jira_get_issue',
  'jira_get_changelog',
  'jira_get_comments',
  'jira_get_project',
  'jira_get_issue_links'
];

const actualTools = listed.tools.map((tool) => tool.name);
const missing = expectedTools.filter(
  (name) => !actualTools.includes(name)
);

if (missing.length) {
  throw new Error(`Missing tools: ${missing.join(', ')}`);
}

pass('tools/list', `${actualTools.length} tools advertised`);

try {
  const result = await client.callTool({
    name: 'jira_get_project',
    arguments: { projectKey: 'RUN' }
  });

  assertProjectRun(result);
  pass('jira_get_project', 'RUN / Running App');
} catch (error) {
  fail('jira_get_project', error);
}

let issueKey;

try {
  const result = await client.callTool({
    name: 'jira_search',
    arguments: {
      jql: 'project = RUN ORDER BY key ASC',
      maxResults: 1
    }
  });

  const text = textFrom(result);
  const parsed = JSON.parse(text);

  issueKey = parsed.issues?.[0]?.key;

  if (!issueKey) {
    throw new Error('No issue returned by the RUN project search');
  }

  pass('jira_search', `sample issue=${issueKey}`);
} catch (error) {
  fail('jira_search', error);
}

if (issueKey) {
  const issueTests = [
    ['jira_get_issue', { issueKey }],
    [
      'jira_get_changelog',
      { issueKey, startAt: 0, maxResults: 10 }
    ],
    [
      'jira_get_comments',
      { issueKey, startAt: 0, maxResults: 10 }
    ],
    ['jira_get_issue_links', { issueKey }]
  ];

  for (const [name, arguments_] of issueTests) {
    try {
      await client.callTool({
        name,
        arguments: arguments_
      });

      pass(name, issueKey);
    } catch (error) {
      fail(name, error);
    }
  }
}

await client.close();

console.log('');
console.log(`Passed: ${passed.length}`);
console.log(`Failed: ${failed.length}`);

if (failed.length) {
  process.exitCode = 1;
} else {
  console.log('PUBLIC MCP REGRESSION: ALL CHECKS PASSED');
}
