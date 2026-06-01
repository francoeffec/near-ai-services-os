const assert = require("node:assert/strict");
const test = require("node:test");
const { entityKey, normalizeDomain, stableId } = require("../src/domain/normalize");
const { parseIntent } = require("../src/domain/intent");
const { generateHandoffMessage } = require("../src/domain/handoff");
const { diagnose, syncWeeklyMetrics, weekStart } = require("../src/ops/metrics");
const { OpsService } = require("../src/ops/service");
const { htmlTranscriptToText, parseFathomSharePage, transcriptToText } = require("../src/integrations/fathom");
const { mergePreservingExisting } = require("../src/sheets/repository");
const { handleIntent, inferCompanyFromThread } = require("../src/slack/app");
const { isPositiveReply, normalizeSmartleadReply } = require("../src/integrations/smartlead");
const { normalizeBooking } = require("../src/integrations/booking");
const { normalizeFathomPayload } = require("../src/integrations/fathom");
const { loadConfig, validateConfig } = require("../src/config");
const { shouldRunMetrics } = require("../src/jobs/scheduler");
const { buildValidationRequests } = require("../src/sheets/bootstrap");

test("entityKey uses domain and normalized email", () => {
  assert.equal(entityKey({ companyDomain: "https://www.Apple.com/path", email: " Jane@Apple.com " }), "apple.com|jane@apple.com");
  assert.equal(normalizeDomain("https://www.Near.com/foo"), "near.com");
  assert.match(stableId("deal", "apple.com|jane@apple.com"), /^deal_[a-f0-9]{12}$/);
});

test("parseIntent detects lead creation", () => {
  const intent = parseIntent("Add Apple as a lead. Jane Doe. jane@apple.com. Interested in RevOps automation.");
  assert.equal(intent.type, "add_lead");
  assert.equal(intent.company, "Apple");
  assert.equal(intent.email, "jane@apple.com");
});

test("parseIntent handles lead creation without an article", () => {
  const intent = parseIntent("Add Microsoft as lead");
  assert.equal(intent.type, "add_lead");
  assert.equal(intent.company, "Microsoft");
});

test("parseIntent detects assignments and handoff", () => {
  assert.deepEqual(parseIntent("Assign Kelvin to Apple.").type, "assign_owner");
  assert.equal(parseIntent("Move CP Brands to handoff.").type, "move_to_handoff");
});

test("parseIntent treats raw Fathom links as call updates that can create deals", () => {
  const intent = parseIntent("<https://fathom.video/share/MnszU5JTucMRvozGWkBUgfD7b3C7jCRm>");
  assert.equal(intent.type, "update_deal_from_call");
  assert.equal(intent.fathomUrl, "https://fathom.video/share/MnszU5JTucMRvozGWkBUgfD7b3C7jCRm");
  assert.equal(intent.autoCreateDeal, true);
});

test("handoff message includes recruiting fields", () => {
  const message = generateHandoffMessage({
    Company: "CP Brands",
    "First Name": "Dionelis",
    "Last Name": "Pantoja",
    Email: "dionelisp@example.com",
    Owner: "Kelvin",
    "Engineer Type": "AI Automation Engineer",
    "Skills Needed": "Zapier, APIs",
    "Hours/Week": "20",
    "Start Date": "2026-06-15",
    Pricing: "$4,000/mo",
    "Project Scope": "Automate reporting workflows.",
    "Next Steps": "Send profiles."
  });
  assert.match(message, /AI Services handoff: CP Brands/);
  assert.match(message, /Zapier, APIs/);
});

test("metrics diagnosis catches impossible open and reply counts", () => {
  assert.equal(diagnose({ Sent: 100, Opened: 10, Replied: 12, "Positive Replies": 2 }), "Reply count exceeds opens. Check tracking or imported Smartlead fields.");
  assert.equal(weekStart(new Date("2026-05-29T12:00:00Z")), "2026-05-25");
});

