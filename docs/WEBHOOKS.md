# Webhooks

All external webhooks must include either:

- `?secret=WEBHOOK_SHARED_SECRET`
- `x-near-ai-secret: WEBHOOK_SHARED_SECRET`

## Smartlead Positive Replies

Endpoint:

```text
POST /webhooks/smartlead
```

The adapter accepts common Smartlead-style shapes and native Smartlead webhook payloads. It creates or updates a Lead when the payload category, reply category, status, type, or sentiment contains `positive` or `interested`.

Recommended setup: configure Smartlead to send category-filtered reply notifications to:

```text
POST /webhooks/smartlead?secret=WEBHOOK_SHARED_SECRET&positive=true
```

Use Smartlead's positive lead categories only. You can fetch those category IDs with Smartlead's `GET /api/v1/leads/fetch-categories` endpoint and include categories whose `sentiment_type` is `positive`, such as `Interested` or `Meeting Booked`.

For Smartlead's webhook create endpoint, use the pattern below. Replace the `category_id_map` keys with your account's positive category IDs:

```json
{
  "name": "NearAI Services Positive Replies",
  "webhook_url": "https://YOUR_HOST/webhooks/smartlead?secret=WEBHOOK_SHARED_SECRET&positive=true",
  "association_type": "campaign",
  "email_campaign_id": 123,
  "event_type_map": {
    "EMAIL_REPLY": true,
    "LEAD_CATEGORY_UPDATED": true
  },
  "category_id_map": {
    "1": true,
    "3": true
  }
}
```

Set `email_campaign_id` per AI Services campaign. The service still filters by `SMARTLEAD_INCLUDED_CAMPAIGN_MATCH`, so non-AI campaigns are ignored even if they send events.

To configure matching campaign webhooks from a deployed shell using the existing environment variables, run:

```bash
node scripts/configure-smartlead-webhooks.js
```

Use `--dry-run` first if you want to preview the positive category IDs and matching campaigns without creating webhooks.

The lead is only written when the campaign matches `SMARTLEAD_INCLUDED_CAMPAIGN_MATCH` and does not match an excluded campaign status. Matches can be campaign-name fragments such as `AI` or exact campaign IDs. Matching positive replies create or update the `Leads` tab with:

- `Source` = `Outreach`
- `Lead Stage` = `Replied Positive`
- Smartlead campaign name in `Campaign`
- Reply text in `Notes`

After the sheet update, the bot posts a short confirmation in `SLACK_AI_LEADS_CHANNEL_ID`.

Example:

```json
{
  "event_id": "smartlead-reply-123",
  "event_type": "positive_reply",
  "campaign_id": "456",
  "campaign_name": "AI HealthTech",
  "lead": {
    "id": "789",
    "first_name": "Thomas",
    "last_name": "Bazerghi",
    "email": "t.bazerghi@mantrahealth.com",
    "company": "Mantra Health"
  },
  "reply_text": "Interested. Can we meet Friday?"
}
```

## HubSpot Meeting Bookings

Endpoint:

```text
POST /webhooks/hubspot-meeting
```

Recommended setup: create a HubSpot workflow that enrolls newly booked AI Services meetings and sends a POST webhook to this endpoint. The webhook can enroll either Meeting records directly or send a custom contact-based payload with meeting fields.

The booking is only written when the meeting title matches `BOOKING_EVENT_TITLE_MATCH`. Matching HubSpot meetings create or update a `Deals` row, update the matching `Leads` row to `Call Booked`, and post a short Slack confirmation in `SLACK_AI_LEADS_CHANNEL_ID`.

Recommended custom request body:

```json
{
  "event_id": "hubspot-meeting-{{ meeting.hs_object_id }}",
  "meeting_title": "{{ meeting.hs_meeting_title }}",
  "start_time": "{{ meeting.hs_meeting_start_time }}",
  "booked_at": "{{ meeting.createdate }}",
  "first_name": "{{ contact.firstname }}",
  "last_name": "{{ contact.lastname }}",
  "email": "{{ contact.email }}",
  "company": "{{ company.name }}",
  "owner_name": "Camila Bagnati"
}
```

Use `owner_name: "Franco Pereyra"` for Franco's booking workflow. If HubSpot cannot provide owner name directly and the workflow is shared, leave `owner_name` blank; the deal will still be created and can be assigned later.

## Chili Piper / Booking Webhook

Endpoint:

```text
POST /webhooks/chili-piper
```

This endpoint remains available as a fallback if anyone books through Chili Piper. The service normalizes `booking`, `event`, `meeting`, `prospect`, `guest`, `invitee`, and `contact` fields.

The booking is only written when the meeting/campaign title matches `BOOKING_EVENT_TITLE_MATCH`. Matching bookings create or update a `Deals` row, update the matching `Leads` row to `Call Booked`, and post a short Slack confirmation in `SLACK_AI_LEADS_CHANNEL_ID`.

For Chili Piper bookings, the sheet `Source` stays as the acquisition source (`Outreach` by default). `Chili Piper` is stored as the event source in the `Events` tab, not as the lead source.

Example:

```json
{
  "event_id": "booking-123",
  "source": "Chili Piper",
  "booking": {
    "id": "booking-123",
    "meeting_type": "AI Automation // + Near",
    "start_time": "2026-06-01T15:00:00-03:00",
    "prospect": {
      "name": "Zach Williams",
      "email": "zach@venveo.com",
      "company": "Venveo"
    }
  }
}
```

## Fathom Transcript

Endpoint:

```text
POST /webhooks/fathom
```

Best setup: configure Fathom to send transcript text or transcript segments. The service can also read public `fathom.video/share/...` URLs by parsing the share page metadata and transcript-copy endpoint. If only a private recording ID is sent, configure `FATHOM_API_KEY`.

Example:

```json
{
  "event_id": "fathom-123",
  "recording": {
    "id": "rec_123",
    "url": "https://fathom.video/share/rec_123",
    "title": "CP Brands AI Services Call"
  },
  "company": "CP Brands",
  "email": "dionelisp@cpbrandsgroup.com",
  "transcript": [
    {
      "speaker": { "display_name": "Client" },
      "text": "We need an AI automation engineer for reporting workflows."
    }
  ]
}
```
