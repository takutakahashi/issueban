import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowUpRight, Check, Copy, Github, ListChecks, LoaderCircle, LogOut, MessageSquare, Pencil, Plus, RefreshCw, Settings as SettingsIcon, Trash2, Users, X } from 'lucide-react';
import { api } from './api';
import { parsePlanMarkdown, type Plan, type PlanApplyResult, type ParsedPlanItem } from '../shared/plan';
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

function IssueCard({ issue, settings, currentColumn, onDragStart, onMove, onOpenComments, onOpenPlan, onOpenDescription, onDelete }: { issue: Issue; settings: Settings; currentColumn: string; onDragStart: () => void; onMove: (columnId: string) => void; onOpenComments: () => void; onOpenPlan: () => void; onOpenDescription: () => void; onDelete: () => void }) {
  return <article className="issue-card" draggable onDragStart={onDragStart}>
    <div className="issue-meta"><span>{issue.localOnly ? 'issueban' : issue.repository}</span><span>{issue.localOnly ? 'ローカルカード' : `#${issue.number}`}</span></div>
    <h3>{issue.title}</h3>
    <div className="labels">{issue.labels.slice(0, 3).map((label) => <span key={label.name} style={{ '--label': `#${label.color}` } as React.CSSProperties}>{label.name}</span>)}</div>
    {issue.localOnly && <button type="button" className="comment-preview" onClick={onOpenDescription} aria-label={`${issue.title}の説明を編集`}>
      <span className="comment-preview-text"><strong>説明</strong><span>{commentExcerpt(issue.body ?? '') || 'まだありません'}</span></span>
    </button>}
    {issue.latestComment && <button type="button" className="comment-preview" onClick={onOpenComments} aria-label={`${issue.title}のコメントを表示`}>
      {issue.latestComment.avatarUrl && <img src={issue.latestComment.avatarUrl} alt="" />}
      <span className="comment-preview-text"><strong>{issue.latestComment.author}</strong><span>{commentExcerpt(issue.latestComment.body) || '（本文なし）'}</span></span>
    </button>}
    <footer>
      <div className="avatars">{issue.assignees.slice(0, 3).map((user) => <img key={user.login} src={user.avatarUrl} alt={user.login} title={user.login} />)}</div>
      <div className="card-actions">
        {issue.localOnly ? <>
          <button type="button" className="comment-chip plan-chip" onClick={onOpenPlan} aria-label={`${issue.title}のPlanを表示`}><ListChecks size={14} /></button>
          <button type="button" className="comment-chip" onClick={onOpenDescription} aria-label={`${issue.title}の説明を編集`}><Pencil size={14} /></button>
          <button type="button" className="comment-chip" onClick={onDelete} aria-label={`${issue.title}のカードを削除`}><Trash2 size={14} /></button>
        </> : <>
          <button type="button" className="comment-chip plan-chip" onClick={onOpenPlan} aria-label={`${issue.title}のPlanを表示`}><ListChecks size={14} /></button>
          <button type="button" className="comment-chip" onClick={onOpenComments} aria-label={`${issue.title}のコメント${issue.commentCount}件を表示`}><MessageSquare size={14} />{issue.commentCount}</button>
          <a href={issue.htmlUrl} target="_blank" rel="noreferrer" aria-label="GitHub で開く"><ArrowUpRight size={16} /></a>
        </>}
      </div>
    </footer>
    <label className="mobile-status">移動先<select aria-label={`${issue.title}の移動先`} value={currentColumn} onChange={(event) => onMove(event.target.value)}>{settings.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
  </article>;
}

function LocalCardDescription({ issue, onClose, onUpdated }: { issue: Issue; onClose: () => void; onUpdated: (issue: Issue) => void }) {
  const [body, setBody] = useState(issue.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const { issue: next } = await api.updateCard(issue, body.trim());
      onUpdated(next); onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '説明の保存に失敗しました');
    } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal description-modal" onMouseDown={(e) => e.stopPropagation()}>
    <button className="icon-button close" onClick={onClose}><X size={20} /></button>
    <p className="eyebrow">LOCAL CARD</p>
    <h2>{issue.title}</h2>
    <form onSubmit={save} className="stack">
      <label>説明<textarea value={body} autoFocus onChange={(e) => setBody(e.target.value)} placeholder="背景や完了条件を入力…" /></label>
      {error && <p className="form-error"><AlertCircle size={14} />{error}</p>}
      <button className="button primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={17} />}説明を保存</button>
    </form>
  </section></div>;
}