test("createDeal updates existing company row when command lacks email", async () => {
  const upserts = [];
  const repository = {
    async read(sheetName) {
      if (sheetName === "Config") {
        return { headers: [], rows: [{ Type: "owner_alias", Key: "Kevin", Value: "Kevin Dubon", "Slack User ID": "U1" }] };
      }
      return { headers: [], rows: [] };
    },
    async findDealByCompany(company) {
      assert.equal(company, "Venveo");
      return {
        "Deal ID": "deal_existing",
        "Entity Key": "venveo.com|zach@venveo.com",
        Company: "Venveo",
        Email: "zach@venveo.com",
        "Deal Stage": "Call Booked"
      };
    },
    async findDealByKey() {
      return null;
    },
    async upsert(sheetName, keyHeader, keyValue, row) {
      upserts.push({ sheetName, keyHeader, keyValue, row });
      return { row, created: false };
    },
    async addEvent() {}
  };
  const service = new OpsService({ repository, slackClient: null, config: { slack: {} } });
  const result = await service.createDeal({ company: "Venveo", owner: "Kevin" });
  assert.equal(result.row["Entity Key"], "venveo.com|zach@venveo.com");
  assert.equal(result.row.Owner, "Kevin Dubon");
  assert.equal(upserts[0].keyValue, "venveo.com|zach@venveo.com");
  assert.equal(upserts[1].row.Email, "zach@venveo.com");
});

test("fathom transcript arrays become speaker text", () => {
  assert.equal(
    transcriptToText([{ speaker: { display_name: "Alice" }, text: "Need an AI engineer." }]),
    "Alice: Need an AI engineer."
  );
});

