const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { entityKey, normalizeDomain, sheetDate, stableId } = require("../src/domain/normalize");
const { parseIntent } = require("../src/domain/intent");
const { generateHandoffMessage } = require("../src/domain/handoff");
const { diagnose, syncWeeklyMetrics, weekStart } = require("../src/ops/metrics");
const { OpsService } = require("../src/ops/service");
const { fetchFathomRecording, htmlTranscriptToText, parseFathomSharePage, transcriptToText } = require("../src/integrations/fathom");
const { Repository, firstEmptyRowNumber, mergePreservingExisting } = require("../src/sheets/repository");
const { SheetsClient, ScriptSheetsClient } = require("../src/sheets/client");
const { buildClarifiedIntent, clarificationQuestion, handleIntent, inferCompanyFromThread, isLeadingUserMention } = require("../src/slack/app");
const { campaignIncluded, isPositiveReply, normalizeSmartleadReply } = require("../src/integrations/smartlead");
const { bookingIncluded, normalizeBooking, normalizeHubSpotMeeting } = require("../src/integrations/booking");
const { normalizeFathomPayload } = require("../src/integrations/fathom");
const { extractionStatus, loadConfig, validateConfig } = require("../src/config");
const { shouldRunMetrics } = require("../src/jobs/scheduler");
const { buildValidationRequests } = require("../src/sheets/bootstrap");
const { extractCallFields, normalizeCallFields } = require("../src/ai/extract");
const { verifyFathomWebhookSignature } = require("../src/integrations/fathom-webhook");

