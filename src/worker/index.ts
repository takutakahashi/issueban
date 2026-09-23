import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { parsePlanMarkdown, planCommentBody, planItemDigests, PLAN_SOURCE_MARKER, removePlanCommentMarker, type ParsedPlanItem, type Plan, type PlanApplyResult, type PlanItem } from '../shared/plan';
import { DEFAULT_SETTINGS, resolveRepository, type Issue, type Settings } from '../shared/types';
import { decrypt, encrypt, randomToken, sha256 } from './crypto';
import { createComment, ensureLabel, getIssue, getViewer, github, GitHubError, GitHubIssue, listAllComments, listComments, listIssues, toIssue, updateComment } from './github';
import { handleMcpRequest } from './mcp';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_SECRET: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};
type WorkspaceContext = { id: string; name: string; role: 'owner' | 'member' };
type Variables = { user: { id: number; login: string; avatarUrl: string; authType: string }; token: string; workspace: WorkspaceContext };
type AppEnv = { Bindings: Bindings; Variables: Variables };
type PlanLinkRow = { item_digest: string; position: number; target_issue_id: number; target_repository: string; target_issue_number: number };
type WorkspaceCardRow = { id: number; column_id: string; title: string; body: string; issueban_label: string; created_at: string; updated_at: string };

const app = new Hono<AppEnv>();
const SESSION_COOKIE = 'issueban_session';
const sessionAge = 60 * 60 * 24 * 30;

function jsonError(message: string, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json' } });
}

function settingsSchema() {
  return z.object({
    repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(25),
    columns: z.array(z.object({ id: z.string().min(1), name: z.string().min(1).max(40), label: z.string().min(1).max(50), color: z.string().regex(/^#?[0-9a-fA-F]{6}$/), localOnly: z.boolean().optional() })).min(1).max(10),
    routingRules: z.array(z.object({ id: z.string(), label: z.string().min(1).max(50), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/) })).max(50)
  });
}

function localIssueFromCard(card: WorkspaceCardRow, settings: Settings): Issue {
  return {
    id: -card.id,
    number: -card.id,
    title: card.title,
    body: card.body,
    htmlUrl: '',
    repository: 'issueban',
    labels: settings.columns.filter((column) => column.id === card.column_id).map((column) => ({ name: column.label, color: column.color })),
    assignees: [],
    commentCount: 0,
    latestComment: null,
    updatedAt: card.updated_at,
    localOnly: true
  };
}

async function loadWorkspaceCards(c: Context<AppEnv>, settings: Settings): Promise<Issue[]> {
  const result = await c.env.DB.prepare(`SELECT id, column_id, title, body, issueban_label, created_at, updated_at
    FROM workspace_cards WHERE workspace_id = ? ORDER BY created_at, id`)
    .bind(c.get('workspace').id).all<WorkspaceCardRow>();
  return result.results.map((card) => localIssueFromCard(card, settings));
}

async function ensureWorkspace(c: Context<AppEnv>, user: { id: number; login: string }): Promise<WorkspaceContext> {
  const existing = await c.env.DB.prepare(`SELECT workspaces.id, workspaces.name, workspace_members.role
    FROM users JOIN workspace_members ON workspace_members.workspace_id = users.current_workspace_id AND workspace_members.user_id = users.id
    JOIN workspaces ON workspaces.id = workspace_members.workspace_id WHERE users.id = ?`)
    .bind(user.id).first<{ id: string; name: string; role: 'owner' | 'member' }>();
  if (existing) return existing;

  const workspaceId = crypto.randomUUID();
  const legacy = await c.env.DB.prepare('SELECT settings FROM users WHERE id = ?').bind(user.id).first<{ settings: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO workspaces (id, name, owner_id, settings) VALUES (?, ?, ?, ?)').bind(workspaceId, `${user.login}'s workspace`, user.id, legacy?.settings ?? '{}'),
    c.env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(workspaceId, user.id),
    c.env.DB.prepare('UPDATE users SET current_workspace_id = ? WHERE id = ?').bind(workspaceId, user.id)
  ]);
  return { id: workspaceId, name: `${user.login}'s workspace`, role: 'owner' };
}

async function createSession(c: Context<AppEnv>, user: { id: number; login: string; avatar_url: string }, token: string, authType: 'oauth' | 'pat') {
  const encrypted = await encrypt(token, c.env.APP_SECRET);
  await c.env.DB.prepare(`INSERT INTO users (id, login, avatar_url, token_ciphertext, token_iv, auth_type)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET login=excluded.login, avatar_url=excluded.avatar_url,
    token_ciphertext=excluded.token_ciphertext, token_iv=excluded.token_iv, auth_type=excluded.auth_type, updated_at=CURRENT_TIMESTAMP`)
    .bind(user.id, user.login, user.avatar_url, encrypted.ciphertext, encrypted.iv, authType).run();
  const session = randomToken();
  const expiresAt = new Date(Date.now() + sessionAge * 1000).toISOString();
  await c.env.DB.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(session), user.id, expiresAt).run();
  setCookie(c, SESSION_COOKIE, session, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: sessionAge });
}

app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth/')) return next();
  const session = getCookie(c, SESSION_COOKIE);
  if (!session) return c.json({ error: 'Authentication required' }, 401);
  const row = await c.env.DB.prepare(`SELECT users.id, users.login, users.avatar_url, users.auth_type, users.token_ciphertext, users.token_iv
    FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id_hash = ? AND sessions.expires_at > CURRENT_TIMESTAMP`)
    .bind(await sha256(session)).first<{ id: number; login: string; avatar_url: string; auth_type: string; token_ciphertext: string; token_iv: string }>();
  if (!row) return c.json({ error: 'Session expired' }, 401);
  c.set('user', { id: row.id, login: row.login, avatarUrl: row.avatar_url, authType: row.auth_type });
  c.set('token', await decrypt(row.token_ciphertext, row.token_iv, c.env.APP_SECRET));
  c.set('workspace', await ensureWorkspace(c, { id: row.id, login: row.login }));
  await next();
});

