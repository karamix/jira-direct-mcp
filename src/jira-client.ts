export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
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
      body: JSON.stringify({ jql, maxResults })
    });
  }

  async getIssue(issueKey: string, fields?: string[]) {
    const query = fields?.length ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
    return this.request<any>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}${query}`);
  }

  async getChangelog(issueKey: string, startAt = 0, maxResults = 100) {
    return this.request<any>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?startAt=${startAt}&maxResults=${maxResults}`);
  }

  async getComments(issueKey: string, startAt = 0, maxResults = 100) {
    return this.request<any>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=${maxResults}`);
  }

  async getProject(projectKey: string) {
    return this.request<any>(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  }

  async getIssueLinks(issueKey: string) {
    return this.request<any>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=issuelinks`);
  }
}
