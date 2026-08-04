import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "skills");
const destination = path.join(root, ".agents", "skills");

await mkdir(destination, { recursive: true });
for (const entry of await readdir(destination, { withFileTypes: true })) {
  if (entry.isDirectory()) await rm(path.join(destination, entry.name), { recursive: true, force: true });
}
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith("modellix-agent-canvas-")) {
    await cp(path.join(source, entry.name), path.join(destination, entry.name), { recursive: true });
  }
}

console.log("Synced canonical skills into .agents/skills.");