app.post('/api/auth/pat', zValidator('json', z.object({ token: z.string().min(20).max(255) })), async (c) => {
  const { token } = c.req.valid('json');
  try {
    const user = await getViewer(token);
    await createSession(c, user, token, 'pat');
    return c.json({ user: { login: user.login, avatarUrl: user.avatar_url } });
  } catch { return c.json({ error: 'PAT を確認できませんでした。権限と有効期限を確認してください。' }, 401); }
});

app.get('/api/auth/oauth/start', async (c) => {
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) return c.json({ error: 'GitHub OAuth が設定されていません' }, 503);
  const state = randomToken();
  await c.env.DB.prepare('INSERT INTO oauth_states (state_hash, expires_at) VALUES (?, ?)').bind(await sha256(state), new Date(Date.now() + 10 * 60_000).toISOString()).run();
  const redirectUri = new URL('/api/auth/oauth/callback', c.req.url).toString();
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'repo read:user');
  url.searchParams.set('state', state);
  return c.redirect(url.toString());
});

app.get('/api/auth/oauth/callback', async (c) => {
  const code = c.req.query('code'); const state = c.req.query('state');
  if (!code || !state || !c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) return c.redirect('/?auth_error=invalid_oauth_callback');
  const hash = await sha256(state);
  const valid = await c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > CURRENT_TIMESTAMP RETURNING state_hash').bind(hash).first();
  if (!valid) return c.redirect('/?auth_error=invalid_oauth_state');
  const response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: c.env.GITHUB_CLIENT_ID, client_secret: c.env.GITHUB_CLIENT_SECRET, code }) });
  const result = await response.json<{ access_token?: string; error?: string }>();
  if (!result.access_token) return c.redirect('/?auth_error=token_exchange_failed');
  const user = await getViewer(result.access_token);
  await createSession(c, user, result.access_token, 'oauth');
  return c.redirect('/');
});

app.post('/api/auth/logout', async (c) => {
  const session = getCookie(c, SESSION_COOKIE);
  if (session) await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(session)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.body(null, 204);
});

app.get('/api/me', (c) => c.json({ user: c.get('user'), workspace: c.get('workspace') }));

app.get('/api/settings', async (c) => {
  const row = await c.env.DB.prepare('SELECT settings FROM workspaces WHERE id = ?').bind(c.get('workspace').id).first<{ settings: string }>();
  return c.json({ settings: { ...DEFAULT_SETTINGS, ...(row?.settings ? JSON.parse(row.settings) : {}) } });
});

