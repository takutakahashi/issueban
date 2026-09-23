# Issue をキーにした Plan 設計

Issue: #18

## 方針

Plan を独立した一覧として管理するのではなく、既存 GitHub Issue に登録できるデータとして設計します。Plan の登録単位と検索キーは GitHub Issue です。

- 1 Issue = 1 Plan
- Plan source issue の `repository` + `issue number` を UI 上のキー、GitHub Issue ID を内部キーとして使う
- Plan 本文は Issue body を書き換えず、専用コメントとして保存する
- Plan item から作成した Issue との対応は D1 に記録する
- 独立した Plan 一覧画面は作らない

## 背景

現在、1 枚の Issue カードから 1 つの Issue を作成できます。しかし、1 つの Issue に複数ステップの計画を書いても、それを個別の作業 Issue として扱えません。計画を Plan として登録し、必要になったときに item 単位で Issue 化できるようにします。

## 目標

- 既存 Issue に Plan を登録・編集できる
- Plan を見出し構造を持つ Markdown 文書として保持・表示できる
- checklist がある場合だけ、明示的な作業単位として解析できる
- Plan item ごとに GitHub Issue を作成できる
- 作成済み item を追跡し、再実行時に重複作成しない
- 既存のボード設定（リポジトリ・カラム・ラベル）を利用する
- Plan を GitHub 上からも確認できる

## 非目標

- Plan 専用の一覧画面や独立テーブルによる Plan 管理
- GitHub Issue body の自動書き換え
- Pull Request の作成
- 自然言語の高度な解釈や AI 生成
- 既存 Issue を後から別の Plan item に変換する機能

## 用語

| 用語 | 意味 |
| --- | --- |
| Plan source issue | Plan を保持する GitHub Issue。Plan のキーになる |
| Plan comment | `<!-- issueban:plan -->` で始まる専用コメント |
| Plan item | Plan 内の 1 つの作業項目 |
| Applied issue | Plan item から作成された GitHub Issue |

## ユーザーフロー

### 1. Plan の登録

Issue カードまたはコメントモーダルに `Plan` 操作を追加します。

1. `Plan` を開く
2. Markdown を入力する
3. プレビューで解析結果を確認する
4. `保存` で Plan comment を作成または更新する
5. 必要になった item を選んで `Issue 化` を実行する

Plan はチェックリストを必須としません。最小形式は次のとおりです。

```markdown
# ログイン改善

## 目的
OAuth ログインの失敗率を下げる。

- [ ] エラー表示を整理する
  具体的には `invalid_oauth_callback` と `invalid_oauth_state` を区別する。
- [ ] リトライ導線を追加する
- [ ] ログを追加する
```

`#` 行は Plan タイトル、各見出しと本文は仕様セクションとして解析します。任意の `- [ ]` は Plan 文書とは別の作業単位として扱います。チェック済み `- [x]` は既定で Issue 化対象から除外します。作業単位の直後にインデントした行がある場合は、その作業本文として扱います。

### 2. Plan comment

Plan comment は次の形式で保存します。

```markdown
<!-- issueban:plan -->
# ログイン改善

## 目的
OAuth ログインの失敗率を下げる。

- [ ] エラー表示を整理する
  具体的には `invalid_oauth_callback` と `invalid_oauth_state` を区別する。
```

先頭行の marker があるコメントだけを Plan comment として扱います。同一 Issue に複数あっても、最も新しい Plan comment を active な Plan にします。古い Plan comment は無視します。

Issue body を Plan で上書きしない理由は次のとおりです。

- Issue の説明を Plan に置き換える意図をユーザーが持つとは限らない
- GitHub 上で Plan と Issue の本来の説明を区別できる
- Plan の編集履歴を Issue comment として残せる

### 3. プレビュー

Plan 保存前に次の内容を表示します。

- Plan タイトル
- item 数
- 各 item のタイトルと本文
- 作成先リポジトリ
- 初期カラムとステータスラベル
- 作成済み Issue の有無

既定の初期カラムは `settings.columns[0]` です。リポジトリは既定の選択を使い、item ごとに上書きできます。設定に存在しないリポジトリ、空タイトル、カラムラベル未設定の item がある場合は `Issue 化` を無効化します。

### 4. Issue 化

`Issue 化` を押すと、Worker が GitHub API を呼び出します。