function CommentThread({ issue, viewerLogin, onClose, onUpdated }: { issue: Issue; viewerLogin: string; onClose: () => void; onUpdated: (issue: Issue) => void }) {
  const [comments, setComments] = useState<Comment[] | null>(null); const [error, setError] = useState('');
  const [composer, setComposer] = useState(''); const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [busy, setBusy] = useState(false); const [actionError, setActionError] = useState('');
  useEffect(() => {
    let active = true;
    api.comments(issue).then((data) => { if (active) setComments(data.comments); }).catch((err) => { if (active) { setError(err instanceof Error ? err.message : 'コメントの取得に失敗しました'); setComments([]); } });
    return () => { active = false; };
  }, [issue.id, issue.repository, issue.number]);
  function replaceIssue(comment: Comment, created: boolean) {
    const commentCount = created ? issue.commentCount + 1 : issue.commentCount;
    const latestComment = created || issue.latestComment?.id === comment.id ? comment : issue.latestComment;
    onUpdated({ ...issue, commentCount, latestComment });
  }
  async function createComment(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setActionError('');
    try {
      const { comment } = await api.createComment(issue, composer.trim());
      const nextComments = [...(comments ?? []), comment];
      setComments(nextComments); setComposer(''); replaceIssue(comment, true);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'コメントを書き込めませんでした'); } finally { setBusy(false); }
  }
  async function updateComment(e: React.FormEvent) {
    if (!editing) return;
    e.preventDefault(); setBusy(true); setActionError('');
    try {
      const { comment } = await api.updateComment(issue, editing.id, editing.body.trim());
      const nextComments = (comments ?? []).map((item) => item.id === comment.id ? comment : item);
      setComments(nextComments); setEditing(null); replaceIssue(comment, false);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'コメントを編集できませんでした'); } finally { setBusy(false); }
  }
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
          {comment.author.toLocaleLowerCase() === viewerLogin.toLocaleLowerCase() && <button type="button" className="icon-button mini" disabled={busy} aria-label="コメントを編集" onClick={() => setEditing({ id: comment.id, body: comment.body })}><Pencil size={14} /></button>}
          <a href={comment.htmlUrl} target="_blank" rel="noreferrer" aria-label="GitHub でこのコメントを開く"><ArrowUpRight size={14} /></a>
        </header>
        {editing?.id === comment.id ? <form className="comment-editor" onSubmit={updateComment}>
          <textarea required autoFocus value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          <div className="comment-editor-actions"><button type="button" className="button secondary compact" disabled={busy} onClick={() => setEditing(null)}>キャンセル</button><button className="button primary compact" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />}保存</button></div>
        </form> : <p>{comment.body || '（本文なし）'}</p>}
      </article>)}</div>}
    {comments !== null && <form className="comment-composer" onSubmit={createComment}>
      <textarea required value={composer} disabled={busy} onChange={(e) => setComposer(e.target.value)} placeholder="コメントを書き込む…" aria-label="新しいコメント" />
      {actionError && <p className="form-error"><AlertCircle size={14} />{actionError}</p>}
      <button className="button primary compact" disabled={busy || composer.trim().length === 0}>{busy && <LoaderCircle className="spin" size={15} />}コメントを書き込む</button>
    </form>}
  </section></div>;
}

function CreateIssue({ settings, initialColumn, onClose, onCreated }: { settings: Settings; initialColumn: string; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ title: '', body: '', issuebanLabel: '', columnId: initialColumn }); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const destination = settings.routingRules.find((rule) => rule.label.toLowerCase() === form.issuebanLabel.toLowerCase())?.repository ?? settings.repositories[0];
  const selectedColumn = settings.columns.find((column) => column.id === form.columnId);
  const localOnly = selectedColumn?.localOnly ?? false;
  async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(''); try { await api.createIssue({ ...form, localOnly }); onCreated(); } catch (err) { setError(err instanceof Error ? err.message : '作成に失敗しました'); setBusy(false); } }
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal" onMouseDown={(e) => e.stopPropagation()}>
    <button className="icon-button close" onClick={onClose}><X size={20} /></button><p className="eyebrow">NEW ISSUE</p><h2>Issue を追加</h2>
    <form onSubmit={submit} className="stack">
      <label>タイトル<input autoFocus required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="何をする必要がありますか？" /></label>
      <label>説明<textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="背景や完了条件を入力…" /></label>
      <div className="form-grid"><label>Issueban ラベル<input value={form.issuebanLabel} onChange={(e) => setForm({ ...form, issuebanLabel: e.target.value })} placeholder="例: frontend" /></label>
      <label>ステータス<select value={form.columnId} onChange={(e) => setForm({ ...form, columnId: e.target.value })}>{settings.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label></div>
      <div className="destination">作成先 <strong>{localOnly ? 'issueban' : destination ?? '未設定'}</strong></div>{error && <p className="form-error">{error}</p>}
      <button className="button primary" disabled={busy || (!localOnly && !destination)}>{busy && <LoaderCircle className="spin" size={17} />}{localOnly ? 'カードを作成' : 'Issue を作成'}</button>
    </form>
  </section></div>;
}

