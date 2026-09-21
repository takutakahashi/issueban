import type { Comment, Issue } from '../shared/types';

type GitHubUser = { id: number; login: string; avatar_url: string };
type GitHubIssue = {
  id: number; number: number; title: string; body: string | null; html_url: string; updated_at: string;
  comments: number;
  pull_request?: unknown;
  labels: ({ name?: string; color?: string } | string)[];
  assignees: { login: string; avatar_url: string }[];
};
type GitHubComment = { id: number; body: string | null; html_url: string; created_at: string; user: GitHubUser | null };

const COMMENT_PREVIEW_LIMIT = 20;
const COMMENT_FETCH_CONCURRENCY = 6;

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

function toComment(comment: GitHubComment): Comment {
  return {
    id: comment.id,
    author: comment.user?.login ?? 'ghost',
    avatarUrl: comment.user?.avatar_url ?? '',
    body: comment.body ?? '',
    createdAt: comment.created_at,
    htmlUrl: comment.html_url
  };
}

export async function listComments(
  token: string,
  repository: string,
  number: number,
  options: { perPage?: number; page?: number } = {}
): Promise<Comment[]> {
  const perPage = options.perPage ?? 100;
  const page = options.page ?? 1;
  const data = await github<GitHubComment[]>(token, `/repos/${repository}/issues/${number}/comments?per_page=${perPage}&page=${page}`);
  return data.map(toComment);
}

export async function createComment(token: string, repository: string, number: number, body: string): Promise<Comment> {
  const comment = await github<GitHubComment>(token, `/repos/${repository}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  return toComment(comment);
}

export async function updateComment(token: string, repository: string, commentId: number, body: string): Promise<Comment> {
  const comment = await github<GitHubComment>(token, `/repos/${repository}/issues/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ body }) });
  return toComment(comment);
}

async function latestComment(token: string, repository: string, number: number, commentCount: number): Promise<Comment | null> {
  if (commentCount <= 0) return null;
  const comments = await listComments(token, repository, number, { perPage: 1, page: commentCount });
  return comments.at(-1) ?? null;
}

async function eachWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  }));
}

export async function listIssues(token: string, repository: string): Promise<Issue[]> {
  const data = await github<GitHubIssue[]>(token, `/repos/${repository}/issues?state=open&per_page=100&sort=updated`);
  const issues = data.filter((item) => !item.pull_request).map<Issue>((item) => ({
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    htmlUrl: item.html_url,
    repository,
    labels: item.labels.map((label) => typeof label === 'string' ? { name: label, color: '6b7280' } : { name: label.name ?? '', color: label.color ?? '6b7280' }),
    assignees: item.assignees.map((user) => ({ login: user.login, avatarUrl: user.avatar_url })),
    commentCount: item.comments,
    latestComment: null,
    updatedAt: item.updated_at
  }));
  const preview = issues.filter((issue) => issue.commentCount > 0).slice(0, COMMENT_PREVIEW_LIMIT);
  await eachWithConcurrency(preview, COMMENT_FETCH_CONCURRENCY, async (issue) => {
    issue.latestComment = await latestComment(token, repository, issue.number, issue.commentCount).catch(() => null);
  });
  return issues;
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
