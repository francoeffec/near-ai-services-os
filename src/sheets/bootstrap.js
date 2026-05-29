const { CONFIG_ROWS, SCHEMAS, SHEETS } = require("../schema");
const { cleanText, entityKey, nowIso, stableId } = require("../domain/normalize");

const LEGACY_HEADER_ALIASES = {
  Stage: "Deal Stage",
  "Call Had Date": "Call Date",
  "Engineer ": "Owner",
  Engineer: "Owner",
  Hours: "Hours/Week"
};

function migrateRows(sheetName, headers, rows, targetHeaders) {
  const now = nowIso();
  return rows
    .filter((row) => Object.values(row).some((value) => cleanText(value)))
    .map((row) => {
      const migrated = {};
      for (const header of headers) {
        if (!header || header.startsWith("_")) continue;
        const target = LEGACY_HEADER_ALIASES[header] || header;
        if (targetHeaders.includes(target) && cleanText(row[header]) && !cleanText(migrated[target])) {
          migrated[target] = row[header];
        }
      }

      if (sheetName === SHEETS.leads) {
        const key = entityKey(migrated);
        migrated["Entity Key"] = migrated["Entity Key"] || key;
        migrated["Lead ID"] = migrated["Lead ID"] || stableId("lead", key);
        migrated["Lead Stage"] = migrated["Lead Stage"] || migrated.Stage || "Positive Response";
      }

      if (sheetName === SHEETS.deals) {
        const key = entityKey(migrated);
        migrated["Entity Key"] = migrated["Entity Key"] || key;
        migrated["Deal ID"] = migrated["Deal ID"] || stableId("deal", key || migrated.Company);
        migrated["Deal Stage"] = migrated["Deal Stage"] || "Call Booked";
        migrated["Call Status"] = migrated["Call Status"] || (migrated["Call Date"] ? "Scheduled" : "");
        migrated["Handoff Status"] = migrated["Handoff Status"] || "";
      }

      if (sheetName === SHEETS.handoff) {
        const key = entityKey(migrated);
        migrated["Entity Key"] = migrated["Entity Key"] || key;
        migrated["Handoff ID"] = migrated["Handoff ID"] || stableId("handoff", key || migrated.Company);
      }

      if (targetHeaders.includes("Created At")) migrated["Created At"] = migrated["Created At"] || now;
      if (targetHeaders.includes("Updated At")) migrated["Updated At"] = migrated["Updated At"] || now;
      return migrated;
    });
}

async function bootstrapSpreadsheet(sheetsClient) {
  const sheetNames = Object.values(SHEETS);
  await sheetsClient.ensureSheets(sheetNames);

  const results = [];
  for (const sheetName of sheetNames) {
    const targetHeaders = SCHEMAS[sheetName];
    const table = await sheetsClient.readTable(sheetName);
    const migratedRows = migrateRows(sheetName, table.headers, table.rows, targetHeaders);
    await sheetsClient.writeHeader(sheetName, targetHeaders);
    if (migratedRows.length > 0) {
      await sheetsClient.writeRows(sheetName, targetHeaders, migratedRows);
    }
    results.push({ sheetName, rowsPreserved: migratedRows.length, columns: targetHeaders.length });
  }

  const configTable = await sheetsClient.readTable(SHEETS.config);
  const hasConfigRows = configTable.rows.some((row) => cleanText(row.Type));
  if (!hasConfigRows) {
    await sheetsClient.appendValues(SHEETS.config, CONFIG_ROWS);
  }

  return results;
}

module.exports = { bootstrapSpreadsheet, migrateRows };
