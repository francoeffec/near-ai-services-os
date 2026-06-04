# Webhooks

All external webhooks must include either:

- `?secret=WEBHOOK_SHARED_SECRET`
- `x-near-ai-secret: WEBHOOK_SHARED_SECRET`

## Smartlead Positive Replies

Endpoint:

```text
POST /webhooks/smartlead
```

The adapter accepts common Smartlead-style shapes and only creates a Lead when the payload category, reply category, status, type, or sentiment contains `positive` or `interested`.

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

## Chili Piper / Booking Webhook

Endpoint:

```text
POST /webhooks/chili-piper
```

Recommended setup: if Chili Piper cannot post directly, use its standard Zapier or webhook bridge and send the booking payload here. The service normalizes `booking`, `event`, `meeting`, `prospect`, `guest`, `invitee`, and `contact` fields.

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
