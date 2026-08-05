import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { modellixStaticHtml } from "../mcp/lib/modellix-static-widget.mjs";
import { pluginPath, pluginRoot } from "../mcp/lib/plugin-root.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("plugin paths are anchored to the installed package", () => {
  assert.equal(pluginRoot(), repositoryRoot);
  assert.equal(pluginPath("mcp", "static", "canvas.html"), path.join(repositoryRoot, "mcp", "static", "canvas.html"));
});

test("runtime serves one prebuilt self-contained MCP Apps document", async () => {
  const html = await modellixStaticHtml();
  assert.match(html, /<html\b/iu);
  assert.match(html, /<script\b/iu);
  assert.match(html, /^\s*<script\s+type="module">\s*$/imu);
  assert.equal(/^\s*<script>\s*$/imu.test(html), false, "bundled scripts must not lose module semantics");
  assert.match(html, /esm\.sh\/@excalidraw/u);
  assert.match(html, /local\("DejaVu Sans"\)/u);
  assert.match(html, /__zod_globalConfig/u);
  assert.match(html, /jitless:\s*(?:true|!0)/u);
  assert.equal(html.includes('"unload"'), false, "the packaged Widget must not register deprecated unload handlers");
  assert.match(html, /"pagehide"/u);
  assert.match(html, /modellixMcp/u);
  assert.doesNotMatch(html, /AIzaSy[A-Za-z0-9_-]{20,}/u, "the packaged Widget must not contain literal Google API keys");
  assert.ok(Buffer.byteLength(html, "utf8") < 9 * 1024 * 1024, "the Widget must fit the MCP stdio transport budget");
  assert.equal(await modellixStaticHtml(), html, "the validated widget should be cached");
});

test("runtime modules do not compile or rewrite frontend assets", async () => {
  const loader = await source("mcp/lib/modellix-static-widget.mjs");
  const resource = await source("mcp/lib/widget-resource.mjs");
  for (const forbidden of ["node:child_process", "mkdtemp", "runViteBuild"]) {
    assert.equal(loader.includes(forbidden), false, `runtime loader contains build concern: ${forbidden}`);
  }
  for (const forbidden of ["createRequire", "app-with-deps", "inlineWidget", "parseExportMap"]) {
    assert.equal(resource.includes(forbidden), false, `resource registration contains browser-bundle concern: ${forbidden}`);
  }
});

test("launchers never install dependencies or override the package root", async () => {
  const launchers = await Promise.all([
    source("scripts/start-mcp.mjs"),
    source("scripts/start-mcp.sh"),
    source("scripts/start-canvas.sh"),
  ]);
  const combined = launchers.join("\n");
  assert.equal(combined.split(/\r?\n/u).some((line) => /^\s*(?:exec\s+)?npm\s+(?:ci|install)\b/iu.test(line)), false);
  assert.equal(combined.includes("MODELLIX_PLUGIN_ROOT"), false);
});

test("the package exposes a host-independent runtime doctor", async () => {
  const launcher = await source("scripts/start-mcp.mjs");
  assert.match(launcher, /--doctor/u);
  assert.match(launcher, /runtimeDependencies/u);
  assert.match(launcher, /supportedHosts/u);
});

test("development host implements the image service context contract", async () => {
  const viteConfiguration = await source("vite.config.js");
  assert.match(viteConfiguration, /initialize:\s*async\s*\(\)\s*=>\s*\{\}/u);
  assert.match(viteConfiguration, /requireWorkspace:\s*\(\)\s*=>\s*workspaceRoot/u);
});

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, ...relativePath.split("/")), "utf8");
}
