# Jira Daily Updater

Cloudflare Workers CronでR2上のJira更新JSONを読み、Jira APIへ反映する構成です。

このWorkerはR2 Bindingを使わず、R2のS3互換APIを直接呼びます。Cloudflare Dashboard / WranglerでR2 Binding追加時に `code: 10136` が出る環境でも動かせるようにしています。

## Schedule

`wrangler.jsonc` のCronは `0 0 * * *` です。Cloudflare CronはUTCなので、日本時間09:00に実行されます。

## R2 Layout

R2 bucket: `jira-updates`

```text
update/*.json              未処理JSON
done/yyyy-mm-dd/*.json     処理成功済みJSON
failed/yyyy-mm-dd/*.json   処理失敗JSON
```

成功したJSONは `done/` へ移動し、`update/` から削除します。失敗したJSONは `failed/` へ移動します。

## Setup

R2 bucketを作成します。

```powershell
npx wrangler r2 bucket create jira-updates
```

R2 API tokenを作成します。

```text
Cloudflare Dashboard
→ R2 Object Storage
→ API
→ Manage API tokens
→ Create API token
```

権限は `Object Read & Write`、対象bucketは `jira-updates` を指定します。作成後に表示される `Access Key ID` と `Secret Access Key` を控えます。

Secretsを登録します。

```powershell
npx wrangler secret put JIRA_API_TOKEN
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

`wrangler.jsonc` の以下を確認します。

- `R2_ACCOUNT_ID`
- `R2_BUCKET_NAME`
- `JIRA_EMAIL`
- `JIRA_SPRINT_FIELD`

## Upload JSON

例:

```powershell
npx wrangler r2 object put jira-updates/update/jira_update-sample.json --file .\jira_update-sample.json
```

## Manual Run

手動実行 `/run` は `ALLOWED_RUN_IPS` に設定したIPからのみ実行できます。

`wrangler.jsonc` 例:

```jsonc
"ALLOWED_RUN_IPS": "203.0.113.10,198.51.100.20"
```

```powershell
Invoke-WebRequest https://jira-daily-updater.maeda-kiyotaka.workers.dev/run
```

`ALLOWED_RUN_IPS` が空の場合、`/run` は403になります。Cron実行には影響しません。

## Deploy

```powershell
npm run deploy
```

## Notes

- `DRY_RUN=true` を環境変数に入れるとJira API更新とR2移動を行わずログだけ出します。
- `MOVE_FAILED=true` の場合、失敗したJSONは `failed/` へ移動します。
- ラベルは大文字小文字を無視して重複除去します。