test("Fathom share pages expose company metadata and transcript text", () => {
  const dataPage = JSON.stringify({
    props: {
      call: {
        id: 692333461,
        title: "AI Automation //Pisteyo + Near",
        started_at: "2026-05-29T17:00:00.000000Z",
        company: { name: "Pisteyo", domain: "pisteyo.com" }
      },
      copyTranscriptUrl: "https://fathom.video/calls/692333461/copy_transcript?token=abc"
    }
  }).replace(/"/g, "&quot;");
  const metadata = parseFathomSharePage(`<div id="app" data-page="${dataPage}"></div>`, "https://fathom.video/share/abc");
  assert.equal(metadata.recordingId, "692333461");
  assert.equal(metadata.company, "Pisteyo");
  assert.equal(metadata.companyDomain, "pisteyo.com");
  assert.equal(metadata.copyTranscriptUrl, "https://fathom.video/calls/692333461/copy_transcript?token=abc");

  const text = htmlTranscriptToText("<p><a>@0:09</a> - <b>Client</b></p><p>Need n8n and API automation.</p>");
  assert.match(text, /Client/);
  assert.match(text, /Need n8n and API automation/);
});

test("repository merge preserves existing non-empty values on partial updates", () => {
  const merged = mergePreservingExisting(
    { Company: "Venveo", Pricing: "$4,000/mo", Notes: "Keep this" },
    { Company: "Venveo", Pricing: "", Notes: "", Owner: "Kevin" }
  );
  assert.equal(merged.Pricing, "$4,000/mo");
  assert.equal(merged.Notes, "Keep this");
  assert.equal(merged.Owner, "Kevin");

  const cleared = mergePreservingExisting({ Notes: "Remove this" }, { __clear: ["Notes"], Notes: "" });
  assert.equal(cleared.Notes, "");
});

test("createDeal honors existing sheet Deal Stage field", async () => {
  const upserts = [];
  const repository = {
    async read(sheetName) {
      if (sheetName === "Config") return { headers: [], rows: [] };
      return { headers: [], rows: [] };
    },
    async findDealByCompany() {
      return null;
    },
    async findDealByKey() {
      return null;
    },
    async upsert(sheetName, keyHeader, keyValue, row) {
      upserts.push({ sheetName, keyHeader, keyValue, row });
      return { row, created: false };
    },
    async addEvent() {}
  };
  const service = new OpsService({ repository, slackClient: null, config: { slack: {} } });
  await service.createDeal({
    "Entity Key": "cpbrandsgroup.com|dionelisp@cpbrandsgroup.com",
    Company: "CP Brands",
    Email: "dionelisp@cpbrandsgroup.com",
    "Deal Stage": "Input Call",
    handoffStatus: "Posted"
  });
  assert.equal(upserts[0].row["Deal Stage"], "Input Call");
  assert.equal(upserts[0].row["Handoff Status"], "Posted");
});

test("bootstrap validations clear stale text-column dropdowns and reapply by header", () => {
  const requests = buildValidationRequests({
    sheets: [
      { properties: { title: "Leads", sheetId: 1799443453, gridProperties: { rowCount: 1000 } } },
      { properties: { title: "Deals", sheetId: 639364026, gridProperties: { rowCount: 1000 } } },
      { properties: { title: "Handoff", sheetId: 746939414, gridProperties: { rowCount: 1000 } } }
    ]
  });

  const leadsClear = requests.find((request) => request.setDataValidation?.range.sheetId === 1799443453 && !request.setDataValidation.rule);
  assert.equal(leadsClear.setDataValidation.range.startColumnIndex, 0);
  assert.equal(leadsClear.setDataValidation.range.endColumnIndex, 16);

  const leadsSource = requests.find((request) => {
    const update = request.setDataValidation;
    return update?.range.sheetId === 1799443453 && update.range.startColumnIndex === 7;
  });
  assert.equal(leadsSource.setDataValidation.rule.condition.values[0].userEnteredValue, "=Config!$C$13:$C$16");

  const dealsStage = requests.find((request) => {
    const update = request.setDataValidation;
    return update?.range.sheetId === 639364026 && update.range.startColumnIndex === 9;
  });
  assert.equal(dealsStage.setDataValidation.rule.condition.values[0].userEnteredValue, "=Config!$C$5:$C$12");

  const badIdentityDropdown = requests.find((request) => {
    const update = request.setDataValidation;
    return update?.rule && update.range.sheetId === 639364026 && [4, 5, 6].includes(update.range.startColumnIndex);
  });
  assert.equal(badIdentityDropdown, undefined);

  const handoffRecapCheckbox = requests.find((request) => {
    const update = request.setDataValidation;
    return update?.range.sheetId === 746939414 && update.range.startColumnIndex === 4;
  });
  assert.equal(handoffRecapCheckbox.setDataValidation.rule.condition.type, "BOOLEAN");
});

test("updateDealFromCall creates a deal and lead when a Fathom call has no existing deal", async () => {
  const upserts = [];
  const events = [];
  const repository = {
    async read(sheetName) {
      if (sheetName === "Config") return { headers: [], rows: [] };
      return { headers: [], rows: [] };
    },
    async findDealByCompany() {
      return null;
    },
    async findDealByKey() {
      return null;
    },
    async upsert(sheetName, keyHeader, keyValue, row) {
      upserts.push({ sheetName, keyHeader, keyValue, row });
      return { row, created: true };
    },
    async addEvent(event) {
      events.push(event);
    }
  };
  const service = new OpsService({
    repository,
    slackClient: null,
    config: { ai: { apiKey: "" }, fathom: {}, slack: {} }
  });
  const transcript = [
    "Company: Pisteyo",
    "Company domain: pisteyo.com",
    "Contact: Eduardo Suarez",
    "Franco: We can support quick AI automation projects.",
    "Client: We need n8n, Airtable, Supabase, APIs and MCP support.",
    "Franco: Those AI automation engineers are around 70 dolares la hora.",
    "Client: Next step is to send info and schedule a call with my partner.",
    "Extra transcript context ".repeat(40)
  ].join("\n");

  const result = await service.updateDealFromCall({
    fathomUrl: "https://fathom.video/share/abc",
    transcriptText: transcript,
    autoCreateDeal: true,
    sourceEventId: "slack:call-1",
    slackThread: "slack://C1/123"
  });

  assert.equal(result.created, true);
  assert.equal(result.leadResult.created, true);
  assert.equal(result.row.Company, "Pisteyo");
  assert.equal(result.row["Company Domain"], "pisteyo.com");
  assert.equal(result.row.Source, "");
  assert.equal(result.row["Fathom URL"], "https://fathom.video/share/abc");
  assert.match(result.row["Skills Needed"], /n8n/);
  assert.match(result.row.Pricing, /70/);
  assert.equal(upserts[0].sheetName, "Deals");
  assert.equal(upserts[1].sheetName, "Leads");
  assert.equal(upserts[1].row["Lead Stage"], "Call Booked");
  assert.equal(events.at(-1).eventType, "deal_upserted");
});

test("Fathom Slack replies recap deal, lead, and filled fields", async () => {
  const text = await handleIntent({
    intent: { type: "update_deal_from_call", fathomUrl: "https://fathom.video/share/abc" },
    opsService: {
      async updateDealFromCall() {
        return {
          created: false,
          leadResult: { created: true, row: { Company: "Pisteyo" } },
          row: {
            Company: "Pisteyo",
            "Fathom URL": "https://fathom.video/share/abc",
            Pricing: "$70/hr",
            "Skills Needed": "n8n, Airtable",
            "Next Steps": "Send recap"
          }
        };
      }
    }
  });

  assert.equal(
    text,
    "Fathom update for Pisteyo: updated the deal and created the lead. Filled/confirmed: Fathom URL, pricing, skills needed, next steps."
  );
});

test("inferCompanyFromThread finds company in prior Slack context", async () => {
  const client = {
    conversations: {
      async replies() {
        return {
          messages: [
            { text: "Create a deal for Venveo." },
            { text: "Update this deal using the attached Fathom transcript." }
          ]
        };
      }
    }
  };
  const company = await inferCompanyFromThread({ client, channel: "C1", threadTs: "123.45" });
  assert.equal(company, "Venveo");
});

test("moveToHandoff does not repost when handoff already has Slack link", async () => {
  let posts = 0;
  const repository = {
    async read(sheetName) {
      if (sheetName === "Config") return { headers: [], rows: [] };
      return { headers: [], rows: [] };
    },
    async findDealByCompany() {
      return null;
    },
    async findDealByKey() {
      return null;
    },
    async upsert(sheetName, _keyHeader, _keyValue, row) {
      if (sheetName === "Handoff") {
        return { row: { ...row, "Slack Handoff Link": "slack://existing" }, created: false };
      }
      return { row, created: false };
    },
    async addEvent() {}
  };
  const slackClient = {
    chat: {
      async postMessage() {
        posts += 1;
        return { ts: "999.000" };
      }
    }
  };
  const service = new OpsService({
    repository,
    slackClient,
    config: { slack: { handoffChannelId: "C1" } }
  });

  const result = await service.moveToHandoff({
    "Deal ID": "deal_1",
    "Entity Key": "cpbrandsgroup.com|dionelisp@cpbrandsgroup.com",
    Company: "CP Brands",
    Email: "dionelisp@cpbrandsgroup.com",
    "Deal Stage": "Input Call"
  });
  assert.equal(posts, 0);
  assert.equal(result.slackLink, "slack://existing");
});

test("moveToHandoff posts when existing handoff link is only the source thread", async () => {
  let posts = 0;
  const handoffRows = [];
  const repository = {
    async read(sheetName) {
      if (sheetName === "Config") return { headers: [], rows: [] };
      return { headers: [], rows: [] };
    },
    async findDealByCompany() {
      return null;
    },
    async findDealByKey() {
      return null;
    },
    async upsert(sheetName, _keyHeader, _keyValue, row) {
      if (sheetName === "Handoff") {
        handoffRows.push(row);
        if (handoffRows.length === 1) {
          return { row: { ...row, "Slack Handoff Link": "slack://C1/source" }, created: false };
        }
      }
      return { row, created: false };
    },
    async addEvent() {}
  };
  const slackClient = {
    chat: {
      async postMessage({ text }) {
        posts += 1;
        assert.match(text, /AI Services handoff: CP Brands/);
        return { ts: "999.000" };
      }
    }
  };
  const service = new OpsService({
    repository,
    slackClient,
    config: { slack: { handoffChannelId: "C1" } }
  });

  const result = await service.moveToHandoff({
    "Deal ID": "deal_1",
    "Entity Key": "cpbrandsgroup.com|dionelisp@cpbrandsgroup.com",
    Company: "CP Brands",
    Email: "dionelisp@cpbrandsgroup.com",
    "Deal Stage": "Input Call",
    "Slack Thread": "slack://C1/source"
  });
  assert.equal(posts, 1);
  assert.equal(result.slackLink, "slack://C1/999.000");
  assert.equal(handoffRows[0]["Slack Handoff Link"], "");
  assert.equal(handoffRows[1]["Slack Handoff Link"], "slack://C1/999.000");
});

test("processPendingHandoffRecaps posts checked handoff rows and resets action fields", async () => {
  const updates = [];
  const events = [];
  const repository = {
    async read(sheetName) {
      assert.equal(sheetName, "Handoff");
      return {
        headers: [],
        rows: [
          {
            _rowNumber: 2,
            "Handoff ID": "handoff_1",
            Company: "CP Brands",
            "Send Handoff Recap": true,
            "Client/Contact": "Dionelis Pantoja",
            Email: "dionelisp@example.com",
            Owner: "Camila Bagnati",
            "Engineer Type": "AI Automation Engineer",
            "Skills Needed": "Zapier, APIs",
            "Hours/Week": "20",
            "Start Date": "Jun 15, 2026",
            Pricing: "$4,000/mo",
            "Project Description": "Automate reporting workflows.",
            "Candidate/Profile Requirements": "Strong Zapier and API experience.",
            "Next Steps": "Send profiles."
          }
        ]
      };
    },
    async updateRowByNumber(sheetName, rowNumber, row) {
      updates.push({ sheetName, rowNumber, row });
      return { row, created: false };
    },
    async addEvent(event) {
      events.push(event);
    }
  };
  const slackClient = {
    chat: {
      async postMessage({ channel, text }) {
        assert.equal(channel, "C-handoff");
        assert.match(text, /AI Services handoff: CP Brands/);
        assert.match(text, /Candidate\/profile requirements/);
        return { ts: "123.456" };
      }
    }
  };
  const service = new OpsService({
    repository,
    slackClient,
    config: { slack: { handoffChannelId: "C-handoff" } }
  });

  const result = await service.processPendingHandoffRecaps();
  assert.deepEqual(result, [{ ok: true, company: "CP Brands", slackLink: "slack://C-handoff/123.456" }]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].row["Send Handoff Recap"], false);
  assert.equal(updates[0].row["Recap Status"], "Sent");
  assert.equal(updates[0].row["Slack Handoff Link"], "slack://C-handoff/123.456");
  assert.equal(events[0].eventType, "handoff_recap_sent");
});

