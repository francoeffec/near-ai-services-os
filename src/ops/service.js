const { SHEETS } = require("../schema");
const { extractCallFields } = require("../ai/extract");
const { generateHandoffMessage } = require("../domain/handoff");
const { fetchFathomRecording } = require("../integrations/fathom");
const { cleanText, domainFromEmail, entityKey, firstNonEmpty, nowIso, sheetDate, sheetDateTime, splitName, stableId } = require("../domain/normalize");

function isLikelyTranscript(text) {
  const value = String(text || "");
  return value.length > 500 || /\bAttached transcript:\b/i.test(value) || /(^|\n)\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s+-\s+/m.test(value);
}

function callExtractionText({ recording = {}, transcriptText = "", fallbackText = "" }) {
  const metadata = [
    recording.title ? `Call title: ${recording.title}` : "",
    recording.company ? `Company: ${recording.company}` : "",
    recording.companyDomain ? `Company domain: ${recording.companyDomain}` : "",
    recording.callDate ? `Call date: ${recording.callDate}` : "",
    recording.summaryText ? `Fathom summary:\n${recording.summaryText}` : ""
  ].filter(Boolean).join("\n");
  return [metadata, transcriptText || fallbackText].filter(Boolean).join("\n\nTranscript:\n");
}

function isChecked(value) {
  if (value === true) return true;
  return ["true", "yes", "y", "send", "1", "x"].includes(cleanText(value).toLowerCase());
}

function slackPermalink(channelId, ts) {
  return ts ? `slack://${channelId}/${ts}` : "";
}

const ACQUISITION_SOURCES = ["Outreach", "Customer", "Referral", "Girdley Media"];
const OWNER_ALIASES = new Map([
  ["fp", "Franco Pereyra"],
  ["franco", "Franco Pereyra"],
  ["cb", "Camila Bagnati"],
  ["camila", "Camila Bagnati"],
  ["cami", "Camila Bagnati"],
  ["cammie", "Camila Bagnati"]
]);

function acquisitionSource(...values) {
  for (const value of values) {
    const cleaned = cleanText(value);
    const match = ACQUISITION_SOURCES.find((source) => source.toLowerCase() === cleaned.toLowerCase());
    if (match) return match;
  }
  return "";
}

function sameCalendarDate(left, right) {
  if (!left || !right) return false;
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  if (Number.isNaN(leftDate.getTime()) || Number.isNaN(rightDate.getTime())) return false;
  return leftDate.toISOString().slice(0, 10) === rightDate.toISOString().slice(0, 10);
}

function sheetDateValue(...values) {
  const raw = firstNonEmpty(...values);
  if (!raw) return "";
  return sheetDate(raw) || raw;
}

class OpsService {
  constructor({ repository, slackClient, config }) {
    this.repository = repository;
    this.slackClient = slackClient;
    this.config = config;
  }

  async canonicalOwner(owner) {
    const requested = cleanText(owner);
    if (!requested) return "";
    const localAlias = OWNER_ALIASES.get(requested.toLowerCase());
    if (localAlias) return localAlias;
    try {
      const configTable = await this.repository.read(SHEETS.config);
      const match = configTable.rows.find((row) => {
        if (row.Type !== "owner_alias") return false;
        const values = [row.Key, row.Value, row["Slack User ID"]];
        const firstName = cleanText(row.Value).split(" ")[0];
        return [...values, firstName]
          .map((value) => cleanText(value).toLowerCase())
          .includes(requested.toLowerCase());
      });
      return match ? match.Value : requested;
    } catch (_error) {
      return requested;
    }
  }

