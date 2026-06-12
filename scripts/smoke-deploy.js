const args = process.argv.slice(2);
const baseUrl = args[0];
const requireRobustExtraction = args.includes("--require-robust-extraction");
const requireGoogleDocs = args.includes("--require-google-docs");
const googleDocUrlArg = args.find((arg) => arg.startsWith("--google-doc-url="));
const googleDocUrl = googleDocUrlArg ? googleDocUrlArg.slice("--google-doc-url=".length) : process.env.GOOGLE_DOC_SMOKE_URL || "";
const adminTokenArg = args.slice(1).find((arg) => !arg.startsWith("--"));
const adminToken = process.env.ADMIN_TOKEN || adminTokenArg || "";

if (!baseUrl) {
  console.error("Usage: node scripts/smoke-deploy.js https://YOUR_HOST [ADMIN_TOKEN] [--require-robust-extraction] [--require-google-docs] [--google-doc-url=https://docs.google.com/document/d/...]");
  process.exit(1);
}

async function check(path, options = {}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, options);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${body}`);
  }
  console.log(`${path}: ${body}`);
  try {
    return JSON.parse(body);
  } catch (_error) {
    return body;
  }
}

async function main() {
  await check("/healthz");
  const ready = await check("/readyz");
  if (requireRobustExtraction && !ready.extraction?.robust) {
    const warnings = ready.extraction?.warnings || ["Fathom extraction is not in robust mode."];
    throw new Error(`Extraction is not robust: ${warnings.join(" ")}`);
  }
  if (requireGoogleDocs && !ready.googleDocs?.configured) {
    throw new Error("Google Docs fetch is not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_B64.");
  }
  if (googleDocUrl) {
    if (!adminToken) throw new Error("ADMIN_TOKEN is required to smoke-test Google Docs fetch.");
    const result = await check(`/admin/google-docs/fetch?token=${encodeURIComponent(adminToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: googleDocUrl, maxChars: 2000 })
    });
    if (!result.text) throw new Error("Google Docs fetch returned no text.");
  }
  if (adminToken) {
    await check(`/jobs/weekly-metrics?token=${encodeURIComponent(adminToken)}`, {
      method: "POST"
    });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
