const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = join(__dirname, "..");
const ignoredDirs = new Set([".git", "node_modules"]);

function jsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...jsFiles(path));
    if (stat.isFile() && entry.endsWith(".js")) files.push(path);
  }
  return files;
}

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

for (const file of jsFiles(root)) {
  run(["--check", file]);
}

run(["--test", "test/domain.test.js"]);
console.log("Local verification passed.");