test("entityKey uses domain and normalized email", () => {
  assert.equal(entityKey({ companyDomain: "https://www.Apple.com/path", email: " Jane@Apple.com " }), "apple.com|jane@apple.com");
  assert.equal(normalizeDomain("https://www.Near.com/foo"), "near.com");
  assert.match(stableId("deal", "apple.com|jane@apple.com"), /^deal_[a-f0-9]{12}$/);
  assert.equal(sheetDate("May 27, 2026"), "May 27, 2026");
  assert.equal(sheetDate("2026-05-27"), "May 27, 2026");
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

test("parseIntent detects remove lead and deal requests", () => {
  const ambiguous = parseIntent("remove this lead and deal");
  assert.equal(ambiguous.type, "remove_pipeline_records");
  assert.equal(ambiguous.removeLead, true);
  assert.equal(ambiguous.removeDeal, true);
  assert.equal(ambiguous.company, "");

  const explicit = parseIntent("delete the deal for Fit4Travel.");
  assert.equal(explicit.type, "remove_pipeline_records");
  assert.equal(explicit.company, "Fit4Travel");
  assert.equal(explicit.removeLead, false);
  assert.equal(explicit.removeDeal, true);
});

test("parseIntent maps manual lead and deal commands into the right fields", () => {
  const intent = parseIntent([
    "<@U0B6XJ2SWUB|Near AI OS> - add lead and deal to the tracker.",
    "existing customer.",
    "david hachuel.",
    "<mailto:david@kiwibiosciences.com|david@kiwibiosciences.com>.",
    "company is kiwi biosciences.",
    "He's interested in an AI engineer at some point first.",
    "The call was had on May 27.",
    "The next step is for Franco to follow up on June 15.",
    "Account executive owner is Franco.",
    "*Sent using* ChatGPT"
  ].join(" "));

  assert.equal(intent.type, "create_deal");
  assert.equal(intent.company, "Kiwi Biosciences");
  assert.equal(intent.companyDomain, "kiwibiosciences.com");
  assert.equal(intent.firstName, "David");
  assert.equal(intent.lastName, "Hachuel");
  assert.equal(intent.email, "david@kiwibiosciences.com");
  assert.equal(intent.source, "Customer");
  assert.equal(intent.owner, "Franco");
  assert.equal(intent.stage, "Future Need");
  assert.equal(intent.callDate, "May 27, 2026");
  assert.match(intent.nextSteps, /Franco to follow up on June 15/);
  assert.doesNotMatch(intent.notes, /Sent using/i);
});

test("manual lead and deal commands ask for missing next step before writing", async () => {
  let wrote = false;
  const intent = parseIntent("Add lead and deal to the tracker. Customer. Jane Doe. jane@example.com. Company is Example.");

  const text = await handleIntent({
    intent,
    opsService: {
      async createDeal() {
        wrote = true;
      }
    }
  });

  assert.equal(wrote, false);
  assert.equal(clarificationQuestion(intent), "What's the next step?");
  assert.match(text, /What's the next step\?/);
});

test("clarification replies complete the original thread intent", () => {
  const intent = buildClarifiedIntent(
    [
      {
        text: "Add lead and deal to the tracker. Customer. Jane Doe. jane@example.com. Company is Example."
      },
      {
        text: "Before I update the tracker, I need one thing: What's the next step?"
      }
    ],
    "Franco should follow up next Friday."
  );

  assert.equal(intent.type, "create_deal");
  assert.equal(intent.company, "Example");
  assert.equal(intent.email, "jane@example.com");
  assert.equal(intent.nextSteps, "Franco should follow up next Friday");
  assert.doesNotMatch(intent.notes, /\s+\./);
});

test("clarification replies complete remove requests", () => {
  const intent = buildClarifiedIntent(
    [
      { text: "remove this lead and deal" },
      {
        bot_id: "B123",
        text: "Before I update the tracker, I need one thing: Which company should I remove?"
      }
    ],
    "Fit4Travel"
  );

  assert.equal(intent.type, "remove_pipeline_records");
  assert.equal(intent.company, "Fit4Travel");
  assert.equal(intent.removeLead, true);
  assert.equal(intent.removeDeal, true);
});

test("help replies in a failed thread do not replay the prior tracker action", () => {
  const intent = buildClarifiedIntent(
    [
      {
        text: "https://fathom.video/share/DotpASwco4KaWY5xkM_Azm_xhxCUBtNx"
      },
      {
        bot_id: "B123",
        text: "I could not complete that: Sheets proxy returned an HTML error page (Error)."
      }
    ],
    "help"
  );

  assert.equal(intent.type, "help");
});

test("parseIntent maps At Company as a deal phrasing", () => {
  const intent = parseIntent([
    "At HelloFresh, as a deal, the call was had on May 28, 2026 and Laurent said that he would distribute some materials with internal stakeholders.",
    "We sent him a one-pager.",
    "Account executive owner is Gianluca Vendramini.",
    "The deal is considering stage."
  ].join(" "));

  assert.equal(intent.type, "create_deal");
  assert.equal(intent.company, "HelloFresh");
  assert.equal(intent.owner, "Gianluca Vendramini");
  assert.equal(intent.stage, "Considering");
  assert.equal(intent.callDate, "May 28, 2026");
  assert.equal(intent.nextSteps, "Laurent will distribute some materials with internal stakeholders");
});

test("clarification ignores bot error replies and keeps prior user context", () => {
  const intent = buildClarifiedIntent(
    [
      {
        text: "At HelloFresh, as a deal, the call was had on May 28, 2026 and Laurent said that he would distribute some materials with internal stakeholders. We sent him a one-pager. Account executive owner is Gianluca Vendramini. The deal is considering stage."
      },
      {
        bot_id: "B123",
        text: "I could not confidently map that to a pipeline action. Try `help` for examples, or include the company name and desired action."
      },
      {
        text: "add as deal and lead"
      },
      {
        bot_id: "B123",
        text: "Before I update the tracker, I need one thing: Who's the main contact?"
      }
    ],
    "Laurent Guillemein\n!gui@hellofresh.com"
  );

  assert.equal(intent.type, "create_deal");
  assert.equal(intent.company, "HelloFresh");
  assert.equal(intent.companyDomain, "hellofresh.com");
  assert.equal(intent.firstName, "Laurent");
  assert.equal(intent.lastName, "Guillemein");
  assert.equal(intent.email, "gui@hellofresh.com");
  assert.equal(intent.owner, "Gianluca Vendramini");
  assert.equal(intent.stage, "Considering");
  assert.equal(intent.callDate, "May 28, 2026");
  assert.equal(clarificationQuestion(intent), "What's the source? Use Outreach, Customer, Referral, or Girdley Media.");
});

test("clarification replay can finish an already-open manual deal thread", () => {
  const intent = buildClarifiedIntent(
    [
      {
        text: "At HelloFresh, as a deal, the call was had on May 28, 2026 and Laurent said that he would distribute some materials with internal stakeholders. We sent him a one-pager. Account executive owner is Gianluca Vendramini. The deal is considering stage."
      },
      {
        bot_id: "B123",
        text: "I could not confidently map that to a pipeline action. Try `help` for examples, or include the company name and desired action."
      },
      {
        text: "add as deal and lead"
      },
      {
        bot_id: "B123",
        text: "Before I update the tracker, I need one thing: Who's the main contact?"
      },
      {
        text: "Laurent Guillemein\n!gui@hellofresh.com"
      }
    ],
    "Customer"
  );

  assert.equal(intent.type, "create_deal");
  assert.equal(intent.company, "HelloFresh");
  assert.equal(intent.firstName, "Laurent");
  assert.equal(intent.lastName, "Guillemein");
  assert.equal(intent.email, "gui@hellofresh.com");
  assert.equal(intent.source, "Customer");
  assert.equal(intent.stage, "Considering");
  assert.equal(clarificationQuestion(intent), "");
});

test("broad Slack message handler can skip direct bot mentions", () => {
  assert.equal(isLeadingUserMention("<@U0B6XJ2SWUB|Near AI OS> add a deal"), true);
  assert.equal(isLeadingUserMention("Drop this Fathom URL <https://fathom.video/share/abc>"), false);
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

test("manual Slack deal intent writes parsed fields to deal and lead rows", async () => {
  const upserts = [];
  const repository = {
    async read(sheetName) {
      if (sheetName === "Config") {
        return {
          headers: [],
          rows: [
            { Type: "owner_alias", Key: "FP", Value: "Franco Pereyra", "Slack User ID": "U1" }
          ]
        };
      }
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
    async addEvent() {}
  };
  const service = new OpsService({ repository, slackClient: null, config: { slack: {} } });
  const intent = parseIntent([
    "add lead and deal to the tracker.",
    "existing customer.",
    "david hachuel.",
    "david@kiwibiosciences.com.",
    "company is kiwi biosciences.",
    "He's interested in an AI engineer at some point first.",
    "The call was had on May 27.",
    "The next step is for Franco to follow up on June 15.",
    "Account executive owner is Franco."
  ].join(" "));

  await service.createDeal(intent);

  assert.equal(upserts[0].sheetName, "Deals");
  assert.equal(upserts[0].row.Company, "Kiwi Biosciences");
  assert.equal(upserts[0].row["Company Domain"], "kiwibiosciences.com");
  assert.equal(upserts[0].row["First Name"], "David");
  assert.equal(upserts[0].row["Last Name"], "Hachuel");
  assert.equal(upserts[0].row.Source, "Customer");
  assert.equal(upserts[0].row.Owner, "Franco Pereyra");
  assert.equal(upserts[0].row["Deal Stage"], "Future Need");
  assert.equal(upserts[0].row["Call Had Date"], "May 27, 2026");
  assert.match(upserts[0].row["Next Steps"], /Franco to follow up on June 15/);
  assert.equal(upserts[1].sheetName, "Leads");
  assert.match(upserts[1].row["Next Step"], /Franco to follow up on June 15/);
});

test("remove lead and deal clears matching tracker rows", async () => {
  const cleared = [];
  const events = [];
  const repository = {
    async read(sheetName) {
      if (sheetName === "Config") return { headers: [], rows: [] };
      return { headers: [], rows: [] };
    },
    async findDealByKey() {
      return null;
    },
    async findDealByCompany(company) {
      assert.equal(company, "Fit4Travel");
      return {
        _rowNumber: 7,
        "Deal ID": "deal_1",
        "Entity Key": "fit4travel.com|doug@example.com",
        Company: "Fit4Travel",
        Email: "doug@example.com"
      };
    },
    async findLeadByKey(input) {
      assert.equal(input.email, "doug@example.com");
      return {
        _rowNumber: 5,
        "Lead ID": "lead_1",
        "Entity Key": "fit4travel.com|doug@example.com",
        Company: "Fit4Travel",
        Email: "doug@example.com"
      };
    },
    async findLeadByCompany() {
      return null;
    },
    async clearRowByNumber(sheetName, rowNumber) {
      cleared.push({ sheetName, rowNumber });
      return { cleared: true };
    },
    async addEvent(event) {
      events.push(event);
    }
  };
  const service = new OpsService({ repository, slackClient: null, config: { slack: {} } });
  const text = await handleIntent({
    intent: parseIntent("remove the lead and deal for Fit4Travel"),
    opsService: service
  });

  assert.equal(text, "Removed deal and lead for Fit4Travel.");
  assert.deepEqual(cleared, [
    { sheetName: "Deals", rowNumber: 7 },
    { sheetName: "Leads", rowNumber: 5 }
  ]);
  assert.equal(events[0].eventType, "pipeline_removed");
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

test("Fathom share fetch uses API summary when an API key is configured", async () => {
  const originalFetch = global.fetch;
  const sharePage = JSON.stringify({
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
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/share/abc")) {
      return { ok: true, text: async () => `<div id="app" data-page="${sharePage}"></div>` };
    }
    if (String(url).includes("/summary")) {
      return {
        ok: true,
        json: async () => ({
          summary: { markdown_formatted: "- Need Zapier support\n- Next step: send profiles" }
        })
      };
    }
    if (String(url).includes("/transcript")) {
      return {
        ok: true,
        json: async () => ({
          transcript: [{ speaker: { display_name: "Client" }, text: "Need Zapier and APIs." }]
        })
      };
    }
    if (String(url).includes("/copy_transcript")) {
      return {
        ok: true,
        json: async () => ({ html: "<p><b>Client</b></p><p>Need Zapier and APIs.</p>" })
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const recording = await fetchFathomRecording(
      { fathom: { apiKey: "fathom-key", baseUrl: "https://api.fathom.ai/external/v1" } },
      "https://fathom.video/share/abc"
    );
    assert.match(recording.summaryText, /Need Zapier support/);
    assert.match(recording.transcriptText, /Need Zapier and APIs/);
    assert.ok(calls.some((url) => url.includes("/recordings/692333461/summary")));
    assert.ok(calls.some((url) => url.includes("/recordings/692333461/transcript")));
    assert.equal(calls.some((url) => url.includes("/copy_transcript")), false);
  } finally {
    global.fetch = originalFetch;
  }
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

test("repository inserts new rows into first empty sheet row", async () => {
  const updates = [];
  const repository = new Repository({
    async readTable() {
      return {
        headers: ["ID", "Entity Key", "Company", "Created At", "Updated At"],
        rows: [
          { _rowNumber: 2, ID: "id_1", "Entity Key": "a.com|", Company: "A" },
          { _rowNumber: 3, ID: "id_2", "Entity Key": "b.com|", Company: "B" },
          { _rowNumber: 4, ID: "", "Entity Key": "", Company: "", "Created At": "", "Updated At": "" },
          { _rowNumber: 1600, ID: "id_3", "Entity Key": "clinow.com|", Company: "Clinow" }
        ]
      };
    },
    async updateRow(sheetName, headers, rowNumber, row) {
      updates.push({ sheetName, headers, rowNumber, row });
    }
  });

  const result = await repository.upsert("Custom", "Entity Key", "c.com|", { Company: "C" }, "ID", "id");
  assert.equal(result.rowNumber, 4);
  assert.equal(updates[0].rowNumber, 4);
});

test("repository clears rows without deleting sheet structure", async () => {
  const updates = [];
  const repository = new Repository({
    async readTable() {
      return {
        headers: ["ID", "Entity Key", "Company", "Updated At"],
        rows: [
          { _rowNumber: 2, ID: "id_1", "Entity Key": "fit4travel.com|doug@example.com", Company: "Fit4Travel", "Updated At": "Jun 9, 2026" }
        ]
      };
    },
    async updateRow(sheetName, headers, rowNumber, row) {
      updates.push({ sheetName, headers, rowNumber, row });
    }
  });

  const result = await repository.clearRowByNumber("Custom", 2);
  assert.equal(result.cleared, true);
  assert.equal(result.row.Company, "Fit4Travel");
  assert.equal(updates[0].rowNumber, 2);
  assert.deepEqual(updates[0].row, { ID: "", "Entity Key": "", Company: "", "Updated At": "" });
});

test("repository normalizes existing created-at timestamps on update", async () => {
  const updates = [];
  const repository = new Repository({
    async readTable() {
      return {
        headers: ["ID", "Entity Key", "Company", "Created At", "Updated At"],
        rows: [
          {
            _rowNumber: 2,
            ID: "id_1",
            "Entity Key": "pisteyo.com|eduardosuarez@pisteyo.com",
            Company: "Pisteyo",
            "Created At": "2026-06-02T07:00:00.000Z"
          }
        ]
      };
    },
    async updateRow(sheetName, headers, rowNumber, row) {
      updates.push({ sheetName, headers, rowNumber, row });
    }
  });

  const result = await repository.upsert(
    "Custom",
    "Entity Key",
    "pisteyo.com|eduardosuarez@pisteyo.com",
    { Company: "Pisteyo" },
    "ID",
    "id"
  );

  assert.equal(result.created, false);
  assert.equal(result.row["Created At"], "Jun 2, 2026");
  assert.equal(updates[0].rowNumber, 2);
});

test("firstEmptyRowNumber falls back to next row when no blanks exist", () => {
  assert.equal(firstEmptyRowNumber({
    rows: [
      { _rowNumber: 2, Company: "A" },
      { _rowNumber: 3, Company: "B" }
    ]
  }, ["Company"]), 4);
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

test("bootstrap validations follow live header order when columns move", () => {
  const requests = buildValidationRequests({
    sheets: [
      { properties: { title: "Deals", sheetId: 639364026, gridProperties: { rowCount: 1000 } } }
    ]
  }, {
    Deals: [
      "Deal ID",
      "Entity Key",
      "Company",
      "Company Domain",
      "First Name",
      "Last Name",
      "Email",
      "Source",
      "Campaign",
      "Deal Stage",
      "Next Steps",
      "Owner",
      "Call Had Date"
    ]
  });

  const ownerDropdown = requests.find((request) => {
    const update = request.setDataValidation;
    return update?.rule && update.range.sheetId === 639364026 && update.range.startColumnIndex === 11;
  });
  assert.equal(ownerDropdown.setDataValidation.rule.condition.values[0].userEnteredValue, "=Config!$C$17:$C$25");

  const nextStepsDropdown = requests.find((request) => {
    const update = request.setDataValidation;
    return update?.rule && update.range.sheetId === 639364026 && update.range.startColumnIndex === 10;
  });
  assert.equal(nextStepsDropdown, undefined);
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
    "Client: How would you build this and what tools would the engineer use?",
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
  assert.match(result.row.Notes, /Need:/);
  assert.match(result.row.Notes, /Pain points:/);
  assert.match(result.row.Notes, /Key questions asked:/);
  assert.match(result.row.Notes, /Pricing:/);
  assert.match(result.row.Notes, /Scope of project:/);
  assert.match(result.row.Notes, /Skills needed:/);
  assert.match(result.row.Notes, /Next steps:/);
  assert.ok(result.row.Notes.length < 1400);
  assert.doesNotMatch(result.row.Notes, /Extra transcript context Extra transcript context/);
  assert.equal(upserts[0].sheetName, "Deals");
  assert.equal(upserts[1].sheetName, "Leads");
  assert.equal(upserts[1].row["Lead Stage"], "Call Booked");
  assert.equal(events.at(-1).eventType, "deal_upserted");
});

test("updateDealFromCall clears stale call-date start dates when no start date was discussed", async () => {
  const existingDeal = {
    "Deal ID": "deal_clinow",
    "Entity Key": "clinow.com|",
    Company: "Clinow",
    "Company Domain": "clinow.com",
    "Deal Stage": "Considering",
    "Call Had Date": "2026-06-01T20:30:00.000Z",
    "Start Date": "2026-06-01T07:00:00.000Z",
    "Handoff Status": "Posted"
  };
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
      return existingDeal;
    },
    async upsert(sheetName, keyHeader, keyValue, row) {
      const existing = sheetName === "Deals" ? existingDeal : {};
      const merged = mergePreservingExisting(existing, row);
      upserts.push({ sheetName, keyHeader, keyValue, row, merged });
      return { row: merged, created: false };
    },
    async addEvent() {}
  };
  const service = new OpsService({
    repository,
    slackClient: null,
    config: { ai: { apiKey: "" }, fathom: {}, slack: {} }
  });

  const result = await service.updateDealFromCall({
    fathomUrl: "https://fathom.video/share/clinow",
    transcriptText: [
      "Call title: AI Automation // Clinow + Near",
      "Company: Clinow",
      "Company domain: clinow.com",
      "Call date: 2026-06-01T20:30:00.000Z",
      "Chad: What is the all-in hourly cost?",
      "Camila: It is seventy dollars per hour all in.",
      "Chad: I need to review the information and decide if an engineer input call makes sense.",
      "Extra transcript context ".repeat(40)
    ].join("\n"),
    autoCreateDeal: true
  });

  assert.equal(result.row["Start Date"], "");
  assert.equal(result.row["Handoff Status"], "");
  assert.equal(result.row["Call Had Date"], "Jun 1, 2026");
  assert.deepEqual(upserts.find((upsert) => upsert.sheetName === "Deals").row.__clear, ["Start Date", "Handoff Status"]);
});

test("updateDealFromCall uses supplied Fathom summary before raw transcript", async () => {
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
      return { row, created: true };
    },
    async addEvent() {}
  };
  const service = new OpsService({
    repository,
    slackClient: null,
    config: { ai: { apiKey: "" }, fathom: {}, slack: {} }
  });

  const result = await service.updateDealFromCall({
    company: "Clinow",
    companyDomain: "clinow.com",
    firstName: "Chad",
    callDate: "2026-06-01T20:30:00.000Z",
    summaryText: [
      "Fathom summary:",
      "Exploring fractional AI engineering support and how the model works.",
      "Local hiring in Fort Wayne is taking longer than expected.",
      "Near will send information on the different models, example profiles, and a calendar link.",
      "$70/hr all-in for fractional AI engineering."
    ].join("\n"),
    transcriptText: [
      "Client: Thanks for the call.",
      "Camila: Great, I will follow up.",
      "Extra transcript context ".repeat(40)
    ].join("\n"),
    autoCreateDeal: true
  });

  assert.equal(result.row["Call Had Date"], "Jun 1, 2026");
  assert.match(result.row.Notes, /Exploring fractional AI engineering support/);
  assert.match(result.row.Notes, /Local hiring in Fort Wayne/);
  assert.match(result.row.Notes, /Near to send information/);
  assert.doesNotMatch(result.row.Notes, /Extra transcript context Extra transcript context/);
  assert.equal(upserts[0].sheetName, "Deals");
  assert.equal(upserts[1].sheetName, "Leads");
});

test("call extraction turns Clinow-style transcript into sales-ready fields", async () => {
  const transcript = [
    "Call title: AI Automation // Clinow + Near",
    "Company: clinow.com",
    "Company domain: clinow.com",
    "Call date: 2026-06-01T20:30:00.000000Z",
    "Transcript:",
    "AI Automation // Clinow + Near - June 01",
    "VIEW RECORDING - 13 mins (No highlights)",
    "@0:46 - chad",
    "I got an email talking about AI and a fractional person. I wanted to see what you had to offer and how that works.",
    "@1:44 - chad",
    "Do you do all kinds of different employee, from accounting, admin, IT, all of it?",
    "@4:50 - chad",
    "So you can do it either way, full-time or part-time?",
    "@4:55 - chad",
    "What kind of talent do you have within AI, familiar with workflows and the latest AI tools?",
    "@5:44 - chad",
    "If we wanted to create something, we'd map out what we want and go back to Claude or n8n, and figure out how to roll it out through a web app where employees could use it.",
    "@6:17 - chad",
    "We are trying to hire some people in Fort Wayne. It's taking longer than I thought. What do we do, how do we get started?",
    "@6:43 - Camila Bagnati (Near)",
    "The goal is to have an input call with an engineer to discuss the specific project further. You can commit with as little as 10 hours. The engineer will structure the project and suggest hours.",
    "@6:58 - chad",
    "The all-in cost?",
    "@7:00 - Camila Bagnati (Near)",
    "It's $70 the hour, all in. Most partners start with 20, 40 hours and scale from there.",
    "@8:08 - chad",
    "Do you hire full-time also?",
    "@9:32 - chad",
    "How much is it if you hire full-time employees? Just a ballpark range.",
    "@9:48 - Camila Bagnati (Near)",
    "Their compensation typically tends to be between $80,000 and $120,000 annual.",
    "@11:06 - chad",
    "We're trying to figure out how to use AI in the best way we can.",
    "@11:22 - Camila Bagnati (Near)",
    "I can send information on the different models, send profiles for review, and send my calendar link.",
    "@12:53 - chad",
    "Let me look at some more information and I'll decide."
  ].join("\n");

  const fields = await extractCallFields({ ai: { apiKey: "" } }, transcript);

  assert.equal(fields.company, "Clinow");
  assert.equal(fields.company_domain, "clinow.com");
  assert.equal(fields.contact_name, "Chad");
  assert.equal(fields.deal_stage, "Considering");
  assert.match(fields.Pricing || fields.pricing, /\$70\/hr/);
  assert.match(fields.pricing, /\$80k-\$120k\/year/);
  assert.match(fields.key_questions, /What is the all-in hourly cost/);
  assert.match(fields.key_questions, /full-time AI engineer compensation/);
  assert.match(fields.next_steps, /Prospect to review/);
  assert.match(fields.project_scope, /engineer input call/);
  assert.doesNotMatch(fields.notes, /VIEW RECORDING|@0:|Call title:|Nice to meet you|They would suggest/i);
  assert.doesNotMatch(fields.notes, /Contract Signed/);
  assert.ok(fields.notes.length < 1800);
});

test("call extraction handles Spanish agency-style AI services calls", async () => {
  const transcript = [
    "Call title: AI Automation //Pisteyo + Near",
    "Company: Pisteyo",
    "Company domain: pisteyo.com",
    "@0:00 - Franco Pereyra (Near)",
    "Contame que estan buscando.",
    "@0:20 - eduardosuarez",
    "Somos una consultora americana que hace estrategia y build. No nos alcanzan las manos para hacer desarrollo y necesitamos para Colombia y Latinoamerica.",
    "@1:00 - Camila Bagnati",
    "Que tipo de desarrolladores contratan?",
    "@1:10 - eduardosuarez",
    "Gente que sepa Python, automatizaciones, n8n, Make, Zapier, Airtable, Supabase, APIs, MCP, Copilot Agents, Custom GPTs y Prompt Engineering.",
    "@2:00 - eduardosuarez",
    "No ha sido facil conseguir gente buena. Muchos dicen saber AI pero cuando entramos a proyectos son autodidactas y algunos son costosos.",
    "@3:00 - eduardosuarez",
    "Pero son empleados de ustedes o tienen un pool de freelance? Como funciona?",
    "@4:00 - eduardosuarez",
    "Tenemos clientes que nos dicen necesito resolver esto con AI. Grabamos el proceso, vamos a un ingeniero y nos da propuesta de tiempos y costos.",
    "@5:00 - Franco Pereyra (Near)",
    "Podemos sumarnos en Discovery, diagramar la solucion o implementar.",
    "@6:00 - eduardosuarez",
    "Tengo hoy un par de proyectos que necesito sacar costos y pasar propuestas. Como funciona esa parte? Tenemos tres discoveries grandes para levantar entre 10 y 15 casos de uso por compania.",
    "@7:00 - eduardosuarez",
    "Nos gustan quick wins, pruebas de concepto faciles, poner Supabase, Airtable y n8n. Quiero mostrarle esto a mi socio de operaciones y produccion.",
    "@8:00 - Camila Bagnati",
    "Te enviamos todo y me contacto por WhatsApp para coordinar esa llamada siguiente con tu partner la semana que viene."
  ].join("\n");

  const fields = await extractCallFields({ ai: { apiKey: "" } }, transcript);

  assert.equal(fields.company, "Pisteyo");
  assert.equal(fields.company_domain, "pisteyo.com");
  assert.equal(fields.contact_name, "Eduardo Suarez");
  assert.equal(fields.deal_stage, "Considering");
  assert.match(fields.need, /flexible AI automation\/development capacity/);
  assert.match(fields.need, /estimating and scoping/);
  assert.match(fields.pain_points, /capacity is constrained/);
  assert.match(fields.pain_points, /expensive/);
  assert.match(fields.key_questions, /Near employees or freelancers/);
  assert.match(fields.key_questions, /next step be if Pisteyo/);
  assert.match(fields.skills_needed, /n8n/);
  assert.match(fields.skills_needed, /Zapier/);
  assert.match(fields.skills_needed, /Supabase/);
  assert.match(fields.project_scope, /discovery, solution design, cost estimates/);
  assert.match(fields.project_scope, /quick AI automation proofs of concept/);
  assert.match(fields.next_steps, /share Near's information/);
  assert.match(fields.next_steps, /WhatsApp or calendar/);
  assert.doesNotMatch(fields.notes, /@\d{1,2}:\d{2}|Transcript:|VIEW RECORDING|Franco Pereyra|Camila Bagnati/);
  assert.ok(fields.notes.length < 1800);
});

test("call extraction does not leak Pisteyo into other company summaries", async () => {
  const transcript = [
    "Call title: AI Automation // BCE South + Near",
    "Company: BCE South",
    "Company domain: bcesouth.com",
    "@0:00 - Bob Selvi",
    "We do discovery and roadmap work and want help estimating and scoping AI projects.",
    "@1:00 - Bob Selvi",
    "Do you support roles beyond AI, such as accounting, admin, IT, and operations?",
    "@2:00 - Bob Selvi",
    "Is that achievable? Is everybody doing what they're supposed to do?",
    "@3:00 - Camila Bagnati (Near)",
    "The next step is usually an engineer input call to define the workflow and estimate hours.",
    "@4:00 - Camila Bagnati (Near)",
    "It's $70 per hour all-in for fractional AI engineering."
  ].join("\n");

  const fields = await extractCallFields({ ai: { apiKey: "" } }, transcript);

  assert.equal(fields.company, "BCE South");
  assert.match(fields.project_scope, /Support BCE South across discovery/);
  assert.doesNotMatch(fields.project_scope, /Pisteyo/);
  assert.doesNotMatch(fields.notes, /Pisteyo/);
  assert.doesNotMatch(fields.key_questions, /roles beyond AI|everybody doing/i);
});

test("call extraction drops small talk from key questions", async () => {
  const transcript = [
    "Call title: AI Automation // Fit4Travel + Near",
    "Company: Fit4Travel",
    "Company domain: fit4travel.com",
    "@0:00 - Doug",
    "Do you support roles beyond AI, such as accounting, admin, IT, and operations?",
    "@0:20 - Doug",
    "How have you been though?",
    "@0:30 - Doug",
    "You'll have the World Cup to warm you up, you know?",
    "@1:00 - Doug",
    "How would an AI workflow be mapped, built, and rolled out to employees?",
    "@1:30 - Doug",
    "What is the all-in cost for a fractional AI engineer?",
    "@2:00 - Camila Bagnati (Near)",
    "We usually run an engineer input call and pricing is $70 per hour all-in."
  ].join("\n");

  const fields = await extractCallFields({ ai: { apiKey: "" } }, transcript);

  assert.equal(fields.company, "Fit4Travel");
  assert.match(fields.key_questions, /AI workflow.*mapped, built, and rolled out/i);
  assert.match(fields.key_questions, /all-in.*cost/i);
  assert.doesNotMatch(fields.key_questions, /World Cup|How have you been|roles beyond AI|accounting|admin|operations/i);
  assert.doesNotMatch(fields.notes, /World Cup|How have you been|roles beyond AI|accounting|admin|operations/i);
});

test("call extraction grounds Fit4Travel recap in the deal discussion", async () => {
  const transcript = [
    "Call title: AI Automation // Fit4Travel + Near",
    "Company: Fit4Travel",
    "0:28 - Doug",
    "How have you been though?",
    "0:39 - Doug",
    "You'll have the World Cup to warm you up, you know?",
    "3:40 - Doug",
    "The projects I was thinking about include recreating our new website and a website migration.",
    "4:35 - Doug",
    "Our head of marketing thinks this might be over his head and he does not have that much experience in it.",
    "4:59 - Doug",
    "We also thought about a web app operating system for people who run international wellness retreats and an online course built with Claude Code.",
    "7:24 - Camila Bagnati (Near)",
    "A good next step would be having one of our engineers scope them and suggest an amount of hours.",
    "8:44 - Doug",
    "The website right now and website migration is the most time-sensitive. Everything is already in GitHub and I have a doc from marketing with the full scope.",
    "9:44 - Doug",
    "How does the process work? Do you just place someone with us?",
    "12:08 - Doug",
    "Could we have an AI engineer oversee internal projects and work in tandem with the Oswaldo replacement who works 40 hours a week?",
    "15:15 - Doug",
    "I want to move quickly. I'll send you the doc later today.",
    "19:59 - Doug",
    "You'll send me the profile for the AI engineer and we can have the meeting later this week."
  ].join("\n");

  const fields = await extractCallFields({ ai: { apiKey: "" } }, transcript);

  assert.equal(fields.company, "Fit4Travel");
  assert.equal(fields.deal_stage, "Considering");
  assert.equal(fields.hours_per_week, "");
  assert.match(fields.need, /website rebuild\/migration/);
  assert.match(fields.project_scope, /GitHub work and marketing team's scope doc/);
  assert.match(fields.next_steps, /send the website scope doc/);
  assert.match(fields.next_steps, /engineer profile/);
  assert.doesNotMatch(fields.notes, /World Cup|How have you been|40 hours|Lost/i);
  assert.doesNotMatch(fields.notes, /mapped, built, and rolled out to employees/i);
});

test("normalization rejects transcript-like and unsafe AI fields", () => {
  const normalized = normalizeCallFields(
    {
      deal_stage: "Contract Signed",
      need: "Run an engineer input call to define one priority workflow or bottleneck and estimate hours.",
      pain_points: "Not captured.",
      key_questions: "Not captured.",
      project_scope: "Call title: AI Automation // Clinow + Near\nTranscript:\n@0:00 - Camila Bagnati (Near)\nNice to meet you.",
      next_steps: "They would suggest how to build it. They would suggest an amount of hours.",
      start_date: "2026-06-01T07:00:00.000Z",
      notes: "Transcript dump"
    },
    {
      deal_stage: "Considering",
      need: "Exploring fractional AI engineering support and how the model works.",
      pain_points: "Local hiring in Fort Wayne is taking longer than expected.",
      key_questions: "What is the all-in hourly cost?",
      project_scope: "Run an engineer input call to define one priority workflow.",
      next_steps: "Near to send information. Prospect to review and decide whether to schedule an engineer input call.",
      pricing: "$70/hr all-in"
    }
  );

  assert.equal(normalized.deal_stage, "Considering");
  assert.match(normalized.need, /Exploring fractional/);
  assert.match(normalized.pain_points, /Local hiring/);
  assert.match(normalized.key_questions, /all-in hourly cost/);
  assert.match(normalized.project_scope, /engineer input call/);
  assert.match(normalized.next_steps, /Prospect to review/);
  assert.equal(normalized.start_date, "");
  assert.doesNotMatch(normalized.notes, /Transcript dump|Nice to meet you|They would suggest/i);
});

test("normalization rejects vague AI next steps in favor of concrete fallback actions", () => {
  const normalized = normalizeCallFields(
    {
      deal_stage: "Considering",
      next_steps: "Continue the conversation and touch base.",
      need: "Exploring fractional AI engineering support."
    },
    {
      deal_stage: "Considering",
      next_steps: "Near to send information on fractional and full-time options. Prospect to review and decide whether to schedule an engineer input call.",
      need: "Exploring fractional AI engineering support and how the model works."
    }
  );

  assert.match(normalized.next_steps, /Near to send information/);
  assert.match(normalized.next_steps, /Prospect to review/);
  assert.doesNotMatch(normalized.next_steps, /touch base|Continue the conversation/i);
});

test("normalization filters non-deal key questions from AI output", () => {
  const normalized = normalizeCallFields(
    {
      deal_stage: "Considering",
      key_questions: [
        "Do you support roles beyond AI, such as accounting, admin, IT, and operations?",
        "How have you been though?",
        "You'll have the World Cup to warm you up, you know?",
        "How would an AI workflow be mapped, built, and rolled out to employees?"
      ].join("\n")
    },
    {
      deal_stage: "Considering",
      key_questions: "What is the all-in hourly cost?"
    }
  );

  assert.match(normalized.key_questions, /AI workflow/);
  assert.doesNotMatch(normalized.key_questions, /World Cup|How have you been|roles beyond AI|accounting|admin|operations/i);
  assert.doesNotMatch(normalized.notes, /World Cup|How have you been|roles beyond AI|accounting|admin|operations/i);
});

test("Fathom Slack replies use extracted summary over row fallbacks", async () => {
  const text = await handleIntent({
    intent: { type: "update_deal_from_call", fathomUrl: "https://fathom.video/share/clinow" },
    opsService: {
      async updateDealFromCall() {
        return {
          created: false,
          leadResult: { created: false, row: { Company: "Clinow" } },
          row: {
            Company: "Clinow",
            "Project Scope": "Run an engineer input call to define one priority workflow or bottleneck and estimate hours.",
            "Fathom URL": "https://fathom.video/share/clinow",
            Pricing: "$70/hr"
          },
          callSummary: {
            need: "Exploring fractional AI engineering support and how the model works.",
            pain_points: "Local hiring in Fort Wayne is taking longer than expected.",
            key_questions: "What is the all-in hourly cost?",
            pricing: "$70/hr all-in",
            project_scope: "Run an engineer input call to define one priority workflow.",
            skills_needed: "Claude, Python, AI agents",
            next_steps: "Prospect to review the information and decide whether to schedule an engineer input call."
          }
        };
      }
    }
  });

  assert.match(text, /\*Need\*\n- Exploring fractional AI engineering support/);
  assert.match(text, /\*Pain points\*\n- Local hiring in Fort Wayne/);
  assert.match(text, /\*Key questions asked\*\n- What is the all-in hourly cost/);
  assert.match(text, /\*Next steps\*\n- Prospect to review the information/);
  assert.doesNotMatch(text, /\*Pain points\*\n- Not captured/);
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
            Notes: [
              "Need:",
              "- Automate customer-facing workflows.",
              "",
              "Pain points:",
              "- Current process is manual.",
              "",
              "Key questions asked:",
              "- How would you build this?",
              "",
              "Pricing:",
              "- $70/hr",
              "",
              "Scope of project:",
              "- Build n8n and Airtable automations.",
              "",
              "Skills needed:",
              "- n8n, Airtable",
              "",
              "Next steps:",
              "- Send recap"
            ].join("\n"),
            "Next Steps": "Send recap"
          }
        };
      }
    }
  });

  assert.match(text, /Fathom update for Pisteyo: updated the deal and created the lead/);
  assert.match(text, /\*Need\*\n- Automate customer-facing workflows/);
  assert.match(text, /\*Pain points\*\n- Current process is manual/);
  assert.match(text, /\*Key questions asked\*\n- How would you build this/);
  assert.match(text, /\*Pricing\*\n- \$70\/hr/);
  assert.match(text, /\*Next steps\*\n- Send recap/);
  assert.ok(text.length < 1400);
});

test("Fathom Slack replies reject transcript-like row notes and keep recap scannable", async () => {
  const text = await handleIntent({
    intent: { type: "update_deal_from_call", fathomUrl: "https://fathom.video/share/abc" },
    opsService: {
      async updateDealFromCall() {
        return {
          created: false,
          leadResult: { created: false, row: { Company: "Clinow" } },
          row: {
            Company: "Clinow",
            "Project Scope": "Run an engineer input call to define one priority workflow or bottleneck and estimate hours.",
            "Skills Needed": "Claude, Python, AI agents, systems integration, workflow automation",
            Notes: [
              "Need:",
              "@0:46 - chad",
              "I got an email talking about AI and a fractional person. Extra transcript context ".repeat(15),
              "",
              "Next steps:",
              "Franco: They would suggest how to build it and suggest an amount of hours."
            ].join("\n"),
            "Next Steps": "Prospect to review the information and decide whether to schedule an engineer input call."
          }
        };
      }
    }
  });

  assert.match(text, /\*Need\*\n- Run an engineer input call/);
  assert.match(text, /\*Skills needed\*\n- Claude\n- Python\n- AI agents\n- systems integration/);
  assert.match(text, /\*Next steps\*\n- Prospect to review the information/);
  assert.doesNotMatch(text, /@0:46|Extra transcript context|Franco:|They would suggest/);
  assert.ok(text.length < 1200);
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

test("inferCompanyFromThread finds company from prior Fathom bot recap", async () => {
  const client = {
    conversations: {
      async replies() {
        return {
          messages: [
            { text: "https://fathom.video/share/DotpASwco4KaWY5xkM_Azm_xhxCUBtNx" },
            { bot_id: "B123", text: "Fathom update for Fit4Travel: created the deal and created the lead.\n\n*Skills needed*\n- Claude, systems integration" },
            { text: "remove this lead and deal" }
          ]
        };
      }
    }
  };
  const company = await inferCompanyFromThread({ client, channel: "C1", threadTs: "123.45" });
  assert.equal(company, "Fit4Travel");
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
    eventSource: "Smartlead",
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
  assert.equal(campaignIncluded({
    smartlead: {
      includedCampaignMatch: ["AI"],
      excludedStatuses: ["PAUSED", "COMPLETED", "ARCHIVED"]
    }
  }, { campaign_name: "AI HealthTech", campaign_status: "ACTIVE" }), true);
  assert.equal(campaignIncluded({
    smartlead: {
      includedCampaignMatch: ["AI"],
      excludedStatuses: ["PAUSED", "COMPLETED", "ARCHIVED"]
    }
  }, { campaign_name: "General Hiring", campaign_status: "ACTIVE" }), false);
});

test("Smartlead native reply webhook is not trusted without a positive category", () => {
  const payload = {
    event_type: "EMAIL_REPLY",
    from_email: "sender@near.com",
    to_email: "jane@example.com",
    to_name: "Jane Doe",
    time_replied: "2026-06-04T15:30:00Z",
    reply_body: "<p>Sounds interesting. Can you send more details?</p>",
    preview_text: "Sounds interesting. Can you send more details?",
    campaign_name: "AI Engineering Services - CEOs",
    campaign_id: 123,
    lead_data: {
      id: "lead_123",
      company_name: "Example Co"
    }
  };

  assert.equal(isPositiveReply(payload), false);
  assert.equal(isPositiveReply(payload, { assumePositive: true }), false);
  const lead = normalizeSmartleadReply(payload);
  assert.match(lead.sourceEventId, /^smartlead:EMAIL_REPLY:123:lead_123:jane@example\.com:2026-06-04T15:30:00Z$/);
  assert.equal(lead.company, "Example Co");
  assert.equal(lead.firstName, "Jane");
  assert.equal(lead.lastName, "Doe");
  assert.equal(lead.email, "jane@example.com");
  assert.equal(lead.campaign, "AI Engineering Services - CEOs");
  assert.equal(lead.campaignId, "123");
  assert.equal(lead.smartleadLeadId, "lead_123");
  assert.equal(lead.lastReplyAt, "2026-06-04T15:30:00Z");
  assert.equal(lead.replySummary, "Sounds interesting. Can you send more details?");
});

test("Smartlead category update webhook is positive when category says interested", () => {
  assert.equal(isPositiveReply({
    event_type: "LEAD_CATEGORY_UPDATED",
    lead_email: "jane@example.com",
    category: {
      name: "Interested",
      sentiment_type: "positive"
    }
  }), true);
});

test("Smartlead out-of-office reply is not positive even with assumePositive", () => {
  assert.equal(isPositiveReply({
    event_type: "EMAIL_REPLY",
    lead_email: "jason.walker@agencyrevolution.com",
    reply_body: "I will be out of the office until Monday, June 15 and will respond after I return.",
    category: {
      name: "Out Of Office",
      sentiment_type: "neutral"
    }
  }, { assumePositive: true }), false);
});

test("Smartlead not interested category is not positive", () => {
  assert.equal(isPositiveReply({
    event_type: "LEAD_CATEGORY_UPDATED",
    lead_email: "jane@example.com",
    category: {
      name: "Not Interested",
      sentiment_type: "not-positive"
    }
  }, { assumePositive: true }), false);
});

test("booking payload normalizes into call-booked deal fields", () => {
  const booking = normalizeBooking({
    event_id: "booking_1",
    source: "Chili Piper",
    booking: {
      id: "booking_1",
      meeting_type: "AI Automation // + Near",
      start_time: "2026-06-01T15:00:00-03:00",
      host: { name: "Camila Bagnati" },
      prospect: {
        name: "Zach Williams",
        email: "zach@venveo.com",
        company: "Venveo"
      }
    }
  });
  assert.equal(booking.company, "Venveo");
  assert.equal(booking.email, "zach@venveo.com");
  assert.equal(booking.eventSource, "Chili Piper");
  assert.equal(booking.source, "Outreach");
  assert.equal(booking.campaign, "AI Automation // + Near");
  assert.equal(booking.owner, "Camila Bagnati");
  assert.equal(booking.stage, "Call Booked");
  assert.equal(booking.callStatus, "Scheduled");
  assert.equal(bookingIncluded({ booking: { titleMatch: ["AI Automation", "+ Near"] } }, booking), true);
  assert.equal(bookingIncluded({ booking: { titleMatch: ["Discovery"] } }, booking), false);
});

test("HubSpot meeting payload normalizes into call-booked deal fields", () => {
  const booking = normalizeHubSpotMeeting({
    object: {
      objectType: "MEETING",
      objectId: "987",
      properties: {
        hs_object_id: "987",
        hs_meeting_title: "AI Engineering Services intro",
        hs_meeting_start_time: "2026-06-08T15:00:00.000Z",
        createdate: "2026-06-04T13:00:00.000Z",
        hs_meeting_body: "Prospect booked through Cami's HubSpot meeting link."
      }
    },
    inputFields: {
      first_name: "Laurent",
      last_name: "Guillemein",
      email: "lgui@hellofresh.com",
      company: "HelloFresh",
      owner_name: "Camila Bagnati"
    }
  });

  assert.equal(booking.sourceEventId, "hubspot-meeting:987");
  assert.equal(booking.eventSource, "HubSpot");
  assert.equal(booking.company, "HelloFresh");
  assert.equal(booking.firstName, "Laurent");
  assert.equal(booking.lastName, "Guillemein");
  assert.equal(booking.email, "lgui@hellofresh.com");
  assert.equal(booking.source, "Outreach");
  assert.equal(booking.campaign, "AI Engineering Services intro");
  assert.equal(booking.owner, "Camila Bagnati");
  assert.equal(booking.callDate, "2026-06-08T15:00:00.000Z");
  assert.equal(booking.callBookedOn, "2026-06-04T13:00:00.000Z");
  assert.equal(booking.stage, "Call Booked");
  assert.equal(bookingIncluded({ booking: { titleMatch: ["AI Engineering"] } }, booking), true);

  const flatBooking = normalizeHubSpotMeeting({
    event_id: "hubspot-meeting-988",
    meeting_title: "AI Services intro",
    start_time: "1780930800000",
    booked_at: "2026-06-04T13:00:00.000Z",
    first_name: "Camila",
    last_name: "Prospect",
    email: "camila@example.com",
    company: "ExampleCo",
    owner_name: "Franco Pereyra"
  });

  assert.equal(flatBooking.sourceEventId, "hubspot-meeting-988");
  assert.equal(flatBooking.company, "ExampleCo");
  assert.equal(flatBooking.firstName, "Camila");
  assert.equal(flatBooking.lastName, "Prospect");
  assert.equal(flatBooking.owner, "Franco Pereyra");
  assert.equal(flatBooking.callDate, "2026-06-08T15:00:00.000Z");
});

test("pipeline webhook notifications post concise Slack updates", async () => {
  const posts = [];
  const service = new OpsService({
    repository: null,
    config: { slack: { aiLeadsChannelId: "C-ai-leads", smartleadNotifyUserIds: ["U-hector", "U-cami"] } },
    slackClient: {
      chat: {
        async postMessage(message) {
          posts.push(message);
          return { ts: `123.${posts.length}` };
        }
      }
    }
  });

  const leadLink = await service.notifySmartleadLead({
    created: true,
    row: {
      Company: "Mantra Health",
      "First Name": "Thomas",
      "Last Name": "Bazerghi",
      Email: "t.bazerghi@mantrahealth.com",
      Campaign: "AI HealthTech",
      "Lead Stage": "Replied Positive"
    }
  }, {
    replySummary: "Interested. Can we meet Friday?"
  });

  const dealLink = await service.notifyChiliPiperDeal({
    created: true,
    leadResult: { created: false },
    row: {
      Company: "Venveo",
      "First Name": "Zach",
      "Last Name": "Williams",
      Email: "zach@venveo.com",
      Owner: "Camila Bagnati",
      "Call Had Date": "Jun 1, 2026",
      "Call Booked On": "May 29, 2026",
      Campaign: "AI Automation // + Near"
    }
  });
  const hubspotLink = await service.notifyBookingDeal({
    created: false,
    leadResult: { created: false },
    row: {
      Company: "HelloFresh",
      "First Name": "Laurent",
      "Last Name": "Guillemein",
      Email: "lgui@hellofresh.com",
      Owner: "Camila Bagnati",
      "Call Had Date": "Jun 8, 2026",
      "Call Booked On": "Jun 4, 2026",
      Campaign: "AI Engineering Services intro"
    }
  }, "HubSpot");

  assert.equal(leadLink, "slack://C-ai-leads/123.1");
  assert.equal(dealLink, "slack://C-ai-leads/123.2");
  assert.equal(hubspotLink, "slack://C-ai-leads/123.3");
  assert.match(posts[0].text, /New positive Smartlead reply: \*Mantra Health\*/);
  assert.match(posts[0].text, /cc: <@U-hector> <@U-cami>/);
  assert.match(posts[0].text, /Campaign: AI HealthTech/);
  assert.match(posts[0].text, /Tracker: Created lead, stage Replied Positive\./);
  assert.match(posts[1].text, /Created deal from Chili Piper booking: \*Venveo\*/);
  assert.match(posts[1].text, /Updated lead stage to Call Booked/);
  assert.match(posts[2].text, /Updated deal from HubSpot booking: \*HelloFresh\*/);
  assert.equal(posts[0].channel, "C-ai-leads");
});

test("Fathom payload normalizes transcript and recording identity", () => {
  const payload = normalizeFathomPayload({
    event_id: "fathom_1",
    recording: {
      id: "rec_1",
      url: "https://fathom.video/share/rec_1",
      started_at: "2026-06-01T20:30:00.000Z",
      default_summary: { markdown_formatted: "Fathom summary: needs Zapier support." },
      transcript: [{ speaker: { display_name: "Client" }, text: "Need Zapier and APIs." }]
    },
    company: "CP Brands",
    email: "dionelisp@cpbrandsgroup.com"
  });
  assert.equal(payload.sourceEventId, "fathom_1");
  assert.equal(payload.recordingId, "rec_1");
  assert.equal(payload.callDate, "2026-06-01T20:30:00.000Z");
  assert.match(payload.summaryText, /needs Zapier support/);
  assert.equal(payload.transcriptText, "Client: Need Zapier and APIs.");
});

test("Fathom payload uses calendar invitees and recording start time", () => {
  const payload = normalizeFathomPayload({
    recording_id: "rec_2",
    share_url: "https://fathom.video/share/rec_2",
    recording_start_time: "2026-06-01T20:30:00.000Z",
    calendar_invitees: [
      { name: "Camila Bagnati", email: "camila@hirewithnear.com" },
      { name: "Chad", email: "chad@clinow.com" }
    ],
    summary: { markdown_formatted: "Exploring fractional AI engineering support." },
    transcript: [
      {
        speaker: { display_name: "Chad", matched_calendar_invitee_email: "chad@clinow.com" },
        text: "What is the all-in hourly cost?"
      }
    ]
  });

  assert.equal(payload.sourceEventId, "rec_2");
  assert.equal(payload.recordingId, "rec_2");
  assert.equal(payload.url, "https://fathom.video/share/rec_2");
  assert.equal(payload.companyDomain, "clinow.com");
  assert.equal(payload.contactName, "Chad");
  assert.equal(payload.email, "chad@clinow.com");
  assert.equal(payload.callDate, "2026-06-01T20:30:00.000Z");
  assert.match(payload.summaryText, /fractional AI engineering/);
  assert.equal(payload.transcriptText, "Chad <chad@clinow.com>: What is the all-in hourly cost?");
});

test("Fathom webhook signature verification accepts valid current signatures", () => {
  const rawSecret = "test-webhook-secret";
  const secret = `whsec_${Buffer.from(rawSecret).toString("base64")}`;
  const rawBody = JSON.stringify({ recording_id: "rec_1" });
  const timestamp = "1780400000";
  const id = "msg_1";
  const signature = crypto.createHmac("sha256", rawSecret).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  const now = new Date(Number(timestamp) * 1000 + 1000);

  assert.equal(verifyFathomWebhookSignature({
    secret,
    rawBody,
    now,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`
    }
  }), true);

  assert.equal(verifyFathomWebhookSignature({
    secret,
    rawBody: JSON.stringify({ recording_id: "tampered" }),
    now,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`
    }
  }), false);
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

test("sheets client prefers service-account auth over Apps Script proxy", async () => {
  const serviceAccountJson = JSON.stringify({
    type: "service_account",
    project_id: "test",
    private_key_id: "test",
    private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
    client_email: "test@test.iam.gserviceaccount.com",
    client_id: "1",
    token_uri: "https://oauth2.googleapis.com/token"
  });

  const client = await SheetsClient.create({
    spreadsheetId: "sheet",
    serviceAccountJson,
    scriptWebAppUrl: "https://script.google.com/macros/s/example/exec",
    scriptSharedSecret: "secret"
  });

  assert.ok(client instanceof SheetsClient);
  assert.equal(client instanceof ScriptSheetsClient, false);
});

test("script sheets client summarizes HTML proxy errors", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    async text() {
      return "<!DOCTYPE html><html><head><title>Error</title></head><body>very long Google Apps Script error page</body></html>";
    }
  });

  try {
    const client = new ScriptSheetsClient({
      spreadsheetId: "sheet",
      scriptWebAppUrl: "https://script.google.com/macros/s/example/exec",
      scriptSharedSecret: "secret"
    });

    await assert.rejects(
      () => client.getValues("Leads"),
      /Sheets proxy returned an HTML error page \(Error\)/
    );
  } finally {
    global.fetch = previousFetch;
  }
});

test("script sheets client bounds default read range to sheet column count", async () => {
  const previousFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push(payload);
    if (payload.action === "getMetadata") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            ok: true,
            result: {
              sheets: [
                {
                  properties: {
                    title: "Leads",
                    gridProperties: { columnCount: 16 }
                  }
                }
              ]
            }
          });
        }
      };
    }
    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, result: [["Lead ID", "Company"]] });
      }
    };
  };

  try {
    const client = new ScriptSheetsClient({
      spreadsheetId: "sheet",
      scriptWebAppUrl: "https://script.google.com/macros/s/example/exec",
      scriptSharedSecret: "secret"
    });

    await client.getValues("Leads");

    assert.equal(requests[0].action, "getMetadata");
    assert.equal(requests[1].action, "getValues");
    assert.equal(requests[1].range, "A:P");
  } finally {
    global.fetch = previousFetch;
  }
});

test("environment validator can require robust Fathom extraction", () => {
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
    fathom: { ...config.fathom, apiKey: "" },
    webhookSharedSecret: "webhook",
    adminToken: "admin"
  }, { requireRobustExtraction: true });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["FATHOM_API_KEY"]);
});

test("extraction status reports degraded and robust modes without exposing secrets", () => {
  const degraded = extractionStatus({
    ai: { apiKey: "" },
    fathom: { apiKey: "" }
  });
  assert.equal(degraded.mode, "transcript_rules_only");
  assert.equal(degraded.robust, false);
  assert.equal(degraded.openaiConfigured, false);
  assert.equal(degraded.fathomApiConfigured, false);
  assert.match(degraded.warnings.join(" "), /OPENAI_API_KEY/);
  assert.match(degraded.warnings.join(" "), /FATHOM_API_KEY/);

  const robust = extractionStatus({
    ai: { apiKey: "openai-key" },
    fathom: { apiKey: "fathom-key" }
  });
  assert.equal(robust.mode, "fathom_summary_plus_ai");
  assert.equal(robust.robust, true);
  assert.deepEqual(robust.warnings, []);
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
