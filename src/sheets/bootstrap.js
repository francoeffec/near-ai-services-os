const { CONFIG_ROWS, SCHEMAS, SHEETS } = require("../schema");
const { cleanText, entityKey, sheetDateTime, stableId } = require("../domain/normalize");

const LEGACY_HEADER_ALIASES = {
  Stage: "Deal Stage",
  "Call Date": "Call Had Date",
  "Engineer ": "Owner",
  Engineer: "Owner",
  Hours: "Hours/Week"
};

const BODY_DROPDOWNS = {
  [SHEETS.leads]: [
    { header: "Source", range: "=Config!$C$14:$C$19" },
    { header: "Lead Stage", range: "=Config!$C$2:$C$4" },
    { header: "Owner", range: "=Config!$C$20:$C$28" }
  ],
  [SHEETS.deals]: [
    { header: "Source", range: "=Config!$C$14:$C$19" },
    { header: "Deal Stage", range: "=Config!$C$5:$C$13" },
    { header: "Owner", range: "=Config!$C$20:$C$28" }
  ],
  [SHEETS.handoff]: [
    { header: "Owner", range: "=Config!$C$20:$C$28" },
    { header: "Trigger Stage", range: "=Config!$C$29:$C$30" }
  ]
};

const BODY_CHECKBOXES = {
  [SHEETS.handoff]: ["Send Handoff Recap"]
};

function dropdownRule(range) {
  return {
    condition: {
      type: "ONE_OF_RANGE",
      values: [{ userEnteredValue: range }]
    },
    strict: true,
    showCustomUi: true
  };
}

function checkboxRule() {
  return {
    condition: {
      type: "BOOLEAN"
    },
    strict: true,
    showCustomUi: true
  };
}

function buildValidationRequests(metadata) {
  const sheetByTitle = new Map((metadata.sheets || []).map((sheet) => [sheet.properties.title, sheet]));
  const requests = [];

  for (const [sheetName, dropdowns] of Object.entries(BODY_DROPDOWNS)) {
    const sheet = sheetByTitle.get(sheetName);
    const headers = SCHEMAS[sheetName] || [];
    if (!sheet || headers.length === 0) continue;

    const sheetId = sheet.properties.sheetId;
    const rowCount = sheet.properties.gridProperties?.rowCount || 1000;
    const bodyRange = {
      sheetId,
      startRowIndex: 1,
      endRowIndex: rowCount,
      startColumnIndex: 0,
      endColumnIndex: headers.length
    };

    requests.push({ setDataValidation: { range: bodyRange } });

    for (const dropdown of dropdowns) {
      const columnIndex = headers.indexOf(dropdown.header);
      if (columnIndex === -1) continue;
      requests.push({
        setDataValidation: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: rowCount,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1
          },
          rule: dropdownRule(dropdown.range)
        }
      });
    }

    for (const header of BODY_CHECKBOXES[sheetName] || []) {
      const columnIndex = headers.indexOf(header);
      if (columnIndex === -1) continue;
      requests.push({
        setDataValidation: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: rowCount,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1
          },
          rule: checkboxRule()
        }
      });
    }
  }

  return requests;
}

async function applySheetValidations(sheetsClient) {
  const metadata = await sheetsClient.getMetadata();
  const requests = buildValidationRequests(metadata);
  if (requests.length > 0) await sheetsClient.batchUpdate(requests);
}

function migrateRows(sheetName, headers, rows, targetHeaders) {
  const now = sheetDateTime();
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
        const replySummary = cleanText(row["Reply Summary"]);
        const existingNotes = cleanText(migrated.Notes);
        if (targetHeaders.includes("Notes") && replySummary && !existingNotes.includes(replySummary)) {
          migrated.Notes = existingNotes ? `${existingNotes}\n${row["Reply Summary"]}` : row["Reply Summary"];
        }
        const key = entityKey(migrated);
        migrated["Entity Key"] = migrated["Entity Key"] || key;
        migrated["Lead ID"] = migrated["Lead ID"] || stableId("lead", key);
        migrated["Lead Stage"] = migrated["Lead Stage"] || migrated.Stage || "Replied Positive";
      }

      if (sheetName === SHEETS.deals) {
        const key = entityKey(migrated);
        migrated["Entity Key"] = migrated["Entity Key"] || key;
        migrated["Deal ID"] = migrated["Deal ID"] || stableId("deal", key || migrated.Company);
        migrated["Deal Stage"] = migrated["Deal Stage"] || "Call Booked";
        migrated["Call Status"] = migrated["Call Status"] || (migrated["Call Had Date"] || migrated["Call Date"] ? "Scheduled" : "");
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

  await applySheetValidations(sheetsClient);

  return results;
}

module.exports = { applySheetValidations, bootstrapSpreadsheet, buildValidationRequests, migrateRows };
