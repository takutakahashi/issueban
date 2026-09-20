import type { Issue, Settings, Workspace, WorkspaceMember } from '../shared/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const api = {
  me: () => request<{ user: { login: string; avatarUrl: string; authType: string }; workspace: { id: string; name: string; role: 'owner' | 'member' } }>('/api/me'),
  patLogin: (token: string) => request('/api/auth/pat', { method: 'POST', body: JSON.stringify({ token }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  settings: () => request<{ settings: Settings }>('/api/settings'),
  saveSettings: (settings: Settings) => request<{ settings: Settings }>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  issues: () => request<{ issues: Issue[]; errors: { repository: string; message: string }[] }>('/api/issues'),
  createIssue: (input: { title: string; body: string; issuebanLabel: string; columnId: string }) => request('/api/issues', { method: 'POST', body: JSON.stringify(input) }),
  moveIssue: (issue: Issue, columnId: string) => request(`/api/issues/${issue.repository}/${issue.number}/move`, { method: 'PATCH', body: JSON.stringify({ columnId }) }),
  workspaces: () => request<{ workspaces: Workspace[]; currentId: string }>('/api/workspaces'),
  members: () => request<{ workspace: { id: string; name: string; role: 'owner' | 'member' }; members: WorkspaceMember[] }>('/api/workspace/members'),
  createWorkspace: (name: string) => request('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
  switchWorkspace: (id: string) => request(`/api/workspaces/${id}/switch`, { method: 'POST' }),
  joinWorkspace: (code: string) => request('/api/workspaces/join', { method: 'POST', body: JSON.stringify({ code }) }),
  renameWorkspace: (name: string) => request('/api/workspace', { method: 'PATCH', body: JSON.stringify({ name }) }),
  createInvite: () => request<{ code: string; expiresAt: string }>('/api/workspace/invites', { method: 'POST' }),
  removeMember: (id: number) => request(`/api/workspace/members/${id}`, { method: 'DELETE' }),
  deleteWorkspace: () => request('/api/workspace', { method: 'DELETE' }),
  leaveWorkspace: () => request('/api/workspace/leave', { method: 'POST' })
};