  async addLead(input) {
    const key = entityKey(input);
    if (!key || key === "|") {
      throw new Error("A lead needs at least a company, company domain, or contact email.");
    }
    const owner = await this.canonicalOwner(input.owner || input.Owner);
    const leadStage = input.stage || input.leadStage || input["Lead Stage"] || "Replied Positive";
    const row = {
      "Entity Key": key,
      Company: input.company || input.Company,
      "Company Domain": input.companyDomain || input["Company Domain"] || "",
      "First Name": input.firstName || input["First Name"] || "",
      "Last Name": input.lastName || input["Last Name"] || "",
      Email: input.email || input.Email || "",
      Source: acquisitionSource(input.source, input.Source),
      Campaign: input.campaign || "",
      "Lead Stage": leadStage,
      Owner: owner,
      "Call Booked On": sheetDateValue(input.callBookedOn, input["Call Booked On"], input.bookedAt),
      Notes: firstNonEmpty(input.notes, input.Notes, input.replySummary),
      "Next Step": input.nextStep || ""
    };

    const result = await this.repository.upsert(SHEETS.leads, "Entity Key", key, row, "Lead ID", "lead");
    await this.repository.addEvent({
      eventId: input.sourceEventId || stableId("event", `lead:${key}:${nowIso()}`),
      source: input.source || "Slack",
      eventType: "lead_upserted",
      entityKey: key,
      status: "processed",
      summary: `${result.created ? "Created" : "Updated"} lead ${row.Company || key}`,
      rawPayload: input
    });
    return result;
  }

  async createDeal(input) {
    const company = input.company || input.Company;
    const hasSpecificIdentity = input.email || input.Email || input.companyDomain || input["Company Domain"];
    const existingByCompany = company && !hasSpecificIdentity ? await this.repository.findDealByCompany(company) : null;
    const base = existingByCompany || {};
    const email = input.email || input.Email || base.Email || "";
    const companyDomain = input.companyDomain || input["Company Domain"] || base["Company Domain"] || domainFromEmail(email);
    const key = base["Entity Key"] || input["Entity Key"] || entityKey(input);
    if (!key || key === "|") {
      throw new Error("A deal needs at least a company, company domain, or contact email.");
    }
    const owner = await this.canonicalOwner(input.owner || input.Owner);
    const dealStage = input.stage || input.dealStage || input["Deal Stage"] || base["Deal Stage"] || "Call Booked";
    const row = {
      "Entity Key": key,
      Company: input.company || input.Company || base.Company,
      "Company Domain": companyDomain,
      "First Name": input.firstName || input["First Name"] || base["First Name"] || "",
      "Last Name": input.lastName || input["Last Name"] || base["Last Name"] || "",
      Email: email,
      Source: acquisitionSource(input.source, input.Source, base.Source),
      Campaign: input.campaign || input.Campaign || base.Campaign || "",
      "Deal Stage": dealStage,
      Owner: owner || base.Owner || "",
      "Call Had Date": sheetDateValue(input.callDate, input["Call Had Date"], input["Call Date"], base["Call Had Date"], base["Call Date"]),
      "Call Booked On": sheetDateValue(input.callBookedOn, input["Call Booked On"], input.bookedAt, base["Call Booked On"]),
      "Call Status": input.callStatus || base["Call Status"] || "",
      "Fathom URL": input.fathomUrl || input["Fathom URL"] || base["Fathom URL"] || "",
      Pricing: input.pricing || input.Pricing || base.Pricing || "",
      "Hours/Week": input.hoursPerWeek || input["Hours/Week"] || base["Hours/Week"] || "",
      "Engineer Type": input.engineerType || input["Engineer Type"] || base["Engineer Type"] || "",
      "Skills Needed": input.skillsNeeded || input["Skills Needed"] || base["Skills Needed"] || "",
      "Project Scope": input.projectScope || input["Project Scope"] || base["Project Scope"] || "",
      "Start Date": sheetDateValue(input.startDate, input["Start Date"], base["Start Date"]),
      "Close Date": sheetDateValue(input.closeDate, input["Close Date"], base["Close Date"]),
      "If Lost Reason": input.ifLostReason || input["If Lost Reason"] || base["If Lost Reason"] || "",
      "Next Steps": input.nextSteps || input["Next Steps"] || base["Next Steps"] || "",
      Notes: input.notes || input.Notes || base.Notes || "",
      "Handoff Status": input.handoffStatus || base["Handoff Status"] || "",
      __clear: input.__clear || []
    };

    const result = await this.repository.upsert(SHEETS.deals, "Entity Key", key, row, "Deal ID", "deal");
    const leadResult = await this.addLead({
      ...row,
      company: row.Company,
      companyDomain: row["Company Domain"],
      firstName: row["First Name"],
      lastName: row["Last Name"],
      email: row.Email,
      campaign: row.Campaign,
      owner: row.Owner,
      source: row.Source,
      stage: "Call Booked",
      nextStep: row["Next Steps"],
      sourceEventId: input.sourceEventId ? `${input.sourceEventId}:lead` : ""
    });
    await this.repository.addEvent({
      eventId: input.sourceEventId || stableId("event", `deal:${key}:${nowIso()}`),
      source: input.source || "Slack",
      eventType: "deal_upserted",
      entityKey: key,
      status: "processed",
      summary: `${result.created ? "Created" : "Updated"} deal ${row.Company || key}`,
      rawPayload: input
    });
    return { ...result, leadResult };
  }

