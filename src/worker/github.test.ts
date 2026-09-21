import { afterEach, describe, expect, it } from 'vitest';
import { listComments, listIssues } from './github';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

const originalFetch = globalThis.fetch;

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => Promise.resolve(handler(String(input)))) as typeof fetch;
}

afterEach(() => { globalThis.fetch = originalFetch; });

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