app.put('/api/settings', zValidator('json', settingsSchema()), async (c) => {
  const settings = c.req.valid('json');
  await c.env.DB.prepare('UPDATE workspaces SET settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(settings), c.get('workspace').id).run();
  return c.json({ settings });
});

async function loadSettings(c: Context<AppEnv>): Promise<Settings> {
  const row = await c.env.DB.prepare('SELECT settings FROM workspaces WHERE id = ?').bind(c.get('workspace').id).first<{ settings: string }>();
  return { ...DEFAULT_SETTINGS, ...(row?.settings ? JSON.parse(row.settings) : {}) };
}

function activePlanComment(comments: Awaited<ReturnType<typeof listAllComments>>) {
  return comments
    .filter((comment) => comment.body.startsWith('<!-- issueban:plan -->'))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
}

async function loadPlan(c: Context<AppEnv>, repository: string, number: number): Promise<Plan | null> {
  const token = c.get('token');
  const settings = await loadSettings(c);
  const source = await getIssue(token, repository, number);
  const planComment = activePlanComment(await listAllComments(token, repository, number));
  if (!planComment) return null;

  const parsed = parsePlanMarkdown(removePlanCommentMarker(planComment.body));
  const links = await c.env.DB.prepare(`SELECT item_digest, position, target_issue_id, target_repository, target_issue_number
    FROM plan_item_links WHERE source_issue_id = ? ORDER BY position`)
    .bind(source.id).all<PlanLinkRow>();
  const digests = await planItemDigests(source.id, parsed.items);
  const items: PlanItem[] = parsed.items.map((item: ParsedPlanItem) => {
    const digest = digests.get(item.position);
    const link = links.results.find((row) => row.item_digest === digest);
    return {
      ...item,
      repository: settings.repositories[0] ?? '',
      columnId: settings.columns[0]?.id ?? '',
      labels: settings.columns[0] ? [settings.columns[0].label] : [],
      status: link ? 'applied' : 'pending',
      targetIssue: link ? {
        id: link.target_issue_id,
        number: link.target_issue_number,
        repository: link.target_repository,
        htmlUrl: `https://github.com/${link.target_repository}/issues/${link.target_issue_number}`
      } : null
    };
  });
  return {
    source: { kind: 'github', issueId: source.id, repository, number, htmlUrl: source.html_url },
    commentId: planComment.id,
    title: parsed.title,
    body: parsed.body,
    items
  };
}

async function workspaceCard(c: Context<AppEnv>, routeId: string): Promise<WorkspaceCardRow | null> {
  const id = Number(routeId);
  if (!Number.isSafeInteger(id) || id >= 0) return null;
  return c.env.DB.prepare(`SELECT id, column_id, title, body, issueban_label, created_at, updated_at
    FROM workspace_cards WHERE id = ? AND workspace_id = ?`).bind(-id, c.get('workspace').id).first<WorkspaceCardRow>();
}

async function loadLocalPlan(c: Context<AppEnv>, card: WorkspaceCardRow): Promise<Plan | null> {
  const stored = await c.env.DB.prepare('SELECT body FROM workspace_card_plans WHERE card_id = ?').bind(card.id).first<{ body: string }>();
  if (!stored) return null;
  const parsed = parsePlanMarkdown(stored.body);
  const links = await c.env.DB.prepare(`SELECT item_digest, position, target_issue_id, target_repository, target_issue_number
    FROM workspace_card_plan_item_links WHERE card_id = ? ORDER BY position`).bind(card.id).all<PlanLinkRow>();
  const digests = await planItemDigests(-card.id, parsed.items);
  const settings = await loadSettings(c);
  const items: PlanItem[] = parsed.items.map((item) => {
    const link = links.results.find((row) => row.item_digest === digests.get(item.position));
    return { ...item, repository: link?.target_repository ?? resolveRepository(card.issueban_label, settings) ?? settings.repositories[0] ?? '',
      columnId: settings.columns[0]?.id ?? '', labels: [], status: link ? 'applied' : 'pending',
      targetIssue: link ? { id: link.target_issue_id, number: link.target_issue_number, repository: link.target_repository,
        htmlUrl: `https://github.com/${link.target_repository}/issues/${link.target_issue_number}` } : null };
  });
  return { source: { kind: 'local', issueId: -card.id, repository: 'issueban', number: -card.id, htmlUrl: '' }, commentId: null,
    title: parsed.title || card.title, body: stored.body, items };
}

function planValidationError(parsed: ReturnType<typeof parsePlanMarkdown>): string | null {
  if (!parsed.body.trim()) return 'Plan の本文を入力してください';
  if (parsed.items.length > 25) return '作業単位は 25 件までです';
  if (parsed.items.some((item) => !item.title || item.title.length > 256 || item.body.length > 65536)) return '作業単位の内容が不正です';
  return null;
}

app.get('/api/workspaces', async (c) => {
  const result = await c.env.DB.prepare(`SELECT workspaces.id, workspaces.name, workspace_members.role,
    (SELECT COUNT(*) FROM workspace_members all_members WHERE all_members.workspace_id = workspaces.id) AS member_count
    FROM workspace_members JOIN workspaces ON workspaces.id = workspace_members.workspace_id
    WHERE workspace_members.user_id = ? ORDER BY workspaces.created_at`)
    .bind(c.get('user').id).all<{ id: string; name: string; role: 'owner' | 'member'; member_count: number }>();
  return c.json({ workspaces: result.results.map((row) => ({ id: row.id, name: row.name, role: row.role, memberCount: row.member_count })), currentId: c.get('workspace').id });
});

app.post('/api/workspaces', zValidator('json', z.object({ name: z.string().trim().min(1).max(60) })), async (c) => {
  const id = crypto.randomUUID(); const user = c.get('user'); const { name } = c.req.valid('json');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO workspaces (id, name, owner_id, settings) VALUES (?, ?, ?, ?)').bind(id, name, user.id, JSON.stringify(DEFAULT_SETTINGS)),
    c.env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, user.id),
    c.env.DB.prepare('UPDATE users SET current_workspace_id = ? WHERE id = ?').bind(id, user.id)
  ]);
  return c.json({ workspace: { id, name, role: 'owner', memberCount: 1 } }, 201);
});