  async assignOwner(input) {
    const deal = await this.resolveDeal(input);
    if (!deal) throw new Error(`Could not find deal for ${input.company || input.email || "that company"}`);
    return this.createDeal({ ...deal, owner: input.owner, source: "Slack", sourceEventId: input.sourceEventId || "" });
  }

  async setDealStage(input) {
    const deal = await this.resolveDeal(input);
    if (!deal) throw new Error(`Could not find deal for ${input.company || input.email || "that company"}`);
    const result = await this.createDeal({ ...deal, stage: input.stage, source: input.source || "Slack", sourceEventId: input.sourceEventId || "" });
    if (["Input Call", "Contract Signed"].includes(input.stage)) {
      await this.moveToHandoff({ ...deal, "Deal Stage": input.stage });
    }
    return result;
  }

  async updateDealFromCall(input) {
    const suppliedTranscript = input.transcriptText || "";
    const suppliedSummary = firstNonEmpty(input.summaryText, input.summary, input.defaultSummary, input.default_summary);
    if (!cleanText(suppliedTranscript) && !input.fathomUrl) {
      throw new Error("I need transcript text or a Fathom URL to update the deal.");
    }

    let recording = suppliedSummary ? { summaryText: suppliedSummary } : {};
    if (input.fathomUrl && !isLikelyTranscript(suppliedTranscript)) {
      const fetchedRecording = await fetchFathomRecording(this.config, input.fathomUrl);
      recording = {
        ...recording,
        ...fetchedRecording,
        summaryText: firstNonEmpty(fetchedRecording.summaryText, recording.summaryText)
      };
    }

    const transcriptText = cleanText(recording.transcriptText) ? recording.transcriptText : suppliedTranscript;
    if (input.fathomUrl && !cleanText(transcriptText)) {
      throw new Error("I found the Fathom URL, but could not read the transcript from it. Make sure the share link allows transcript copying.");
    }

    const extracted = await extractCallFields(this.config, callExtractionText({
      recording,
      transcriptText,
      fallbackText: input.rawText || input.fathomUrl
    }));
    const identity = {
      company: firstNonEmpty(input.company, extracted.company, recording.company),
      companyDomain: firstNonEmpty(input.companyDomain, input["Company Domain"], extracted.company_domain, recording.companyDomain),
      email: firstNonEmpty(input.email, input.Email, extracted.contact_email, recording.email)
    };
    const contact = splitName(firstNonEmpty(input.contactName, extracted.contact_name));
    const deal = await this.resolveDeal({ ...input, ...identity });
    if (!deal && !input.autoCreateDeal) {
      throw new Error(`Could not match this call to a deal. Include the company name or contact email.`);
    }
    if (!deal && !identity.company && !identity.companyDomain && !identity.email) {
      throw new Error("I read the call, but could not identify the company or contact. Add the company name with the Fathom URL once and I can create the deal.");
    }

    const base = deal || {};
    const callDate = firstNonEmpty(input.callDate, recording.callDate, base["Call Had Date"], base["Call Date"]);
    const stage = firstNonEmpty(extracted.deal_stage, input.stage, base["Deal Stage"], "Call Booked");
    const clearFields = [];
    if (!cleanText(extracted.start_date) && sameCalendarDate(base["Start Date"], callDate)) {
      clearFields.push("Start Date");
    }
    if (cleanText(base["Handoff Status"]) && !["Input Call", "Contract Signed"].includes(stage)) {
      clearFields.push("Handoff Status");
    }

    const updated = await this.createDeal({
      ...base,
      company: firstNonEmpty(identity.company, base.Company),
      companyDomain: firstNonEmpty(identity.companyDomain, base["Company Domain"]),
      firstName: firstNonEmpty(input.firstName, base["First Name"], contact.firstName),
      lastName: firstNonEmpty(input.lastName, base["Last Name"], contact.lastName),
      email: firstNonEmpty(identity.email, base.Email),
      source: firstNonEmpty(base.Source, input.source),
      stage,
      callDate,
      fathomUrl: firstNonEmpty(input.fathomUrl, recording.url, base["Fathom URL"]),
      pricing: firstNonEmpty(extracted.pricing, base.Pricing),
      hoursPerWeek: firstNonEmpty(extracted.hours_per_week, base["Hours/Week"]),
      engineerType: firstNonEmpty(extracted.engineer_type, base["Engineer Type"]),
      skillsNeeded: firstNonEmpty(extracted.skills_needed, base["Skills Needed"]),
      projectScope: firstNonEmpty(extracted.project_scope, base["Project Scope"]),
      startDate: firstNonEmpty(extracted.start_date, base["Start Date"]),
      ifLostReason: firstNonEmpty(extracted.if_lost_reason, base["If Lost Reason"]),
      nextSteps: firstNonEmpty(extracted.next_steps, base["Next Steps"]),
      notes: firstNonEmpty(extracted.notes, base.Notes),
      slackThread: firstNonEmpty(input.slackThread, base["Slack Thread"]),
      sourceEventId: firstNonEmpty(input.sourceEventId, recording.sourceEventId),
      __clear: clearFields
    });

    if (["Input Call", "Contract Signed"].includes(updated.row["Deal Stage"])) {
      await this.moveToHandoff(updated.row);
    }
    return { ...updated, callSummary: extracted };
  }

