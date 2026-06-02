const { cleanText } = require("../domain/normalize");
const { compactField, formatCallSummary } = require("../domain/call-summary");

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
            "Keep need, pain_points, project_scope, skills_needed, pricing, next_steps, and notes concise. Do not paste transcript lines.",
            "notes must be a human-readable TL;DR under 1200 characters with only these sections: Need, Pain points, Pricing, Scope of project, Skills needed. Use short bullets.",
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
  if (direct) return cleanText(direct[1]).replace(/[.,;:]+$/g, "");

  const title = body.match(/\b(?:Call title|Title):\s*([^\n]+)/i);
  if (title) {
    const titleText = cleanText(title[1]);
    const afterSlash = titleText.includes("//") ? titleText.split("//").pop() : titleText;
    const candidate = afterSlash
      .split(/\+| with | - /i)
      .map(cleanText)
      .find((part) => part && !/^near$/i.test(part) && !/^ai automation$/i.test(part));
    if (candidate) return candidate;
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
  if (direct) return cleanText(direct[1]).replace(/[.,;:]+$/g, "");

  const speakerLines = body.match(/^\d{1,2}:\d{2}\s*-\s*([^\n]+)$/gim) || [];
  for (const line of speakerLines) {
    const name = cleanText(line.replace(/^\d{1,2}:\d{2}\s*-\s*/i, ""));
    if (name && !/near|franco|camila|iphone|speaker/i.test(name)) return name;
  }
  return "";
}

function collectSkills(body) {
  const skills = [
    ["n8n", /\bn8n\b|\b8n\b/i],
    ["Airtable", /\bairtable\b/i],
    ["Supabase", /\bsupabase\b/i],
    ["APIs", /\bapi\b|\bapis\b/i],
    ["MCP", /\bmcp\b/i],
    ["Custom GPTs", /\bcustom gpt\b|\bgpts?\b/i],
    ["Copilot", /\bcopilot\b/i],
    ["Prompt Engineering", /\bprompt engineering\b/i],
    ["AI agents", /\bagents?\b/i],
    ["workflow automation", /\bworkflow\b|\bautomatiz/i]
  ];
  return skills
    .filter(([, pattern]) => pattern.test(body))
    .map(([label]) => label)
    .join(", ");
}

function matchingLines(raw, pattern, max = 2) {
  return String(raw || "")
    .split(/\n+/)
    .map((line) => cleanText(line.replace(/^[^:\n]{1,40}:\s*/, "")))
    .filter((line) => pattern.test(line))
    .slice(0, max)
    .join(" ");
}

function normalizeCallFields(fields = {}) {
  const normalized = {
    ...fields,
    need: compactField(fields.need || fields.project_scope, 2, 420),
    pain_points: compactField(fields.pain_points, 2, 420),
    pricing: compactField(fields.pricing, 1, 220),
    skills_needed: compactField(fields.skills_needed, 3, 420),
    project_scope: compactField(fields.project_scope, 2, 520),
    next_steps: compactField(fields.next_steps, 2, 420),
    if_lost_reason: compactField(fields.if_lost_reason, 1, 220)
  };
  normalized.notes = formatCallSummary(normalized);
  return normalized;
}

function heuristicCallExtraction(text) {
  const raw = String(text || "");
  const body = cleanText(raw);
  const lower = body.toLowerCase();
  const stage = lower.includes("signed")
    ? "Contract Signed"
    : lower.includes("input call")
      ? "Input Call"
      : lower.includes("qualified") || lower.includes("interested")
        ? "Considering"
        : "";

  const pricing = (body.match(/\$[0-9,]+(?:\s*\/\s*(?:month|mo|hour|hr|week))?/i) || [])[0]
    || (body.match(/\b(?:usd|us\$)?\s*[0-9]{2,4}\s*(?:d[oó]lares|usd)?\s*(?:la hora|por hora|\/\s*(?:hour|hr)|per hour)\b/i) || [])[0]
    || "";
  const hours = (body.match(/\b[0-9]{1,3}\s*(?:hours|hrs|h)\/?(?:week|wk)?\b/i) || [])[0] || "";
  const startDate = (body.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s+\d{4})?\b/i) || [])[0] || "";
  const skills = collectSkills(body);

  return {
    company: extractCompanyName(raw),
    company_domain: extractCompanyDomain(raw),
    contact_name: extractContactName(raw),
    contact_email: firstExternalEmail(raw),
    deal_stage: stage,
    pricing,
    hours_per_week: hours,
    engineer_type: skills ? "AI Automation Engineer" : "",
    need: matchingLines(raw, /\b(need|looking for|want|interested|support|help)\b/i, 2),
    pain_points: matchingLines(raw, /\b(pain|manual|problem|issue|challenge|bottleneck|hard|difficult|slow)\b/i, 2),
    skills_needed: skills,
    project_scope: matchingLines(raw, /\b(automate|automation|workflow|build|integrat|report|dashboard|agent|api|n8n|airtable|supabase|mcp)\b/i, 3),
    start_date: startDate,
    next_steps: matchingLines(raw, /\b(next step|send|schedule|follow up|follow-up|intro|proposal|recap)\b/i, 2),
    notes: "",
    if_lost_reason: ""
  };
}

async function extractCallFields(config, transcriptText) {
  try {
    const ai = await extractCallFieldsWithOpenAI(config, transcriptText);
    if (Object.keys(ai).length > 0) return normalizeCallFields(ai);
  } catch (error) {
    console.warn("OpenAI extraction failed; using heuristic extraction", error.message);
  }
  return normalizeCallFields(heuristicCallExtraction(transcriptText));
}

module.exports = { extractCallFields, heuristicCallExtraction, normalizeCallFields };
