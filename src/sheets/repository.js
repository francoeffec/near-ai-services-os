const { SHEETS, SCHEMAS } = require("../schema");
const { cleanText, entityKey, nowIso, stableId } = require("../domain/normalize");

function mergePreservingExisting(existing = {}, incoming = {}) {
  const merged = { ...existing };
  const clearFields = new Set(incoming.__clear || []);
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "__clear") continue;
    if (clearFields.has(key)) {
      merged[key] = "";
      continue;
    }
    if (value === 0 || value === false || cleanText(value)) {
      merged[key] = value;
    } else if (!(key in merged)) {
      merged[key] = "";
    }
  }
  return merged;
}

class Repository {
  constructor(sheetsClient) {
    this.sheets = sheetsClient;
  }

  async read(sheetName) {
    const table = await this.sheets.readTable(sheetName);
    const expected = SCHEMAS[sheetName];
    if (expected) {
      const missing = expected.filter((header) => !table.headers.includes(header));
      if (missing.length > 0) {
        throw new Error(`${sheetName} is missing required headers: ${missing.join(", ")}`);
      }
    }
    return table;
  }

  async upsert(sheetName, keyHeader, keyValue, row, idHeader, idPrefix) {
    const table = await this.read(sheetName);
    const now = nowIso();
    const headers = table.headers;
    const existing = table.rows.find((candidate) => String(candidate[keyHeader] || "") === String(keyValue || ""));
    const merged = mergePreservingExisting(existing || {}, row);
    merged[keyHeader] = keyValue;
    merged["Updated At"] = now;

    if (idHeader && !merged[idHeader]) {
      merged[idHeader] = stableId(idPrefix, keyValue);
    }
    if (headers.includes("Created At") && !merged["Created At"]) {
      merged["Created At"] = now;
    }

    if (existing) {
      await this.sheets.updateRow(sheetName, headers, existing._rowNumber, merged);
      return { row: merged, created: false };
    }

    await this.sheets.appendRow(sheetName, headers, merged);
    return { row: merged, created: true };
  }

  async addEvent(event) {
    const key = event.eventId || stableId("event", JSON.stringify(event).slice(0, 5000));
    const row = {
      "Event ID": key,
      Source: event.source,
      "Event Type": event.eventType,
      "Entity Key": event.entityKey || "",
      "Received At": event.receivedAt || nowIso(),
      "Processed At": event.processedAt || nowIso(),
      Status: event.status || "processed",
      Summary: event.summary || "",
      "Raw Payload": JSON.stringify(event.rawPayload || {})
    };
    return this.upsert(SHEETS.events, "Event ID", key, row);
  }

  async findDealByCompany(company) {
    const needle = String(company || "").trim().toLowerCase();
    const table = await this.read(SHEETS.deals);
    return table.rows.find((row) => String(row.Company || "").trim().toLowerCase() === needle);
  }

  async findDealByKey(input) {
    const key = entityKey(input);
    const table = await this.read(SHEETS.deals);
    return table.rows.find((row) => row["Entity Key"] === key);
  }
}

module.exports = { Repository, mergePreservingExisting };
