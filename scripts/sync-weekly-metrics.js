const { loadConfig } = require("../src/config");
const { SheetsClient } = require("../src/sheets/client");
const { Repository } = require("../src/sheets/repository");
const { syncWeeklyMetrics } = require("../src/ops/metrics");

async function main() {
  const config = loadConfig({ strict: false });
  const sheetsClient = await SheetsClient.create({
    spreadsheetId: config.google.spreadsheetId,
    serviceAccountJson: config.google.serviceAccountJson
  });
  const repository = new Repository(sheetsClient);
  const result = await syncWeeklyMetrics({ config, repository });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