- item は `position` 昇順で 1 件ずつ作成する
- 作成できた Issue の ID・番号・URL を D1 の link として保存する
- 失敗した item だけ `failed` にし、再実行で未作成 item だけを作成する
- 作成後にボードを再取得し、作成済み Issue を表示する

Plan 全体を 1 つの Issue にまとめる機能は MVP では作りません。Plan source issue は Plan のキーであり、Plan item の Issue は別に作成します。

## データモデル

Plan 本文は GitHub comment に保存します。D1 は Plan 本文を保存せず、item と作成済み Issue の対応だけを持ちます。

```sql
CREATE TABLE plan_item_links (
  source_issue_id INTEGER NOT NULL,
  item_digest TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  target_issue_id INTEGER NOT NULL,
  target_repository TEXT NOT NULL,
  target_issue_number INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_issue_id, item_digest)
);
CREATE INDEX plan_item_links_source ON plan_item_links(source_issue_id);
CREATE INDEX plan_item_links_target ON plan_item_links(target_repository, target_issue_number);
```

`source_issue_id` は GitHub Issue ID です。実装では `source_issue_id` を唯一の source キーとし、UI は `repository` と `issue number` をルートから復元します。

`item_digest` は次のように計算します。

```text
sha256(source_issue_id + "\0" + occurrence + "\0" + normalized title + "\0" + normalized body)
```

`occurrence` は同一内容の item が複数ある場合に 0 から始まる出現順です。内容が同じまま順序が変わっても、既存 link を維持できます。item を削除した場合、対応する link は残りますが、Plan preview には表示しません。

API 形式は次のとおりです。

```ts
type PlanSource = {
  issueId: number;
  repository: string;
  number: number;
  htmlUrl: string;
};

type PlanItemStatus = 'pending' | 'applying' | 'applied' | 'failed';

type PlanItem = {
  position: number;
  digest: string;
  title: string;
  body: string;
  completed: boolean;
  repository: string;
  columnId: string;
  labels: string[];
  status: PlanItemStatus;
  targetIssue?: {
    id: number;
    number: number;
    repository: string;
    htmlUrl: string;
  } | null;
  errorMessage?: string | null;
};

type Plan = {
  source: PlanSource;
  commentId: number;
  title: string;
  body: string;
  items: PlanItem[];
};
```

`status` は D1 の link 有無と Apply 実行中の状態から算出します。Plan 本文自体に状態を持たせません。

## API

| メソッド | パス | 概要 |
| --- | --- | --- |
| `GET` | `/api/issues/:owner/:repo/:number/plan` | active な Plan comment と item 状態を返す |
| `PUT` | `/api/issues/:owner/:repo/:number/plan` | Plan comment を作成または更新する |
| `POST` | `/api/issues/:owner/:repo/:number/plan/preview` | Markdown を解析し、既定マッピング付き item を返す |
| `POST` | `/api/issues/:owner/:repo/:number/plan/apply` | 選択 item を GitHub Issue として作成する |

リクエスト例は次のとおりです。

```json
{
  "title": "ログイン改善",
  "body": "# ログイン改善\n\n## 目的\nOAuth ログインの失敗率を下げる。",
  "items": [
    {
      "title": "エラー表示を整理する",
      "body": "`invalid_oauth_callback` と `invalid_oauth_state` を区別する。",
      "repository": "owner/app",
      "columnId": "backlog",
      "labels": ["status: backlog"]
    },
    {
      "title": "リトライ導線を追加する",
      "body": "",
      "repository": "owner/app",
      "columnId": "backlog",
      "labels": ["status: backlog"]
    }
  ]
}
```

リクエスト制約は次のとおりです。

- `title`: 1〜140 文字
- `body`: 最大 65,536 文字
- item 数: 最大 25
- item タイトル: 1〜256 文字
- `repository`: ワークスペース設定に含まれること
- `columnId`: ワークスペース設定に含まれること
- `labels`: ステータスラベルを 1 つ含むこと

読み取りと `preview` はワークスペースメンバー全員に許可します。`PUT` と `apply` もメンバー全員に許可しますが、GitHub への書き込みには呼び出したユーザーの OAuth/PAT 権限が必要です。権限不足時は item 単位で失敗します。

## 解析仕様