function PlanModal({ issue, settings, onClose, onRefresh }: { issue: Issue; settings: Settings; onClose: () => void; onRefresh: () => void }) {
  const [plan, setPlan] = useState<Plan | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [selections, setSelections] = useState<Record<number, { repository: string; columnId: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PlanApplyResult | null>(null);
  const parsed = useMemo(() => parsePlanMarkdown(draft), [draft]);
  const applied = useMemo(() => new Map((plan?.items ?? []).map((item) => [item.position, item])), [plan]);

  useEffect(() => {
    let active = true;
    api.plan(issue).then(({ plan }) => {
      if (!active) return;
      setPlan(plan);
      setDraft(plan?.body ?? '');
      setSelections(Object.fromEntries((plan?.items ?? []).map((item) => [item.position, { repository: item.repository, columnId: item.columnId }])));
    }).catch((err) => {
      if (active) { setError(err instanceof Error ? err.message : 'Plan の取得に失敗しました'); setPlan(null); }
    });
    return () => { active = false; };
  }, [issue.id, issue.repository, issue.number]);

  function itemOption(item: ParsedPlanItem) {
    const saved = applied.get(item.position);
    const mapping = selections[item.position];
    return {
      ...item,
      repository: mapping?.repository ?? saved?.repository ?? settings.repositories[0] ?? '',
      columnId: mapping?.columnId ?? saved?.columnId ?? settings.columns[0]?.id ?? '',
      targetIssue: saved?.targetIssue ?? null
    };
  }

  async function save() {
    setBusy(true); setError(''); setResult(null);
    try {
      const { plan } = await api.savePlan(issue, draft.trim());
      setPlan(plan);
      setSelections(Object.fromEntries(plan.items.map((item) => [item.position, { repository: item.repository, columnId: item.columnId }])));
    } catch (err) { setError(err instanceof Error ? err.message : 'Plan を保存できませんでした'); } finally { setBusy(false); }
  }

  async function apply() {
    setBusy(true); setError(''); setResult(null);
    try {
      const items = parsed.items.filter((item) => !item.completed && !applied.get(item.position)?.targetIssue).map((item) => {
        const option = itemOption(item);
        return { position: item.position, repository: option.repository, columnId: option.columnId };
      });
      const result = await api.applyPlan(issue, items);
      setResult(result);
      const next = await api.plan(issue);
      setPlan(next.plan);
      setSelections(Object.fromEntries((next.plan?.items ?? []).map((item) => [item.position, { repository: item.repository, columnId: item.columnId }])));
      onRefresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Issue を作成できませんでした'); } finally { setBusy(false); }
  }

  const changed = plan === undefined || plan === null || plan.body !== draft;
  const canApply = plan !== undefined && plan !== null && plan.body === draft && parsed.items.some((item) => !item.completed && !applied.get(item.position)?.targetIssue);
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal plan-modal" onMouseDown={(e) => e.stopPropagation()}>
    <button className="icon-button close" onClick={onClose} aria-label="閉じる"><X size={20} /></button>
    <p className="eyebrow">PLAN</p><h2>Issue Plan</h2>
    <p className="comment-issue-meta">{issue.localOnly ? 'issueban ローカルカード' : `${issue.repository} #${issue.number}`}</p>
    <label>Plan 文書 <textarea value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} placeholder={'# 実装計画\n\n## 目的\n達成したいこと\n\n## 仕様\n実装する内容\n\n## 作業単位（任意）\n- [ ] 最初の作業'} /></label>
    {parsed.sections.length > 0 && <div className="plan-preview"><small>プレビュー</small><h3>{parsed.title || 'Plan'}</h3>{parsed.sections.filter((section) => section.level > 1).map((section, index) => <section key={`${section.level}-${section.title}-${index}`}><h4>{section.title}</h4>{section.body && <p>{section.body}</p>}</section>)}</div>}
    {plan !== undefined && parsed.items.length > 0 && <div className="plan-items">{parsed.items.map((item) => {
      const option = itemOption(item);
      return <article className="plan-item" key={item.position}>
        <header><span className="plan-position">{item.position}</span><strong>{item.title}</strong>{item.completed && <small>完了</small>}{option.targetIssue && <a href={option.targetIssue.htmlUrl} target="_blank" rel="noreferrer">#{option.targetIssue.number}</a>}</header>
        {item.body && <p>{item.body}</p>}
        {!item.completed && !option.targetIssue && <div className="plan-item-mapping">
          <select aria-label={`${item.title}の作成先リポジトリ`} value={option.repository} onChange={(event) => setSelections((current) => ({ ...current, [item.position]: { ...option, repository: event.target.value } }))}>{settings.repositories.map((repository) => <option key={repository} value={repository}>{repository}</option>)}</select>
          <select aria-label={`${item.title}の初期カラム`} value={option.columnId} onChange={(event) => setSelections((current) => ({ ...current, [item.position]: { ...option, columnId: event.target.value } }))}>{settings.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select>
        </div>}
      </article>;
    })}</div>}
    {result && (result.applied.length > 0 || result.failed.length > 0) && <div className="plan-result">
      {result.applied.length > 0 && <p><Check size={14} />{result.applied.length} 件の Issue を作成しました。</p>}
      {result.failed.map((item) => <p className="form-error" key={`${item.position}-${item.title}`}><AlertCircle size={14} />#{item.position} {item.title}: {item.message}</p>)}
    </div>}
    {error && <p className="form-error"><AlertCircle size={14} />{error}</p>}
    <div className="plan-actions">
      <button className="button secondary" disabled={busy || changed || !canApply} onClick={() => void apply()}>{busy && <LoaderCircle className="spin" size={15} />}未作成の作業単位を Issue 化</button>
      <button className="button primary" disabled={busy || !draft.trim() || parsed.items.length > 25} onClick={() => void save()}>{busy && <LoaderCircle className="spin" size={15} />}文書を保存</button>
    </div>
  </section></div>;
}

function SettingsModal({ value, onClose, onSave }: { value: Settings; onClose: () => void; onSave: (settings: Settings) => Promise<void> }) {
  const [draft, setDraft] = useState<Settings>(structuredClone(value)); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const repos = draft.repositories.join('\n');
  function addColumn() {
    if (draft.columns.length >= 10) return;
    setDraft({
      ...draft,
      columns: [...draft.columns, { id: crypto.randomUUID(), name: '', label: '', color: '6b7280' }]
    });
  }
  function removeColumn(index: number) {
    if (draft.columns.length <= 1) return;
    const column = draft.columns[index];
    if (column.name && !window.confirm(`「${column.name}」カラムを削除しますか？\nこのカラムのカードは、設定保存後に先頭カラムへ表示されます。`)) return;
    setDraft({ ...draft, columns: draft.columns.filter((_, columnIndex) => columnIndex !== index) });
  }
  function addRule() { setDraft({ ...draft, routingRules: [...draft.routingRules, { id: crypto.randomUUID(), label: '', repository: draft.repositories[0] ?? '' }] }); }
  async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(''); try { await onSave(draft); onClose(); } catch (err) { setError(err instanceof Error ? err.message : '保存に失敗しました'); setBusy(false); } }
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
    <button className="icon-button close" onClick={onClose}><X size={20} /></button><p className="eyebrow">BOARD SETTINGS</p><h2>ボード設定</h2>
    <form onSubmit={submit} className="stack">
      <label>対象リポジトリ <small>1 行に owner/repo を 1 つ</small><textarea value={repos} onChange={(e) => setDraft({ ...draft, repositories: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })} placeholder={'acme/web\nacme/api'} /></label>
      <div className="setting-heading"><div><strong>カラムと同期ラベル</strong><small>移動時、このラベルに自動更新されます（最大 10 件）</small></div><button type="button" className="text-button" disabled={draft.columns.length >= 10} onClick={addColumn}>＋ カラム追加</button></div>
      <div className="editable-list">{draft.columns.map((column, index) => <div className="column-edit" key={column.id}>
        <input aria-label="色" className="color-input" type="color" value={`#${column.color.replace('#', '')}`} onChange={(e) => { const columns = [...draft.columns]; columns[index] = { ...column, color: e.target.value.slice(1) }; setDraft({ ...draft, columns }); }} />
        <input required className="column-name" aria-label="カラム名" placeholder="カラム名" value={column.name} onChange={(e) => { const columns = [...draft.columns]; columns[index] = { ...column, name: e.target.value }; setDraft({ ...draft, columns }); }} />
        <input required className="column-label" aria-label="同期ラベル" placeholder="status: example" value={column.label} onChange={(e) => { const columns = [...draft.columns]; columns[index] = { ...column, label: e.target.value }; setDraft({ ...draft, columns }); }} />
        <button type="button" className="icon-button danger column-delete" disabled={draft.columns.length <= 1} aria-label={`${column.name || '新しい'}カラムを削除`} title={draft.columns.length <= 1 ? 'カラムは最低 1 件必要です' : 'カラムを削除'} onClick={() => removeColumn(index)}><Trash2 size={16} /></button>
        <label className="local-only-toggle"><input type="checkbox" checked={column.localOnly ?? false} onChange={(e) => { const columns = [...draft.columns]; columns[index] = { ...column, localOnly: e.target.checked }; setDraft({ ...draft, columns }); }} />GitHub Issue を作成しない</label>
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
  const [loading, setLoading] = useState(true); const [dragging, setDragging] = useState<Issue | null>(null); const [createColumn, setCreateColumn] = useState<string | null>(null); const [showSettings, setShowSettings] = useState(false); const [showTeam, setShowTeam] = useState(false); const [commentIssue, setCommentIssue] = useState<Issue | null>(null); const [planIssue, setPlanIssue] = useState<Issue | null>(null); const [descriptionIssue, setDescriptionIssue] = useState<Issue | null>(null);
  const load = useCallback(async (keepIssue?: Issue) => {
    setLoading(true);
    try {
      const [s, data, spaces] = await Promise.all([api.settings(), api.issues(), api.workspaces()]);
      setSettings(s.settings);
      if (!keepIssue) {
        setIssues(data.issues);
      } else {
        const isKept = data.issues.some((issue) => issue.repository === keepIssue.repository && issue.number === keepIssue.number);
        setIssues(isKept ? data.issues : [...data.issues, keepIssue]);
      }
      setWorkspaces(spaces.workspaces);
      setErrors(data.errors.map((e) => `${e.repository}: ${e.message}`));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const grouped = useMemo(() => Object.fromEntries(settings.columns.map((column) => [column.id, issues.filter((issue) => issueColumn(issue, settings) === column.id)])), [issues, settings]);
  async function switchWorkspace(id: string) {
    if (id === user.workspace.id || switchingWorkspace) return;
    setSwitchingWorkspace(true); setErrors([]);
    try { await api.switchWorkspace(id); window.location.reload(); }
    catch (error) { setErrors([error instanceof Error ? error.message : 'ワークスペースの切り替えに失敗しました']); setSwitchingWorkspace(false); }
  }
  async function move(issue: Issue, columnId: string) {
    if (issueColumn(issue, settings) === columnId) return setDragging(null);
    const target = settings.columns.find((column) => column.id === columnId); if (!target) return;
    const previous = issues;
    const optimistic = { ...issue, labels: [...issue.labels.filter((label) => !settings.columns.some((col) => col.label.toLowerCase() === label.name.toLowerCase())), { name: target.label, color: target.color }] };
    setIssues((current) => current.map((item) => item.id === issue.id ? optimistic : item));
    setDragging(null);
    try {
      if (issue.localOnly) {
        const result = await api.moveCard(issue, columnId);
        setIssues((current) => current.map((item) => item.id === issue.id ? result.issue : item));
      } else {
        await api.moveIssue(issue, columnId);
      }
    }
    catch (error) { setIssues(previous); setErrors([error instanceof Error ? error.message : '移動に失敗しました']); }
  }
  async function removeCard(issue: Issue) {
    const previous = issues;
    setIssues(issues.filter((item) => item.id !== issue.id));
    try { await api.deleteCard(issue); } catch (error) { setIssues(previous); setErrors([error instanceof Error ? error.message : '削除に失敗しました']); }
  }
  async function drop(columnId: string) { if (dragging) await move(dragging, columnId); }
  return <div className="app-shell"><header className="topbar"><div className="brand"><span className="brand-mark">ib</span><span>issueban</span></div><div className="top-actions"><label className="workspace-switcher"><span>Workspace</span><select aria-label="ワークスペースを切り替え" value={user.workspace.id} disabled={loading || switchingWorkspace} onChange={(event) => void switchWorkspace(event.target.value)}>{!workspaces.some((workspace) => workspace.id === user.workspace.id) && <option value={user.workspace.id}>{user.workspace.name}</option>}{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select>{switchingWorkspace && <LoaderCircle className="spin" size={15} />}</label><button className="icon-button refresh-button" aria-label="再読み込み" title="再読み込み" onClick={() => void load()}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button><button className="icon-button" aria-label="チーム" title="チーム" onClick={() => setShowTeam(true)}><Users size={18} /></button><button className="icon-button" aria-label="設定" title="設定" onClick={() => setShowSettings(true)}><SettingsIcon size={18} /></button><div className="user"><img src={user.avatarUrl} alt="" /><span>{user.login}</span></div><button className="icon-button logout" aria-label="ログアウト" title="ログアウト" onClick={onLogout}><LogOut size={18} /></button></div></header>
    <main className="board-wrap"><div className="board-heading"><div><p className="eyebrow">WORKSPACE BOARD</p><h1>{user.workspace.name}</h1><p className="board-summary">{issues.length} issues · {settings.repositories.length} repositories</p></div><button className="button primary compact" onClick={() => setCreateColumn(settings.columns[0]?.id ?? '')}><Plus size={18} /><span>Issue を追加</span></button></div>
    {errors.length > 0 && <div className="notice"><AlertCircle size={17} /><div>{errors.map((error) => <p key={error}>{error}</p>)}</div><button onClick={() => setErrors([])}><X size={15} /></button></div>}
    {!loading && settings.repositories.length === 0 ? <section className="empty-state"><div className="empty-icon"><SettingsIcon /></div><h2>最初のリポジトリを接続</h2><p>対象リポジトリとカラムを設定すると、Issue がここに並びます。</p><button className="button primary" onClick={() => setShowSettings(true)}>ボードを設定</button></section> :
    <div className="board">{settings.columns.map((column) => <section className={`column ${dragging ? 'drag-active' : ''}`} key={column.id} onDragOver={(e) => e.preventDefault()} onDrop={() => void drop(column.id)}><header><div><i style={{ background: `#${column.color}` }} /><h2>{column.name}</h2><span>{grouped[column.id]?.length ?? 0}</span></div><button className="icon-button mini" aria-label={`${column.name}にカードを追加`} onClick={() => setCreateColumn(column.id)}><Plus size={17} /></button></header><div className="card-list">{grouped[column.id]?.map((issue) => <IssueCard key={issue.id} issue={issue} settings={settings} currentColumn={column.id} onDragStart={() => setDragging(issue)} onMove={(columnId) => void move(issue, columnId)} onOpenComments={() => setCommentIssue(issue)} onOpenPlan={() => setPlanIssue(issue)} onOpenDescription={() => setDescriptionIssue(issue)} onDelete={() => void removeCard(issue)} />)}{loading && [1, 2].map((n) => <div className="issue-card skeleton" key={n} />)}<button className="add-card" onClick={() => setCreateColumn(column.id)}><Plus size={15} />カードを追加</button></div></section>)}</div>}</main>
    {createColumn && <CreateIssue settings={settings} initialColumn={createColumn} onClose={() => setCreateColumn(null)} onCreated={() => { setCreateColumn(null); void load(); }} />}
    {showSettings && <SettingsModal value={settings} onClose={() => setShowSettings(false)} onSave={async (next) => { const result = await api.saveSettings(next); setSettings(result.settings); void load(); }} />}
    {showTeam && <TeamModal user={user} onClose={() => setShowTeam(false)} />}
    {commentIssue && <CommentThread issue={commentIssue} viewerLogin={user.login} onClose={() => setCommentIssue(null)} onUpdated={(next) => {
      setIssues((previous) => previous.map((item) => item.id === next.id ? next : item));
      setCommentIssue((current) => current && current.id === next.id ? next : current);
    }} />}
    {planIssue && <PlanModal issue={planIssue} settings={settings} onClose={() => setPlanIssue(null)} onRefresh={() => void load()} />}
    {descriptionIssue && <LocalCardDescription issue={descriptionIssue} onClose={() => setDescriptionIssue(null)} onUpdated={(next) => {
      setIssues((previous) => previous.map((item) => item.id === next.id ? next : item));
    }} />}
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
