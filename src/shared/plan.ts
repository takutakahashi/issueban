export const PLAN_COMMENT_MARKER = '<!-- issueban:plan -->';
export const PLAN_SOURCE_MARKER = '<!-- issueban:plan-source';

export type ParsedPlanItem = {
  position: number;
  title: string;
  body: string;
  completed: boolean;
};

export type ParsedPlan = {
  title: string;
  body: string;
  items: ParsedPlanItem[];
};

export type PlanItem = {
  position: number;
  title: string;
  body: string;
  completed: boolean;
  repository: string;
  columnId: string;
  labels: string[];
  status: 'pending' | 'applying' | 'applied' | 'failed';
  targetIssue?: { id: number; number: number; repository: string; htmlUrl: string } | null;
  errorMessage?: string | null;
};

export type Plan = {
  source: { issueId: number; repository: string; number: number; htmlUrl: string };
  commentId: number;
  title: string;
  body: string;
  items: PlanItem[];
};

export type PlanApplyItem = {
  position: number;
  repository: string;
  columnId: string;
};

export type PlanApplyResult = {
  applied: { position: number; title: string; targetIssue: { id: number; number: number; repository: string; htmlUrl: string } }[];
  failed: { position: number; title: string; message: string }[];
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function removeMarker(body: string, marker: string): string {
  const index = body.indexOf(marker);
  return index === -1 ? body : body.slice(index + marker.length);
}

export function removePlanCommentMarker(body: string): string {
  return removeMarker(body, PLAN_COMMENT_MARKER).replace(/^\s*\n/, '');
}

export function parsePlanMarkdown(input: string): ParsedPlan {
  const body = input.replace(/\r\n/g, '\n');
  const lines = body.split('\n');
  const title = lines.find((line) => /^#\s+\S/.test(line.trim()))?.replace(/^#\s+/, '').trim() ?? '';
  const items: ParsedPlanItem[] = [];
  let current: ParsedPlanItem | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^#{1,2}\s+\S/.test(line)) {
      current = null;
      continue;
    }
    const match = /^(\s*)- \[( |x|X)\]\s*(.+)$/.exec(line);
    if (match) {
      current = { position: items.length + 1, title: match[3].trim(), body: '', completed: match[2].toLowerCase() === 'x' };
      items.push(current);
      continue;
    }
    if (!current || !line.trim()) continue;
    if (rawLine.startsWith(' ') || rawLine.startsWith('\t')) {
      current.body = current.body ? `${current.body}\n${line.trim()}` : line.trim();
    }
  }

  return { title, body, items };
}

export function planCommentBody(body: string): string {
  return `${PLAN_COMMENT_MARKER}\n\n${body.trim()}\n`;
}

export function stripPlanSourceMarker(body: string): string {
  const markerEnd = body.indexOf('-->');
  if (!body.startsWith(PLAN_SOURCE_MARKER) || markerEnd === -1) return body;
  return body.slice(markerEnd + 3).trim();
}

export async function planItemDigest(
  sourceIssueId: number,
  item: Pick<ParsedPlanItem, 'title' | 'body'>,
  occurrence = 0
): Promise<string> {
  const value = [sourceIssueId, occurrence, normalizeText(item.title), normalizeText(item.body)].join('\0');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function planItemDigests(sourceIssueId: number, items: ParsedPlanItem[]): Promise<Map<number, string>> {
  const occurrenceCounts = new Map<string, number>();
  const digests = new Map<number, string>();
  for (const item of items) {
    const key = `${normalizeText(item.title)}\0${normalizeText(item.body)}`;
    const occurrence = occurrenceCounts.get(key) ?? 0;
    occurrenceCounts.set(key, occurrence + 1);
    digests.set(item.position, await planItemDigest(sourceIssueId, item, occurrence));
  }
  return digests;
}
