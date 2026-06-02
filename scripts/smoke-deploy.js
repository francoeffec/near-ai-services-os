const args = process.argv.slice(2);
const baseUrl = args[0];
const requireRobustExtraction = args.includes("--require-robust-extraction");
const adminTokenArg = args.slice(1).find((arg) => !arg.startsWith("--"));
const adminToken = process.env.ADMIN_TOKEN || adminTokenArg || "";

if (!baseUrl) {
  console.error("Usage: node scripts/smoke-deploy.js https://YOUR_HOST [ADMIN_TOKEN] [--require-robust-extraction]");
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
