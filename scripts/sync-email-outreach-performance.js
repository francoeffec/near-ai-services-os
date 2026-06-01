const { loadConfig } = require("../src/config");
const { syncEmailOutreachPerformance } = require("../src/ops/metrics");
const { SheetsClient } = require("../src/sheets/client");
const { Repository } = require("../src/sheets/repository");

async function main() {
  const config = loadConfig({ strict: false });
  const sheetsClient = await SheetsClient.create({
    spreadsheetId: config.google.spreadsheetId,
    serviceAccountJson: config.google.serviceAccountJson,
    scriptWebAppUrl: config.google.scriptWebAppUrl,
    scriptSharedSecret: config.google.scriptSharedSecret
  });
  const repository = new Repository(sheetsClient);
  const result = await syncEmailOutreachPerformance({ config, repository, sheetsClient });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
