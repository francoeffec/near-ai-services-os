const { cleanText, firstNonEmpty } = require("./normalize");

const SUMMARY_SECTIONS = [
  { label: "Need", keys: ["need", "Need"] },
  { label: "Pain points", keys: ["pain_points", "Pain Points", "Pain points"] },
  { label: "Key questions asked", keys: ["key_questions", "Key Questions", "Key questions asked"] },
  { label: "Pricing", keys: ["pricing", "Pricing"] },
  { label: "Scope of project", keys: ["project_scope", "Project Scope", "Project Description"] },
  { label: "Skills needed", keys: ["skills_needed", "Skills Needed"] },
  { label: "Next steps", keys: ["next_steps", "Next Steps", "Next Step"] }
];

function shorten(value, maxLength = 220) {
  const text = cleanText(value)
    .replace(/^[-*\u2022]\s*/, "")
    .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*[-\u2013]\s*/i, "");
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength - 3).trim();
  const boundary = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf(";"), clipped.lastIndexOf(","));
  return `${(boundary > 80 ? clipped.slice(0, boundary) : clipped).trim()}...`;
}

function isTranscriptChunk(value) {
  const text = cleanText(value);
  if (!text) return true;
  return /\b(VIEW RECORDING|Transcript:|Call title:|Attached transcript:)\b/i.test(text)
    || /(^|\s)@\d{1,2}:\d{2}\s*-/i.test(text)
    || /\b(?:Camila Bagnati|Franco Pereyra|Franco|Cami|Near|Client|Speaker)\s*:/i.test(text)
    || /Extra transcript context/i.test(text)
    || text.length > 520;
}

function splitCommaList(chunk) {
  const text = cleanText(chunk);
  if ((text.match(/,/g) || []).length < 2 || /[.!?]/.test(text)) return [chunk];
  const parts = text.split(",").map((part) => cleanText(part)).filter(Boolean);
  if (parts.length < 3) return [chunk];
  if (parts.some((part) => part.length > 45)) return [chunk];
  return parts;
}

function splitPoints(value, maxItems = 2) {
  const raw = String(value || "")
    .replace(/\r/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\s*\|\s*/g, "\n");
  const normalized = raw
    .replace(/\n\s*[-*\u2022]\s*/g, "\n")
    .replace(/\n\s*\d+\.\s*/g, "\n");
  const chunks = normalized
    .split(/\n+|;\s+/)
    .flatMap((chunk) => chunk.split(/(?<=[.!?])\s+(?=[A-Z0-9$])/))
    .flatMap(splitCommaList)
    .map((chunk) => cleanText(chunk))
    .filter(Boolean)
    .filter((chunk) => !isTranscriptChunk(chunk))
    .map((chunk) => shorten(chunk))
    .filter((chunk) => !/^speaker\s*\d*:?$/i.test(chunk));

  return [...new Set(chunks)].slice(0, maxItems);
}

function sectionFromNotes(notes, label) {
  const text = String(notes || "").replace(/\r/g, "\n");
  if (!text) return "";
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextLabels = SUMMARY_SECTIONS
    .filter((section) => section.label !== label)
    .map((section) => section.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(`${escaped}:?\\s*\\n([\\s\\S]*?)(?=\\n(?:${nextLabels}):?\\s*\\n|$)`, "i");
  const match = text.match(pattern);
  if (!match) return "";
  return isTranscriptChunk(match[1]) ? "" : match[1];
}

function firstValue(input, section) {
  for (const key of section.keys) {
    const value = input?.[key];
    if (cleanText(value)) return value;
  }
  return sectionFromNotes(input?.Notes || input?.notes, section.label);
}

function sectionMaxItems(label) {
  if (label === "Key questions asked") return 3;
  if (label === "Next steps") return 2;
  if (label === "Skills needed") return 4;
  return 2;
}

function callSummarySections(input = {}) {
  return SUMMARY_SECTIONS.map((section) => {
    const fallback = section.label === "Need"
      ? firstNonEmpty(input.project_scope, input["Project Scope"])
      : "";
    const maxItems = sectionMaxItems(section.label);
    const primaryPoints = splitPoints(firstValue(input, section), maxItems);
    const fallbackPoints = primaryPoints.length ? [] : splitPoints(fallback, maxItems);
    const points = primaryPoints.length ? primaryPoints : fallbackPoints;
    return {
      label: section.label,
      points: points.length ? points : ["Not captured."]
    };
  });
}

function formatCallSummary(input = {}) {
  return callSummarySections(input)
    .map((section) => `${section.label}:\n${section.points.map((point) => `- ${point}`).join("\n")}`)
    .join("\n\n");
}

function formatSlackCallSummary(input = {}) {
  return callSummarySections(input)
    .filter((section) => !(section.points.length === 1 && section.points[0] === "Not captured."))
    .map((section) => `*${section.label}*\n${section.points.map((point) => `- ${point}`).join("\n")}`)
    .join("\n\n");
}

function compactField(value, maxItems = 2, maxLength = 500) {
  return splitPoints(value, maxItems).join("; ").slice(0, maxLength).trim();
}

module.exports = {
  callSummarySections,
  compactField,
  formatCallSummary,
  formatSlackCallSummary,
  splitPoints
};