app.post('/api/workspaces/:id/switch', async (c) => {
  const membership = await c.env.DB.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).first();
  if (!membership) return c.json({ error: 'このワークスペースには参加していません' }, 403);
  await c.env.DB.prepare('UPDATE users SET current_workspace_id = ? WHERE id = ?').bind(c.req.param('id'), c.get('user').id).run();
  return c.json({ ok: true });
});

app.get('/api/workspace/members', async (c) => {
  const result = await c.env.DB.prepare(`SELECT users.id, users.login, users.avatar_url, workspace_members.role, workspace_members.joined_at
    FROM workspace_members JOIN users ON users.id = workspace_members.user_id WHERE workspace_members.workspace_id = ? ORDER BY workspace_members.joined_at`)
    .bind(c.get('workspace').id).all<{ id: number; login: string; avatar_url: string; role: 'owner' | 'member'; joined_at: string }>();
  return c.json({ workspace: c.get('workspace'), members: result.results.map((row) => ({ id: row.id, login: row.login, avatarUrl: row.avatar_url, role: row.role, joinedAt: row.joined_at })) });
});

app.patch('/api/workspace', zValidator('json', z.object({ name: z.string().trim().min(1).max(60) })), async (c) => {
  if (c.get('workspace').role !== 'owner') return c.json({ error: 'オーナーのみ変更できます' }, 403);
  await c.env.DB.prepare('UPDATE workspaces SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(c.req.valid('json').name, c.get('workspace').id).run();
  return c.json({ ok: true });
});

app.post('/api/workspace/invites', async (c) => {
  if (c.get('workspace').role !== 'owner') return c.json({ error: 'オーナーのみ招待できます' }, 403);
  const code = randomToken(18); const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  await c.env.DB.prepare('INSERT INTO workspace_invites (token_hash, workspace_id, created_by, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(code), c.get('workspace').id, c.get('user').id, expiresAt).run();
  return c.json({ code, expiresAt }, 201);
});

app.post('/api/workspaces/join', zValidator('json', z.object({ code: z.string().min(10).max(100) })), async (c) => {
  const hash = await sha256(c.req.valid('json').code.trim());
  const invite = await c.env.DB.prepare(`DELETE FROM workspace_invites WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP
    RETURNING workspace_id`).bind(hash).first<{ workspace_id: string }>();
  if (!invite) return c.json({ error: '招待コードが無効か、期限切れです' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')").bind(invite.workspace_id, c.get('user').id),
    c.env.DB.prepare('UPDATE users SET current_workspace_id = ? WHERE id = ?').bind(invite.workspace_id, c.get('user').id)
  ]);
  return c.json({ ok: true });
});

app.delete('/api/workspace/members/:userId', async (c) => {
  if (c.get('workspace').role !== 'owner') return c.json({ error: 'オーナーのみメンバーを削除できます' }, 403);
  const userId = Number(c.req.param('userId'));
  if (!Number.isSafeInteger(userId) || userId === c.get('user').id) return c.json({ error: 'オーナー自身は削除できません' }, 422);
  await c.env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role != ?').bind(c.get('workspace').id, userId, 'owner').run();
  await c.env.DB.prepare('UPDATE users SET current_workspace_id = NULL WHERE id = ? AND current_workspace_id = ?').bind(userId, c.get('workspace').id).run();
  return c.body(null, 204);
});

app.delete('/api/workspace', async (c) => {
  if (c.get('workspace').role !== 'owner') return c.json({ error: 'オーナーのみ削除できます' }, 403);
  const workspaceId = c.get('workspace').id;
  const nextWorkspace = await c.env.DB.prepare(`SELECT workspace_id FROM workspace_members
    WHERE user_id = ? AND workspace_id != ? ORDER BY joined_at LIMIT 1`)
    .bind(c.get('user').id, workspaceId).first<{ workspace_id: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET current_workspace_id = NULL WHERE current_workspace_id = ?').bind(workspaceId),
    c.env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspaceId),
    ...(nextWorkspace ? [c.env.DB.prepare('UPDATE users SET current_workspace_id = ? WHERE id = ?').bind(nextWorkspace.workspace_id, c.get('user').id)] : [])
  ]);
  return c.json({ nextWorkspaceId: nextWorkspace?.workspace_id ?? null });
});

