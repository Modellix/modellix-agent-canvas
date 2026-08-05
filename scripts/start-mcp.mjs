#!/usr/bin/env node

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const resolveFromPlugin = createRequire(path.join(ROOT_DIR, "package.json")).resolve;
const packageMetadata = JSON.parse(await readFile(path.join(ROOT_DIR, "package.json"), "utf8"));
const REQUIRED_DEPENDENCIES = new Map([
  ["@modelcontextprotocol/ext-apps", "@modelcontextprotocol/ext-apps"],
  ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/server/mcp.js"],
  ["ajv", "ajv/package.json"],
  ["ajv-formats", "ajv-formats/package.json"],
  ["image-size", "image-size"],
  ["modellix-cli", "modellix-cli/bin/run.js"],
  ["proper-lockfile", "proper-lockfile"],
  ["zod", "zod"],
]);

function missingDependencies() {
  return [...REQUIRED_DEPENDENCIES]
    .filter(([, specifier]) => {
      try {
        resolveFromPlugin(specifier);
        return false;
      } catch {
        return true;
      }
    })
    .map(([packageName]) => packageName);
}

const missing = missingDependencies();
const widgetPath = path.join(ROOT_DIR, "mcp", "static", "canvas.html");
const nodeVersion = process.versions.node.split(".").map(Number);
const nodeSupported = (nodeVersion[0] === 20 && nodeVersion[1] >= 19)
  || (nodeVersion[0] >= 22 && (nodeVersion[0] > 22 || nodeVersion[1] >= 12));

if (process.argv.includes("--doctor")) {
  const report = {
    ok: nodeSupported && missing.length === 0 && existsSync(widgetPath),
    package: packageMetadata.name,
    version: packageMetadata.version,
    node: {
      version: process.versions.node,
      supported: nodeSupported,
      required: packageMetadata.engines?.node,
    },
    runtimeDependencies: {
      complete: missing.length === 0,
      missing,
    },
    widget: {
      bundled: existsSync(widgetPath),
    },
    supportedHosts: ["codex", "cursor", "claude-code", "opencode", "generic"],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

if (missing.length > 0) {
  throw new Error(
    `Modellix Agent Canvas is missing runtime dependencies: ${missing.join(", ")}. `
    + `Reinstall ${packageMetadata.name}@${packageMetadata.version} through the host plugin, `
    + "or run npm ci when working from a source checkout. Use --doctor for a complete runtime report.",
  );
}

const WORKSPACE_CWD = process.env.MODELLIX_WORKSPACE_CWD || process.cwd();
process.env.MODELLIX_WORKSPACE_CWD = WORKSPACE_CWD;
await import(pathToFileURL(path.join(ROOT_DIR, "mcp", "server.mjs")).href);
