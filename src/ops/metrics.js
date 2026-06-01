const { SHEETS } = require("../schema");
const { campaignIncluded, fetchSmartleadCampaigns } = require("../integrations/smartlead");

function weekStart(date = new Date()) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setUTCDate(copy.getUTCDate() + diff);
  return copy.toISOString().slice(0, 10);
}

function numberFrom(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function rate(numerator, denominator) {
  if (!denominator) return "";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function diagnose(row) {
  const sent = Number(row.Sent || 0);
  const opened = Number(row.Opened || 0);
  const replied = Number(row.Replied || 0);
  const positive = Number(row["Positive Replies"] || 0);
  if (opened > 0 && replied > opened) return "Reply count exceeds opens. Check tracking or imported Smartlead fields.";
  if (sent > 250 && opened / sent < 0.15) return "Low open rate vs volume. Test subject line or deliverability.";
  if (replied > 0 && positive / replied < 0.15) return "Replies are low intent. Review targeting or offer.";
  return "Healthy or needs more data.";
}

async function syncWeeklyMetrics({ config, repository, fetchCampaigns = fetchSmartleadCampaigns, date = new Date() }) {
  const startDate = weekStart(date);
  const endDate = date.toISOString().slice(0, 10);
  const campaigns = await fetchCampaigns(config, { startDate, endDate });
  const included = campaigns.filter((campaign) => campaignIncluded(config, campaign));
  const dealsTable = await repository.read(SHEETS.deals);
  const week = startDate;
  const results = [];

  for (const campaign of included) {
    const campaignName = campaign.name || campaign.campaign_name || campaign.title || "";
    const campaignId = campaign.id || campaign.campaign_id || "";
    const deals = dealsTable.rows.filter((row) => String(row.Campaign || "").toLowerCase() === String(campaignName).toLowerCase());
    const callsBooked = deals.filter((row) => ["Call Booked", "Considering", "Input Call", "Contract Signed"].includes(row["Deal Stage"])).length;
    const inputCalls = deals.filter((row) => row["Deal Stage"] === "Input Call").length;
    const signed = deals.filter((row) => row["Deal Stage"] === "Contract Signed").length;

    const sent = numberFrom(campaign.sent_count, campaign.sent, campaign.emails_sent, campaign.total_sent);
    const opened = numberFrom(campaign.open_count, campaign.opened, campaign.unique_opens, campaign.total_opened, campaign.unique_open_count);
    const replied = numberFrom(campaign.reply_count, campaign.replied, campaign.replies, campaign.total_replied);
    const positive = numberFrom(campaign.positive_reply_count, campaign.positive_replies, campaign.positive_replied, campaign.interested_count);
    const key = `${week}:${campaignId || campaignName}`;
    const row = {
      "Metric ID": key,
      "Week Start": week,
      "Campaign ID": campaignId,
      Campaign: campaignName,
      "Campaign Status": campaign.status || campaign.campaign_status || "",
      Sent: sent,
      Opened: opened,
      Replied: replied,
      "Positive Replies": positive,
      "Calls Booked": callsBooked,
      "Deals Created": deals.length,
      "Input Calls": inputCalls,
      "Contract Signed": signed,
      "Open Rate": rate(opened, sent),
      "Reply Rate": rate(replied, sent),
      "Positive Reply Rate": rate(positive, sent),
      "Booking Rate": rate(callsBooked, sent)
    };
    row.Diagnosis = diagnose(row);
    results.push({ key, campaign: campaignName, row });
  }

  return results;
}

module.exports = { diagnose, syncWeeklyMetrics, weekStart };
