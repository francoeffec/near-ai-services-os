const crypto = require("crypto");

function cleanText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/\s+/g, " ");
}

function lower(value) {
  return cleanText(value).toLowerCase();
}

function normalizeEmail(value) {
  return lower(value).replace(/[<>]/g, "");
}

function domainFromEmail(email) {
  const normalized = normalizeEmail(email);
  const [, domain] = normalized.split("@");
  return domain || "";
}

function normalizeDomain(value) {
  const raw = lower(value || "");
  if (!raw) return "";
  return raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .replace(/[^a-z0-9.-]/g, "");
}

function slug(value) {
  return lower(value)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function entityKey(input = {}) {
  const email = normalizeEmail(input.email || input.Email);
  const explicitDomain = normalizeDomain(input.companyDomain || input["Company Domain"] || input.domain);
  const emailDomain = domainFromEmail(email);
  const domain = explicitDomain || emailDomain;
  const company = slug(input.company || input.Company || "");

  if (domain && email) return `${domain}|${email}`;
  if (domain) return `${domain}|`;
  if (company && email) return `${company}|${email}`;
  return `${company}|`;
}

function stableId(prefix, key) {
  const hash = crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 12);
  return `${prefix}_${hash}`;
}

function nowIso() {
  return new Date().toISOString();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const cleaned = cleanText(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function splitName(fullName) {
  const parts = cleanText(fullName).split(" ").filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

module.exports = {
  cleanText,
  domainFromEmail,
  entityKey,
  firstNonEmpty,
  lower,
  normalizeDomain,
  normalizeEmail,
  nowIso,
  slug,
  splitName,
  stableId
};
