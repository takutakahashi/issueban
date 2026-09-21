# issueban

GitHub Issues と双方向に同期する、Cloudflare Workers ネイティブのカンバンです。

- 複数リポジトリの Issue を 1 枚のボードに集約
- Issueban ラベルに応じて、新規 Issue の作成先リポジトリを切り替え
- カード移動時に GitHub Issue のステータスラベルを自動更新
- カードに最新コメントのプレビューを表示し、クリックでコメント一覧を確認
- GitHub OAuth App / Personal access token (PAT) の両方に対応
- 共有ワークスペース、招待コード、オーナー／メンバー権限によるチーム開発
- PWA としてホーム画面へインストール可能。アプリシェルはオフラインでも起動
- OAuth/PAT は AES-GCM で暗号化、セッション ID は SHA-256 ハッシュで D1 に保存

## Stack

React 19 + Vite の SPA、Hono API、Cloudflare Workers Static Assets、Cloudflare D1 です。フロントエンド、API、データベースを Cloudflare 上の 1 Worker にまとめています。

## Local setup

必要なもの: Node.js 20 以上、Cloudflare アカウント。

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

PAT ログインだけを使う場合、`.dev.vars` の GitHub OAuth 変数は不要です。Fine-grained PAT には対象リポジトリの Issues `Read and write` と Metadata `Read-only` を付与してください。Classic PAT の場合は private repository に `repo` scope が必要です。

## GitHub OAuth App

GitHub の Settings → Developer settings → OAuth Apps で OAuth App を作成します。

- Homepage URL: デプロイ先 URL（ローカルは `http://localhost:5173`）
- Authorization callback URL: `<デプロイ先>/api/auth/oauth/callback`

Client ID / secret を `.dev.vars` に設定します。本番では Wrangler secrets を利用してください。

```bash
npx wrangler secret put APP_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

## Remote MCP server

`/mcp` はリモート MCP（Streamable HTTP）エンドポイントです。`Authorization: Bearer` に GitHub Personal Access Token を指定すると、そのトークンで GitHub API を呼び出します。認証時には `/user` でトークンを検証します。

対応ツール（Issueban ボード操作）:

- `issueban_get_authenticated_user` — Bearer トークンの GitHub ユーザー確認
- `issueban_list_board` — 設定したリポジトリのカードをカラムごとに一覧
- `issueban_move_card` — カードを別カラムへ移動（GitHub ラベルを更新）
- `issueban_create_card` — 新規カードを作成（GitHub Issue を作成し、カラムラベルを付与）

ボードツールは `settings`（`repositories` と `columns`）を引数として受け取ります。MCP サーバーはセッションレスのため、呼び出しごとにボード設定を指定してください。

動作確認:

```bash
curl -s http://localhost:5173/mcp \
  -H 'Authorization: Bearer $GITHUB_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

MCP クライアントには `https://<デプロイ先>/mcp` を指定し、認証には GitHub PAT を Bearer トークンとして設定してください。トークンはこのサーバーに保存せず、リクエストごとにのみ使用します。

## Deploy

1. Cloudflare にログインし、D1 を作成します。

```bash
npx wrangler login
npx wrangler d1 create issueban
```

2. 別の Cloudflare アカウントへデプロイする場合は、出力された `database_id` を `wrangler.jsonc` に設定します。このリポジトリの本番用 D1 ID は設定済みです。
3. migration、secret、デプロイを実行します。

```bash
npm run db:migrate:remote
npx wrangler secret put APP_SECRET
# OAuth を使う場合のみ、上記の GitHub secrets も登録
npm run deploy
```

### main へのマージで自動リリース

`main` へマージ（push）すると GitHub Actions が typecheck・テスト・D1 migration・ビルド・`wrangler deploy` を順に実行し、本番へ自動デプロイします。ワークフローは `.github/workflows/release.yml` にあり、手動実行（workflow_dispatch）も可能です。リポジトリの Settings → Secrets and variables → Actions に次の secret を登録してください。

- `CLOUDFLARE_API_TOKEN`: Workers Scripts と D1 を編集できる API トークン
- `CLOUDFLARE_ACCOUNT_ID`: デプロイ先の Cloudflare アカウント ID

手元からデプロイする場合はこれまで通り `npm run deploy` を実行します。

初回ログイン後、歯車アイコンから対象リポジトリ、カラムと同期ラベル、Issueban ラベルごとの作成先を設定します。ルーティングに一致しないラベルは対象リポジトリの先頭へ作成されます。カードを別カラムへ移動すると、既存のカラム用ラベルのみを取り除き、移動先ラベルを追加します。それ以外の GitHub ラベルは維持します。

カードのコメントバッジから Issue の説明とコメント一覧をモーダルで確認でき、コメントを書き込めます。自分が投稿したコメントはモーダル内で編集できます。コメントは閲覧時に GitHub API から都度取得し、D1 へは保存しません。

ヘッダーのセレクターから参加中のワークスペースを切り替えられます。メンバーアイコンからはチーム用ワークスペースを作成できます。オーナーが発行した招待コードは 1 回のみ使用でき、7 日で失効します。参加者はワークスペースのボード設定を共有しつつ、GitHub API 操作には各自の OAuth/PAT を利用します。オーナーはメンバー削除とワークスペース削除、メンバーは退出が可能です。ワークスペースを削除すると、参加中の別 workspace があればそこへ切り替わり、なければログアウトされます。既存ユーザーは初回アクセス時に従来の設定を引き継いだ個人ワークスペースへ自動移行されます。

## Commands

```bash
npm run typecheck
npm test
npm run build
```

## PWA

対応ブラウザではインストール案内が表示され、デスクトップやホーム画面から standalone アプリとして起動できます。Service Worker はアプリシェルと静的アセットのみをキャッシュし、認証情報や `/api/*` のレスポンスはキャッシュしません。GitHub Issue の取得・更新にはネットワーク接続が必要です。

## Security notes

- `APP_SECRET` はトークン暗号化鍵です。変更すると保存済み認証情報を復号できなくなります。
- 認証 Cookie は `HttpOnly`, `Secure`, `SameSite=Lax` です。
- OAuth state は一度だけ使え、10 分で失効します。
- GitHub トークンは API レスポンスやブラウザストレージへ返しません。
