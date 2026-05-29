# Deployment Checklist

This is the minimum handoff needed to finish production deployment.

## 1. Deployment Target

Recommended: Render using `render.yaml`.

Needed:

- Permission to create or update the `near-ai-services-os` web service.
- A connected Git repo or a manual deploy path from this repository.
- Public HTTPS URL after deploy.

The app exposes:

- `GET /healthz`
- `GET /readyz`
- `POST /slack/events`
- `POST /webhooks/smartlead`
- `POST /webhooks/chili-piper`
- `POST /webhooks/fathom`
- `POST /jobs/weekly-metrics`

## 2. Required Secrets

Set these environment variables on the deployment target:

```text
GOOGLE_SPREADSHEET_ID=1SzVtD8Ql94nGo6hw-FMwnTH_Ur3kIr2zW-d7AqFOrks
GOOGLE_SERVICE_ACCOUNT_JSON=...
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_AI_LEADS_CHANNEL_ID=C0B63R2TC3V
SLACK_HANDOFF_CHANNEL_ID=C0B63R2TC3V
OPENAI_API_KEY=...
WEBHOOK_SHARED_SECRET=...
ADMIN_TOKEN=...
SMARTLEAD_API_KEY=...
```

If the deployment provider has trouble with raw JSON, set `GOOGLE_SERVICE_ACCOUNT_JSON_B64` instead.

Optional:

```text
FATHOM_API_KEY=...
FATHOM_BASE_URL=https://api.fathom.ai/external/v1
OPENAI_MODEL=gpt-4.1-mini
SLACK_ALLOWED_USER_IDS=
SLACK_ALLOWED_CHANNEL_IDS=C0B63R2TC3V
```

## 3. Google Sheets Access

- Share the spreadsheet with the Google service account email as editor.
- Run `npm run validate:env` before starting the service.
- After deploy, visit `/readyz`.
- Expected response:

```json
{ "ok": true, "sheet": "ready" }
```

## 4. Slack App Setup

Bot scopes:

```text
app_mentions:read
channels:history
chat:write
commands
files:read
users:read
```

Event request URL:

```text
https://YOUR_HOST/slack/events
```

Subscribe to bot events:

```text
app_mention
message.channels
```

Slash command:

```text
/near-ai -> https://YOUR_HOST/slack/events
```

Install the app into the workspace and invite it to `#ai-leads`.

## 5. External Integrations

Smartlead:

```text
POST https://YOUR_HOST/webhooks/smartlead?secret=WEBHOOK_SHARED_SECRET
```

Chili Piper or Zapier booking bridge:

```text
POST https://YOUR_HOST/webhooks/chili-piper?secret=WEBHOOK_SHARED_SECRET
```

Fathom:

```text
POST https://YOUR_HOST/webhooks/fathom?secret=WEBHOOK_SHARED_SECRET
```

Cron:

```text
POST https://YOUR_HOST/jobs/weekly-metrics?token=ADMIN_TOKEN
```

Recommended cadence: every Monday morning and on demand after Smartlead campaign changes.

## 6. Smoke Tests

Run these in `#ai-leads` after deploy:

```text
/near-ai Add TestCo as a lead. Jane Doe. jane@testco.com. Interested in AI workflow automation.
/near-ai Create a deal for TestCo.
/near-ai Assign Kelvin to TestCo.
/near-ai Move TestCo to handoff.
```

Expected:

- `Leads` has one TestCo row.
- `Deals` has one TestCo row, not duplicates.
- `Handoff` has one TestCo row.
- `Events` contains the processed Slack events.
- The bot posts confirmations in Slack.

After smoke test, delete or mark the TestCo rows as test data.