app.post('/api/workspace/leave', async (c) => {
  if (c.get('workspace').role === 'owner') return c.json({ error: 'オーナーはワークスペースから退出できません' }, 422);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(c.get('workspace').id, c.get('user').id),
    c.env.DB.prepare('UPDATE users SET current_workspace_id = NULL WHERE id = ?').bind(c.get('user').id)
  ]);
  return c.body(null, 204);
});

app.get('/api/issues', async (c) => {
  const settings = await loadSettings(c);
  const repos = [...new Set([...settings.repositories, ...settings.routingRules.map((rule) => rule.repository)])];
  const settled = await Promise.allSettled(repos.map((repo) => listIssues(c.get('token'), repo)));
  const issues = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  const errors = settled.flatMap((result, index) => result.status === 'rejected' ? [{ repository: repos[index], message: result.reason instanceof Error ? result.reason.message : '取得に失敗しました' }] : []);
  const cards = await loadWorkspaceCards(c, settings);
  return c.json({ issues: [...issues, ...cards], errors });
});

app.get('/api/issues/:owner/:repo/:number/comments', async (c) => {
  const repository = `${c.req.param('owner')}/${c.req.param('repo')}`;
  const number = Number(c.req.param('number'));
  if (!Number.isSafeInteger(number) || number <= 0) return c.json({ error: 'Issue 番号が不正です' }, 422);
  const comments = await listComments(c.get('token'), repository, number);
  return c.json({ comments });
});

app.post('/api/issues/:owner/:repo/:number/comments', zValidator('json', z.object({ body: z.string().trim().min(1).max(65536) })), async (c) => {
  const repository = `${c.req.param('owner')}/${c.req.param('repo')}`;
  const number = Number(c.req.param('number'));
  if (!Number.isSafeInteger(number) || number <= 0) return c.json({ error: 'Issue 番号が不正です' }, 422);
  const comment = await createComment(c.get('token'), repository, number, c.req.valid('json').body);
  return c.json({ comment }, 201);
});

app.patch('/api/issues/:owner/:repo/:number/comments/:commentId', zValidator('json', z.object({ body: z.string().trim().min(1).max(65536) })), async (c) => {
  const repository = `${c.req.param('owner')}/${c.req.param('repo')}`;
  const number = Number(c.req.param('number'));
  const commentId = Number(c.req.param('commentId'));
  if (!Number.isSafeInteger(number) || number <= 0 || !Number.isSafeInteger(commentId) || commentId <= 0) {
    return c.json({ error: 'コメントの指定が不正です' }, 422);
  }
  const comment = await updateComment(c.get('token'), repository, number, commentId, c.req.valid('json').body);
  return c.json({ comment });
});

app.post('/api/issues', zValidator('json', z.object({ title: z.string().min(1).max(256), body: z.string().max(65536).default(''), issuebanLabel: z.string().max(50).default(''), columnId: z.string().min(1), localOnly: z.boolean().default(false) })), async (c) => {
  const input = c.req.valid('json'); const settings = await loadSettings(c);
  const column = settings.columns.find((item) => item.id === input.columnId);
  if (!column) return c.json({ error: 'カラムが見つかりません' }, 422);

  if (input.localOnly) {
    const result = await c.env.DB.prepare(`INSERT INTO workspace_cards (workspace_id, column_id, title, body, issueban_label, created_by)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id, column_id, title, body, issueban_label, created_at, updated_at`)
      .bind(c.get('workspace').id, column.id, input.title, input.body, input.issuebanLabel.trim(), c.get('user').id)
      .first<WorkspaceCardRow>();
    if (!result) return c.json({ error: 'カードを作成できませんでした' }, 500);
    return c.json({ issue: localIssueFromCard(result, settings), repository: 'issueban' }, 201);
  }

  const repository = resolveRepository(input.issuebanLabel, settings);
  if (!repository) return c.json({ error: '作成先リポジトリを設定してください' }, 422);
  await ensureLabel(c.get('token'), repository, column.label, column.color);
  const labels = [column.label];
  if (input.issuebanLabel) labels.push(input.issuebanLabel);
  const issue = await github<any>(c.get('token'), `/repos/${repository}/issues`, { method: 'POST', body: JSON.stringify({ title: input.title, body: input.body, labels }) });
  return c.json({ issue, repository }, 201);
});

