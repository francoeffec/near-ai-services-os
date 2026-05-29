# Near AI Services Operating System

This repository contains the cloud service for Near's AI Services operating system.

The product model is simple:

- Google Sheets is the database.
- Slack is the user interface.
- Smartlead, Chili Piper or booking webhooks, and Fathom are input sources.
- The service is the automation layer that keeps every tab synchronized.

## Why This Architecture

I recommend a small Node service instead of pure Google Apps Script.

The tradeoff is that we need a deployed service and secrets, but the payoff is material: Slack signature verification, webhook protection, idempotent event processing, structured AI extraction, scheduled jobs, better logs, and cleaner integration tests. Apps Script is attractive for speed, but it is weaker for secure Slack events, external webhooks, retries, and production observability.

## What It Does

- Creates and updates leads from Slack or Smartlead positive replies.
- Creates deals from Slack, Chili Piper/Zapier booking payloads, or calendar-style booking payloads.
- Updates deals from Fathom transcript payloads or pasted/attached call notes in Slack.
- Moves deals to handoff and generates a Slack handoff message.
- Updates owner/recruiting assignments from natural-language Slack commands.
- Maintains weekly Smartlead and sheet-derived reporting.
- Stores every processed external event in the `Events` tab for traceability.

## Slack UX

Supported through app mentions, channel messages in the allowed AI Leads channel, and the `/near-ai` slash command:

```text
Add Apple as a lead. Jane Doe. jane@apple.com. Interested in RevOps automation.
Create a deal for Venveo.
Update Mantra Health using this Fathom transcript: ...
Move CP Brands to handoff.
Assign Kelvin to Apple.
```

## Required Spreadsheet Tabs

The service expects these tabs:

- `Funnel`
- `Leads`
- `Deals`
- `Handoff`
- `Weekly Metrics`
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
   - Chili Piper/Zapier booking payloads to `/webhooks/chili-piper?secret=...`
   - Fathom transcript payloads to `/webhooks/fathom?secret=...`
8. Configure a cron job:
   - `POST /jobs/weekly-metrics?token=ADMIN_TOKEN`

You can also set `ENABLE_SCHEDULER=true` for an in-process Monday metrics sync. I still recommend an external cron as the primary production trigger because external cron survives process restarts more predictably.

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
