const { loadConfig } = require("./config");
const { SheetsClient } = require("./sheets/client");
const { Repository } = require("./sheets/repository");
const { OpsService } = require("./ops/service");
const { createSlackApp } = require("./slack/app");
const { attachRoutes } = require("./server");
const { startScheduler } = require("./jobs/scheduler");

async function main() {
  const config = loadConfig();
  const sheetsClient = await SheetsClient.create({
    spreadsheetId: config.google.spreadsheetId,
    serviceAccountJson: config.google.serviceAccountJson,
    scriptWebAppUrl: config.google.scriptWebAppUrl,
    scriptSharedSecret: config.google.scriptSharedSecret
  });
  const repository = new Repository(sheetsClient);
  const opsService = new OpsService({ repository, slackClient: null, config });
  const slack = createSlackApp({ config, opsService });
  opsService.slackClient = slack.app.client;

  attachRoutes({ receiver: slack.receiver, config, opsService, repository, sheetsClient });
  startScheduler({ config, repository });
  await slack.app.start(config.port);
  console.log(`NearAI Services running on port ${config.port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
