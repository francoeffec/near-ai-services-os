# NearAI Services

This repository contains the cloud service for NearAI Services.

The product model is simple:

- Google Sheets is the database.
- Slack is the user interface.
- Smartlead, HubSpot meeting webhooks, Chili Piper fallback booking webhooks, and Fathom are input sources.
- The service is the automation layer that keeps every tab synchronized.

## Why This Architecture

I recommend a small Node service instead of pure Google Apps Script.

The tradeoff is that we need a deployed service and secrets, but the payoff is material: Slack signature verification, webhook protection, idempotent event processing, structured AI extraction, scheduled jobs, better logs, and cleaner integration tests. Apps Script is attractive for speed, but it is weaker for secure Slack events, external webhooks, retries, and production observability.

## What It Does

- Creates and updates leads from Slack or Smartlead positive replies.
- Creates deals from Slack, HubSpot meeting bookings, Chili Piper/Zapier booking payloads, or calendar-style booking payloads.
- Creates or updates deals and lead rows from Fathom share URLs, transcript payloads, or pasted/attached call notes in Slack.
- Moves deals to handoff and generates a Slack handoff message.
- Sends Handoff tab recaps to Slack when `Send Handoff Recap` is checked on a row.
- Updates owner/recruiting assignments from natural-language Slack commands.
- Maintains sheet-derived reporting in the `Metrics` tab.
- Stores every processed external event in the `Events` tab for traceability.

## Slack UX

Supported through app mentions, channel messages in the allowed AI Leads channel, and the `/near-ai` slash command:

```text
Add Apple as a lead. Jane Doe. jane@apple.com. Interested in RevOps automation.
Create a deal for Venveo.
https://fathom.video/share/...
Update Mantra Health using this Fathom transcript: ...
Move CP Brands to handoff.
Assign Kelvin to Apple.
```

## Required Spreadsheet Tabs

The service expects these tabs:

- `Leads`
- `Deals`
- `Handoff`
- `Metrics`
- `Events`
- `Config`

Run:

```bash
npm run bootstrap:sheet
```

The bootstrap is additive and header-driven. It preserves existing rows where possible and gives the automation stable IDs, event tracking, owner mapping, and dropdown values.

## Health Checks

- `/healthz` confirms the process is alive.
- `/readyz` confirms the process can read the required Google Sheet tabs and headers.
- `/readyz` also reports the extraction mode. For production Fathom URL drops, `extraction.robust` should be `true`.

## Fathom Extraction

The Slack workflow works in two modes:

- `transcript_rules_only`: no `OPENAI_API_KEY` and no `FATHOM_API_KEY`. The service can read public Fathom share-page transcripts, but it cannot use Fathom's official summary data or AI extraction. This mode is useful as a fallback only.
- `fathom_summary_plus_ai`: both `OPENAI_API_KEY` and `FATHOM_API_KEY` are configured. This is the intended production mode for AEs dropping Fathom URLs in `#ai-leads`.

For the no-data-entry AE workflow, configure both keys in the deployed environment:

```text
OPENAI_API_KEY=...
FATHOM_API_KEY=...
```

Fathom direct webhooks should post to:

```text
https://YOUR_HOST/webhooks/fathom?secret=WEBHOOK_SHARED_SECRET
```

If Fathom webhook signing is enabled, set `FATHOM_WEBHOOK_SECRET` instead of using the query-string shared secret. The service verifies `webhook-id`, `webhook-timestamp`, and `webhook-signature` before processing the payload.

When Fathom sends summary, transcript, calendar invitees, and recording start time, the service uses that grounded API/webhook data before falling back to raw transcript parsing.

## Deployment

The app is Docker-ready and can run on Render, Fly.io, Railway, Cloud Run, or any service that can run a Node process.

1. Create a Slack app with bot scopes:
   - `app_mentions:read`
   - `channels:history`
   - `chat:write`
   - `commands`
   - `files:read`
   - `users:read`
2. Add request URL:
   - `https://YOUR_HOST/slack/events`
3. Create slash command:
   - `/near-ai`
   - `https://YOUR_HOST/slack/events`
4. Share the Google Sheet with the Google service account email.
5. Configure environment variables from `.env.example`.
6. Deploy the service.
7. Register webhooks:
   - Smartlead positive replies to `/webhooks/smartlead?secret=...`
   - HubSpot meeting bookings to `/webhooks/hubspot-meeting?secret=...`
   - Chili Piper/Zapier booking payloads to `/webhooks/chili-piper?secret=...`
   - Fathom transcript payloads to `/webhooks/fathom?secret=...`
8. Use the `Metrics` tab for live pipeline reporting from the sheet data.

For Handoff tab recap buttons, keep `ENABLE_HANDOFF_RECAP_POLLING=true`. The service checks the Handoff tab every `HANDOFF_RECAP_POLLING_SECONDS`, posts checked rows to `SLACK_HANDOFF_CHANNEL_ID`, records the Slack link/status/time, and clears the checkbox.

Payload examples are in [docs/WEBHOOKS.md](docs/WEBHOOKS.md).

The production rollout checklist is in [docs/DEPLOYMENT_CHECKLIST.md](docs/DEPLOYMENT_CHECKLIST.md).

## Local Verification

```bash
npm test
```

The unit tests cover the core command parser, key generation, and handoff message generation without requiring external credentials.

Full integration testing requires the Slack app credentials, Google service account JSON, and external integration API keys or webhook setup.

Pre-deploy env check:

```bash
npm run validate:env
```

Post-deploy smoke test:

```bash
node scripts/smoke-deploy.js https://YOUR_HOST
```

Production Fathom extraction smoke test:

```bash
node scripts/smoke-deploy.js https://YOUR_HOST --require-robust-extraction
```
