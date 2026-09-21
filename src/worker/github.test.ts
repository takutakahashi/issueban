import { afterEach, describe, expect, it } from 'vitest';
import { createComment, listComments, listIssues, toIssue, updateComment } from './github';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

const originalFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe('toIssue', () => {
  it('maps a newly created GitHub issue into a board card', () => {
    expect(toIssue({
      id: 42,
      number: 12,
      title: 'Issue 化するカード',
      body: '説明',
      html_url: 'https://github.com/acme/api/issues/12',
      updated_at: '2026-09-21T00:00:00Z',
      comments: 0,
      labels: [{ name: 'status: progress', color: 'f59e0b' }, 'frontend'],
      assignees: []
    }, 'acme/api')).toEqual({
      id: 42,
      number: 12,
      title: 'Issue 化するカード',
      body: '説明',
      htmlUrl: 'https://github.com/acme/api/issues/12',
      repository: 'acme/api',
      labels: [{ name: 'status: progress', color: 'f59e0b' }, { name: 'frontend', color: '6b7280' }],
      assignees: [],
      commentCount: 0,
      latestComment: null,
      updatedAt: '2026-09-21T00:00:00Z'
    });
  });
});

describe('listIssues', () => {
  it('maps issue fields and previews the latest comment of commented issues', async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      if (url.includes('/issues?')) {
        return jsonResponse([
          { id: 1, number: 7, title: 'コメントあり', body: '説明', html_url: 'https://github.com/acme/api/issues/7', updated_at: '2026-01-01T00:00:00Z', comments: 2, labels: [{ name: 'status: backlog', color: '6b7280' }], assignees: [{ login: 'octocat', avatar_url: 'https://avatars.example/octocat' }] },
          { id: 2, number: 8, title: 'コメントなし', body: null, html_url: 'https://github.com/acme/api/issues/8', updated_at: '2026-01-01T00:00:00Z', comments: 0, labels: [], assignees: [] }
        ]);
      }
      return jsonResponse([{ id: 99, body: '最新のコメント', html_url: 'https://github.com/acme/api/issues/7#issuecomment-99', created_at: '2026-01-02T00:00:00Z', user: { id: 5, login: 'octocat', avatar_url: 'https://avatars.example/octocat' } }]);
    });

    const issues = await listIssues('token', 'acme/api');

    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      number: 7,
      repository: 'acme/api',
      commentCount: 2,
      latestComment: { id: 99, author: 'octocat', body: '最新のコメント' }
    });
    expect(issues[1]).toMatchObject({ commentCount: 0, latestComment: null });
    expect(calls).toContain('https://api.github.com/repos/acme/api/issues/7/comments?per_page=1&page=2');
  });

  it('keeps the board usable when a comment preview cannot be fetched', async () => {
    stubFetch((url) => {
      if (url.includes('/issues?')) {
        return jsonResponse([{ id: 1, number: 7, title: 'コメントあり', body: null, html_url: 'https://github.com/acme/api/issues/7', updated_at: '2026-01-01T00:00:00Z', comments: 1, labels: [], assignees: [] }]);
      }
      return new Response(JSON.stringify({ message: 'rate limited' }), { status: 403 });
    });

    const issues = await listIssues('token', 'acme/api');
    expect(issues[0]).toMatchObject({ commentCount: 1, latestComment: null });
  });
});

describe('listComments', () => {
  it('maps comment authors and bodies', async () => {
    stubFetch(() => jsonResponse([
      { id: 1, body: '一つ目', html_url: 'https://github.com/acme/api/issues/7#issuecomment-1', created_at: '2026-01-01T00:00:00Z', user: { id: 5, login: 'octocat', avatar_url: 'https://avatars.example/octocat' } },
      { id: 2, body: null, html_url: 'https://github.com/acme/api/issues/7#issuecomment-2', created_at: '2026-01-02T00:00:00Z', user: null }
    ]));

    const comments = await listComments('token', 'acme/api', 7);
    expect(comments).toEqual([
      { id: 1, author: 'octocat', avatarUrl: 'https://avatars.example/octocat', body: '一つ目', createdAt: '2026-01-01T00:00:00Z', htmlUrl: 'https://github.com/acme/api/issues/7#issuecomment-1' },
      { id: 2, author: 'ghost', avatarUrl: '', body: '', createdAt: '2026-01-02T00:00:00Z', htmlUrl: 'https://github.com/acme/api/issues/7#issuecomment-2' }
    ]);
  });
});

describe('issue comments', () => {
  it('creates a comment through the GitHub issues comments API', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return jsonResponse({ id: 10, body: '新しいコメント', html_url: 'https://github.com/acme/api/issues/7#issuecomment-10', created_at: '2026-01-03T00:00:00Z', user: { id: 5, login: 'octocat', avatar_url: 'https://avatars.example/octocat' } });
    });

    const comment = await createComment('token', 'acme/api', 7, '新しいコメント');

    expect(comment).toEqual({
      id: 10,
      author: 'octocat',
      avatarUrl: 'https://avatars.example/octocat',
      body: '新しいコメント',
      createdAt: '2026-01-03T00:00:00Z',
      htmlUrl: 'https://github.com/acme/api/issues/7#issuecomment-10'
    });
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/api/issues/7/comments');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ body: '新しいコメント' });
  });

  it('updates a comment through the GitHub issues comments API', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return jsonResponse({ id: 10, body: '編集済み', html_url: 'https://github.com/acme/api/issues/7#issuecomment-10', created_at: '2026-01-03T00:00:00Z', user: { id: 5, login: 'octocat', avatar_url: 'https://avatars.example/octocat' } });
    });

    const comment = await updateComment('token', 'acme/api', 7, 10, '編集済み');

    expect(comment.body).toBe('編集済み');
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/api/issues/7/comments/10');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ body: '編集済み' });
  });
});
