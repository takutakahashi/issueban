import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowUpRight, Check, Copy, Github, LoaderCircle, LogOut, MessageSquare, Plus, RefreshCw, Settings as SettingsIcon, Trash2, Users, X } from 'lucide-react';
import { api } from './api';
import { commentExcerpt, DEFAULT_SETTINGS, issueColumn, type Comment, type Issue, type Settings, type Workspace, type WorkspaceMember } from '../shared/types';

type User = { login: string; avatarUrl: string; authType: string; workspace: { id: string; name: string; role: 'owner' | 'member' } };

function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function loginPat(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.patLogin(token); onLogin(); } catch (err) { setError(err instanceof Error ? err.message : 'ログインに失敗しました'); } finally { setBusy(false); }
  }
  return <main className="login-shell">
    <section className="login-copy">
      <div className="brand"><span className="brand-mark">ib</span><span>issueban</span></div>
      <p className="eyebrow">ISSUES, IN MOTION</p>
      <h1>GitHub Issues を、<br /><em>流れ</em>に変える。</h1>
      <p className="lead">リポジトリをまたぐ Issue をひとつのボードへ。カードを動かすだけで、GitHub のラベルまで同期します。</p>
      <div className="features"><span>Multi-repository</span><span>Label sync</span><span>Edge-native</span></div>
    </section>
    <section className="login-panel">
      <div className="login-card">
        <div className="card-icon"><Github size={26} /></div>
        <h2>ワークスペースに接続</h2>
        <p>GitHub アカウントで安全に始められます。</p>
        <a className="button primary oauth" href="/api/auth/oauth/start"><Github size={18} /> GitHub OAuth で続ける</a>
        <div className="divider"><span>または PAT を使用</span></div>
        <form onSubmit={loginPat}>
          <label>Personal access token</label>
          <input type="password" autoComplete="off" placeholder="github_pat_••••••••" value={token} onChange={(e) => setToken(e.target.value)} />
          {error && <p className="form-error"><AlertCircle size={14} />{error}</p>}
          <button className="button secondary" disabled={busy || token.length < 20}>{busy ? <LoaderCircle className="spin" size={17} /> : null}PAT で接続</button>
        </form>
        <p className="security-note">トークンは暗号化され、ブラウザには保存されません。</p>
      </div>
    </section>
  </main>;
}

function IssueCard({ issue, settings, currentColumn, onDragStart, onMove, onOpenComments }: { issue: Issue; settings: Settings; currentColumn: string; onDragStart: () => void; onMove: (columnId: string) => void; onOpenComments: () => void }) {
  return <article className="issue-card" draggable onDragStart={onDragStart}>
    <div className="issue-meta"><span>{issue.repository}</span><span>#{issue.number}</span></div>
    <h3>{issue.title}</h3>
    <div className="labels">{issue.labels.slice(0, 3).map((label) => <span key={label.name} style={{ '--label': `#${label.color}` } as React.CSSProperties}>{label.name}</span>)}</div>
    {issue.latestComment && <button type="button" className="comment-preview" onClick={onOpenComments} aria-label={`${issue.title}のコメントを表示`}>
      {issue.latestComment.avatarUrl && <img src={issue.latestComment.avatarUrl} alt="" />}
      <span className="comment-preview-text"><strong>{issue.latestComment.author}</strong><span>{commentExcerpt(issue.latestComment.body) || '（本文なし）'}</span></span>
    </button>}
    <footer>
      <div className="avatars">{issue.assignees.slice(0, 3).map((user) => <img key={user.login} src={user.avatarUrl} alt={user.login} title={user.login} />)}</div>
      <div className="card-actions">
        {issue.commentCount > 0 && <button type="button" className="comment-chip" onClick={onOpenComments} aria-label={`${issue.title}のコメント${issue.commentCount}件を表示`}><MessageSquare size={14} />{issue.commentCount}</button>}
        <a href={issue.htmlUrl} target="_blank" rel="noreferrer" aria-label="GitHub で開く"><ArrowUpRight size={16} /></a>
      </div>
    </footer>
    <label className="mobile-status">移動先<select aria-label={`${issue.title}の移動先`} value={currentColumn} onChange={(event) => onMove(event.target.value)}>{settings.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
  </article>;
}

function CommentThread({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const [comments, setComments] = useState<Comment[] | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.comments(issue).then((data) => { if (active) setComments(data.comments); }).catch((err) => { if (active) { setError(err instanceof Error ? err.message : 'コメントの取得に失敗しました'); setComments([]); } });
    return () => { active = false; };
  }, [issue]);
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal comment-modal" onMouseDown={(e) => e.stopPropagation()}>
    <button className="icon-button close" onClick={onClose} aria-label="閉じる"><X size={20} /></button>
    <p className="eyebrow">COMMENTS</p><h2>{issue.title}</h2>
    <p className="comment-issue-meta">{issue.repository} #{issue.number} · <a href={issue.htmlUrl} target="_blank" rel="noreferrer">GitHub で開く</a></p>
    {issue.body && <article className="comment-item issue-body"><header><strong>説明</strong></header><p>{issue.body}</p></article>}
    {error && <p className="form-error"><AlertCircle size={14} />{error}</p>}
    {comments === null ? <p className="comment-loading"><LoaderCircle className="spin" size={16} />コメントを読み込み中…</p> : comments.length === 0 ? <p className="comment-empty">まだコメントはありません。</p> :
      <div className="comment-list">{comments.map((comment) => <article className="comment-item" key={comment.id}>
        <header>
          {comment.avatarUrl && <img src={comment.avatarUrl} alt="" />}
          <strong>{comment.author}</strong>
          <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString('ja-JP')}</time>
          <a href={comment.htmlUrl} target="_blank" rel="noreferrer" aria-label="GitHub でこのコメントを開く"><ArrowUpRight size={14} /></a>
        </header>
        <p>{comment.body || '（本文なし）'}</p>
      </article>)}</div>}
  </section></div>;
}

