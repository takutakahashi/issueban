import type { Issue } from '../shared/types';

type GitHubUser = { id: number; login: string; avatar_url: string };
type GitHubIssue = {
  id: number; number: number; title: string; body: string | null; html_url: string; updated_at: string;
  pull_request?: unknown;
  labels: ({ name?: string; color?: string } | string)[];
  assignees: { login: string; avatar_url: string }[];
};

export class GitHubError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function github<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'issueban-worker',
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string };
    throw new GitHubError(response.status, body.message ?? `GitHub API returned ${response.status}`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const getViewer = (token: string) => github<GitHubUser>(token, '/user');

export async function listIssues(token: string, repository: string): Promise<Issue[]> {
  const data = await github<GitHubIssue[]>(token, `/repos/${repository}/issues?state=open&per_page=100&sort=updated`);
  return data.filter((item) => !item.pull_request).map((item) => ({
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    htmlUrl: item.html_url,
    repository,
    labels: item.labels.map((label) => typeof label === 'string' ? { name: label, color: '6b7280' } : { name: label.name ?? '', color: label.color ?? '6b7280' }),
    assignees: item.assignees.map((user) => ({ login: user.login, avatarUrl: user.avatar_url })),
    updatedAt: item.updated_at
  }));
}

export async function ensureLabel(token: string, repository: string, name: string, color: string): Promise<void> {
  const encoded = encodeURIComponent(name);
  try {
    await github(token, `/repos/${repository}/labels/${encoded}`);
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    await github(token, `/repos/${repository}/labels`, { method: 'POST', body: JSON.stringify({ name, color: color.replace('#', '') }) });
  }
}