app.patch('/api/cards/:id/move', zValidator('json', z.object({ columnId: z.string().min(1) })), async (c) => {
  const cardId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(cardId) || cardId >= 0) return c.json({ error: 'カードの指定が不正です' }, 422);
  const workspaceCardId = -cardId;
  const settings = await loadSettings(c);
  const card = await c.env.DB.prepare(`SELECT id, column_id, title, body, issueban_label, created_at, updated_at
    FROM workspace_cards WHERE id = ? AND workspace_id = ?`).bind(workspaceCardId, c.get('workspace').id).first<WorkspaceCardRow>();
  if (!card) return c.json({ error: 'カードが見つかりません' }, 404);
  const target = settings.columns.find((item) => item.id === c.req.valid('json').columnId);
  if (!target) return c.json({ error: 'カラムが見つかりません' }, 422);

  if (!target.localOnly) {
    const repository = resolveRepository(card.issueban_label, settings);
    if (!repository) return c.json({ error: '作成先リポジトリを設定してください' }, 422);
    await ensureLabel(c.get('token'), repository, target.label, target.color);
    const labels = [target.label];
    if (card.issueban_label) labels.push(card.issueban_label);
    const issue = await github<GitHubIssue>(c.get('token'), `/repos/${repository}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: card.title, body: card.body, labels })
    });
    await c.env.DB.prepare('DELETE FROM workspace_cards WHERE id = ? AND workspace_id = ?')
      .bind(card.id, c.get('workspace').id).run();
    return c.json({ issue: toIssue(issue, repository), repository });
  }

  const updated = await c.env.DB.prepare(`UPDATE workspace_cards SET column_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? RETURNING id, column_id, title, body, issueban_label, created_at, updated_at`)
    .bind(target.id, card.id).first<WorkspaceCardRow>();
  if (!updated) return c.json({ error: 'カードが見つかりません' }, 404);
  return c.json({ issue: localIssueFromCard(updated, settings) });
});

app.delete('/api/cards/:id', async (c) => {
  const cardId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(cardId) || cardId >= 0) return c.json({ error: 'カードの指定が不正です' }, 422);
  const workspaceCardId = -cardId;
  const result = await c.env.DB.prepare('DELETE FROM workspace_cards WHERE id = ? AND workspace_id = ?')
    .bind(workspaceCardId, c.get('workspace').id).run();
  if (result.meta.changes === 0) return c.json({ error: 'カードが見つかりません' }, 404);
  return c.body(null, 204);
});

app.patch('/api/cards/:id', zValidator('json', z.object({ body: z.string().max(65536) })), async (c) => {
  const cardId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(cardId) || cardId >= 0) return c.json({ error: 'カードの指定が不正です' }, 422);
  const workspaceCardId = -cardId;
  const settings = await loadSettings(c);
  const updated = await c.env.DB.prepare(`UPDATE workspace_cards SET body = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND workspace_id = ? RETURNING id, column_id, title, body, issueban_label, created_at, updated_at`)
    .bind(c.req.valid('json').body, workspaceCardId, c.get('workspace').id).first<WorkspaceCardRow>();
  if (!updated) return c.json({ error: 'カードが見つかりません' }, 404);
  return c.json({ issue: localIssueFromCard(updated, settings) });
});

app.get('/api/cards/:id/plan', async (c) => {
  const card = await workspaceCard(c, c.req.param('id'));
  if (!card) return c.json({ error: 'カードが見つかりません' }, 404);
  return c.json({ plan: await loadLocalPlan(c, card) });
});

app.put('/api/cards/:id/plan', zValidator('json', z.object({ body: z.string().max(65536) })), async (c) => {
  const card = await workspaceCard(c, c.req.param('id'));
  if (!card) return c.json({ error: 'カードが見つかりません' }, 404);
  const body = c.req.valid('json').body;
  const error = planValidationError(parsePlanMarkdown(body));
  if (error) return c.json({ error }, 422);
  await c.env.DB.prepare(`INSERT INTO workspace_card_plans (card_id, body, created_by) VALUES (?, ?, ?)
    ON CONFLICT(card_id) DO UPDATE SET body = excluded.body, updated_at = CURRENT_TIMESTAMP`)
    .bind(card.id, body, c.get('user').id).run();
  return c.json({ plan: await loadLocalPlan(c, card) });
});

app.post('/api/cards/:id/plan/apply', zValidator('json', z.object({ items: z.array(z.object({
  position: z.number().int().positive(), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), columnId: z.string().min(1)
})).max(25) })), async (c) => {
  const card = await workspaceCard(c, c.req.param('id'));
  if (!card) return c.json({ error: 'カードが見つかりません' }, 404);
  const plan = await loadLocalPlan(c, card);
  if (!plan) return c.json({ error: 'Plan が登録されていません' }, 422);
  const parsed = parsePlanMarkdown(plan.body);
  const requested = new Map(c.req.valid('json').items.map((item) => [item.position, item]));
  if (requested.size === 0) return c.json({ error: 'Issue 化する作業単位を選択してください' }, 422);
  const settings = await loadSettings(c);
  const digests = await planItemDigests(-card.id, parsed.items);
  const existing = await c.env.DB.prepare('SELECT item_digest FROM workspace_card_plan_item_links WHERE card_id = ?').bind(card.id).all<{ item_digest: string }>();
  const linked = new Set(existing.results.map((row) => row.item_digest));
  const applied: PlanApplyResult['applied'] = []; const failed: PlanApplyResult['failed'] = [];
  for (const item of parsed.items) {
    const input = requested.get(item.position); const digest = digests.get(item.position) ?? '';
    if (!input || item.completed || linked.has(digest)) continue;
    const column = settings.columns.find((candidate) => candidate.id === input.columnId);
    if (!settings.repositories.includes(input.repository)) { failed.push({ position: item.position, title: item.title, message: '作成先リポジトリが設定されていません' }); continue; }
    if (!column) { failed.push({ position: item.position, title: item.title, message: 'カラムが見つかりません' }); continue; }
    try {
      await ensureLabel(c.get('token'), input.repository, column.label, column.color);
      const issue = await github<GitHubIssue>(c.get('token'), `/repos/${input.repository}/issues`, { method: 'POST', body: JSON.stringify({
        title: item.title, labels: [column.label], body: `${PLAN_SOURCE_MARKER}\nsource_type: local_card\nsource_card_id: ${card.id}\nitem_digest: ${digest}\n-->\n\n${item.body}\n\n---\nPlan: ${parsed.title || card.title}\nSource: issueban local card #${card.id}\n`
      }) });
      await c.env.DB.prepare(`INSERT INTO workspace_card_plan_item_links
        (card_id, item_digest, position, title, target_issue_id, target_repository, target_issue_number, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(card.id, digest, item.position, item.title, issue.id, input.repository, issue.number, c.get('user').id).run();
      linked.add(digest);
      applied.push({ position: item.position, title: item.title, targetIssue: { id: issue.id, number: issue.number, repository: input.repository, htmlUrl: issue.html_url } });
    } catch (cause) { failed.push({ position: item.position, title: item.title, message: cause instanceof Error ? cause.message : 'Issue を作成できませんでした' }); }
  }
  return c.json({ applied, failed });
});

app.patch('/api/issues/:owner/:repo/:number/move', zValidator('json', z.object({ columnId: z.string().min(1) })), async (c) => {
  const repository = `${c.req.param('owner')}/${c.req.param('repo')}`; const number = c.req.param('number');
  const settings = await loadSettings(c); const column = settings.columns.find((item) => item.id === c.req.valid('json').columnId);
  if (!column) return c.json({ error: 'カラムが見つかりません' }, 422);
  const current = await github<{ labels: ({ name?: string } | string)[] }>(c.get('token'), `/repos/${repository}/issues/${number}`);
  const statusLabels = new Set(settings.columns.map((item) => item.label.toLowerCase()));
  const labels = current.labels.map((label) => typeof label === 'string' ? label : label.name ?? '').filter((label) => !statusLabels.has(label.toLowerCase()));
  labels.push(column.label);
  await ensureLabel(c.get('token'), repository, column.label, column.color);
  await github(c.get('token'), `/repos/${repository}/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ labels }) });
  return c.json({ ok: true });
});

