const { cleanText, firstNonEmpty } = require("../domain/normalize");
const { compactField, formatCallSummary } = require("../domain/call-summary");

const DEAL_STAGES = new Set([
  "Cancelled",
  "Call Booked",
  "Unqualified",
  "Considering",
  "Input Call",
  "Contract Signed",
  "Lost",
  "Future Need"
]);

const NEAR_SPEAKER_PATTERN = /\b(near|camila|cami|franco|hayden|kevin|codex|iphone)\b/i;

async function extractCallFieldsWithOpenAI(config, transcriptText) {
  if (!config.ai?.apiKey) return {};

  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      company: { type: "string" },
      company_domain: { type: "string" },
      contact_name: { type: "string" },
      contact_email: { type: "string" },
      deal_stage: { type: "string" },
      pricing: { type: "string" },
      hours_per_week: { type: "string" },
      engineer_type: { type: "string" },
      need: { type: "string" },
      pain_points: { type: "string" },
      key_questions: { type: "string" },
      skills_needed: { type: "string" },
      project_scope: { type: "string" },
      start_date: { type: "string" },
      next_steps: { type: "string" },
      notes: { type: "string" },
      if_lost_reason: { type: "string" }
    },
    required: [
      "company",
      "company_domain",
      "contact_name",
      "contact_email",
      "deal_stage",
      "pricing",
      "hours_per_week",
      "engineer_type",
      "need",
      "pain_points",
      "key_questions",
      "skills_needed",
      "project_scope",
      "start_date",
      "next_steps",
      "notes",
      "if_lost_reason"
    ]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.ai.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.ai.model || "gpt-4.1-mini",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "deal_call_update",
          strict: true,
          schema: jsonSchema
        }
      },
      messages: [
        {
          role: "system",
          content: [
            "Extract NearAI Services deal fields from a sales call transcript or Fathom summary.",
            "The company and contact should be the external prospect, not Near.",
            "Prefer a Fathom summary/action-items section when present; use the transcript only to fill gaps.",
            "Use deal_stage only from: Cancelled, Call Booked, Unqualified, Considering, Input Call, Contract Signed, Lost, Future Need.",
            "Capture key_questions as the most important prospect questions asked during the call, rewritten concisely.",
            "Keep need, pain_points, key_questions, project_scope, skills_needed, pricing, next_steps, and notes concise. Do not paste transcript lines.",
            "notes must be a human-readable TL;DR under 1400 characters with only these sections: Need, Pain points, Key questions asked, Pricing, Scope of project, Skills needed, Next steps. Use short bullets.",
            "Use empty strings when the call does not support a field. Do not invent facts."
          ].join(" ")
        },
        {
          role: "user",
          content: transcriptText.slice(0, 60000)
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI extraction failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

function firstExternalEmail(body) {
  const emails = body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return emails.find((email) => !/@hirewithnear\.com$/i.test(email)) || "";
}

function extractCompanyName(body) {
  const direct = body.match(/\bCompany:\s*([^\n]+)/i) || body.match(/\bProspect company:\s*([^\n]+)/i);
  if (direct) return prettyCompanyName(cleanText(direct[1]).replace(/[.,;:]+$/g, ""), extractCompanyDomain(body));

  const title = body.match(/\b(?:Call title|Title):\s*([^\n]+)/i);
  if (title) {
    const titleText = cleanText(title[1]);
    const afterSlash = titleText.includes("//") ? titleText.split("//").pop() : titleText;
    const candidate = afterSlash
      .split(/\+| with | - /i)
      .map(cleanText)
      .find((part) => part && !/^near$/i.test(part) && !/^ai automation$/i.test(part));
    if (candidate) return prettyCompanyName(candidate, extractCompanyDomain(body));
  }

  return "";
}

function extractCompanyDomain(body) {
  const direct = body.match(/\bCompany domain:\s*([a-z0-9.-]+\.[a-z]{2,})/i);
  if (direct) return direct[1].toLowerCase();
  const email = firstExternalEmail(body);
  if (email) return email.split("@").pop().toLowerCase();
  const domains = body.match(/\b[a-z0-9.-]+\.[a-z]{2,}\b/gi) || [];
  return (domains.find((domain) => !/hirewithnear\.com/i.test(domain) && !/fathom\.video/i.test(domain)) || "").toLowerCase();
}

function extractContactName(body) {
  const direct = body.match(/\bContact:\s*([^\n<]+)/i) || body.match(/\bClient\/Contact:\s*([^\n<]+)/i);
  if (direct) return titleCaseName(cleanText(direct[1]).replace(/[.,;:]+$/g, ""));

  const speakerLines = body.match(/^\d{1,2}:\d{2}\s*-\s*([^\n]+)$/gim) || [];
  for (const line of speakerLines) {
    const name = cleanText(line.replace(/^\d{1,2}:\d{2}\s*-\s*/i, ""));
    if (name && !NEAR_SPEAKER_PATTERN.test(name) && !/speaker/i.test(name)) return titleCaseName(name);
  }
  const turns = parseTranscriptTurns(body);
  const external = turns.find((turn) => !isNearSpeaker(turn.speaker));
  if (external?.speaker) return titleCaseName(external.speaker);
  return "";
}

function collectSkills(body) {
  const skills = [
    ["n8n", /\bn8n\b|\b8n\b/i],
    ["Airtable", /\bairtable\b/i],
    ["Supabase", /\bsupabase\b/i],
    ["APIs", /\bapi\b|\bapis\b/i],
    ["MCP", /\bmcp\b/i],
    ["Claude", /\bclaude\b/i],
    ["Python", /\bpython\b/i],
    ["Custom GPTs", /\bcustom gpt\b|\bgpts?\b/i],
    ["Copilot", /\bcopilot\b/i],
    ["Prompt Engineering", /\bprompt engineering\b/i],
    ["AI agents", /\bagents?\b/i],
    ["systems integration", /\bintegrat(?:e|ing|ion|ions)\b|\bcrm\b|\bsystems?\b/i],
    ["workflow automation", /\bworkflow\b|\bautomatiz/i]
  ];
  return skills
    .filter(([, pattern]) => pattern.test(body))
    .map(([label]) => label)
    .join(", ");
}

function titleCaseName(value) {
  return cleanText(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function prettyCompanyName(value, domain = "") {
  const cleaned = cleanText(value);
  const normalizedDomain = cleanText(domain).toLowerCase();
  if (!cleaned) return "";
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) {
    const label = cleaned.split(".")[0] || cleaned;
    return label
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  if (normalizedDomain && cleaned.toLowerCase() === normalizedDomain) {
    return prettyCompanyName(normalizedDomain);
  }
  return cleaned;
}

function parseTranscriptTurns(text) {
  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const turns = [];
  let current = null;

  const pushCurrent = () => {
    if (current && cleanText(current.text)) {
      turns.push({ speaker: cleanText(current.speaker), text: cleanText(current.text) });
    }
  };

  for (const line of lines) {
    if (/^(?:Call title|Company|Company domain|Call date|Transcript|Fathom summary):/i.test(line)) continue;
    if (/^VIEW RECORDING\b/i.test(line)) continue;

    const fathomSpeaker = line.match(/^@\d{1,2}:\d{2}\s*-\s*(.+)$/i);
    if (fathomSpeaker) {
      pushCurrent();
      current = { speaker: fathomSpeaker[1], text: "" };
      continue;
    }

    const colonSpeaker = line.match(/^([^:\n]{2,60}):\s+(.+)$/);
    if (colonSpeaker && !/^https?:\/\//i.test(line)) {
      pushCurrent();
      current = { speaker: colonSpeaker[1], text: colonSpeaker[2] };
      continue;
    }

    if (current) {
      current.text = `${current.text} ${line}`.trim();
    }
  }
  pushCurrent();
  return turns;
}

function isNearSpeaker(speaker) {
  return NEAR_SPEAKER_PATTERN.test(cleanText(speaker));
}

function pointList(points, max = 2) {
  return [...new Set(points.map(cleanText).filter(Boolean))].slice(0, max).join("\n");
}

function canonicalQuestion(question) {
  const text = cleanText(question).replace(/\s*\?+\s*$/g, "");
  const lower = text.toLowerCase();
  if (!text) return "";
  if (/all[-\s]?in cost|cost[-\s]?in cost|\bcost\b/.test(lower)) return "What is the all-in hourly cost?";
  if (/how much.*full[-\s]?time|full[-\s]?time.*employees|rough numbers|ballpark/.test(lower)) return "What does full-time AI engineer compensation look like?";
  if (/do you hire full[-\s]?time|full[-\s]?time also/.test(lower)) return "Can Near also help hire a full-time AI engineer?";
  if (/what.*do we do|how.*do you go|get started|how.*works/.test(lower)) return "What is the process to get started with fractional AI support?";
  if (/either way|full[-\s]?time or part[-\s]?time|part[-\s]?time/.test(lower)) return "Can Near support both fractional and full-time AI talent?";
  if (/talent.*ai|ai.*talent|latest.*ai tools|workflows.*tools/.test(lower)) return "Do you have AI talent familiar with workflows and current AI tools?";
  if (/do you do all kinds|accounting|admin|it\b/.test(lower)) return "Do you support roles beyond AI, such as accounting, admin, IT, and operations?";
  if (/how.*use ai|best way/.test(lower)) return "How should the company use AI in the highest-leverage way?";
  if (/what.*offer|fractional/.test(lower)) return "How does the fractional AI engineer model work?";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}?`;
}

function keyQuestionsFromTurns(turns) {
  const questions = [];
  for (const turn of turns.filter((item) => !isNearSpeaker(item.speaker))) {
    const text = cleanText(turn.text);
    const explicit = text.match(/[^.!?]*\?/g) || [];
    for (const candidate of explicit) questions.push(canonicalQuestion(candidate));

    if (!explicit.length) {
      if (/\b(all[-\s]?in cost|cost|how much|full[-\s]?time|part[-\s]?time|talent|fractional|what kind)\b/i.test(text)) {
        questions.push(canonicalQuestion(text));
      }
    }
  }
  const priority = [
    /all-in hourly cost/i,
    /full-time ai engineer compensation/i,
    /help hire a full-time ai engineer/i,
    /fractional and full-time ai talent/i,
    /ai talent familiar/i,
    /process to get started/i,
    /fractional ai engineer model/i,
    /roles beyond ai/i
  ];
  const cleaned = questions.filter((question) => question && !/where are you calling from|what caught|how do you find your people|work with hr/i.test(question));
  const ranked = [...new Set(cleaned)].sort((a, b) => {
    const rank = (value) => {
      const index = priority.findIndex((pattern) => pattern.test(value));
      return index === -1 ? priority.length : index;
    };
    return rank(a) - rank(b);
  });
  return pointList(ranked, 5);
}

function extractPricingPoints(body) {
  const points = [];
  if (/\$70\b.{0,40}\b(hour|hr|all in)\b/i.test(body) || /\b70\b.{0,20}\b(hour|hr|la hora|por hora)\b/i.test(body)) {
    points.push("$70/hr all-in for fractional AI engineering.");
  }
  if (/as little as 10 hours|commit with as little as 10 hours|10 hours/i.test(body)) {
    points.push("Can start with as little as 10 hours.");
  }
  if (/(20,\s*40|20\s*(?:or|to|-)\s*40)\s*hours/i.test(body)) {
    points.push("20-40 hours is a typical starting package.");
  }
  if (/\$?80,?000.{0,30}\$?120,?000|80,?000.{0,20}120,?000/i.test(body)) {
    points.push("Full-time AI engineer compensation was framed around $80k-$120k/year.");
  }
  if (/month[-\s]?to[-\s]?month/i.test(body)) {
    points.push("Month-to-month commitment is available.");
  }
  return pointList(points, 4);
}

function extractNeedPoints(body) {
  const points = [];
  if (/fractional (?:ai )?(?:person|engineer)|fractional ai|package of hours/i.test(body)) {
    points.push("Exploring fractional AI engineering support and how the model works.");
  }
  if (/full[-\s]?time (?:permanent )?(?:ai )?engineer|hire full[-\s]?time/i.test(body)) {
    points.push("Also considering whether a full-time AI engineer or AI architect makes sense.");
  }
  if (/how to use ai|use ai in the best way|trying to figure out.*ai/i.test(body)) {
    points.push("Trying to identify practical, high-leverage AI use cases across the business.");
  }
  if (/right information out of our systems|centralized information/i.test(body)) {
    points.push("Wants AI to access or centralize the right information from internal systems.");
  }
  if (/create something|construct it|roll it out|web app|employees could use it/i.test(body)) {
    points.push("Wants to understand how an AI workflow/tool would be mapped, built, and rolled out to employees.");
  }
  return pointList(points, 3);
}

function extractPainPoints(body) {
  const points = [];
  if (/hiring.*fort wayne.*taking longer|taking longer than i thought|trying to hire.*taking longer/i.test(body)) {
    points.push("Local hiring in Fort Wayne is taking longer than expected.");
  }
  if (/trying to figure out.*things|how to use ai in the best way|what we want to use it/i.test(body)) {
    points.push("They are still clarifying which AI use cases should be prioritized.");
  }
  if (/right information out of our systems|centralized information/i.test(body)) {
    points.push("Internal information is spread across systems and needs to be easier for AI/tools to use.");
  }
  if (/repetitive.*team members|employees.*time.*something else/i.test(body)) {
    points.push("Potential opportunity to reduce repetitive work so employees can focus on higher-value tasks.");
  }
  return pointList(points, 3);
}

function extractScopePoints(body) {
  const points = [];
  if (/input call with an engineer|meet the engineer|walk them through/i.test(body)) {
    points.push("Run an engineer input call to define one priority workflow or bottleneck and estimate hours.");
  }
  if (/ai agents|integrating your crms|different tools|repetitive processes|centralized information/i.test(body)) {
    points.push("Potential builds include AI agents, CRM/tool integrations, centralized information access, and workflow automation.");
  }
  if (/web app|employees could use it|roll it out/i.test(body)) {
    points.push("Engineer can help determine the best rollout path, including an internal app or employee-facing workflow.");
  }
  return pointList(points, 3);
}

function extractNextSteps(body) {
  const points = [];
  if (/send (?:you )?(?:all )?(?:the )?information|send.*different models|send profiles|send.*examples/i.test(body)) {
    points.push("Near to send information on fractional and full-time options, plus example profiles or relevant examples.");
  }
  if (/calendar link/i.test(body)) {
    points.push("Near to include a calendar link so the prospect can reconnect if useful.");
  }
  if (/let me look|take a look|i'll decide|decide/i.test(body)) {
    points.push("Prospect to review the information and decide whether to schedule an engineer input call.");
  }
  if (/schedule.*engineer.*next week/i.test(body) && !/let me look|i'll decide/i.test(body)) {
    points.push("Schedule an engineer input call for next week.");
  }
  return pointList(points, 3);
}

function extractDealStage(body, fallback = "") {
  if (/\b(cancelled|canceled)\b/i.test(body)) return "Cancelled";
  if (/\b(no fit|not interested|no budget|unqualified)\b/i.test(body)) return "Unqualified";
  if (/\b(lost|went with|chose another|not moving forward)\b/i.test(body)) return "Lost";
  if (/\b(contract signed|signed the contract|agreement signed|ready to sign|send the contract)\b/i.test(body)) return "Contract Signed";
  if (/\b(input call booked|input call scheduled|engineer input call scheduled)\b/i.test(body)) return "Input Call";
  if (/\b(call booked|meeting booked|calendar invite|scheduled for)\b/i.test(body)) return "Call Booked";
  if (/\b(future need|second half|later this year|not now)\b/i.test(body)) return "Future Need";
  if (/\b(interested|send me|send information|take a look|review|decide|fractional|full-time|ai engineer)\b/i.test(body)) return "Considering";
  return DEAL_STAGES.has(fallback) ? fallback : "";
}

function extractStartDate(body) {
  const match = body.match(/\b(?:start|kick off|begin)\s+(?:on|around|by)?\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s+\d{4})?)\b/i);
  return match ? match[1] : "";
}

function hasTranscriptLeak(value) {
  const text = String(value || "");
  if (!cleanText(text)) return false;
  return /@\d{1,2}:\d{2}\s*-/i.test(text)
    || /\b(VIEW RECORDING|Transcript:|Call title:)\b/i.test(text)
    || /\b(?:Camila Bagnati|Franco|Near|Client|Speaker)\s*:/i.test(text)
    || text.length > 900;
}

function safeField(value, { allowLong = false, nextStep = false } = {}) {
  const text = cleanText(value);
  if (!text) return "";
  if (hasTranscriptLeak(text)) return "";
  if (!allowLong && text.length > 700) return "";
  if (nextStep && /\b(they would suggest|if you agree|if you're ready|work product)\b/i.test(text)) return "";
  return text;
}

function chooseField(primary, fallback, options) {
  return firstNonEmpty(safeField(primary, options), safeField(fallback, options));
}

function chooseDealStage(primary, fallback) {
  const primaryStage = cleanText(primary);
  const fallbackStage = cleanText(fallback);
  const terminalStages = new Set(["Contract Signed", "Lost", "Unqualified", "Cancelled"]);
  if (fallbackStage && terminalStages.has(primaryStage) && primaryStage !== fallbackStage) return fallbackStage;
  if (DEAL_STAGES.has(primaryStage)) return primaryStage;
  return DEAL_STAGES.has(fallbackStage) ? fallbackStage : "";
}

function heuristicCallExtraction(text) {
  const raw = String(text || "");
  const body = cleanText(raw);
  const turns = parseTranscriptTurns(raw);
  const skills = collectSkills(body);
  const pricing = extractPricingPoints(body)
    || (body.match(/\$[0-9,]+(?:\s*\/\s*(?:month|mo|hour|hr|week))?/i) || [])[0]
    || (body.match(/\b(?:usd|us\$)?\s*[0-9]{2,4}\s*(?:d[oó]lares|usd)?\s*(?:la hora|por hora|\/\s*(?:hour|hr)|per hour)\b/i) || [])[0]
    || "";
  const hours = /20,?\s*40\s*hours/i.test(body)
    ? "20-40 hours typical; 10-hour minimum"
    : (body.match(/\b[0-9]{1,3}\s*(?:hours|hrs|h)\/?(?:week|wk)?\b/i) || [])[0] || "";

  return {
    company: extractCompanyName(raw),
    company_domain: extractCompanyDomain(raw),
    contact_name: extractContactName(raw),
    contact_email: firstExternalEmail(raw),
    deal_stage: extractDealStage(body),
    pricing,
    hours_per_week: hours,
    engineer_type: skills ? (/architect/i.test(body) ? "AI Automation Engineer / AI Architect" : "AI Automation Engineer") : "",
    need: extractNeedPoints(body),
    pain_points: extractPainPoints(body),
    key_questions: keyQuestionsFromTurns(turns),
    skills_needed: skills,
    project_scope: extractScopePoints(body),
    start_date: extractStartDate(body),
    next_steps: extractNextSteps(body),
    notes: "",
    if_lost_reason: ""
  };
}

function normalizeCallFields(fields = {}, fallbackFields = {}) {
  const normalized = {
    ...fields,
    company: chooseField(fields.company, fallbackFields.company),
    company_domain: chooseField(fields.company_domain, fallbackFields.company_domain),
    contact_name: chooseField(fields.contact_name, fallbackFields.contact_name),
    contact_email: chooseField(fields.contact_email, fallbackFields.contact_email),
    deal_stage: chooseDealStage(fields.deal_stage, fallbackFields.deal_stage),
    need: compactField(chooseField(fields.need || fields.project_scope, fallbackFields.need || fallbackFields.project_scope), 3, 520),
    pain_points: compactField(chooseField(fields.pain_points, fallbackFields.pain_points), 3, 520),
    key_questions: compactField(chooseField(fields.key_questions, fallbackFields.key_questions), 5, 700),
    pricing: compactField(chooseField(fields.pricing, fallbackFields.pricing), 4, 520),
    hours_per_week: chooseField(fields.hours_per_week, fallbackFields.hours_per_week),
    engineer_type: chooseField(fields.engineer_type, fallbackFields.engineer_type),
    skills_needed: compactField(chooseField(fields.skills_needed, fallbackFields.skills_needed), 6, 520),
    project_scope: compactField(chooseField(fields.project_scope, fallbackFields.project_scope), 3, 650),
    start_date: chooseField(fields.start_date, fallbackFields.start_date),
    next_steps: compactField(chooseField(fields.next_steps, fallbackFields.next_steps, { nextStep: true }), 3, 620),
    if_lost_reason: compactField(chooseField(fields.if_lost_reason, fallbackFields.if_lost_reason), 1, 220)
  };
  if (!normalized.deal_stage && fallbackFields.deal_stage) normalized.deal_stage = fallbackFields.deal_stage;
  normalized.notes = formatCallSummary(normalized);
  return normalized;
}

async function extractCallFields(config, transcriptText) {
  const fallback = heuristicCallExtraction(transcriptText);
  try {
    const ai = await extractCallFieldsWithOpenAI(config, transcriptText);
    if (Object.keys(ai).length > 0) return normalizeCallFields(ai, fallback);
  } catch (error) {
    console.warn("OpenAI extraction failed; using heuristic extraction", error.message);
  }
  return normalizeCallFields(fallback);
}

module.exports = {
  extractCallFields,
  heuristicCallExtraction,
  normalizeCallFields,
  parseTranscriptTurns
};
