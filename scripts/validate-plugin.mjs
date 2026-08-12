import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentManifestPath = path.join(root, "plugin.json");
const agentRaw = await readFile(agentManifestPath, "utf8");
const agentManifest = JSON.parse(agentRaw);
const agentMcp = JSON.parse(await readFile(path.join(root, "mcp.json"), "utf8"));
const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
const raw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(raw);
const openManifestPath = path.join(root, ".plugin", "plugin.json");
const openRaw = await readFile(openManifestPath, "utf8");
const openManifest = JSON.parse(openRaw);
const cursorManifest = JSON.parse(await readFile(path.join(root, ".cursor-plugin", "plugin.json"), "utf8"));
const claudeManifest = JSON.parse(await readFile(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const server = JSON.parse(await readFile(path.join(root, "server.json"), "utf8"));
const codexMarketplace = JSON.parse(await readFile(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
const cursorMarketplace = JSON.parse(await readFile(path.join(root, ".cursor-plugin", "marketplace.json"), "utf8"));
const claudeMarketplace = JSON.parse(await readFile(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
const adapters = await Promise.all([
  ".mcp.json",
  "mcp.json",
  ".mcp.claude.json",
].map(async (file) => [file, JSON.parse(await readFile(path.join(root, file), "utf8"))]));
const codexAdapter = JSON.parse(await readFile(path.join(root, ".mcp.codex.json"), "utf8"));
const openCodeAdapter = JSON.parse(await readFile(path.join(root, "adapters", "opencode", "opencode.json"), "utf8"));
const openCodeV2Adapter = JSON.parse(await readFile(path.join(root, "adapters", "opencode", "opencode-v2.json"), "utf8"));
const expectedNpxArgs = ["-y", "--package", `${pkg.name}@${pkg.version}`, "modellix-agent-canvas"];
const agentPluginSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const agentMcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

requiredString(manifest.name, "name");
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.name) || manifest.name.length > 64) {
  throw new Error("Plugin name must be lower-case hyphen-case and no longer than 64 characters.");
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
  throw new Error("Plugin version must use semantic versioning.");
}
if (manifest.version !== pkg.version) throw new Error("Plugin and npm package versions must match.");
validateAgentManifest(agentManifest, agentPluginSchema);
validateAgentMcp(agentMcp, agentMcpSchema);
if (agentManifest.name !== manifest.name || agentManifest.version !== pkg.version) {
  throw new Error("Agent Plugins manifest identity is out of sync.");
}
if (openManifest.name !== manifest.name || openManifest.version !== pkg.version) {
  throw new Error("Open Plugins manifest identity is out of sync.");
}
if (cursorManifest.name !== manifest.name || cursorManifest.version !== pkg.version) {
  throw new Error("Cursor plugin manifest identity is out of sync.");
}
if (claudeManifest.name !== manifest.name || claudeManifest.version !== pkg.version) {
  throw new Error("Claude plugin manifest identity is out of sync.");
}
if (claudeManifest.mcpServers !== "./.mcp.claude.json") {
  throw new Error("Claude plugin must explicitly select its Claude-specific MCP adapter instead of auto-discovering .mcp.json.");
}
if (cursorManifest.skills !== "./skills/" || cursorManifest.mcpServers !== "./.mcp.json") {
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
if (claudeMarketplaceEntry.mcpServers !== claudeManifest.mcpServers) {
  throw new Error("Claude marketplace and plugin manifest must select the same MCP adapter.");
}
await assertRelativeFileOrDirectory(claudeManifest.mcpServers, "claudePlugin.mcpServers");
for (const [file, adapter] of adapters) {
  const serverConfig = adapter.mcpServers?.["modellix-agent-canvas"];
  if (serverConfig?.command !== "npx" || !samePrefix(serverConfig.args, expectedNpxArgs)) {
    throw new Error(`${file} must explicitly select the complete pinned npm runtime and executable through npx.`);
  }
}
const codexServer = codexAdapter.mcpServers?.["modellix-agent-canvas"];
const codexManifestServer = manifest.mcpServers?.["modellix-agent-canvas"];
const agentServer = agentMcp.mcpServers?.["modellix-agent-canvas"];
if (
  agentServer?.type !== "stdio"
  || agentServer.command !== "npx"
  || !samePrefix(agentServer.args, [...expectedNpxArgs, "--host", "generic", "--supports-mcp-apps", "false"])
) {
  throw new Error("Agent Plugins MCP adapter must use the pinned generic stdio runtime with the local fallback.");
}
for (const [label, serverConfig] of [
  ["Codex plugin manifest", codexManifestServer],
  ["Codex standalone adapter", codexServer],
]) {
  if (
    serverConfig?.command !== "node"
    || serverConfig.cwd !== "."
    || !samePrefix(serverConfig.args, ["./codex-bootstrap.mjs", "--host", "codex", "--supports-mcp-apps", "true"])
  ) {
    throw new Error(`${label} must launch the pinned runtime through the plugin-root single-process bootstrap.`);
  }
}
if (JSON.stringify(codexManifestServer) !== JSON.stringify(codexServer)) {
  throw new Error("Codex plugin manifest and standalone adapter must contain the same MCP server configuration.");
}
if (!await exists(path.join(root, "codex-bootstrap.mjs"))) {
  throw new Error("Codex bootstrap entry is missing from the plugin root.");
}
const openCodeCommand = openCodeAdapter.mcp?.["modellix-agent-canvas"]?.command;
if (openCodeCommand?.[0] !== "npx" || !samePrefix(openCodeCommand.slice(1), expectedNpxArgs)) {
  throw new Error("OpenCode stable must explicitly select the complete pinned npm runtime and executable through npx.");
}
const openCodeV2Command = openCodeV2Adapter.mcp?.servers?.["modellix-agent-canvas"]?.command;
if (openCodeV2Command?.[0] !== "npx" || !samePrefix(openCodeV2Command.slice(1), expectedNpxArgs)) {
  throw new Error("OpenCode V2 must explicitly select the complete pinned npm runtime and executable through npx.");
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
requiredString(agentManifest.description, "agentPlugin.description");
requiredString(agentManifest.author?.name, "agentPlugin.author.name");
requiredString(openManifest.description, "openPlugin.description");
requiredString(openManifest.author?.name, "openPlugin.author.name");
if (agentManifest.license !== pkg.license) throw new Error("Agent Plugins and npm licenses must match.");
if (openManifest.license !== pkg.license) throw new Error("Open Plugins and npm licenses must match.");
requiredString(manifest.interface?.displayName, "interface.displayName");
requiredString(manifest.interface?.shortDescription, "interface.shortDescription");
requiredString(manifest.interface?.longDescription, "interface.longDescription");
requiredString(manifest.interface?.developerName, "interface.developerName");
requiredString(manifest.interface?.category, "interface.category");

for (const field of ["homepage", "repository"]) assertHttps(manifest[field], field);
for (const field of ["homepage", "repository"]) assertHttps(agentManifest[field], `agentPlugin.${field}`);
for (const field of ["homepage", "repository"]) assertHttps(openManifest[field], `openPlugin.${field}`);
for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
  assertHttps(manifest.interface?.[field], `interface.${field}`);
}
await assertRelativeFileOrDirectory(manifest.skills, "skills");
for (const field of ["skills", "mcpServers", "logo"]) {
  await assertRelativeFileOrDirectory(openManifest[field], `openPlugin.${field}`);
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
if (/\[TODO:/u.test(agentRaw)) throw new Error("Agent Plugins manifest contains an unresolved TODO placeholder.");
if (/\[TODO:/u.test(openRaw)) throw new Error("Open Plugins manifest contains an unresolved TODO placeholder.");

process.stdout.write("Plugin manifests OK: Agent Plugins 1.0.0, host metadata, and companion paths are valid.\n");

function validateAgentManifest(value, expectedSchema) {
  assertObject(value, "Agent Plugins plugin.json");
  assertOnlyFields(value, [
    "$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions",
  ], "Agent Plugins plugin.json");
  if (value.$schema !== expectedSchema) throw new Error(`Agent Plugins plugin.json must target ${expectedSchema}.`);
  requiredString(value.name, "agentPlugin.name");
  if (value.name.length > 64 || !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value.name)) {
    throw new Error("Agent Plugins name violates the 1.0.0 name constraints.");
  }
  for (const field of ["version", "description", "homepage", "repository", "license"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`agentPlugin.${field} must be a string.`);
  }
  if (value.author !== undefined) {
    assertObject(value.author, "agentPlugin.author");
    assertOnlyFields(value.author, ["name", "email", "url"], "agentPlugin.author");
    for (const [field, entry] of Object.entries(value.author)) {
      if (typeof entry !== "string") throw new Error(`agentPlugin.author.${field} must be a string.`);
    }
  }
  if (value.keywords !== undefined && (!Array.isArray(value.keywords) || value.keywords.some((entry) => typeof entry !== "string"))) {
    throw new Error("agentPlugin.keywords must be an array of strings.");
  }
  if (value.extensions !== undefined) {
    assertObject(value.extensions, "agentPlugin.extensions");
    for (const [namespace, extension] of Object.entries(value.extensions)) {
      if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u.test(namespace)) throw new Error(`Invalid Agent Plugins extension namespace: ${namespace}`);
      assertObject(extension, `agentPlugin.extensions.${namespace}`);
    }
  }
}

function validateAgentMcp(value, expectedSchema) {
  assertObject(value, "Agent Plugins mcp.json");
  assertOnlyFields(value, ["$schema", "mcpServers"], "Agent Plugins mcp.json");
  if (value.$schema !== expectedSchema) throw new Error(`Agent Plugins mcp.json must target ${expectedSchema}.`);
  assertObject(value.mcpServers, "agentMcp.mcpServers");
  for (const [name, server] of Object.entries(value.mcpServers)) {
    assertObject(server, `agentMcp.mcpServers.${name}`);
    if (server.type === "stdio") {
      assertOnlyFields(server, ["type", "command", "args", "env", "cwd"], `agentMcp.mcpServers.${name}`);
      requiredString(server.command, `agentMcp.mcpServers.${name}.command`);
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((entry) => typeof entry !== "string"))) {
        throw new Error(`agentMcp.mcpServers.${name}.args must be an array of strings.`);
      }
      if (server.env !== undefined) {
        assertObject(server.env, `agentMcp.mcpServers.${name}.env`);
        for (const [key, entry] of Object.entries(server.env)) {
          if (["PLUGIN_ROOT", "PLUGIN_DATA"].includes(key) || typeof entry !== "string") {
            throw new Error(`agentMcp.mcpServers.${name}.env contains an invalid entry: ${key}`);
          }
        }
      }
      if (server.cwd !== undefined && (typeof server.cwd !== "string" || !/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/u.test(server.cwd))) {
        throw new Error(`agentMcp.mcpServers.${name}.cwd is not an Agent Plugins path.`);
      }
      continue;
    }
    if (server.type === "streamable-http" || server.type === "sse") {
      assertOnlyFields(server, ["type", "url", "headers"], `agentMcp.mcpServers.${name}`);
      requiredString(server.url, `agentMcp.mcpServers.${name}.url`);
      if (server.headers !== undefined) {
        assertObject(server.headers, `agentMcp.mcpServers.${name}.headers`);
        if (Object.values(server.headers).some((entry) => typeof entry !== "string")) {
          throw new Error(`agentMcp.mcpServers.${name}.headers must contain only strings.`);
        }
      }
      continue;
    }
    throw new Error(`agentMcp.mcpServers.${name} has an unsupported transport type.`);
  }
}

function assertObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
}

function assertOnlyFields(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} contains unsupported fields: ${unknown.join(", ")}`);
}

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