app.get('/api/issues/:owner/:repo/:number/plan', async (c) => {
  const repository = `${c.req.param('owner')}/${c.req.param('repo')}`;
  const number = Number(c.req.param('number'));
  if (!Number.isSafeInteger(number) || number <= 0) return c.json({ error: 'Issue 番号が不正です' }, 422);
  const plan = await loadPlan(c, repository, number);
  return c.json({ plan });
});

app.put('/api/issues/:owner/:repo/:number/plan', zValidator('json', z.object({ body: z.string().max(65536) })), async (c) => {
  const repository = `${c.req.param('owner')}/${c.req.param('repo')}`;
  const number = Number(c.req.param('number'));
  if (!Number.isSafeInteger(number) || number <= 0) return c.json({ error: 'Issue 番号が不正です' }, 422);
  const parsed = parsePlanMarkdown(c.req.valid('json').body);
  const validationError = planValidationError(parsed);
  if (validationError) return c.json({ error: validationError }, 422);

  const token = c.get('token');
  const source = await getIssue(token, repository, number);
  const comments = await listAllComments(token, repository, number);
  const existing = activePlanComment(comments);
  const body = planCommentBody(c.req.valid('json').body);
  if (existing) await updateComment(token, repository, number, existing.id, body);
  else await createComment(token, repository, number, body);
  return c.json({ plan: await loadPlan(c, repository, number) });
});

app.post('/api/issues/:owner/:repo/:number/plan/preview', zValidator('json', z.object({ body: z.string().max(65536) })), async (c) => {
  const parsed = parsePlanMarkdown(c.req.valid('json').body);
  const settings = await loadSettings(c);
  const digests = await planItemDigests(0, parsed.items);
  const items = parsed.items.map((item) => ({
    ...item,
    digest: digests.get(item.position),
    repository: settings.repositories[0] ?? '',
    columnId: settings.columns[0]?.id ?? '',
    labels: settings.columns[0] ? [settings.columns[0].label] : []
  }));
  return c.json({ title: parsed.title, items });
});