function CreateIssue({ settings, initialColumn, onClose, onCreated }: { settings: Settings; initialColumn: string; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ title: '', body: '', issuebanLabel: '', columnId: initialColumn }); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const destination = settings.routingRules.find((rule) => rule.label.toLowerCase() === form.issuebanLabel.toLowerCase())?.repository ?? settings.repositories[0];
  async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(''); try { await api.createIssue(form); onCreated(); } catch (err) { setError(err instanceof Error ? err.message : '作成に失敗しました'); setBusy(false); } }
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal" onMouseDown={(e) => e.stopPropagation()}>
    <button className="icon-button close" onClick={onClose}><X size={20} /></button><p className="eyebrow">NEW ISSUE</p><h2>Issue を追加</h2>
    <form onSubmit={submit} className="stack">
      <label>タイトル<input autoFocus required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="何をする必要がありますか？" /></label>
      <label>説明<textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="背景や完了条件を入力…" /></label>
      <div className="form-grid"><label>Issueban ラベル<input value={form.issuebanLabel} onChange={(e) => setForm({ ...form, issuebanLabel: e.target.value })} placeholder="例: frontend" /></label>
      <label>ステータス<select value={form.columnId} onChange={(e) => setForm({ ...form, columnId: e.target.value })}>{settings.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label></div>
      <div className="destination">作成先 <strong>{destination ?? '未設定'}</strong></div>{error && <p className="form-error">{error}</p>}
      <button className="button primary" disabled={busy || !destination}>{busy && <LoaderCircle className="spin" size={17} />}Issue を作成</button>
    </form>
  </section></div>;
}