test("Smartlead positive reply payload normalizes into lead fields", () => {
  const payload = {
    event_id: "reply_1",
    event_type: "positive_reply",
    campaign_id: "camp_1",
    campaign_name: "AI HealthTech",
    lead: {
      id: "lead_1",
      name: "Thomas Bazerghi",
      email: "t.bazerghi@mantrahealth.com",
      company: "Mantra Health"
    },
    reply_text: "Interested. Can we meet Friday?"
  };
  assert.equal(isPositiveReply(payload), true);
  assert.deepEqual(normalizeSmartleadReply(payload), {
    sourceEventId: "reply_1",
    company: "Mantra Health",
    firstName: "Thomas",
    lastName: "Bazerghi",
    email: "t.bazerghi@mantrahealth.com",
    source: "Outreach",
    campaign: "AI HealthTech",
    campaignId: "camp_1",
    smartleadLeadId: "lead_1",
    lastReplyAt: "",
    replySummary: "Interested. Can we meet Friday?",
    notes: "Interested. Can we meet Friday?"
  });
});

test("booking payload normalizes into call-booked deal fields", () => {
  const booking = normalizeBooking({
    event_id: "booking_1",
    source: "Chili Piper",
    booking: {
      id: "booking_1",
      meeting_type: "AI Automation // + Near",
      start_time: "2026-06-01T15:00:00-03:00",
      prospect: {
        name: "Zach Williams",
        email: "zach@venveo.com",
        company: "Venveo"
      }
    }
  });
  assert.equal(booking.company, "Venveo");
  assert.equal(booking.email, "zach@venveo.com");
  assert.equal(booking.stage, "Call Booked");
  assert.equal(booking.callStatus, "Scheduled");
});