  async moveToHandoff(input) {
    const deal = input["Deal ID"] ? input : await this.resolveDeal(input);
    if (!deal) throw new Error(`Could not find deal for ${input.company || input.email || "that company"}`);
    const key = deal["Entity Key"] || entityKey(deal);
    const handoffId = stableId("handoff", key);
    const handoffRow = {
      "Handoff ID": handoffId,
      "Deal ID": deal["Deal ID"],
      "Entity Key": key,
      Company: deal.Company,
      "Send Handoff Recap": false,
      "Recap Status": input["Recap Status"] || "Ready",
      "Recap Sent At": input["Recap Sent At"] || "",
      "Recap Error": "",
      "Client/Contact": [deal["First Name"], deal["Last Name"]].map(cleanText).filter(Boolean).join(" "),
      Email: deal.Email,
      Owner: deal.Owner,
      "Handoff Stage": "Ready",
      "Trigger Stage": deal["Deal Stage"] || "Input Call",
      "Engineer Type": deal["Engineer Type"],
      "Skills Needed": deal["Skills Needed"],
      "Hours/Week": deal["Hours/Week"],
      "Start Date": deal["Start Date"],
      Pricing: deal.Pricing,
      "Project Description": deal["Project Scope"],
      "Candidate/Profile Requirements": "",
      "Call Notes": deal.Notes,
      "Next Steps": deal["Next Steps"],
      "Slack Handoff Link": input["Slack Handoff Link"] || ""
    };

    const result = await this.repository.upsert(SHEETS.handoff, "Handoff ID", handoffId, handoffRow, "Handoff ID", "handoff");
    const message = generateHandoffMessage(deal);
    const sourceThreadLink = cleanText(deal["Slack Thread"]);
    let slackLink = cleanText(result.row["Slack Handoff Link"]);
    const handoffLinkWasSourceThread = slackLink && sourceThreadLink && slackLink === sourceThreadLink;
    if (handoffLinkWasSourceThread) slackLink = "";

    if (!slackLink && this.slackClient && this.config.slack.handoffChannelId) {
      const posted = await this.slackClient.chat.postMessage({
        channel: this.config.slack.handoffChannelId,
        text: message
      });
      slackLink = posted.ts ? `slack://${this.config.slack.handoffChannelId}/${posted.ts}` : "";
      if (slackLink) {
        await this.repository.upsert(SHEETS.handoff, "Handoff ID", handoffId, { ...handoffRow, "Slack Handoff Link": slackLink }, "Handoff ID", "handoff");
      }
    } else if (handoffLinkWasSourceThread) {
      await this.repository.upsert(SHEETS.handoff, "Handoff ID", handoffId, { ...handoffRow, __clear: ["Slack Handoff Link"] }, "Handoff ID", "handoff");
    }

    await this.createDeal({ ...deal, company: deal.Company, email: deal.Email, handoffStatus: slackLink ? "Posted" : "Ready" });
    return { ...result, message, slackLink };
  }

