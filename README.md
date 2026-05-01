# Jira Daily Updater

Cloudflare Workers CronでR2上のJira更新JSONを読み、Jira APIへ反映する構成です。

## Schedule

`wrangler.jsonc` のCronは `0 0 * * *` です。Cloudflare CronはUTCなので、日本時間09:00に実行されます。

## R2 Layout

R2 bucket: `jira-updates`

```text
update/*.json              未処理JSON
done/yyyy-mm-dd/*.json     処理成功済みJSON
failed/yyyy-mm-dd/*.json   処理失敗JSON
```

成功したJSONは `done/` へ移動し、`update/` から削除します。失敗したJSONは `failed/` へ移動し、エラーの短い内容をR2 custom metadataに保存します。

## Setup

R2 bucketを作成します。

```powershell
npx wrangler r2 bucket create jira-updates
```

Jira API tokenをSecretに登録します。

```powershell
npx wrangler secret put JIRA_API_TOKEN
```

`wrangler.jsonc` の以下を実値に変更します。

- `JIRA_EMAIL`
- `JIRA_SPRINT_FIELD`

## Upload JSON

例:

```powershell
npx wrangler r2 object put jira-updates/update/jira_update-sample.json --file .\jira_update-sample.json
```

## Manual Run

ローカル起動:

```powershell
npm run dev
```

別ターミナルから:

```powershell
Invoke-WebRequest http://localhost:8787/run
```

## Deploy

```powershell
npm run deploy
```

## Notes

- `DRY_RUN=true` を環境変数に入れるとJira API更新とR2移動を行わずログだけ出します。
- `MOVE_FAILED=true` の場合、失敗したJSONは `failed/` へ移動します。
- ラベルは大文字小文字を無視して重複除去します。
