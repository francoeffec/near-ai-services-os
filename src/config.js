function required(name, fallback = undefined) {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalList(name, fallback = "") {
  return String(process.env[name] || fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function serviceAccountJsonFromEnv() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64) return "";
  return Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, "base64").toString("utf8");
}

function loadConfig({ strict = true } = {}) {
  const get = strict ? required : (name, fallback) => process.env[name] || fallback;

  return {
    env: process.env.NODE_ENV || "development",
    port: Number(process.env.PORT || 3000),
    baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    google: {
      spreadsheetId: get("GOOGLE_SPREADSHEET_ID", "1SzVtD8Ql94nGo6hw-FMwnTH_Ur3kIr2zW-d7AqFOrks"),
      serviceAccountJson: serviceAccountJsonFromEnv(),
      scriptWebAppUrl: process.env.GOOGLE_SCRIPT_WEB_APP_URL || "",
      scriptSharedSecret: process.env.GOOGLE_SCRIPT_SHARED_SECRET || ""
    },
    slack: {
      botToken: get("SLACK_BOT_TOKEN", ""),
      signingSecret: get("SLACK_SIGNING_SECRET", ""),
      appToken: process.env.SLACK_APP_TOKEN || "",
      aiLeadsChannelId: get("SLACK_AI_LEADS_CHANNEL_ID", "C0B63R2TC3V"),
      handoffChannelId: process.env.SLACK_HANDOFF_CHANNEL_ID || process.env.SLACK_AI_LEADS_CHANNEL_ID || "C0B63R2TC3V",
      allowedUserIds: optionalList("SLACK_ALLOWED_USER_IDS"),
      allowedChannelIds: optionalList("SLACK_ALLOWED_CHANNEL_IDS", process.env.SLACK_AI_LEADS_CHANNEL_ID || "C0B63R2TC3V")
    },
    ai: {
      apiKey: process.env.OPENAI_API_KEY || "",
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini"
    },
    webhookSharedSecret: get("WEBHOOK_SHARED_SECRET", ""),
    adminToken: get("ADMIN_TOKEN", ""),
    smartlead: {
      apiKey: process.env.SMARTLEAD_API_KEY || "",
      baseUrl: process.env.SMARTLEAD_BASE_URL || "https://server.smartlead.ai/api/v1",
      includedCampaignMatch: optionalList("SMARTLEAD_INCLUDED_CAMPAIGN_MATCH", "AI"),
      excludedStatuses: optionalList("SMARTLEAD_EXCLUDED_STATUSES", "PAUSED,COMPLETED,ARCHIVED"),
      timezone: process.env.SMARTLEAD_TIMEZONE || "America/Argentina/Buenos_Aires"
    },
    fathom: {
      apiKey: process.env.FATHOM_API_KEY || "",
      baseUrl: process.env.FATHOM_BASE_URL || "https://api.fathom.ai/external/v1"
    },
    booking: {
      calendarIds: optionalList("GOOGLE_CALENDAR_IDS"),
      titleMatch: optionalList("BOOKING_EVENT_TITLE_MATCH", "AI Automation,+ Near")
    },
    scheduler: {
      enabled: String(process.env.ENABLE_SCHEDULER || "").toLowerCase() === "true",
      metricsHourUtc: Number(process.env.WEEKLY_METRICS_SYNC_HOUR_UTC || 12),
      metricsMinuteUtc: Number(process.env.WEEKLY_METRICS_SYNC_MINUTE_UTC || 0),
      handoffRecapPollingEnabled: String(process.env.ENABLE_HANDOFF_RECAP_POLLING || "true").toLowerCase() === "true",
      handoffRecapPollingSeconds: Number(process.env.HANDOFF_RECAP_POLLING_SECONDS || 60)
    }
  };
}

function validateConfig(config, { requireIntegrations = false } = {}) {
  const missing = [];
  const googleAuthOk = Boolean(
    config.google.serviceAccountJson ||
    (config.google.scriptWebAppUrl && config.google.scriptSharedSecret)
  );

  const required = [
    ["GOOGLE_SPREADSHEET_ID", config.google.spreadsheetId],
    ["GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SCRIPT_WEB_APP_URL+GOOGLE_SCRIPT_SHARED_SECRET", googleAuthOk],
    ["SLACK_BOT_TOKEN", config.slack.botToken],
    ["SLACK_SIGNING_SECRET", config.slack.signingSecret],
    ["SLACK_AI_LEADS_CHANNEL_ID", config.slack.aiLeadsChannelId],
    ["OPENAI_API_KEY", config.ai.apiKey],
    ["WEBHOOK_SHARED_SECRET", config.webhookSharedSecret],
    ["ADMIN_TOKEN", config.adminToken]
  ];

  if (requireIntegrations) {
    required.push(["SMARTLEAD_API_KEY", config.smartlead.apiKey]);
  }

  for (const [name, value] of required) {
    if (!value) missing.push(name);
  }

  if (config.google.serviceAccountJson) {
    try {
      JSON.parse(config.google.serviceAccountJson);
    } catch (_error) {
      missing.push("GOOGLE_SERVICE_ACCOUNT_JSON(valid JSON)");
    }
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

function extractionStatus(config) {
  const openaiConfigured = Boolean(config.ai?.apiKey);
  const fathomApiConfigured = Boolean(config.fathom?.apiKey);
  const warnings = [];

  if (!openaiConfigured) {
    warnings.push("OPENAI_API_KEY is missing; Fathom call extraction is using deterministic transcript rules only.");
  }
  if (!fathomApiConfigured) {
    warnings.push("FATHOM_API_KEY is missing; dropped share URLs cannot use Fathom's official recording summary endpoint.");
  }

  return {
    openaiConfigured,
    fathomApiConfigured,
    mode: openaiConfigured
      ? (fathomApiConfigured ? "fathom_summary_plus_ai" : "transcript_plus_ai")
      : (fathomApiConfigured ? "fathom_summary_plus_rules" : "transcript_rules_only"),
    robust: openaiConfigured && fathomApiConfigured,
    warnings
  };
}

module.exports = { extractionStatus, loadConfig, validateConfig };
