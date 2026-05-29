const { cleanText } = require("../domain/normalize");

async function extractCallFieldsWithOpenAI(config, transcriptText) {
  if (!config.ai.apiKey) return {};

  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      deal_stage: { type: "string" },
      pricing: { type: "string" },
      hours_per_week: { type: "string" },
      engineer_type: { type: "string" },
      skills_needed: { type: "string" },
      project_scope: { type: "string" },
      start_date: { type: "string" },
      next_steps: { type: "string" },
      notes: { type: "string" },
      if_lost_reason: { type: "string" }
    },
    required: [
      "deal_stage",
      "pricing",
      "hours_per_week",
      "engineer_type",
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
      model: config.ai.model,
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
          content: "Extract Near AI Services deal fields from a sales call transcript. Use empty strings when the transcript does not support a field. Do not invent facts."
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

function heuristicCallExtraction(text) {
  const body = cleanText(text);
  const lower = body.toLowerCase();
  const stage = lower.includes("signed")
    ? "Contract Signed"
    : lower.includes("input call")
      ? "Input Call"
      : lower.includes("qualified")
        ? "Qualified"
        : "";

  const pricing = (body.match(/\$[0-9,]+(?:\s*\/\s*(?:month|mo|hour|hr|week))?/i) || [])[0] || "";
  const hours = (body.match(/\b[0-9]{1,3}\s*(?:hours|hrs|h)\/?(?:week|wk)?\b/i) || [])[0] || "";
  const startDate = (body.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s+\d{4})?\b/i) || [])[0] || "";

  return {
    deal_stage: stage,
    pricing,
    hours_per_week: hours,
    engineer_type: "",
    skills_needed: "",
    project_scope: body.slice(0, 1200),
    start_date: startDate,
    next_steps: "",
    notes: body.slice(0, 2000),
    if_lost_reason: ""
  };
}

async function extractCallFields(config, transcriptText) {
  try {
    const ai = await extractCallFieldsWithOpenAI(config, transcriptText);
    if (Object.keys(ai).length > 0) return ai;
  } catch (error) {
    console.warn("OpenAI extraction failed; using heuristic extraction", error.message);
  }
  return heuristicCallExtraction(transcriptText);
}

module.exports = { extractCallFields, heuristicCallExtraction };
