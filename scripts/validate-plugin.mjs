import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
const raw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(raw);
const openManifestPath = path.join(root, ".plugin", "plugin.json");
const openRaw = await readFile(openManifestPath, "utf8");
const openManifest = JSON.parse(openRaw);
const cursorManifest = JSON.parse(await readFile(path.join(root, ".cursor-plugin", "plugin.json"), "utf8"));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const server = JSON.parse(await readFile(path.join(root, "server.json"), "utf8"));
const codexMarketplace = JSON.parse(await readFile(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
const cursorMarketplace = JSON.parse(await readFile(path.join(root, ".cursor-plugin", "marketplace.json"), "utf8"));
const claudeMarketplace = JSON.parse(await readFile(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
const adapters = await Promise.all([
  ".mcp.json",
  ".mcp.codex.json",
  "mcp.json",
  ".mcp.claude.json",
].map(async (file) => [file, JSON.parse(await readFile(path.join(root, file), "utf8"))]));
const openCodeAdapter = JSON.parse(await readFile(path.join(root, "adapters", "opencode", "opencode.json"), "utf8"));
const expectedNpxArgs = ["-y", "--package", `${pkg.name}@${pkg.version}`, "modellix-agent-canvas"];

requiredString(manifest.name, "name");
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.name) || manifest.name.length > 64) {
  throw new Error("Plugin name must be lower-case hyphen-case and no longer than 64 characters.");
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
  throw new Error("Plugin version must use semantic versioning.");
}
if (manifest.version !== pkg.version) throw new Error("Plugin and npm package versions must match.");
if (openManifest.name !== manifest.name || openManifest.version !== pkg.version) {
  throw new Error("Open Plugins manifest identity is out of sync.");
}
if (cursorManifest.name !== manifest.name || cursorManifest.version !== pkg.version) {
  throw new Error("Cursor plugin manifest identity is out of sync.");
}
if (cursorManifest.skills !== "./skills/" || cursorManifest.mcpServers !== "./mcp.json") {
  throw new Error("Cursor plugin must declare its canonical skills and Cursor MCP adapter.");
}
for (const field of ["skills", "mcpServers", "logo"]) {
  await assertRelativeFileOrDirectory(cursorManifest[field], `cursorPlugin.${field}`);
}
for (const field of ["homepage", "repository"]) assertHttps(cursorManifest[field], `cursorPlugin.${field}`);
if (pkg.name !== "@modellix/agent-canvas") throw new Error("Unexpected npm package name.");
if (server.name !== pkg.mcpName) throw new Error("server.json name and package.json mcpName must match.");
if (server.version !== pkg.version) throw new Error("server.json and npm package versions must match.");
if (server.packages?.[0]?.identifier !== pkg.name || server.packages?.[0]?.version !== pkg.version) {
  throw new Error("server.json npm package metadata is out of sync.");
}
const codexMarketplaceEntry = codexMarketplace.plugins?.find((candidate) => candidate.name === manifest.name);
if (!codexMarketplaceEntry) throw new Error(`Codex marketplace is missing ${manifest.name}.`);
if (codexMarketplaceEntry.source?.source !== "local" || codexMarketplaceEntry.source?.path !== "./") {
  throw new Error("Codex Git marketplace must install the plugin from the repository root.");
}
if (!await exists(path.resolve(root, codexMarketplaceEntry.source.path, ".codex-plugin", "plugin.json"))) {
  throw new Error("Codex marketplace source does not resolve to a Codex plugin root.");
}
const claudeMarketplaceEntry = claudeMarketplace.plugins?.find((candidate) => candidate.name === manifest.name);
if (!claudeMarketplaceEntry) throw new Error(`Claude marketplace is missing ${manifest.name}.`);
if (claudeMarketplaceEntry.source?.package !== pkg.name || claudeMarketplaceEntry.source?.version !== pkg.version) {
  throw new Error("Claude marketplace npm source is out of sync.");
}
for (const [file, adapter] of adapters) {
  const serverConfig = adapter.mcpServers?.["modellix-agent-canvas"];
  if (serverConfig?.command !== "npx" || !samePrefix(serverConfig.args, expectedNpxArgs)) {
    throw new Error(`${file} must explicitly select the complete pinned npm runtime and executable through npx.`);
  }
}
const openCodeCommand = openCodeAdapter.mcp?.servers?.["modellix-agent-canvas"]?.command;
if (openCodeCommand?.[0] !== "npx" || !samePrefix(openCodeCommand.slice(1), expectedNpxArgs)) {
  throw new Error("OpenCode must explicitly select the complete pinned npm runtime and executable through npx.");
}
requiredString(cursorMarketplace.name, "cursorMarketplace.name");
requiredString(cursorMarketplace.owner?.name, "cursorMarketplace.owner.name");
const cursorMarketplaceEntry = cursorMarketplace.plugins?.find((candidate) => candidate.name === manifest.name);
if (!cursorMarketplaceEntry) throw new Error(`Cursor marketplace is missing ${manifest.name}.`);
if (cursorMarketplaceEntry.source !== "./") {
  throw new Error("Cursor marketplace must use the plugin root as a string source.");
}
requiredString(cursorMarketplaceEntry.description, "cursorMarketplace.plugins[].description");
for (const field of Object.keys(cursorMarketplaceEntry)) {
  if (!["name", "source", "description", "minClientVersions"].includes(field)) {
    throw new Error(`Cursor marketplace entry contains an unsupported field: ${field}`);
  }
}
if (!await exists(path.resolve(root, cursorMarketplaceEntry.source, ".cursor-plugin", "plugin.json"))) {
  throw new Error("Cursor marketplace source does not resolve to a Cursor plugin root.");
}
requiredString(manifest.description, "description");
requiredString(manifest.author?.name, "author.name");
requiredString(openManifest.description, "openPlugin.description");
requiredString(openManifest.author?.name, "openPlugin.author.name");
if (openManifest.license !== pkg.license) throw new Error("Open Plugins and npm licenses must match.");
requiredString(manifest.interface?.displayName, "interface.displayName");
requiredString(manifest.interface?.shortDescription, "interface.shortDescription");
requiredString(manifest.interface?.longDescription, "interface.longDescription");
requiredString(manifest.interface?.developerName, "interface.developerName");
requiredString(manifest.interface?.category, "interface.category");

for (const field of ["homepage", "repository"]) assertHttps(manifest[field], field);
for (const field of ["homepage", "repository"]) assertHttps(openManifest[field], `openPlugin.${field}`);
for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
  assertHttps(manifest.interface?.[field], `interface.${field}`);
}
for (const field of ["skills", "mcpServers"]) await assertRelativeFileOrDirectory(manifest[field], field);
for (const field of ["skills", "mcpServers", "logo"]) {
  await assertRelativeFileOrDirectory(openManifest[field], `openPlugin.${field}`);
}
if (manifest.mcpServers !== "./.mcp.codex.json") {
  throw new Error("Codex plugin must use the Codex-specific MCP adapter.");
}
if (openManifest.mcpServers !== "./.mcp.json") {
  throw new Error("Open Plugins must use the vendor-neutral root MCP adapter.");
}
for (const field of ["composerIcon", "logo", "logoDark"]) {
  if (manifest.interface?.[field]) await assertRelativeFileOrDirectory(manifest.interface[field], `interface.${field}`);
}
if (manifest.apps && !await exists(path.resolve(root, manifest.apps))) {
  throw new Error("plugin.json declares apps but the companion file does not exist.");
}
if (manifest.hooks !== undefined) throw new Error("plugin.json contains the unsupported hooks field.");
const prompts = manifest.interface?.defaultPrompt ?? [];
if (!Array.isArray(prompts) || prompts.length > 3 || prompts.some((item) => typeof item !== "string" || item.length > 128)) {
  throw new Error("interface.defaultPrompt must contain at most three strings of at most 128 characters.");
}
if (/\[TODO:/u.test(raw)) throw new Error("plugin.json contains an unresolved TODO placeholder.");
if (/\[TODO:/u.test(openRaw)) throw new Error("Open Plugins manifest contains an unresolved TODO placeholder.");

process.stdout.write("Plugin manifest OK: required metadata, HTTPS policy links, and companion paths are valid.\n");

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`plugin.json ${field} is required.`);
}

function assertHttps(value, field) {
  requiredString(value, field);
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname) throw new Error(`${field} must be an absolute HTTPS URL.`);
}

async function assertRelativeFileOrDirectory(value, field) {
  requiredString(value, field);
  if (!value.startsWith("./")) throw new Error(`${field} must be a plugin-root relative path beginning with ./`);
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${field} escapes the plugin root.`);
  if (!await exists(target)) throw new Error(`${field} does not exist: ${value}`);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function samePrefix(actual, expected) {
  return Array.isArray(actual) && expected.every((value, index) => actual[index] === value);
}