app.post('/api/issues/:owner/:repo/:number/plan/apply', zValidator('json', z.object({
  items: z.array(z.object({
    position: z.number().int().positive(),
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    columnId: z.string().min(1)
  })).max(25)
}), ), async (c) => {
  const repository = `${c.req.param('owner')}/${c.req.param('repo')}`;
  const number = Number(c.req.param('number'));
  if (!Number.isSafeInteger(number) || number <= 0) return c.json({ error: 'Issue 番号が不正です' }, 422);
  const token = c.get('token');
  const settings = await loadSettings(c);
  const source = await getIssue(token, repository, number);
  const comments = await listAllComments(token, repository, number);
  const planComment = activePlanComment(comments);
  if (!planComment) return c.json({ error: 'Plan が登録されていません' }, 422);
  const parsed = parsePlanMarkdown(removePlanCommentMarker(planComment.body));
  const requested = new Map(c.req.valid('json').items.map((item) => [item.position, item]));
  if (requested.size === 0) return c.json({ error: 'Issue 化する Plan item を選択してください' }, 422);

  const digests = await planItemDigests(source.id, parsed.items);
  const links = await c.env.DB.prepare('SELECT item_digest FROM plan_item_links WHERE source_issue_id = ?')
    .bind(source.id).all<{ item_digest: string }>();
  const linked = new Set(links.results.map((row) => row.item_digest));
  const applied: { position: number; title: string; targetIssue: { id: number; number: number; repository: string; htmlUrl: string } }[] = [];
  const failed: { position: number; title: string; message: string }[] = [];

  for (const item of parsed.items) {
    const input = requested.get(item.position);
    if (!input || item.completed || linked.has(digests.get(item.position) ?? '')) continue;
    const column = settings.columns.find((candidate) => candidate.id === input.columnId);
    if (!settings.repositories.includes(input.repository)) {
      failed.push({ position: item.position, title: item.title, message: '作成先リポジトリが設定されていません' });
      continue;
    }
    if (!column) {
      failed.push({ position: item.position, title: item.title, message: 'カラムが見つかりません' });
      continue;
    }
    try {
      await ensureLabel(token, input.repository, column.label, column.color);
      const issue = await github<GitHubIssue>(token, `/repos/${input.repository}/issues`, {
        method: 'POST',
        body: JSON.stringify({
          title: item.title,
          body: `${PLAN_SOURCE_MARKER}\nsource_issue_id: ${source.id}\nsource_repository: ${repository}\nsource_issue_number: ${number}\nitem_digest: ${digests.get(item.position)}\n-->\n\n${item.body}\n\n---\nPlan: ${parsed.title || source.title}\nSource: ${source.html_url}\n`,
          labels: [column.label]
        })
      });
      await c.env.DB.prepare(`INSERT INTO plan_item_links
        (source_issue_id, item_digest, position, title, target_issue_id, target_repository, target_issue_number, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(source.id, digests.get(item.position), item.position, item.title, issue.id, input.repository, issue.number, c.get('user').id).run();
      linked.add(digests.get(item.position) ?? '');
      applied.push({
        position: item.position,
        title: item.title,
        targetIssue: {
          id: issue.id,
          number: issue.number,
          repository: input.repository,
          htmlUrl: issue.html_url
        }
      });
    } catch (error) {
      failed.push({
        position: item.position,
        title: item.title,
        message: error instanceof Error ? error.message : 'Issue を作成できませんでした'
      });
    }
  }
  return c.json({ applied, failed });
});

app.on(['OPTIONS', 'GET', 'DELETE', 'POST'], '/mcp', async (c) => {
  if (c.req.method !== 'POST') return handleMcpRequest(c.req.raw, '', null);

  const authorization = c.req.header('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization Bearer token required' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) return c.json({ error: 'GitHub token required' }, 401, { 'WWW-Authenticate': 'Bearer' });

  try {
    const viewer = await getViewer(token);
    const settings = await c.env.DB.prepare(`SELECT workspaces.settings
      FROM users JOIN workspaces ON workspaces.id = users.current_workspace_id WHERE users.id = ?`)
      .bind(viewer.id).first<{ settings: string }>();
    const workspaceSettings = settings?.settings ? { ...DEFAULT_SETTINGS, ...JSON.parse(settings.settings) } as Settings : null;
    return handleMcpRequest(c.req.raw, token, workspaceSettings);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) {
      return c.json({ error: 'Invalid GitHub token' }, 401, { 'WWW-Authenticate': 'Bearer' });
    }
    return c.json({ error: 'GitHub token verification failed' }, 502);
  }
});

app.onError((error, c) => {
  console.error(error);
  if (error instanceof GitHubError) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    return c.json({ error: error.message }, status as 502);
  }
  return c.json({ error: '予期しないエラーが発生しました' }, 500);
});

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
export default app;