  async updateHandoffRow(row, patch) {
    const next = { ...row, ...patch };
    if (this.repository.updateRowByNumber && row._rowNumber) {
      return this.repository.updateRowByNumber(SHEETS.handoff, row._rowNumber, next);
    }
    const key = next["Handoff ID"] || stableId("handoff", next["Entity Key"] || entityKey(next) || next.Company);
    next["Handoff ID"] = key;
    return this.repository.upsert(SHEETS.handoff, "Handoff ID", key, next, "Handoff ID", "handoff");
  }

  async sendHandoffRecap(handoffRow) {
    if (!this.slackClient || !this.config.slack.handoffChannelId) {
      throw new Error("Slack handoff channel is not configured.");
    }
    const channel = this.config.slack.handoffChannelId;
    const message = generateHandoffMessage(handoffRow);
    const posted = await this.slackClient.chat.postMessage({ channel, text: message });
    const slackLink = slackPermalink(channel, posted.ts);
    const result = await this.updateHandoffRow(handoffRow, {
      "Send Handoff Recap": false,
      "Recap Status": "Sent",
      "Recap Sent At": sheetDateTime(),
      "Recap Error": "",
      "Slack Handoff Link": slackLink || handoffRow["Slack Handoff Link"] || ""
    });
    await this.repository.addEvent?.({
      eventId: stableId("event", `handoff_recap:${handoffRow["Handoff ID"] || handoffRow.Company}:${nowIso()}`),
      source: "Sheets",
      eventType: "handoff_recap_sent",
      entityKey: handoffRow["Entity Key"] || "",
      status: "processed",
      summary: `Sent handoff recap for ${handoffRow.Company || "handoff row"}`,
      rawPayload: { handoffId: handoffRow["Handoff ID"], company: handoffRow.Company, slackLink }
    });
    return { ...result, message, slackLink };
  }

  async processPendingHandoffRecaps({ limit = 20 } = {}) {
    const table = await this.repository.read(SHEETS.handoff);
    const pending = table.rows.filter((row) => isChecked(row["Send Handoff Recap"])).slice(0, limit);
    const results = [];

    for (const row of pending) {
      try {
        const result = await this.sendHandoffRecap(row);
        results.push({ ok: true, company: row.Company, slackLink: result.slackLink });
      } catch (error) {
        await this.updateHandoffRow(row, {
          "Send Handoff Recap": false,
          "Recap Status": "Error",
          "Recap Error": error.message
        });
        await this.repository.addEvent?.({
          eventId: stableId("event", `handoff_recap_error:${row["Handoff ID"] || row.Company}:${nowIso()}`),
          source: "Sheets",
          eventType: "handoff_recap_error",
          entityKey: row["Entity Key"] || "",
          status: "error",
          summary: `Failed to send handoff recap for ${row.Company || "handoff row"}: ${error.message}`,
          rawPayload: { handoffId: row["Handoff ID"], company: row.Company }
        });
        results.push({ ok: false, company: row.Company, error: error.message });
      }
    }

    return results;
  }

  async resolveDeal(input) {
    if (input["Deal ID"]) return input;
    if (input.email || input.Email || input.companyDomain || input.company) {
      const byKey = await this.repository.findDealByKey(input);
      if (byKey) return byKey;
    }
    if (input.company || input.Company) {
      return this.repository.findDealByCompany(input.company || input.Company);
    }
    return null;
  }
}

module.exports = { OpsService };
