export type Column = { id: string; name: string; label: string; color: string; localOnly?: boolean };
export type RoutingRule = { id: string; label: string; repository: string };
export type Settings = { repositories: string[]; columns: Column[]; routingRules: RoutingRule[] };
export type Workspace = { id: string; name: string; role: 'owner' | 'member'; memberCount: number };
export type WorkspaceMember = { id: number; login: string; avatarUrl: string; role: 'owner' | 'member'; joinedAt: string };

export type Comment = {
  id: number;
  author: string;
  avatarUrl: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
};

export type Issue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  repository: string;
  labels: { name: string; color: string }[];
  assignees: { login: string; avatarUrl: string }[];
  commentCount: number;
  latestComment: Comment | null;
  updatedAt: string;
  localOnly?: boolean;
};

export function commentExcerpt(body: string, length = 150): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  return normalized.length > length ? `${normalized.slice(0, length - 1)}…` : normalized;
}

export const DEFAULT_SETTINGS: Settings = {
  repositories: [],
  columns: [
    { id: 'backlog', name: 'Backlog', label: 'status: backlog', color: '6b7280' },
    { id: 'progress', name: 'In progress', label: 'status: in progress', color: 'f59e0b' },
    { id: 'review', name: 'Review', label: 'status: review', color: '8b5cf6' },
    { id: 'done', name: 'Done', label: 'status: done', color: '10b981' }
  ],
  routingRules: []
};

export function resolveRepository(label: string, settings: Settings): string | undefined {
  return settings.routingRules.find((rule) => rule.label.toLowerCase() === label.trim().toLowerCase())?.repository
    ?? settings.repositories[0];
}

export function issueColumn(issue: Issue, settings: Settings): string {
  const labels = new Set(issue.labels.map((label) => label.name.toLowerCase()));
  return settings.columns.find((column) => labels.has(column.label.toLowerCase()))?.id ?? settings.columns[0]?.id ?? '';
}
