const { loadConfig, validateConfig } = require("../src/config");

const config = loadConfig({ strict: false });
const result = validateConfig(config, {
  requireIntegrations: process.argv.includes("--require-integrations")
});

if (!result.ok) {
  console.error(`Missing or invalid environment variables: ${result.missing.join(", ")}`);
  process.exit(1);
}

console.log("Environment validation passed.");
