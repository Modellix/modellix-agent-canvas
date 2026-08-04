import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_PROFILE } from "../mcp/lib/modellix-contracts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = async (...parts) => JSON.parse(await readFile(path.join(root, ...parts), "utf8"));

test("host manifests use the documented config shapes and the same release version", async () => {
  const [pkg, server, openPlugin, codex, cursor, claude, codexMarketplace, cursorMarketplace, claudeMarketplace, openMcp, codexMcp, cursorMcp, claudeMcp, opencode] = await Promise.all([
    json("package.json"),
    json("server.json"),
    json(".plugin", "plugin.json"),
    json(".codex-plugin", "plugin.json"),
    json(".cursor-plugin", "plugin.json"),
    json(".claude-plugin", "plugin.json"),
    json(".agents", "plugins", "marketplace.json"),
    json(".cursor-plugin", "marketplace.json"),
    json(".claude-plugin", "marketplace.json"),
    json(".mcp.json"),
    json(".mcp.codex.json"),
    json("mcp.json"),
    json(".mcp.claude.json"),
    json("adapters", "opencode", "opencode.json"),
  ]);
  assert.equal(openPlugin.version, pkg.version);
  assert.equal(openPlugin.skills, "./skills/");
  assert.equal(openPlugin.mcpServers, "./.mcp.json");
  assert.equal(codex.version, pkg.version);
  assert.equal(codex.mcpServers, "./.mcp.codex.json");
  assert.equal(DEFAULT_PROFILE, "default");
  assert.equal(cursor.version, pkg.version);
  assert.equal(cursor.skills, "./skills/");
  assert.equal(cursor.mcpServers, "./mcp.json");
  assert.equal(claude.version, pkg.version);
  assert.equal(pkg.name, "@modellix/agent-canvas");
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(codexMarketplace.plugins[0].source.source, "local");
  assert.equal(codexMarketplace.plugins[0].source.path, "./");
  assert.equal(cursorMarketplace.name, "modellix");
  assert.equal(cursorMarketplace.plugins[0].name, cursor.name);
  assert.equal(cursorMarketplace.plugins[0].source, "./");
  assert.equal(typeof cursorMarketplace.plugins[0].source, "string");
  assert.equal(claudeMarketplace.plugins[0].source.package, pkg.name);
  assert.equal(claudeMarketplace.plugins[0].source.version, pkg.version);
  assert.equal(cursor.variables, undefined);
  assert.equal(claude.userConfig, undefined);
  assert.equal(openMcp.mcpServers["modellix-agent-canvas"].command, "npx");
  assert.deepEqual(openMcp.mcpServers["modellix-agent-canvas"].args.slice(0, 4), ["-y", "--package", `${pkg.name}@${pkg.version}`, "modellix-agent-canvas"]);
  assert.match(openMcp.mcpServers["modellix-agent-canvas"].args.join(" "), /--host cursor/u);
  assert.equal(openMcp.mcpServers["modellix-agent-canvas"].cwd, undefined);
  assert.doesNotMatch(openMcp.mcpServers["modellix-agent-canvas"].args.join(" "), /workspaceFolder/u);
  assert.equal(codexMcp.mcpServers["modellix-agent-canvas"].command, "npx");
  assert.deepEqual(codexMcp.mcpServers["modellix-agent-canvas"].args.slice(0, 4), ["-y", "--package", `${pkg.name}@${pkg.version}`, "modellix-agent-canvas"]);
  assert.equal(codexMcp.mcpServers["modellix-agent-canvas"].cwd, undefined);
  assert.match(codexMcp.mcpServers["modellix-agent-canvas"].args.join(" "), /--host codex/u);
  assert.doesNotMatch(codexMcp.mcpServers["modellix-agent-canvas"].args.join(" "), /workspaceFolder|--project-dir/u);
  assert.equal(claudeMcp.mcpServers["modellix-agent-canvas"].command, "npx");
  assert.deepEqual(claudeMcp.mcpServers["modellix-agent-canvas"].args.slice(0, 4), ["-y", "--package", `${pkg.name}@${pkg.version}`, "modellix-agent-canvas"]);
  assert.match(claudeMcp.mcpServers["modellix-agent-canvas"].args.join(" "), /--host claude-code/u);
  assert.match(claudeMcp.mcpServers["modellix-agent-canvas"].args.join(" "), /CLAUDE_PROJECT_DIR/u);
  assert.doesNotMatch(claudeMcp.mcpServers["modellix-agent-canvas"].args.join(" "), /CLAUDE_PLUGIN_ROOT/u);
  assert.equal(claudeMcp.mcpServers["modellix-agent-canvas"].env.MODELLIX_API_KEY, undefined);
  assert.equal(cursorMcp.mcpServers["modellix-agent-canvas"].env, undefined);
  assert.deepEqual(opencode.mcp.servers["modellix-agent-canvas"].command.slice(0, 5), ["npx", "-y", "--package", `${pkg.name}@${pkg.version}`, "modellix-agent-canvas"]);
  assert.deepEqual(cursorMcp.mcpServers["modellix-agent-canvas"].args.slice(0, 4), ["-y", "--package", `${pkg.name}@${pkg.version}`, "modellix-agent-canvas"]);
  assert.doesNotMatch(cursorMcp.mcpServers["modellix-agent-canvas"].args.join(" "), /workspaceFolder|--project-dir/u);
  assert.equal(opencode.mcp.servers["modellix-agent-canvas"].environment, undefined);
});

test("OpenCode skill mirrors are byte-identical to canonical skills", async () => {
  for (const name of [
    "modellix-agent-canvas-open",
    "modellix-agent-canvas-image-gen",
    "modellix-agent-canvas-image-edit",
  ]) {
    const canonical = await readFile(path.join(root, "skills", name, "SKILL.md"));
    const mirror = await readFile(path.join(root, ".agents", "skills", name, "SKILL.md"));
    assert.equal(createHash("sha256").update(canonical).digest("hex"), createHash("sha256").update(mirror).digest("hex"));
  }
});

test("public adapters contain production placeholders but no QA origins or literal API keys", async () => {
  const files = [
    ".mcp.json",
    ".mcp.codex.json",
    ".mcp.claude.json",
    "mcp.json",
    "adapters/opencode/opencode.json",
    ".cursor-plugin/marketplace.json",
    ".cursor-plugin/plugin.json",
    "README.md",
    "docs/README.zh-CN.md",
  ];
  for (const file of files) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(content, /https?:\/\/[^/\s]*\bqa\b[^/\s]*/iu, file);
    assert.doesNotMatch(content, /mod-[A-Za-z0-9_-]{16,}/u, file);
  }
});
