export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraUpdateFields {
  summary?: string;
  description?: string;
  priority?: string;
  labels?: string[];
}

function adfText(value: string) {
  return {
    type: 'doc',
    version: 1,
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: value }]
    }]
  };
}

export class JiraClient {
  constructor(private readonly config: JiraConfig) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const auth = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
        ...(init.headers ?? {})
      }
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Jira API ${response.status}: ${body.slice(0, 1000)}`);
    }

    return body ? JSON.parse(body) as T : (undefined as T);
  }

  async search(jql: string, maxResults = 50) {
    return this.request<any>('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults,
        fields: ['key']
      })
    });
  }

  async getIssue(issueKey: string, fields?: string[]) {
    const query = fields?.length
      ? `?fields=${encodeURIComponent(fields.join(','))}`
      : '';

    return this.request<any>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}${query}`
    );
  }

  async getChangelog(issueKey: string, startAt = 0, maxResults = 100) {
    return this.request<any>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?startAt=${startAt}&maxResults=${maxResults}`
    );
  }

  async getComments(issueKey: string, startAt = 0, maxResults = 100) {
    return this.request<any>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=${maxResults}`
    );
  }

  async getProject(projectKey: string) {
    return this.request<any>(
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`
    );
  }

  async getIssueLinks(issueKey: string) {
    return this.request<any>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=issuelinks`
    );
  }

  async addComment(issueKey: string, body: string) {
    return this.request<any>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        method: 'POST',
        body: JSON.stringify({ body: adfText(body) })
      }
    );
  }

  async updateIssue(issueKey: string, fields: JiraUpdateFields) {
    const jiraFields: Record<string, unknown> = {};

    if (fields.summary !== undefined) {
      jiraFields.summary = fields.summary;
    }

    if (fields.description !== undefined) {
      jiraFields.description = adfText(fields.description);
    }

    if (fields.priority !== undefined) {
      jiraFields.priority = { name: fields.priority };
    }

    if (fields.labels !== undefined) {
      jiraFields.labels = fields.labels;
    }

    return this.request<any>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ fields: jiraFields })
      }
    );
  }

  async getTransitions(issueKey: string) {
    return this.request<any>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`
    );
  }

  async transitionIssue(issueKey: string, transitionId: string) {
    return this.request<any>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
      {
        method: 'POST',
        body: JSON.stringify({
          transition: { id: transitionId }
        })
      }
    );
  }

  async createIssue(input: {
    projectKey: string;
    issueTypeName: string;
    summary: string;
    description?: string;
    priority?: string;
    labels?: string[];
  }) {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueTypeName },
      summary: input.summary
    };

    if (input.description !== undefined) {
      fields.description = adfText(input.description);
    }

    if (input.priority !== undefined) {
      fields.priority = { name: input.priority };
    }

    if (input.labels !== undefined) {
      fields.labels = input.labels;
    }

    return this.request<any>('/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({ fields })
    });
  }
}
