const baseUrl = process.argv[2];
const adminToken = process.env.ADMIN_TOKEN || process.argv[3] || "";

if (!baseUrl) {
  console.error("Usage: node scripts/smoke-deploy.js https://YOUR_HOST [ADMIN_TOKEN]");
  process.exit(1);
}

async function check(path, options = {}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, options);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${body}`);
  }
  console.log(`${path}: ${body}`);
}

async function main() {
  await check("/healthz");
  await check("/readyz");
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
