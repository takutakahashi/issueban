import * as z from 'zod/v4';
import { ensureLabel, getViewer, GitHubError, listIssues, github } from './github';
import { resolveRepository, type Settings } from '../shared/types';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', MCP_PROTOCOL_VERSION]);

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown };
type ToolHandler = (token: string, params: Record<string, unknown>, settings: Settings) => Promise<unknown>;
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: ToolHandler;
};

type BoardColumn = { id: string; label: string; color?: string };
type BoardCard = {
  repository: string;
  number: number;
  title: string;
  body: string | null;
  columnId: string;
  labels: string[];
  updatedAt: string;
};

const repositorySchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);

const moveCardSchema = z.object({
  repository: repositorySchema,
  cardNumber: z.number().int().min(1),
  targetColumnId: z.string().min(1)
});

const createCardSchema = z.object({
  repository: repositorySchema.optional(),
  columnId: z.string().min(1),
  title: z.string().min(1).max(256),
  body: z.string().max(65536).optional(),
  issuebanLabel: z.string().max(50).optional()
});

function resolveColumnId(issueLabels: string[], columns: { id: string; label: string }[]): string {
  const labelSet = new Set(issueLabels.map((label) => label.toLowerCase()));
  return columns.find((column) => labelSet.has(column.label.toLowerCase()))?.id ?? columns[0]?.id ?? '';
}

function parseArgs(schema: z.ZodType, params: Record<string, unknown>): unknown {
  const result = schema.safeParse(params);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
    throw new Error(message);
  }
  return result.data as unknown;
}

