const { loadConfig } = require("../src/config");
const { SheetsClient } = require("../src/sheets/client");
const { bootstrapSpreadsheet } = require("../src/sheets/bootstrap");

async function main() {
  const config = loadConfig({ strict: false });
  const sheetsClient = await SheetsClient.create({
    spreadsheetId: config.google.spreadsheetId,
    serviceAccountJson: config.google.serviceAccountJson
  });
  const result = await bootstrapSpreadsheet(sheetsClient);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
