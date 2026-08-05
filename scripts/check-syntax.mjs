import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const roots = ["mcp", "scripts", "test"];
const files = [path.resolve("codex-bootstrap.mjs")];
for (const root of roots) files.push(...await listJavaScript(path.resolve(root)));

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}

process.stdout.write(`Syntax OK: ${files.length} files.\n`);

async function listJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listJavaScript(fullPath));
    else if (entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name)) result.push(fullPath);
  }
  return result;
}
