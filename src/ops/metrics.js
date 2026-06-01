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
    const normalized = typeof value === "string" ? value.replace(/[,%]/g, "") : value;
    const n = Number(normalized);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function decimalRate(numerator, denominator) {
  if (!denominator) return 0;
  return numerator / denominator;
}

function rate(numerator, denominator) {
  if (!denominator) return "";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function campaignName(campaign = {}) {
  return campaign.name || campaign.campaign_name || campaign.title || "";
}

function campaignId(campaign = {}) {
  return campaign.id || campaign.campaign_id || campaign.uuid || "";
}

function titleCase(value) {
  return String(value || "")
    .trim()
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function campaignStatus(campaign = {}) {
  return titleCase(campaign.status || campaign.campaign_status || campaign.status_label || "");
}

function campaignDeals(dealsTable, campaign) {
  const name = String(campaignName(campaign)).trim().toLowerCase();
  const id = String(campaignId(campaign)).trim().toLowerCase();
  if (!name && !id) return [];
  return dealsTable.rows.filter((row) => {
    const rowCampaign = String(row.Campaign || "").trim().toLowerCase();
    return rowCampaign && (rowCampaign === name || rowCampaign === id);
  });
}

function countCallsBooked(deals) {
  const bookedStages = new Set([
    "call booked",
    "considering",
    "input call",
    "contract signed",
    "lost",
    "future need",
    "cancelled",
    "unqualified"
  ]);
  return deals.filter((row) => {
    if (row["Call Booked On"]) return true;
    return bookedStages.has(String(row["Deal Stage"] || "").trim().toLowerCase());
  }).length;
}

function outreachPerformanceRow(campaign, dealsTable) {
  const name = campaignName(campaign);
  const deals = campaignDeals(dealsTable, campaign);
  const contactsAdded = numberFrom(
    campaign.contacts_added,
    campaign.total_contacts,
    campaign.total_leads,
    campaign.leads_count,
    campaign.lead_count,
    campaign.prospect_count,
    campaign.added_count
  );
  const sent = numberFrom(campaign.sent_count, campaign.sent, campaign.emails_sent, campaign.total_sent);
  const replies = numberFrom(campaign.reply_count, campaign.replied, campaign.replies, campaign.total_replied);
  const positive = numberFrom(
    campaign.positive_reply_count,
    campaign.positive_replies,
    campaign.positive_replied,
    campaign.interested_count,
    campaign.interested_replies
  );
  const callsBooked = countCallsBooked(deals);

  return {
    status: campaignStatus(campaign),
    campaign: name,
    contactsAdded,
    sent,
    replyRate: decimalRate(replies, sent),
    positive,
    callsBooked,
    bookingRate: decimalRate(callsBooked, sent)
  };
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

async function syncEmailOutreachPerformance({ config, repository, sheetsClient, fetchCampaigns = fetchSmartleadCampaigns }) {
  if (!sheetsClient || typeof sheetsClient.updateValues !== "function") {
    throw new Error("sheetsClient.updateValues is required to sync email outreach performance");
  }

  const campaigns = await fetchCampaigns(config, {});
  const included = campaigns
    .filter((campaign) => campaignIncluded(config, campaign))
    .sort((a, b) => String(campaignName(a)).localeCompare(String(campaignName(b))));
  const dealsTable = await repository.read(SHEETS.deals);
  const campaignRows = included.map((campaign) => outreachPerformanceRow(campaign, dealsTable));
  const totals = campaignRows.reduce((sum, row) => ({
    contactsAdded: sum.contactsAdded + row.contactsAdded,
    sent: sum.sent + row.sent,
    positive: sum.positive + row.positive,
    callsBooked: sum.callsBooked + row.callsBooked,
    replies: sum.replies + row.replyRate * row.sent
  }), { contactsAdded: 0, sent: 0, positive: 0, callsBooked: 0, replies: 0 });

  const matrix = [
    ["Email Outreach Performance", "", "", "", "", "", "", ""],
    ["Status", "Campaign ID", "Contacts Added", "Emails Sent", "Reply Rate", "Positive Replies", "Calls Booked", "Booking Rate"],
    [
      "Grand Total",
      "All AI Engineering Services Campaigns",
      totals.contactsAdded,
      totals.sent,
      decimalRate(totals.replies, totals.sent),
      totals.positive,
      totals.callsBooked,
      decimalRate(totals.callsBooked, totals.sent)
    ],
    ...campaignRows.map((row) => [
      row.status,
      row.campaign,
      row.contactsAdded,
      row.sent,
      row.replyRate,
      row.positive,
      row.callsBooked,
      row.bookingRate
    ])
  ];

  while (matrix.length < 151) {
    matrix.push(["", "", "", "", "", "", "", ""]);
  }

  await sheetsClient.updateValues("Metrics", "A50:H200", matrix);
  return {
    campaigns: campaignRows.length,
    totals,
    rows: matrix.slice(0, 3 + campaignRows.length)
  };
}

module.exports = {
  diagnose,
  syncEmailOutreachPerformance,
  syncWeeklyMetrics,
  weekStart
};