パーサーは `src/shared/plan.ts` に実装し、フロントエンドと Worker の両方から使います。

- 最初の `#` 行がタイトル候補になる
- `##` 以下は Plan 説明として扱う
- `- [ ]` で始まる行を Plan item にする
- インデントされた非空行を直前 item の本文にする
- `- [x]` は解析結果に含めるが `completed: true` にする
- 空行は item 本文の区切りではなく、本文整形のために保持する
- 同名の `#` タイトルが入力フォームのタイトルを上書きしない

保存時には Worker でも同一パーサーを通し、クライアントだけが信頼できる item を送れないようにします。`item_digest` は保存時に計算します。

## Issue 作成

`POST /api/issues/:owner/:repo/:number/plan/apply` は次の順序で処理します。

1. ワークスペースメンバーシップと Plan source issue の存在を確認する
2. active な Plan comment を取得して解析する
3. D1 の `plan_item_links` を取得して item に対応付ける
4. リクエストされた item position のうち `pending` または `failed` を対象にする
5. item を `position` 昇順で 1 件ずつ作成する
6. 対応カラムのラベルが存在しなければ `ensureLabel` で作成する
7. Issue を作成する
8. GitHub Issue 作成に成功したら link を D1 に保存する
9. 失敗したら item ごとのエラーを返し、次の item に進む

作成する Issue の本文は次のようにします。

```markdown
<!-- issueban:plan-source
source_issue_id: 123456789
source_repository: owner/repo
source_issue_number: 42
item_digest: 0123456789abcdef
-->

{item.body}

---
Plan: {plan.title}
Source: {source issue url}
```

この marker により、作成済み Issue から元の Plan source issue をたどれます。Plan item と Applied issue の関係を D1 に保存しつつ、GitHub 上でも人間が確認できるようにします。

## UI

既存の Issue モーダルに Plan セクションを追加します。

- `Plan` ボタンで Plan panel を開く
- Plan が未登録の場合は Markdown 入力フォームを表示する
- 登録済みの場合は Plan 本文を編集できる
- 解析結果は item 単位のリストで確認する
- item ごとにリポジトリとカラムを選択できる
- 作成済み item には Applied issue へのリンクを表示する
- 失敗 item にはエラーメッセージと `再実行` を表示する
- Plan があるカードには小さな `Plan` バッジを表示する

Plan は既存 Issue ボードの別カードにはしません。Plan source issue のカードはこれまでどおり Issue として扱います。

## エラー設計

| 状況 | 挙動 |
| --- | --- |
| ワークスペース未参加 | `403` |
| Plan source issue 未存在 | `404` |
| Plan comment 未存在で `apply` | `422` |
| Markdown 解析後の item が 0 件 | `422` |
| 設定外リポジトリ / カラム | `422` |
| GitHub 権限不足 | item を `failed`、他 item は続行 |
| GitHub API 一時障害 | item を `failed`、再実行可能にする |

Apply は部分成功を許します。失敗 item のみ対象にして再実行できます。

## テスト

### ユニットテスト

- Markdown 解析：タイトル・説明・item・本文・完了項目
- item digest の安定性
- 同一内容 item の digest 分離
- 設定変更により無効になった item の検証

### API テスト

- メンバー以外の拒否
- 設定外リポジトリの拒否
- Apply の冪等性
- 一部失敗時の item status
- 同一 item の二重実行で Issue を作成しないこと
- Plan comment が複数ある場合に最新のみ採用すること

## 実装フェーズ

1. `plan.ts` と解析・digest テストを追加
2. `plan_item_links` migration とクライアント型を追加
3. Plan comment の取得・保存 API を追加
4. Issue モーダルに Plan panel とプレビュー UI を追加
5. Apply API、GitHub Issue 作成、失敗表示・再実行を追加
6. README に Plan の操作説明を追加

## 代替案

### Plan を 1 つの Issue にする

実装は軽いですが、項目単位の作成や状態管理ができません。Plan と作業単位が混在するため採用しません。

### Plan を D1 の独立テーブルに保存する

Plan 専用一覧を作りやすいですが、Issue との対応が二重管理になり、GitHub 上の可視性が下がります。Issue をキーにする要件に合いません。

### Plan を localStorage に保存する

バックエンド実装が不要ですが、チーム共有や作成済み追跡ができません。Issue #18 の目的に合いません。
