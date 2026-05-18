# シフト決定システム

シフト入力サイト + LINE Bot の一式です。

## ディレクトリ構成

```
shift-system/
├── frontend/
│   └── index.html          ← ブラウザで開けば即動作 (localStorageで動作)
├── supabase/
│   └── schema.sql          ← Supabaseに流すSQL
└── line-bot/
    ├── bot.js              ← LINE Bot本体 (Node.js)
    ├── package.json
    └── .env.example
```

## ① ブラウザで即試す (localStorage 動作)

`frontend/index.html` をダブルクリックしてブラウザで開くだけで動作します。
データは同じ端末の `localStorage` に保存されます。

これだけで以下が試せます:
- 名前の追加/削除/選択
- 月の設定 (回答必要人数、勉強会日、祝日の追加/除外)
- 個人オプション (週あたり最大シフト数、土曜希望)
- 参加可能日のカレンダー入力 (○ / △ / ✕ をクリックで切替)
- 全員の回答状況の表示
- 確定シフトの算出と個人別出勤日の表示

## ② 複数人で使う (Supabase 連携)

### Step 1. Supabase プロジェクト作成
1. https://supabase.com で無料プロジェクトを作成
2. ダッシュボード → **SQL Editor** → `supabase/schema.sql` の内容を貼り付けて実行
3. **Settings → API** から以下を取得
   - Project URL (例: `https://xxxxx.supabase.co`)
   - `anon public` キー
   - `service_role` キー (LINE Bot用; 公開しないこと)

### Step 2. index.html を編集
ファイル冒頭の設定箇所を編集:
```js
const SUPABASE_URL = "https://xxxxx.supabase.co";
const SUPABASE_KEY = "anon public のキー";
const USE_SUPABASE = true;
```
さらに同ファイル内のSupabase script tagのコメントを外す:
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

### Step 3. デプロイ
静的ホスティングならどこでも動きます: Netlify / Vercel / Cloudflare Pages / GitHub Pages など。

> ⚠️ `loadStateFromBackend` / `saveResponseToBackend` 関数はサンプル骨格として用意してあります。
> `useEffect` から呼び出してUIに反映する処理は、運用要件に合わせて完成させてください。

## ③ LINE Bot のセットアップ

### Step 1. LINE Developers
1. https://developers.line.biz でプロバイダー作成
2. **Messaging API** チャネルを作成
3. **Messaging API設定** から:
   - Channel access token を発行
   - Channel secret を控える
   - Webhook URL を後述のデプロイ先 URL `/webhook` に設定
   - 「応答メッセージ」を OFF、「Webhook」を ON
4. Botを対象のグループに招待

### Step 2. グループIDの取得
グループ内で `/groupid` と送信するとBotがグループIDを返してくれます (Webhook設定後)。
または `bot.js` のコンソールログにも出力されます。

### Step 3. インストール & 起動
```bash
cd line-bot
cp .env.example .env       # 取得したトークン類を埋める
npm install
npm start
```

### Step 4. 公開
Render / Railway / Fly.io / VPS など、HTTPSで公開できる場所にデプロイ。
LINE Webhook URL に `https://your-server/webhook` を設定。

### Step 5. 各APIを叩く
```bash
# 月初の呼びかけ (URL + 締切22日)
curl -X POST https://your-server/api/notify-new-month \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"

# 未回答リマインド (メンションなしのテキストメッセージ)
curl -X POST https://your-server/api/send-reminder \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"

# 締切後の強リマインド (未回答者がいれば「シフトを提出できません」)
curl -X POST https://your-server/api/send-final-reminder \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"

# 確定シフトをグループへ投稿
curl -X POST https://your-server/api/post-decided-shift \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

### Step 6. 定期実行 (GitHub Actions)

`.github/workflows/shift-reminders.yml` を同梱しています。以下を設定すれば自動で動きます。

| 日付 (JST 9:00) | 呼ばれるAPI | 内容 |
|---|---|---|
| 毎月 **15日** | `/api/notify-new-month` | サイトURLと締切22日を案内 |
| 毎月 **21日** | `/api/send-reminder` | 通常リマインド |
| 毎月 **22, 24, 26, 28, 30日** | `/api/send-final-reminder` | 未回答者が残っていれば「シフトを提出できません」(全員回答済みなら自動スキップ) |

リポジトリの **Settings → Secrets and variables → Actions** に以下を登録:
- `BOT_URL` … 例 `https://your-server` (末尾スラッシュなし)
- `ADMIN_TOKEN` … bot の `.env` と同じ値

## シフト決定ロジック

1. 全員回答 (`responses.submitted = true` の数 ≧ `total_people`) が前提
2. 各日付ごとに枠を埋める:
   - **平日**: 午後のみ、定員2
   - **土曜**: 午前1 / 正午1 / 午後2
3. 各枠で:
   - ○ (参加可) の人を優先選択
   - 定員に足りなければ △ で補充
   - 同候補内ではこれまでのシフト数が少ない人が優先 (公平化)
   - 同数ならランダム
4. **土曜の正午に決まった人は、午後の定員2のうち1を自動的に埋める**
5. 週あたり最大シフト数の希望があれば厳守
6. 土曜午前と午後の両方に○ + 希望がある人は、その希望を最優先

## 仕様まとめ

| 項目 | 内容 |
|---|---|
| 対象月 | 翌月固定 |
| 除外日 | 日曜日、祝日 (内閣府データ + 手動)、勉強会の日 (デフォルト第3木曜) |
| 募集枠 | 平日: 午後 / 土曜: 午前・正午(11-15時)・午後 |
| 定員 | 基本2人、土曜午前と正午のみ1人 |
| 選択肢 | ○ (参加可) / △ (補欠可) / ✕ (不可、デフォルト) |
| 個人オプション | 週あたり最大シフト数、土曜午前/午後希望 |
| データ保存 | localStorage (デフォルト) または Supabase |
