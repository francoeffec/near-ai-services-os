const { cleanText, splitName } = require("./normalize");

const STAGE_ALIASES = [
  ["contract signed", "Contract Signed"],
  ["signed", "Contract Signed"],
  ["input call", "Input Call"],
  ["handoff", "Input Call"],
  ["qualified", "Qualified"],
  ["considering", "Considering"],
  ["call booked", "Call Booked"],
  ["booked", "Call Booked"],
  ["unqualified", "Unqualified"],
  ["lost", "Cancelled / Lost"],
  ["cancelled", "Cancelled / Lost"],
  ["canceled", "Cancelled / Lost"]
];

function extractCompany(text) {
  const patterns = [
    /\bassign\s+.+?\s+to\s+([A-Z][A-Za-z0-9&.\-' ]{1,60})(?:\.|,|$)/i,
    /\b(?:add|create)\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)\s+as\s+a\s+(?:lead|deal)\b/i,
    /\b(?:lead|deal|company)\s+for\s+([A-Z][A-Za-z0-9&.\-' ]{1,60})(?:\.|,|$)/i,
    /\b(?:move|update)\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)(?:\s+(?:to|using|with|for)\b|\.|,|$)/i,
    /\b(?:add|create)\s+([A-Z][A-Za-z0-9&.\-' ]{1,60})(?:\.|,|$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return cleanText(match[1])
        .replace(/\b(as|to|using|with|for|a|the)$/i, "")
        .replace(/[.,;:]+$/g, "")
        .trim();
    }
  }

  return "";
}

function extractEmail(text) {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

function extractOwner(text) {
  const match = text.match(/\bassign\s+([A-Za-z][A-Za-z .'-]{1,40})\s+to\b/i) || text.match(/\bowner\s+([A-Za-z][A-Za-z .'-]{1,40})\b/i);
  return match ? cleanText(match[1]) : "";
}

function extractStage(text) {
  const normalized = text.toLowerCase();
  for (const [needle, stage] of STAGE_ALIASES) {
    if (normalized.includes(needle)) return stage;
  }
  return "";
}

function extractFathomUrl(text) {
  const urls = text.match(/https?:\/\/\S+/gi) || [];
  return urls.find((url) => /fathom|fathom\.video/i.test(url)) || "";
}

function extractPerson(text) {
  const email = extractEmail(text);
  const beforeEmail = email ? text.slice(0, text.indexOf(email)) : text;
  const sentenceParts = beforeEmail.split(/[.,\n]/).map(cleanText).filter(Boolean);
  for (const part of sentenceParts) {
    const words = part.split(" ").filter(Boolean);
    if (words.length >= 2 && words.length <= 4 && !/add|create|lead|deal|company|interested/i.test(part)) {
      return splitName(part);
    }
  }
  return { firstName: "", lastName: "" };
}

function parseIntent(text) {
  const body = cleanText(text);
  const lowerBody = body.toLowerCase();
  const company = extractCompany(body);
  const email = extractEmail(body);
  const owner = extractOwner(body);
  const stage = extractStage(body);
  const fathomUrl = extractFathomUrl(body);
  const person = extractPerson(body);

  if (/\bassign\b/i.test(body)) {
    return { type: "assign_owner", company, owner, rawText: body };
  }

  if (/\bmove\b.*\bhandoff\b|\bhandoff\b/i.test(body)) {
    return { type: "move_to_handoff", company, stage: "Input Call", rawText: body };
  }

  if (/\bupdate\b/i.test(body) && (fathomUrl || /transcript|call notes|fathom/i.test(body))) {
    return { type: "update_deal_from_call", company, fathomUrl, transcriptText: body, rawText: body };
  }

  if (/\b(create|add)\b.*\bdeal\b|\bcall booked\b/i.test(body)) {
    return {
      type: "create_deal",
      company,
      email,
      firstName: person.firstName,
      lastName: person.lastName,
      stage: stage || "Call Booked",
      notes: body,
      rawText: body
    };
  }

  if (/\b(add|create)\b.*\blead\b|\bpositive repl(y|ies|ied)\b|\binterested\b/i.test(body)) {
    return {
      type: "add_lead",
      company,
      email,
      firstName: person.firstName,
      lastName: person.lastName,
      stage: stage || "Positive Response",
      notes: body,
      rawText: body
    };
  }

  if (stage && company) {
    return { type: "set_deal_stage", company, stage, rawText: body };
  }

  if (lowerBody === "help" || lowerBody.includes("what can you do")) {
    return { type: "help", rawText: body };
  }

  return { type: "unknown", company, rawText: body };
}

module.exports = { parseIntent, STAGE_ALIASES };
