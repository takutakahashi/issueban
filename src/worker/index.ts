import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { DEFAULT_SETTINGS, resolveRepository, type Settings } from '../shared/types';
import { decrypt, encrypt, randomToken, sha256 } from './crypto';
import { ensureLabel, getViewer, github, GitHubError, listIssues } from './github';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_SECRET: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};
type Variables = { user: { id: number; login: string; avatarUrl: string; authType: string }; token: string };
type AppEnv = { Bindings: Bindings; Variables: Variables };

const app = new Hono<AppEnv>();
const SESSION_COOKIE = 'issueban_session';
const sessionAge = 60 * 60 * 24 * 30;

function jsonError(message: string, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json' } });
}

function settingsSchema() {
  return z.object({
    repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(25),
    columns: z.array(z.object({ id: z.string().min(1), name: z.string().min(1).max(40), label: z.string().min(1).max(50), color: z.string().regex(/^#?[0-9a-fA-F]{6}$/) })).min(1).max(10),
    routingRules: z.array(z.object({ id: z.string(), label: z.string().min(1).max(50), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/) })).max(50)
  });
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

app.get('/api/me', (c) => c.json({ user: c.get('user') }));

app.get('/api/settings', async (c) => {
  const row = await c.env.DB.prepare('SELECT settings FROM users WHERE id = ?').bind(c.get('user').id).first<{ settings: string }>();
  return c.json({ settings: { ...DEFAULT_SETTINGS, ...(row?.settings ? JSON.parse(row.settings) : {}) } });
});

app.put('/api/settings', zValidator('json', settingsSchema()), async (c) => {
  const settings = c.req.valid('json');
  await c.env.DB.prepare('UPDATE users SET settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(JSON.stringify(settings), c.get('user').id).run();
  return c.json({ settings });
});

async function loadSettings(c: Context<AppEnv>): Promise<Settings> {
  const row = await c.env.DB.prepare('SELECT settings FROM users WHERE id = ?').bind(c.get('user').id).first<{ settings: string }>();
  return { ...DEFAULT_SETTINGS, ...(row?.settings ? JSON.parse(row.settings) : {}) };
}

app.get('/api/issues', async (c) => {
  const settings = await loadSettings(c);
  const repos = [...new Set([...settings.repositories, ...settings.routingRules.map((rule) => rule.repository)])];
  const settled = await Promise.allSettled(repos.map((repo) => listIssues(c.get('token'), repo)));
  const issues = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  const errors = settled.flatMap((result, index) => result.status === 'rejected' ? [{ repository: repos[index], message: result.reason instanceof Error ? result.reason.message : '取得に失敗しました' }] : []);
  return c.json({ issues, errors });
});

app.post('/api/issues', zValidator('json', z.object({ title: z.string().min(1).max(256), body: z.string().max(65536).default(''), issuebanLabel: z.string().max(50).default(''), columnId: z.string().min(1) })), async (c) => {
  const input = c.req.valid('json'); const settings = await loadSettings(c);
  const repository = resolveRepository(input.issuebanLabel, settings);
  const column = settings.columns.find((item) => item.id === input.columnId);
  if (!repository) return c.json({ error: '作成先リポジトリを設定してください' }, 422);
  if (!column) return c.json({ error: 'カラムが見つかりません' }, 422);
  await ensureLabel(c.get('token'), repository, column.label, column.color);
  const labels = [column.label];
  if (input.issuebanLabel) labels.push(input.issuebanLabel);
  const issue = await github<any>(c.get('token'), `/repos/${repository}/issues`, { method: 'POST', body: JSON.stringify({ title: input.title, body: input.body, labels }) });
  return c.json({ issue, repository }, 201);
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

app.onError((error, c) => {
  console.error(error);
  if (error instanceof GitHubError) return c.json({ error: error.message }, error.status === 403 ? 403 : 502);
  return c.json({ error: '予期しないエラーが発生しました' }, 500);
});

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
export default app;
