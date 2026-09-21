import { afterEach, describe, expect, it } from 'vitest';
import { createComment, listComments, listIssues, updateComment } from './github';

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

const postedComment = {
  id: 12, body: '新規コメント', html_url: 'https://github.com/acme/api/issues/7#issuecomment-12', created_at: '2026-01-03T00:00:00Z',
  user: { id: 5, login: 'octocat', avatar_url: 'https://avatars.example/octocat' }
};

function stubFetchWithInit(handler: (url: string, init?: RequestInit) => Response): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => { calls.push({ url: String(input), init }); return Promise.resolve(handler(String(input), init)); }) as typeof fetch;
  return { calls };
}

describe('createComment', () => {
  it('posts the body to the issue comments endpoint and maps the created comment', async () => {
    const { calls } = stubFetchWithInit(() => jsonResponse(postedComment));

    const comment = await createComment('token', 'acme/api', 7, '新規コメント');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/api/issues/7/comments');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe(JSON.stringify({ body: '新規コメント' }));
    expect(comment).toEqual({ id: 12, author: 'octocat', avatarUrl: 'https://avatars.example/octocat', body: '新規コメント', createdAt: '2026-01-03T00:00:00Z', htmlUrl: 'https://github.com/acme/api/issues/7#issuecomment-12' });
  });
});

describe('updateComment', () => {
  it('patches the comment endpoint and maps the updated comment', async () => {
    const { calls } = stubFetchWithInit(() => jsonResponse({ ...postedComment, body: '編集後の本文' }));

    const comment = await updateComment('token', 'acme/api', 12, '編集後の本文');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/api/issues/comments/12');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(calls[0].init?.body).toBe(JSON.stringify({ body: '編集後の本文' }));
    expect(comment).toMatchObject({ id: 12, author: 'octocat', body: '編集後の本文' });
  });
});