const tools: ToolDefinition[] = [
  {
    name: 'issueban_get_authenticated_user',
    description: 'Get the GitHub user associated with the request bearer token.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (token) => await getViewer(token)
  },
  {
    name: 'issueban_list_board',
    description: 'List all cards on the Issueban board across configured repositories, with column assignments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (token, _params, settings) => {
      const cards: BoardCard[] = [];
      for (const repository of settings.repositories) {
        const issues = await listIssues(token, repository);
        for (const issue of issues) {
          const labelNames = issue.labels.map((label) => label.name);
          cards.push({
            repository,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            columnId: resolveColumnId(labelNames, settings.columns),
            labels: labelNames,
            updatedAt: issue.updatedAt
          });
        }
      }
      return cards;
    }
  },
  {
    name: 'issueban_move_card',
    description: 'Move a card to a different column by updating its GitHub labels.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$' },
        cardNumber: { type: 'integer', minimum: 1 },
        targetColumnId: { type: 'string', minLength: 1 },
      },
      required: ['repository', 'cardNumber', 'targetColumnId'],
      additionalProperties: false
    },
    run: async (token, params, settings) => {
      const args = parseArgs(moveCardSchema, params) as { repository: string; cardNumber: number; targetColumnId: string };
      const targetColumn = settings.columns.find((column) => column.id === args.targetColumnId);
      if (!targetColumn) throw new Error(`Column not found: ${args.targetColumnId}`);

      const issue = await github<{ labels: ({ name?: string } | string)[] }>(token, `/repos/${args.repository}/issues/${args.cardNumber}`);
      const statusLabels = new Set(settings.columns.map((column) => column.label.toLowerCase()));
      const labels = issue.labels
        .map((label) => typeof label === 'string' ? label : label.name ?? '')
        .filter((label) => label && !statusLabels.has(label.toLowerCase()));
      labels.push(targetColumn.label);

      await ensureLabel(token, args.repository, targetColumn.label, targetColumn.color);
      await github(token, `/repos/${args.repository}/issues/${args.cardNumber}`, {
        method: 'PATCH',
        body: JSON.stringify({ labels })
      });
      return { repository: args.repository, cardNumber: args.cardNumber, columnId: targetColumn.id, labels };
    }
  },
  {
    name: 'issueban_create_card',
    description: 'Create a new card (GitHub issue) on the Issueban board.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$' },
        columnId: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1, maxLength: 256 },
        body: { type: 'string', maxLength: 65536 },
        issuebanLabel: { type: 'string', maxLength: 50 },
      },
      required: ['columnId', 'title'],
      additionalProperties: false
    },
    run: async (token, params, settings) => {
      const args = parseArgs(createCardSchema, params) as {
        repository?: string; columnId: string; title: string; body?: string; issuebanLabel?: string;
      };
      const repository = args.repository ?? resolveRepository(args.issuebanLabel ?? '', settings);
      if (!repository) throw new Error('Repository not specified and no routing rule or repository configured.');
      const column = settings.columns.find((item) => item.id === args.columnId);
      if (!column) throw new Error(`Column not found: ${args.columnId}`);

      await ensureLabel(token, repository, column.label, column.color);
      const labels = [column.label];
      if (args.issuebanLabel) labels.push(args.issuebanLabel);
      const issue = await github<Record<string, unknown>>(token, `/repos/${repository}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: args.title, body: args.body ?? '', labels })
      });
      return issue;
    }
  }
];

function responseHeaders(protocolVersion: string): Headers {
  const headers = new Headers({
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'MCP-Session-Id, MCP-Protocol-Version',
    'content-type': 'application/json',
    'mcp-protocol-version': protocolVersion
  });
  return headers;
}

function resultResponse(id: JsonRpcId | undefined, result: Record<string, unknown>, protocolVersion = MCP_PROTOCOL_VERSION): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: responseHeaders(protocolVersion) });
}

function errorResponse(id: JsonRpcId | undefined, code: number, message: string, status: number, protocolVersion = MCP_PROTOCOL_VERSION): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), { status, headers: responseHeaders(protocolVersion) });
}

function notificationResponse(): Response {
  return new Response(null, {
    status: 202,
    headers: new Headers({
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'MCP-Protocol-Version',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION
    })
  });
}

function toolResult(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: { result: data } };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callTool(id: JsonRpcId | undefined, params: unknown, token: string, settings: Settings | null): Promise<Response> {
  const parsed = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).safeParse(params ?? {});
  if (!parsed.success) return errorResponse(id, -32602, 'Invalid params for tools/call', 400);

  const tool = tools.find((item) => item.name === parsed.data.name);
  if (!tool) return errorResponse(id, -32602, `Unknown tool: ${parsed.data.name}`, 400);

  try {
    const data = await tool.run(token, parsed.data.arguments ?? {}, settings ?? { repositories: [], columns: [], routingRules: [] });
    return resultResponse(id, toolResult(data));
  } catch (error) {
    if (error instanceof GitHubError) return resultResponse(id, toolError(error.message));
    return resultResponse(id, toolError(error instanceof Error ? error.message : 'Tool execution failed'));
  }
}

export async function handleMcpRequest(request: Request, token: string, settings: Settings | null): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
        'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
        'access-control-max-age': '86400'
      })
    });
  }
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method === 'GET') {
    const headers = responseHeaders(MCP_PROTOCOL_VERSION);
    headers.set('allow', 'POST, DELETE, OPTIONS');
    return new Response(JSON.stringify({ error: 'Server-initiated SSE streams are not supported' }), { status: 405, headers });
  }
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });

  let request_: JsonRpcRequest;
  try {
    request_ = await request.json() as JsonRpcRequest;
  } catch {
    return errorResponse(undefined, -32700, 'Parse error', 400);
  }

  const parsed = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional()
  }).safeParse(request_);
  if (!parsed.success) return errorResponse(undefined, -32600, 'Invalid Request', 400);

  const { id, method, params } = parsed.data;
  if (method.startsWith('notifications/')) return notificationResponse();

  if (method === 'initialize') {
    const version = z.object({ protocolVersion: z.string() }).safeParse(params ?? {});
    const requested = version.success ? version.data.protocolVersion : MCP_PROTOCOL_VERSION;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION;
    return resultResponse(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'issueban-github-mcp', version: '0.1.0' },
      instructions: 'Authenticate with a GitHub personal access token using the Authorization: Bearer header. Board settings are automatically loaded from the Issueban workspace associated with the token owner.'
    }, protocolVersion);
  }
  if (method === 'ping') return resultResponse(id, {});
  if (method === 'tools/list') {
    return resultResponse(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') return await callTool(id, params, token, settings);
  if (method === 'resources/list') return resultResponse(id, { resources: [] });
  if (method === 'prompts/list') return resultResponse(id, { prompts: [] });
  return errorResponse(id, -32601, `Method not found: ${method}`, 400);
}
