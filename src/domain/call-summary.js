const { cleanText, firstNonEmpty } = require("./normalize");

const SUMMARY_SECTIONS = [
  { label: "Need", keys: ["need", "Need"] },
  { label: "Pain points", keys: ["pain_points", "Pain Points", "Pain points"] },
  { label: "Pricing", keys: ["pricing", "Pricing"] },
  { label: "Scope of project", keys: ["project_scope", "Project Scope", "Project Description"] },
  { label: "Skills needed", keys: ["skills_needed", "Skills Needed"] }
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
    .flatMap((chunk) => chunk.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((chunk) => shorten(chunk))
    .filter(Boolean)
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
  return match ? match[1] : "";
}

function firstValue(input, section) {
  for (const key of section.keys) {
    const value = input?.[key];
    if (cleanText(value)) return value;
  }
  return sectionFromNotes(input?.Notes || input?.notes, section.label);
}

function callSummarySections(input = {}) {
  return SUMMARY_SECTIONS.map((section) => {
    const fallback = section.label === "Need"
      ? firstNonEmpty(input.project_scope, input["Project Scope"])
      : "";
    const value = firstNonEmpty(firstValue(input, section), fallback);
    const maxItems = section.label === "Skills needed" ? 3 : 2;
    const points = splitPoints(value, maxItems);
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
    .map((section) => `*${section.label}*\n${section.points.map((point) => `- ${point}`).join("\n")}`)
    .join("\n\n");
}

function compactField(value, maxItems = 2, maxLength = 500) {
  return splitPoints(value, maxItems).join(" ").slice(0, maxLength).trim();
}

module.exports = {
  callSummarySections,
  compactField,
  formatCallSummary,
  formatSlackCallSummary,
  splitPoints
};