test("Fathom payload normalizes transcript and recording identity", () => {
  const payload = normalizeFathomPayload({
    event_id: "fathom_1",
    recording: {
      id: "rec_1",
      url: "https://fathom.video/share/rec_1",
      transcript: [{ speaker: { display_name: "Client" }, text: "Need Zapier and APIs." }]
    },
    company: "CP Brands",
    email: "dionelisp@cpbrandsgroup.com"
  });
  assert.equal(payload.sourceEventId, "fathom_1");
  assert.equal(payload.recordingId, "rec_1");
  assert.equal(payload.transcriptText, "Client: Need Zapier and APIs.");
});

test("weekly metrics preview excludes completed campaigns and preserves week history key", async () => {
  const upserts = [];
  const repository = {
    async read(sheetName) {
      assert.equal(sheetName, "Deals");
      return {
        rows: [
          { Campaign: "AI HealthTech", "Deal Stage": "Call Booked" },
          { Campaign: "AI HealthTech", "Deal Stage": "Input Call" },
          { Campaign: "AI Sales", "Deal Stage": "Call Booked" }
        ]
      };
    },
    async upsert(sheetName, keyHeader, keyValue, row) {
      upserts.push({ sheetName, keyHeader, keyValue, row });
      return { created: true, row };
    }
  };
  const result = await syncWeeklyMetrics({
    config: {
      smartlead: {
        includedCampaignMatch: ["AI"],
        excludedStatuses: ["COMPLETED"]
      }
    },
    repository,
    date: new Date("2026-05-29T12:00:00Z"),
    async fetchCampaigns() {
      return [
        {
          id: "camp_1",
          campaign_name: "AI HealthTech",
          campaign_status: "ACTIVE",
          total_sent: 100,
          total_opened: 25,
          total_replied: 5,
          positive_replies: 2
        },
        {
          id: "camp_2",
          campaign_name: "AI Old Completed",
          campaign_status: "COMPLETED",
          total_sent: 200
        }
      ];
    }
  });
  assert.equal(result.length, 1);
  assert.equal(upserts.length, 0);
  assert.equal(result[0].key, "2026-05-25:camp_1");
  assert.equal(result[0].row["Calls Booked"], 2);
  assert.equal(result[0].row["Input Calls"], 1);
  assert.equal(result[0].row["Open Rate"], "25.0%");
});

