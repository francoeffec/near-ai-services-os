const { cleanText, firstNonEmpty } = require("./normalize");

function contactName(row) {
  const joined = [row["First Name"], row["Last Name"]].map(cleanText).filter(Boolean).join(" ");
  return joined || cleanText(row["Client/Contact"]) || cleanText(row.Email);
}

function generateHandoffMessage(deal) {
  const company = cleanText(deal.Company) || "Unknown company";
  const contact = contactName(deal) || "Unknown contact";
  const owner = cleanText(deal.Owner) || "Unassigned";
  const engineerType = cleanText(deal["Engineer Type"]) || "TBD";
  const skills = cleanText(deal["Skills Needed"]) || "TBD";
  const hours = cleanText(deal["Hours/Week"]) || cleanText(deal.Hours) || "TBD";
  const startDate = cleanText(deal["Start Date"]) || "TBD";
  const pricing = cleanText(deal.Pricing) || "TBD";
  const scope = firstNonEmpty(deal["Project Scope"], deal.Notes, "No scope notes yet.");
  const nextSteps = cleanText(deal["Next Steps"]) || "Confirm recruiting next step.";

  return [
    `*AI Services handoff: ${company}*`,
    `Contact: ${contact}${deal.Email ? ` (${cleanText(deal.Email)})` : ""}`,
    `Owner: ${owner}`,
    "",
    `Role / engineer type: ${engineerType}`,
    `Skills needed: ${skills}`,
    `Hours/week: ${hours}`,
    `Start date: ${startDate}`,
    `Pricing: ${pricing}`,
    "",
    `Project scope: ${scope}`,
    `Next steps: ${nextSteps}`
  ].join("\n");
}

module.exports = { generateHandoffMessage };
