import { afterEach, describe, expect, it } from 'vitest';
import { handleMcpRequest } from './mcp';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

const originalFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;
}

afterEach(() => { globalThis.fetch = originalFetch; });

type JsonRpcResponse = {
  id?: string | number | null;
  result?: {
    tools?: { name: string }[];
    structuredContent?: { result?: unknown };
    content?: { text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
};

function postMcp(payload: unknown): Promise<Response> {
  return handleMcpRequest(new Request('https://issueban.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload)
  }), 'github-token');
}

const columns = [
  { id: 'backlog', label: 'status: backlog', color: '6b7280' },
  { id: 'progress', label: 'status: in progress', color: 'f59e0b' }
];

describe('remote MCP server', () => {
  it('rejects unsupported HTTP methods for the streamable HTTP transport', async () => {
    const get = await handleMcpRequest(new Request('https://issueban.example/mcp'), '');
    expect(get.status).toBe(405);
    expect(await get.text()).toContain('Server-initiated SSE streams are not supported');
  });

  it('returns the server capabilities and tool list', async () => {
    const initialize = await postMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const initialization = await initialize.json() as JsonRpcResponse;
    expect(initialization).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'issueban-github-mcp', version: '0.1.0' }
      }
    });

    const list = await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = ((await list.json()) as JsonRpcResponse).result?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      'issueban_get_authenticated_user',
      'issueban_list_board',
      'issueban_move_card',
      'issueban_create_card'
    ]);
  });

  it('lists board cards with column assignments using the bearer token', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return jsonResponse([
        { id: 1, number: 7, title: '進行中', body: null, html_url: 'https://github.com/acme/api/issues/7', updated_at: '2026-01-01T00:00:00Z', comments: 0, labels: [{ name: 'status: in progress', color: 'f59e0b' }], assignees: [] },
        { id: 2, number: 8, title: 'ラベルなし', body: '説明', html_url: 'https://github.com/acme/api/issues/8', updated_at: '2026-01-02T00:00:00Z', comments: 0, labels: [], assignees: [] }
      ]);
    });

    const response = await postMcp({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'issueban_list_board', arguments: { repositories: ['acme/api'], columns: [{ id: 'backlog', label: 'status: backlog' }, { id: 'progress', label: 'status: in progress' }] } }
    });
    const body = await response.json() as JsonRpcResponse;

    expect(response.status).toBe(200);
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer github-token' });
    const cards = body.result?.structuredContent?.result as { columnId: string; number: number }[];
    expect(cards[0]).toMatchObject({ number: 7, columnId: 'progress' });
    expect(cards[1]).toMatchObject({ number: 8, columnId: 'backlog' });
  });

  it('moves a card to another column by updating labels', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      if (init?.method === 'PATCH') return jsonResponse({ number: 7 });
      if (String(url).includes('/labels/status%3A%20backlog')) return new Response(JSON.stringify({ name: 'status: backlog' }), { status: 200 });
      if (String(url).includes('/issues/7')) return jsonResponse({ labels: [{ name: 'status: in progress' }] });
      return jsonResponse({ name: 'status: backlog' });
    });

    const response = await postMcp({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'issueban_move_card', arguments: { repository: 'acme/api', cardNumber: 7, targetColumnId: 'backlog', columns } }
    });
    const body = await response.json() as JsonRpcResponse;
    const patch = calls.find((call) => call.init?.method === 'PATCH');

    expect(response.status).toBe(200);
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ labels: ['status: backlog'] });
    expect(body.result?.structuredContent?.result).toMatchObject({ cardNumber: 7, columnId: 'backlog', labels: ['status: backlog'] });
  });

  it('creates a card with the column and issueban labels', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      if (init?.method === 'POST' && String(url).includes('/repos/acme/api/labels')) return jsonResponse({ name: 'status: backlog' });
      if (init?.method === 'POST' && String(url).includes('/repos/acme/api/issues')) return jsonResponse({ number: 10, title: '新しいカード' });
      if (String(url).includes('/labels/status%3A%20backlog')) return new Response(null, { status: 404 });
      return jsonResponse({});
    });

    const response = await postMcp({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'issueban_create_card', arguments: { repository: 'acme/api', columnId: 'backlog', title: '新しいカード', body: '説明', issuebanLabel: 'issueban: urgent', columns } }
    });
    const body = await response.json() as JsonRpcResponse;
    const create = calls.find((call) => call.init?.method === 'POST' && String(call.url).includes('/repos/acme/api/issues') && !String(call.url).includes('/labels'));

    expect(response.status).toBe(200);
    expect(JSON.parse(String(create?.init?.body))).toEqual({ title: '新しいカード', body: '説明', labels: ['status: backlog', 'issueban: urgent'] });
    expect(body.result?.structuredContent?.result).toMatchObject({ number: 10 });
  });

  it('returns invalid-parameter errors as tool results', async () => {
    const response = await postMcp({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'issueban_list_board', arguments: { repositories: [], columns: [] } }
    });
    const body = await response.json() as JsonRpcResponse;

    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0].text).toContain('repositories');
  });
});