test("environment validator reports missing production secrets", () => {
  const config = loadConfig({ strict: false });
  const result = validateConfig({
    ...config,
    google: { spreadsheetId: "sheet", serviceAccountJson: "" },
    slack: { ...config.slack, botToken: "", signingSecret: "", aiLeadsChannelId: "C1" },
    ai: { ...config.ai, apiKey: "" },
    webhookSharedSecret: "",
    adminToken: "",
    smartlead: { ...config.smartlead, apiKey: "" }
  }, { requireIntegrations: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.sort(), [
    "ADMIN_TOKEN",
    "GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SCRIPT_WEB_APP_URL+GOOGLE_SCRIPT_SHARED_SECRET",
    "OPENAI_API_KEY",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "SMARTLEAD_API_KEY",
    "WEBHOOK_SHARED_SECRET"
  ].sort());
});

test("environment validator accepts Apps Script sheet proxy", () => {
  const config = loadConfig({ strict: false });
  const result = validateConfig({
    ...config,
    google: {
      spreadsheetId: "sheet",
      serviceAccountJson: "",
      scriptWebAppUrl: "https://script.google.com/macros/s/example/exec",
      scriptSharedSecret: "secret"
    },
    slack: { ...config.slack, botToken: "xoxb-token", signingSecret: "signing", aiLeadsChannelId: "C1" },
    ai: { ...config.ai, apiKey: "openai" },
    webhookSharedSecret: "webhook",
    adminToken: "admin",
    smartlead: { ...config.smartlead, apiKey: "smartlead" }
  }, { requireIntegrations: true });
  assert.equal(result.ok, true);
});

test("scheduler runs weekly metrics once on configured Monday window", () => {
  const config = {
    scheduler: {
      enabled: true,
      metricsHourUtc: 12,
      metricsMinuteUtc: 0
    }
  };
  assert.equal(shouldRunMetrics(config, new Date("2026-06-01T12:00:00Z"), ""), true);
  assert.equal(shouldRunMetrics(config, new Date("2026-06-01T12:30:00Z"), "2026-06-01"), false);
  assert.equal(shouldRunMetrics(config, new Date("2026-06-02T12:00:00Z"), ""), false);
  assert.equal(shouldRunMetrics({ scheduler: { ...config.scheduler, enabled: false } }, new Date("2026-06-01T12:00:00Z"), ""), false);
});

test("config can read base64 service account JSON", () => {
  const priorJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const priorB64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 = Buffer.from('{"type":"service_account"}').toString("base64");
  try {
    assert.equal(loadConfig({ strict: false }).google.serviceAccountJson, '{"type":"service_account"}');
  } finally {
    if (priorJson === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = priorJson;
    if (priorB64 === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 = priorB64;
  }
});
