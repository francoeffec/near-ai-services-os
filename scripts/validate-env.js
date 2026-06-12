const { loadConfig, validateConfig } = require("../src/config");

const config = loadConfig({ strict: false });
const result = validateConfig(config, {
  requireIntegrations: process.argv.includes("--require-integrations"),
  requireRobustExtraction: process.argv.includes("--require-robust-extraction"),
  requireGoogleDocs: process.argv.includes("--require-google-docs")
});

if (!result.ok) {
  console.error(`Missing or invalid environment variables: ${result.missing.join(", ")}`);
  process.exit(1);
}

console.log("Environment validation passed.");
