#!/usr/bin/env node

const DEFAULT_BASE_URL = "https://server.smartlead.ai/api/v1";
const WEBHOOK_NAME = "NearAI Services Positive Replies";

function list(value, fallback = "") {
  return String(value || fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function smartleadUrl(baseUrl, path, apiKey) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  url.searchParams.set("api_key", apiKey);
  return url;
}

async function smartleadGet(baseUrl, apiKey, path) {
  const response = await fetch(smartleadUrl(baseUrl, path, apiKey));
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
  return response.json();
}

async function smartleadPost(baseUrl, apiKey, path, body) {
  const response = await fetch(smartleadUrl(baseUrl, path, apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${text.slice(0, 240)}`);
  return data;
}

async function smartleadPut(baseUrl, apiKey, path, body) {
  const response = await fetch(smartleadUrl(baseUrl, path, apiKey), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${text.slice(0, 240)}`);
  return data;
}

function campaignId(campaign) {
  return campaign.id || campaign.campaign_id;
}

function campaignName(campaign) {
  return campaign.name || campaign.campaign_name || String(campaignId(campaign) || "");
}

function campaignStatus(campaign) {
  return String(campaign.status || campaign.campaign_status || "").toUpperCase();
}

function webhookIdFromResponse(result) {
  const candidates = [
    result.id,
    result.webhook_id,
    result.data?.id,
    result.data?.webhook_id,
    result.data?.webhook?.id,
    result.webhook?.id
  ];
  for (const value of candidates) {
    if (typeof value === "string" || typeof value === "number") return value;
  }
  return null;
}

function existingWebhookId(webhook) {
  return webhook.id || webhook.webhook_id || webhook.webhook?.id || null;
}

function includedCampaigns(config, campaigns) {
  const included = list(process.env.SMARTLEAD_INCLUDED_CAMPAIGN_MATCH, "AI").map((item) => item.toLowerCase());
  const excluded = list(process.env.SMARTLEAD_EXCLUDED_STATUSES, "PAUSED,COMPLETED,ARCHIVED").map((item) => item.toUpperCase());
  return campaigns.filter((campaign) => {
    const id = String(campaignId(campaign) || "").toLowerCase();
    const name = campaignName(campaign).toLowerCase();
    const status = campaignStatus(campaign);
    const include = included.length === 0 || included.some((match) => name.includes(match) || id === match);
    const exclude = excluded.some((match) => status.includes(match));
    return include && !exclude;
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const apiKey = requireEnv("SMARTLEAD_API_KEY");
  const webhookSecret = requireEnv("WEBHOOK_SHARED_SECRET");
  const baseUrl = process.env.SMARTLEAD_BASE_URL || DEFAULT_BASE_URL;
  const host = (process.env.BASE_URL || "https://near-ai-services-os.onrender.com").replace(/\/$/, "");
  const webhookUrl = `${host}/webhooks/smartlead?secret=${encodeURIComponent(webhookSecret)}&positive=true`;

  const categoriesData = await smartleadGet(baseUrl, apiKey, "leads/fetch-categories");
  const categories = Array.isArray(categoriesData) ? categoriesData : categoriesData.data || [];
  const positiveCategories = categories.filter((category) => {
    const sentiment = String(category.sentiment_type || "").toLowerCase();
    return sentiment === "positive";
  });
  if (positiveCategories.length === 0) throw new Error("No positive Smartlead categories found");
  const categoryIdMap = Object.fromEntries(positiveCategories.map((category) => [String(category.id), true]));

  const campaignsData = await smartleadGet(baseUrl, apiKey, "campaigns/");
  const campaigns = Array.isArray(campaignsData) ? campaignsData : campaignsData.data || campaignsData.campaigns || [];
  const selected = includedCampaigns({}, campaigns);

  console.log(JSON.stringify({
    dryRun,
    positiveCategoryIds: positiveCategories.map((category) => category.id),
    selectedCampaigns: selected.map((campaign) => ({
      id: campaignId(campaign),
      name: campaignName(campaign),
      status: campaign.status || campaign.campaign_status || ""
    }))
  }));

  for (const campaign of selected) {
    const id = Number(campaignId(campaign));
    const name = campaignName(campaign);
    if (!id) {
      console.log(JSON.stringify({ campaign: name, status: "skipped", reason: "missing id" }));
      continue;
    }

    let existing = [];
    try {
      const webhooksData = await smartleadGet(baseUrl, apiKey, `campaigns/${id}/webhooks`);
      existing = Array.isArray(webhooksData) ? webhooksData : webhooksData.data || [];
    } catch {
      existing = [];
    }
    const body = {
      name: WEBHOOK_NAME,
      webhook_url: webhookUrl,
      association_type: "campaign",
      email_campaign_id: id,
      event_type_map: {
        LEAD_CATEGORY_UPDATED: true
      },
      category_id_map: categoryIdMap,
      force_create: false
    };

    const configuredWebhook = existing.find((webhook) => String(webhook.webhook_url || "").includes("/webhooks/smartlead"));
    if (configuredWebhook) {
      const webhookId = existingWebhookId(configuredWebhook);
      if (!webhookId) {
        console.log(JSON.stringify({ campaignId: id, campaign: name, status: "skipped", reason: "existing webhook missing id" }));
        continue;
      }
      if (dryRun) {
        console.log(JSON.stringify({ campaignId: id, campaign: name, status: "would_update", webhookId }));
        continue;
      }
      const result = await smartleadPut(baseUrl, apiKey, `webhook/update/${webhookId}`, body);
      console.log(JSON.stringify({
        campaignId: id,
        campaign: name,
        status: "updated",
        webhookId: webhookIdFromResponse(result) || webhookId,
        ok: result.ok ?? result.success ?? true
      }));
      continue;
    }

    if (dryRun) {
      console.log(JSON.stringify({ campaignId: id, campaign: name, status: "would_create" }));
      continue;
    }

    const result = await smartleadPost(baseUrl, apiKey, "webhook/create", body);
    console.log(JSON.stringify({
      campaignId: id,
      campaign: name,
      status: "created",
      webhookId: webhookIdFromResponse(result),
      ok: result.ok ?? result.success ?? true
    }));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
