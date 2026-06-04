const { cleanText, firstNonEmpty, splitName } = require("../domain/normalize");

function cleanReplyText(value) {
  return cleanText(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\""));
}

function lastReplyFromHistory(payload) {
  const history = Array.isArray(payload.history) ? payload.history : [];
  return [...history].reverse().find((item) => /reply/i.test(item.type || "")) || {};
}

function replyTextFromPayload(payload) {
  const lastReply = payload.lastReply || payload.last_reply || {};
  const historyReply = lastReplyFromHistory(payload);
  return cleanReplyText(firstNonEmpty(
    payload.preview_text,
    payload.reply_preview,
    payload.reply_body,
    payload.message,
    payload.reply_text,
    payload.email_body,
    payload.body,
    lastReply.preview_text,
    lastReply.email_body,
    lastReply.body,
    historyReply.preview_text,
    historyReply.email_body,
    historyReply.body
  ));
}

function categoryDetails(payload) {
  const leadData = payload.lead_data || {};
  const category = payload.category || leadData.category || payload.lead?.category || {};
  const categoryName = typeof category === "string" ? category : category.name;
  const categorySentiment = typeof category === "object" ? category.sentiment_type : "";
  return {
    name: cleanText(firstNonEmpty(
      categoryName,
      payload.category_name,
      payload.lead_category,
      payload.lead_category_name
    )),
    sentiment: cleanText(firstNonEmpty(categorySentiment, payload.sentiment_type, payload.sentiment))
  };
}

function isNegativeOrAutomatedText(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return false;
  return [
    /\bout\s+of\s+(the\s+)?office\b/,
    /\booo\b/,
    /\bautomatic\s+reply\b/,
    /\bauto(?:matic)?[-\s]?response\b/,
    /\bauto[-\s]?reply\b/,
    /\baway\s+from\s+(the\s+)?office\b/,
    /\bvacation\b/,
    /\bwill\s+(respond|reply)\s+.*\b(return|back)\b/,
    /\bnot\s+interested\b/,
    /\bdo\s+not\s+contact\b/,
    /\bunsubscribe\b/,
    /\bwrong\s+person\b/,
    /\bbounce\b/,
    /\buncategorizable\b/,
    /\bnot[-\s]?positive\b/
  ].some((pattern) => pattern.test(text));
}

function isPositiveCategory(payload) {
  const { name, sentiment } = categoryDetails(payload);
  if (isNegativeOrAutomatedText([name, sentiment].join(" "))) return false;
  if (sentiment.toLowerCase() === "positive") return true;
  return [
    "interested",
    "meeting request",
    "meeting booked",
    "information request",
    "candidate sent - follow up",
    "send to cold call (cv sent)"
  ].includes(name.toLowerCase());
}

function smartleadEventId(payload) {
  return firstNonEmpty(
    payload.event_id,
    payload.id,
    payload.reply_id,
    payload.webhook_id,
    payload.message_id,
    [
      "smartlead",
      payload.event_type || payload.type,
      payload.campaign_id || payload.campaign?.id,
      payload.lead_id || payload.lead_data?.id || payload.lead?.id,
      payload.lead_email || payload.to_email || payload.email || payload.lead_data?.email || payload.lead?.email,
      payload.time_replied || payload.reply_at || payload.lastReply?.time || payload.created_at || payload.timestamp
    ].map(cleanText).filter(Boolean).join(":")
  );
}

function isReplyLike(payload) {
  const eventType = cleanText(payload.event_type || payload.type).toUpperCase();
  return /REPLY|REPLIED|LEAD_CATEGORY_UPDATED/.test(eventType) || Boolean(replyTextFromPayload(payload));
}

function isPositiveReply(payload, options = {}) {
  const replyText = replyTextFromPayload(payload);
  const { name: categoryName, sentiment: categorySentiment } = categoryDetails(payload);
  if (isNegativeOrAutomatedText(replyText) || isNegativeOrAutomatedText(categoryName)) return false;
  if (isPositiveCategory(payload)) return true;
  if (options.assumePositive && !categoryName && isReplyLike(payload)) return false;
  const fields = [
    payload.category,
    categoryName,
    categorySentiment,
    payload.category_name,
    payload.lead_category,
    payload.lead_category_name,
    payload.sentiment_type,
    payload.reply_category,
    payload.sentiment,
    payload.status,
    payload.event_type,
    payload.type
  ].map((value) => String(value || "").toLowerCase());
  return fields.some((value) => {
    if (isNegativeOrAutomatedText(value)) return false;
    return value.includes("positive") || /\binterested\b/.test(value);
  });
}

