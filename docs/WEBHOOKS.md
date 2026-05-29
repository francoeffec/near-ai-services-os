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

Best setup: configure Fathom to send transcript text or transcript segments. If only a recording ID is sent, the service can fetch the transcript when `FATHOM_API_KEY` is configured.

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
