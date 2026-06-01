const { cleanText, firstNonEmpty, splitName } = require("../domain/normalize");

function isPositiveReply(payload) {
  const fields = [
    payload.category,
    payload.reply_category,
    payload.sentiment,
    payload.status,
    payload.event_type,
    payload.type
  ].map((value) => String(value || "").toLowerCase());
  return fields.some((value) => value.includes("positive") || value.includes("interested"));
}

function normalizeSmartleadReply(payload) {
  const lead = payload.lead || payload.prospect || payload.contact || payload;
  const campaign = payload.campaign || {};
  const fullName = firstNonEmpty(lead.name, lead.full_name, payload.name);
  const split = splitName(fullName);

  return {
    sourceEventId: firstNonEmpty(payload.event_id, payload.id, payload.reply_id, payload.webhook_id),
    company: firstNonEmpty(lead.company, lead.company_name, payload.company, payload.company_name),
    firstName: firstNonEmpty(lead.first_name, payload.first_name, split.firstName),
    lastName: firstNonEmpty(lead.last_name, payload.last_name, split.lastName),
    email: firstNonEmpty(lead.email, payload.email, payload.from_email),
    source: "Outreach",
    campaign: firstNonEmpty(campaign.name, payload.campaign_name, payload.campaign),
    campaignId: firstNonEmpty(campaign.id, payload.campaign_id),
    smartleadLeadId: firstNonEmpty(lead.id, payload.lead_id),
    lastReplyAt: firstNonEmpty(payload.reply_at, payload.created_at, payload.timestamp),
    replySummary: cleanText(firstNonEmpty(payload.message, payload.reply_text, payload.email_body)).slice(0, 1000),
    notes: cleanText(firstNonEmpty(payload.message, payload.reply_text, payload.email_body)).slice(0, 2000)
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

  const performanceById = new Map();
  const performanceByName = new Map();
  for (const stats of performance) {
    const id = String(stats.id || stats.campaign_id || "");
    const name = String(stats.campaign_name || stats.name || "");
    if (id) performanceById.set(id, stats);
    if (name) performanceByName.set(name.toLowerCase(), stats);
  }

  const merged = campaigns.map((campaign) => {
    const id = String(campaign.id || campaign.campaign_id || "");
    const name = String(campaign.name || campaign.campaign_name || "");
    const stats = performanceById.get(id) || performanceByName.get(name.toLowerCase()) || {};
    return { ...campaign, ...stats };
  });

  for (const stats of performance) {
    const id = String(stats.id || stats.campaign_id || "");
    const name = String(stats.campaign_name || stats.name || "");
    if ((id && byId.has(id)) || (name && byName.has(name.toLowerCase()))) continue;
    merged.push(stats);
  }

  return merged;
}

function campaignIncluded(config, campaign) {
  const name = String(campaign.name || campaign.campaign_name || "");
  const status = String(campaign.status || campaign.campaign_status || campaign.status_label || "").toUpperCase();
  const excluded = config.smartlead.excludedStatuses.some((value) => status.includes(value));
  const included = config.smartlead.includedCampaignMatch.length === 0 || config.smartlead.includedCampaignMatch.some((value) => name.toLowerCase().includes(value.toLowerCase()));
  return included && !excluded;
}

module.exports = {
  campaignIncluded,
  fetchSmartleadJson,
  fetchSmartleadCampaigns,
  isPositiveReply,
  normalizeSmartleadReply
};