function normalizeSmartleadReply(payload) {
  const lead = payload.lead || payload.prospect || payload.contact || payload;
  const leadData = payload.lead_data || {};
  const campaign = payload.campaign || {};
  const fullName = firstNonEmpty(lead.name, lead.full_name, payload.name, payload.to_name, payload.lead_name);
  const split = splitName(fullName);
  const replyText = replyTextFromPayload(payload);

  return {
    sourceEventId: smartleadEventId(payload),
    eventSource: "Smartlead",
    company: firstNonEmpty(lead.company, lead.company_name, leadData.company_name, leadData.company, payload.company, payload.company_name),
    firstName: firstNonEmpty(lead.first_name, leadData.first_name, payload.first_name, split.firstName),
    lastName: firstNonEmpty(lead.last_name, leadData.last_name, payload.last_name, split.lastName),
    email: firstNonEmpty(lead.email, leadData.email, payload.email, payload.lead_email, payload.to_email, payload.from_email),
    source: "Outreach",
    campaign: firstNonEmpty(campaign.name, payload.campaign_name, payload.campaign),
    campaignId: firstNonEmpty(campaign.id, payload.campaign_id),
    smartleadLeadId: firstNonEmpty(lead.id, leadData.id, payload.lead_id),
    lastReplyAt: firstNonEmpty(payload.reply_at, payload.time_replied, payload.lastReply?.time, payload.last_reply?.time, lastReplyFromHistory(payload).time, payload.created_at, payload.timestamp),
    replySummary: replyText.slice(0, 1000),
    notes: replyText.slice(0, 2000)
  };
}

async function fetchSmartleadJson(config, path, params = {}) {
  if (!config.smartlead.apiKey) {
    throw new Error("SMARTLEAD_API_KEY is required to fetch campaign metrics");
  }

  const url = new URL(`${config.smartlead.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  url.searchParams.set("api_key", config.smartlead.apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Smartlead request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchSmartleadCampaigns(config, window = {}) {
  const campaignsData = await fetchSmartleadJson(config, "campaigns/");
  const campaigns = Array.isArray(campaignsData) ? campaignsData : campaignsData.data || campaignsData.campaigns || [];

  let performance = [];
  try {
    const statsData = await fetchSmartleadJson(config, "analytics/campaign/overall-stats", {
      start_date: window.startDate,
      end_date: window.endDate,
      timezone: config.smartlead.timezone
    });
    performance = statsData.data?.campaign_wise_performance || statsData.campaign_wise_performance || [];
  } catch (error) {
    console.warn("Smartlead performance endpoint failed; falling back to campaign list fields", error.message);
  }

  const byId = new Map();
  const byName = new Map();
  for (const campaign of campaigns) {
    if (campaign.id || campaign.campaign_id) byId.set(String(campaign.id || campaign.campaign_id), campaign);
    if (campaign.name || campaign.campaign_name) byName.set(String(campaign.name || campaign.campaign_name).toLowerCase(), campaign);
  }

  if (performance.length === 0) return campaigns;

  return performance.map((stats) => {
    const id = String(stats.id || stats.campaign_id || "");
    const name = String(stats.campaign_name || stats.name || "");
    const metadata = byId.get(id) || byName.get(name.toLowerCase()) || {};
    return { ...metadata, ...stats };
  });
}

function campaignIncluded(config, campaign) {
  const name = String(campaign.name || campaign.campaign_name || "");
  const id = String(campaign.id || campaign.campaign_id || "");
  const status = String(campaign.status || campaign.campaign_status || "").toUpperCase();
  const excluded = config.smartlead.excludedStatuses.some((value) => status.includes(value));
  const included = config.smartlead.includedCampaignMatch.length === 0 || config.smartlead.includedCampaignMatch.some((value) => {
    const match = value.toLowerCase();
    return name.toLowerCase().includes(match) || id.toLowerCase() === match;
  });
  return included && !excluded;
}

module.exports = {
  campaignIncluded,
  fetchSmartleadJson,
  fetchSmartleadCampaigns,
  isPositiveReply,
  normalizeSmartleadReply
};