function SettingsModal({ value, onClose, onSave }: { value: Settings; onClose: () => void; onSave: (settings: Settings) => Promise<void> }) {
  const [draft, setDraft] = useState<Settings>(structuredClone(value)); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const repos = draft.repositories.join('\n');
  function addRule() { setDraft({ ...draft, routingRules: [...draft.routingRules, { id: crypto.randomUUID(), label: '', repository: draft.repositories[0] ?? '' }] }); }
  async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(''); try { await onSave(draft); onClose(); } catch (err) { setError(err instanceof Error ? err.message : '保存に失敗しました'); setBusy(false); } }
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
    <button className="icon-button close" onClick={onClose}><X size={20} /></button><p className="eyebrow">BOARD SETTINGS</p><h2>ボード設定</h2>
    <form onSubmit={submit} className="stack">
      <label>対象リポジトリ <small>1 行に owner/repo を 1 つ</small><textarea value={repos} onChange={(e) => setDraft({ ...draft, repositories: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })} placeholder={'acme/web\nacme/api'} /></label>
      <div className="setting-heading"><div><strong>カラムと同期ラベル</strong><small>移動時、このラベルに自動更新されます</small></div></div>
      <div className="editable-list">{draft.columns.map((column, index) => <div className="column-edit" key={column.id}>
        <input aria-label="色" className="color-input" type="color" value={`#${column.color.replace('#', '')}`} onChange={(e) => { const columns = [...draft.columns]; columns[index] = { ...column, color: e.target.value.slice(1) }; setDraft({ ...draft, columns }); }} />
        <input required value={column.name} onChange={(e) => { const columns = [...draft.columns]; columns[index] = { ...column, name: e.target.value }; setDraft({ ...draft, columns }); }} />
        <input required value={column.label} onChange={(e) => { const columns = [...draft.columns]; columns[index] = { ...column, label: e.target.value }; setDraft({ ...draft, columns }); }} />
      </div>)}</div>
      <div className="setting-heading"><div><strong>ラベルルーティング</strong><small>Issueban ラベルごとに作成先を切り替えます</small></div><button type="button" className="text-button" onClick={addRule}>＋ ルール追加</button></div>
      <div className="editable-list">{draft.routingRules.map((rule, index) => <div className="rule-edit" key={rule.id}>
        <input required placeholder="frontend" value={rule.label} onChange={(e) => { const routingRules = [...draft.routingRules]; routingRules[index] = { ...rule, label: e.target.value }; setDraft({ ...draft, routingRules }); }} />
        <span>→</span><select value={rule.repository} onChange={(e) => { const routingRules = [...draft.routingRules]; routingRules[index] = { ...rule, repository: e.target.value }; setDraft({ ...draft, routingRules }); }}>{draft.repositories.map((repo) => <option key={repo}>{repo}</option>)}</select>
        <button type="button" className="icon-button" onClick={() => setDraft({ ...draft, routingRules: draft.routingRules.filter((_, i) => i !== index) })}><X size={16} /></button>
      </div>)}</div>
      {error && <p className="form-error">{error}</p>}<button className="button primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={17} />}設定を保存</button>
    </form>
  </section></div>;
}

function TeamModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]); const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [newName, setNewName] = useState(''); const [joinCode, setJoinCode] = useState(''); const [invite, setInvite] = useState('');
  const [copied, setCopied] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const refresh = useCallback(async () => { try { const [spaces, team] = await Promise.all([api.workspaces(), api.members()]); setWorkspaces(spaces.workspaces); setMembers(team.members); } catch (err) { setError(err instanceof Error ? err.message : '読み込みに失敗しました'); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function action(fn: () => Promise<unknown>, reload = false) { setBusy(true); setError(''); try { await fn(); if (reload) window.location.reload(); else await refresh(); } catch (err) { setError(err instanceof Error ? err.message : '操作に失敗しました'); } finally { setBusy(false); } }
  async function copyInvite() { await navigator.clipboard.writeText(invite); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal team-modal" onMouseDown={(e) => e.stopPropagation()}>
    <button className="icon-button close" onClick={onClose}><X size={20} /></button><p className="eyebrow">TEAM WORKSPACE</p><h2>チーム</h2>
    <div className="workspace-current"><div><small>現在のワークスペース</small><strong>{user.workspace.name}</strong></div><span className="role-badge">{user.workspace.role === 'owner' ? 'Owner' : 'Member'}</span></div>
    <div className="team-section"><h3>ワークスペース</h3><div className="workspace-list">{workspaces.map((workspace) => <button key={workspace.id} className={`workspace-row ${workspace.id === user.workspace.id ? 'active' : ''}`} disabled={busy || workspace.id === user.workspace.id} onClick={() => void action(() => api.switchWorkspace(workspace.id), true)}><span>{workspace.name}<small>{workspace.memberCount} members</small></span>{workspace.id === user.workspace.id && <Check size={17} />}</button>)}</div>
      <div className="inline-form"><input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新しいチーム名" /><button className="button secondary" disabled={busy || !newName.trim()} onClick={() => void action(async () => { await api.createWorkspace(newName); window.location.reload(); })}>作成</button></div>
      <div className="inline-form"><input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="招待コードを貼り付け" /><button className="button secondary" disabled={busy || joinCode.length < 10} onClick={() => void action(() => api.joinWorkspace(joinCode), true)}>参加</button></div>
    </div>
    <div className="team-section"><div className="setting-heading"><div><h3>メンバー</h3><small>同じボード設定と Issue を共有します</small></div>{user.workspace.role === 'owner' && <button className="text-button" disabled={busy} onClick={() => void action(async () => { const result = await api.createInvite(); setInvite(result.code); })}>＋ 招待を作成</button>}</div>
      {invite && <div className="invite-code"><code>{invite}</code><button className="icon-button" onClick={() => void copyInvite()}>{copied ? <Check size={17} /> : <Copy size={17} />}</button><small>1 回のみ使用可能・7 日間有効</small></div>}
      <div className="member-list">{members.map((member) => <div className="member-row" key={member.id}><img src={member.avatarUrl} alt="" /><div><strong>{member.login}</strong><small>{member.role === 'owner' ? 'Owner' : 'Member'}</small></div>{user.workspace.role === 'owner' && member.role !== 'owner' && <button className="icon-button danger" title="メンバーを削除" onClick={() => void action(() => api.removeMember(member.id))}><Trash2 size={16} /></button>}</div>)}</div>
    </div>
    {user.workspace.role === 'member' && <button className="leave-button" disabled={busy} onClick={() => void action(() => api.leaveWorkspace(), true)}>このワークスペースから退出</button>}
    {user.workspace.role === 'owner' && <button className="delete-workspace-button" disabled={busy} onClick={() => { if (window.confirm(`「${user.workspace.name}」を削除しますか？\nメンバーとボード設定もすべて削除されます。この操作は取り消せません。`)) void action(async () => { const result = await api.deleteWorkspace(); if (result.nextWorkspaceId) await api.switchWorkspace(result.nextWorkspaceId); else await api.logout(); }, true); }}>ワークスペースを削除</button>}
    {error && <p className="form-error"><AlertCircle size={14} />{error}</p>}
  </section></div>;
}

function Board({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS); const [issues, setIssues] = useState<Issue[]>([]); const [errors, setErrors] = useState<string[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]); const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [loading, setLoading] = useState(true); const [dragging, setDragging] = useState<Issue | null>(null); const [createColumn, setCreateColumn] = useState<string | null>(null); const [showSettings, setShowSettings] = useState(false); const [showTeam, setShowTeam] = useState(false); const [commentIssue, setCommentIssue] = useState<Issue | null>(null);
  const load = useCallback(async () => { setLoading(true); try { const [s, data, spaces] = await Promise.all([api.settings(), api.issues(), api.workspaces()]); setSettings(s.settings); setIssues(data.issues); setWorkspaces(spaces.workspaces); setErrors(data.errors.map((e) => `${e.repository}: ${e.message}`)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const grouped = useMemo(() => Object.fromEntries(settings.columns.map((column) => [column.id, issues.filter((issue) => issueColumn(issue, settings) === column.id)])), [issues, settings]);
  async function switchWorkspace(id: string) {
    if (id === user.workspace.id || switchingWorkspace) return;
    setSwitchingWorkspace(true); setErrors([]);
    try { await api.switchWorkspace(id); window.location.reload(); }
    catch (error) { setErrors([error instanceof Error ? error.message : 'ワークスペースの切り替えに失敗しました']); setSwitchingWorkspace(false); }
  }
  async function move(issue: Issue, columnId: string) { if (issueColumn(issue, settings) === columnId) return setDragging(null); const target = settings.columns.find((column) => column.id === columnId); if (!target) return; const previous = issues; setIssues(issues.map((item) => item.id === issue.id ? { ...item, labels: [...item.labels.filter((label) => !settings.columns.some((col) => col.label.toLowerCase() === label.name.toLowerCase())), { name: target.label, color: target.color }] } : item)); try { await api.moveIssue(issue, columnId); } catch (error) { setIssues(previous); setErrors([error instanceof Error ? error.message : '移動に失敗しました']); } setDragging(null); }
  async function drop(columnId: string) { if (dragging) await move(dragging, columnId); }
  return <div className="app-shell"><header className="topbar"><div className="brand"><span className="brand-mark">ib</span><span>issueban</span></div><div className="top-actions"><label className="workspace-switcher"><span>Workspace</span><select aria-label="ワークスペースを切り替え" value={user.workspace.id} disabled={loading || switchingWorkspace} onChange={(event) => void switchWorkspace(event.target.value)}>{!workspaces.some((workspace) => workspace.id === user.workspace.id) && <option value={user.workspace.id}>{user.workspace.name}</option>}{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select>{switchingWorkspace && <LoaderCircle className="spin" size={15} />}</label><button className="icon-button refresh-button" aria-label="再読み込み" title="再読み込み" onClick={() => void load()}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button><button className="icon-button" aria-label="チーム" title="チーム" onClick={() => setShowTeam(true)}><Users size={18} /></button><button className="icon-button" aria-label="設定" title="設定" onClick={() => setShowSettings(true)}><SettingsIcon size={18} /></button><div className="user"><img src={user.avatarUrl} alt="" /><span>{user.login}</span></div><button className="icon-button logout" aria-label="ログアウト" title="ログアウト" onClick={onLogout}><LogOut size={18} /></button></div></header>
    <main className="board-wrap"><div className="board-heading"><div><p className="eyebrow">WORKSPACE BOARD</p><h1>{user.workspace.name}</h1><p className="board-summary">{issues.length} issues · {settings.repositories.length} repositories</p></div><button className="button primary compact" onClick={() => setCreateColumn(settings.columns[0]?.id ?? '')}><Plus size={18} /><span>Issue を追加</span></button></div>
    {errors.length > 0 && <div className="notice"><AlertCircle size={17} /><div>{errors.map((error) => <p key={error}>{error}</p>)}</div><button onClick={() => setErrors([])}><X size={15} /></button></div>}
    {!loading && settings.repositories.length === 0 ? <section className="empty-state"><div className="empty-icon"><SettingsIcon /></div><h2>最初のリポジトリを接続</h2><p>対象リポジトリとカラムを設定すると、Issue がここに並びます。</p><button className="button primary" onClick={() => setShowSettings(true)}>ボードを設定</button></section> :
    <div className="board">{settings.columns.map((column) => <section className={`column ${dragging ? 'drag-active' : ''}`} key={column.id} onDragOver={(e) => e.preventDefault()} onDrop={() => void drop(column.id)}><header><div><i style={{ background: `#${column.color}` }} /><h2>{column.name}</h2><span>{grouped[column.id]?.length ?? 0}</span></div><button className="icon-button mini" aria-label={`${column.name}にカードを追加`} onClick={() => setCreateColumn(column.id)}><Plus size={17} /></button></header><div className="card-list">{grouped[column.id]?.map((issue) => <IssueCard key={issue.id} issue={issue} settings={settings} currentColumn={column.id} onDragStart={() => setDragging(issue)} onMove={(columnId) => void move(issue, columnId)} onOpenComments={() => setCommentIssue(issue)} />)}{loading && [1, 2].map((n) => <div className="issue-card skeleton" key={n} />)}<button className="add-card" onClick={() => setCreateColumn(column.id)}><Plus size={15} />カードを追加</button></div></section>)}</div>}</main>
    {createColumn && <CreateIssue settings={settings} initialColumn={createColumn} onClose={() => setCreateColumn(null)} onCreated={() => { setCreateColumn(null); void load(); }} />}
    {showSettings && <SettingsModal value={settings} onClose={() => setShowSettings(false)} onSave={async (next) => { const result = await api.saveSettings(next); setSettings(result.settings); void load(); }} />}
    {showTeam && <TeamModal user={user} onClose={() => setShowTeam(false)} />}
    {commentIssue && <CommentThread issue={commentIssue} onClose={() => setCommentIssue(null)} />}
  </div>;
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const check = useCallback(() => api.me().then((data) => setUser({ ...data.user, workspace: data.workspace })).catch(() => setUser(null)), []);
  useEffect(() => { void check(); }, [check]);
  if (user === undefined) return <div className="boot"><span className="brand-mark">ib</span><LoaderCircle className="spin" /></div>;
  if (!user) return <Login onLogin={check} />;
  return <Board user={user} onLogout={async () => { await api.logout(); setUser(null); }} />;
}
