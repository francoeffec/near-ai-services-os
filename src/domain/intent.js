const { cleanText, domainFromEmail, splitName } = require("./normalize");

const STAGE_ALIASES = [
  ["contract signed", "Contract Signed"],
  ["signed", "Contract Signed"],
  ["future need", "Future Need"],
  ["input call", "Input Call"],
  ["handoff", "Input Call"],
  ["considering", "Considering"],
  ["call booked", "Call Booked"],
  ["booked", "Call Booked"],
  ["unqualified", "Unqualified"],
  ["lost", "Lost"],
  ["cancelled", "Cancelled"],
  ["canceled", "Cancelled"]
];

function extractCompany(text) {
  const patterns = [
    /\bat\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)\s*,?\s+as\s+(?:a\s+)?(?:lead|deal)\b/i,
    /\bcompany\s+(?:is|:)\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)(?:\.|,|$)/i,
    /\b(?:company|account)\s+name\s+(?:is|:)\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)(?:\.|,|$)/i,
    /\bassign\s+.+?\s+to\s+([A-Z][A-Za-z0-9&.\-' ]{1,60})(?:\.|,|$)/i,
    /\b(?:add|create)\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)\s+as\s+(?:a\s+)?(?:lead|deal)\b/i,
    /\b(?:lead|deal|company)\s+for\s+([A-Z][A-Za-z0-9&.\-' ]{1,60})(?:\.|,|$)/i,
    /\b(?:move|update)\s+([A-Z][A-Za-z0-9&.\-' ]{1,60}?)(?:\s+(?:to|using|with|for)\b|\.|,|$)/i,
    /\b(?:add|create)\s+([A-Z][A-Za-z0-9&.\-' ]{1,60})(?:\.|,|$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return titleIfLowercase(cleanText(match[1])
        .replace(/\s+as\s+(?:a\s+)?(?:lead|deal)$/i, "")
        .replace(/\b(as|to|using|with|for|a|the)$/i, "")
        .replace(/[.,;:]+$/g, "")
        .trim());
    }
  }

  return "";
}

function titleIfLowercase(value) {
  const text = cleanText(value);
  if (!text || /[A-Z]/.test(text)) return text;
  return text.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function extractEmail(text) {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

function extractOwner(text) {
  const match = text.match(/\bassign\s+([A-Za-z][A-Za-z .'-]{1,40})\s+to\b/i)
    || text.match(/\b(?:account executive\s+|ae\s+)?owner\s*(?:is|:)?\s+([A-Za-z][A-Za-z .'-]{1,40})(?:\.|,|$)/i);
  return match ? titleIfLowercase(cleanText(match[1]).replace(/[.,;:]+$/g, "")) : "";
}

function extractStage(text) {
  const normalized = text.toLowerCase();
  for (const [needle, stage] of STAGE_ALIASES) {
    if (normalized.includes(needle)) return stage;
  }
  if (/\b(at some point|not now|not right now|later|revisit|future)\b/i.test(text)) return "Future Need";
  if (/\b(call was had|call had|had a call|met with|meeting happened)\b/i.test(text)) return "Considering";
  return "";
}

function extractFathomUrl(text) {
  const urls = text.match(/https?:\/\/[^\s<>)|]+/gi) || [];
  const url = urls.find((candidate) => /fathom|fathom\.video/i.test(candidate)) || "";
  return cleanText(url).replace(/[.,;:!?]+$/g, "");
}

function extractPerson(text) {
  const explicitContact = text.match(/\b(?:main\s+contact|contact)\s+(?:is|:)?\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\b/i);
  if (explicitContact) return splitName(titleIfLowercase(explicitContact[1]));

  const email = extractEmail(text);
  const beforeEmail = email ? text.slice(0, text.indexOf(email)) : text;
  const sentenceParts = beforeEmail.split(/[.,\n]/).map(cleanText).filter(Boolean);
  for (const part of sentenceParts.slice().reverse()) {
    const words = part.split(" ").filter(Boolean);
    if (words.length >= 2 && words.length <= 4 && !/^at\s+/i.test(part) && !/add|create|lead|deal|company|contact|interested|customer|source|tracker|mailto/i.test(part)) {
      const person = splitName(titleIfLowercase(part));
      return person;
    }
  }
  return { firstName: "", lastName: "" };
}

function extractSource(text) {
  if (/\bgirdley\s+media\b|\bgirdley\b/i.test(text)) return "Girdley Media";
  if (/\breferral\b|\breferred\b/i.test(text)) return "Referral";
  if (/\bexisting customer\b|\bcustomer\b/i.test(text)) return "Customer";
  if (/\boutreach\b/i.test(text)) return "Outreach";
  return "";
}

function normalizeSlackMarkup(text) {
  return cleanText(text)
    .replace(/<mailto:([^|>]+)(?:\|[^>]+)?>/gi, "$1")
    .replace(/<(https?:\/\/[^>]+)>/gi, "$1")
    .replace(/<@[^>]+>/g, "")
    .replace(/\*Sent using\*\s+ChatGPT/gi, "")
    .replace(/^\s*-\s*/, "")
    .replace(/\s+\./g, ".");
}

function dateWithYear(value) {
  const text = cleanText(value).replace(/,$/, "");
  if (!text) return "";
  if (/\b\d{4}\b/.test(text)) return text;
  return `${text}, ${new Date().getFullYear()}`;
}

function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

function relativeWeekdayDate(value, referenceDate = new Date()) {
  const text = cleanText(value).toLowerCase();
  const weekdayMatch = text.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (!weekdayMatch) return "";
  const targetDay = WEEKDAY_INDEX[weekdayMatch[1]];
  const reference = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  if (/last\s+week/i.test(text)) {
    const startOfCurrentWeek = new Date(reference);
    startOfCurrentWeek.setDate(reference.getDate() - reference.getDay());
    startOfCurrentWeek.setDate(startOfCurrentWeek.getDate() - 7 + targetDay);
    return formatDate(startOfCurrentWeek);
  }
  const offset = (targetDay - reference.getDay() + 7) % 7;
  const date = new Date(reference);
  date.setDate(reference.getDate() + offset);
  return formatDate(date);
}

function extractCallDate(text) {
  const relativeMatch = text.match(/\b(?:call\s+(?:was\s+)?had|call date|met|meeting(?:\s+happened)?)\s+(?:on|is|:)?\s+((?:last\s+week\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+last\s+week)?)/i);
  if (relativeMatch) return relativeWeekdayDate(relativeMatch[1]);

  const match = text.match(/\b(?:call\s+(?:was\s+)?had|call date|met|meeting(?:\s+happened)?)\s+(?:on|is|:)?\s+([A-Z][a-z]+\.?\s+\d{1,2}(?:,?\s+\d{4})?)/i);
  return match ? dateWithYear(match[1]) : "";
}

function extractNextSteps(text) {
  const match = text.match(/\bnext steps?\s+(?:is|are|:)\s+(.+?)(?=(?:\.\s+(?:account executive\s+|ae\s+)?owner\b|\.\s+(?:source|campaign)\b|$))/i);
  if (!match) {
    const promisedAction = text.match(/\b([A-Z][A-Za-z.'-]+)\s+said\s+(?:that\s+)?(?:he|she|they)\s+would\s+(.+?)(?=\.|$)/i);
    if (promisedAction) {
      return cleanText(`${titleIfLowercase(promisedAction[1])} will ${promisedAction[2]}`).replace(/[.\s]+$/g, "");
    }
    return "";
  }
  return cleanText(match[1])
    .replace(/\s+\./g, ".")
    .replace(/^for\s+/i, "")
    .replace(/[.\s]+$/g, "");
}

function parseIntent(text) {
  const body = normalizeSlackMarkup(text);
  const lowerBody = body.toLowerCase();
  const company = extractCompany(body);
  const email = extractEmail(body);
  const owner = extractOwner(body);
  const stage = extractStage(body);
  const fathomUrl = extractFathomUrl(body);
  const person = extractPerson(body);
  const source = extractSource(body);
  const companyDomain = domainFromEmail(email);
  const callDate = extractCallDate(body);
  const nextSteps = extractNextSteps(body);

  if (/\bassign\b/i.test(body)) {
    return { type: "assign_owner", company, owner, rawText: body };
  }

  if (/\bmove\b.*\bhandoff\b|\bhandoff\b/i.test(body)) {
    return { type: "move_to_handoff", company, stage: "Input Call", rawText: body };
  }

  if (fathomUrl || (/\bupdate\b/i.test(body) && /transcript|call notes|fathom/i.test(body))) {
    return {
      type: "update_deal_from_call",
      company,
      email,
      fathomUrl,
      transcriptText: body,
      autoCreateDeal: Boolean(fathomUrl),
      rawText: body
    };
  }

  if (/\b(create|add)\b.*\bdeal\b|\bas\s+(?:a\s+)?deal\b|\bdeal\b.*\bstage\b|\bcall booked\b/i.test(body)) {
    return {
      type: "create_deal",
      company,
      companyDomain,
      email,
      firstName: person.firstName,
      lastName: person.lastName,
      source,
      owner,
      stage: stage || "Call Booked",
      callDate,
      nextSteps,
      nextStep: nextSteps,
      notes: body,
      rawText: body
    };
  }

  if (/\b(add|create)\b.*\blead\b|\bpositive repl(y|ies|ied)\b|\binterested\b/i.test(body)) {
    return {
      type: "add_lead",
      company,
      companyDomain,
      email,
      firstName: person.firstName,
      lastName: person.lastName,
      source,
      owner,
      stage: stage || "Replied Positive",
      nextStep: nextSteps,
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
