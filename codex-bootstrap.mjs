#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 3 * 60 * 1000;
const LOCK_POLL_MS = 250;
const HEARTBEAT_MS = 5_000;
const MAX_NPM_ERROR_BYTES = 64 * 1024;

export async function main() {
  assertSupportedNode();
  const metadata = await readPackageMetadata(PLUGIN_ROOT);
  const cacheRoot = runtimeCacheRoot();
  const packageRoot = await ensureRuntime({
    cacheRoot,
    packageName: metadata.name,
    packageVersion: metadata.version,
    packageSpec: runtimePackageSpec(metadata),
  });

  const launchCwd = path.resolve(process.cwd());
  process.env.MODELLIX_WORKSPACE_CWD ||= samePath(launchCwd, PLUGIN_ROOT) ? packageRoot : launchCwd;
  process.chdir(packageRoot);
  await import(pathToFileURL(path.join(packageRoot, "scripts", "start-mcp.mjs")).href);
}

export async function ensureRuntime({ cacheRoot, packageName, packageVersion, packageSpec }) {
  const resolvedCacheRoot = path.resolve(cacheRoot);
  const versionRoot = safeCacheChild(resolvedCacheRoot, versionDirectoryName(packageVersion));
  await mkdir(resolvedCacheRoot, { recursive: true });

  const ready = await runtimePackageRoot(versionRoot, packageName, packageVersion);
  if (ready) return ready;

  const lockRoot = safeCacheChild(resolvedCacheRoot, `.install-${versionDirectoryName(packageVersion)}.lock`);
  const lock = await acquireInstallLock({
    lockRoot,
    ready: () => runtimePackageRoot(versionRoot, packageName, packageVersion),
  });
  if (lock.ready) return lock.ready;

  const stagingRoot = safeCacheChild(
    resolvedCacheRoot,
    `.stage-${versionDirectoryName(packageVersion)}-${process.pid}-${randomUUID()}`,
  );
  let heartbeat;
  try {
    await mkdir(stagingRoot, { recursive: false });
    heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lockRoot, now, now).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    await installRuntime({ packageSpec, stagingRoot });
    const stagedPackageRoot = await runtimePackageRoot(stagingRoot, packageName, packageVersion);
    if (!stagedPackageRoot) {
      throw new Error(`The installed runtime did not contain ${packageName}@${packageVersion}.`);
    }

    const concurrentReady = await runtimePackageRoot(versionRoot, packageName, packageVersion);
    if (!concurrentReady) {
      await removeCacheChild(resolvedCacheRoot, versionRoot);
      await rename(stagingRoot, versionRoot);
    }
    const installed = await runtimePackageRoot(versionRoot, packageName, packageVersion);
    if (!installed) throw new Error("The pinned runtime could not be promoted into the local cache.");
    return installed;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await removeCacheChild(resolvedCacheRoot, stagingRoot).catch(() => {});
    await lock.release().catch(() => {});
  }
}

export function runtimeCacheRoot(environment = process.env, platform = process.platform, home = homedir()) {
  if (environment.MODELLIX_AGENT_CANVAS_RUNTIME_DIR) {
    return path.resolve(environment.MODELLIX_AGENT_CANVAS_RUNTIME_DIR);
  }
  if (environment.MODELLIX_PLUGIN_DATA) {
    return path.resolve(environment.MODELLIX_PLUGIN_DATA, "runtime");
  }
  if (platform === "win32") {
    const base = environment.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(base, "Modellix", "AgentCanvas", "runtime");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", "modellix-agent-canvas", "runtime");
  }
  return path.join(environment.XDG_CACHE_HOME || path.join(home, ".cache"), "modellix-agent-canvas", "runtime");
}

export function versionDirectoryName(version) {
  const value = String(version || "");
  const identifier = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
  const semverPattern = new RegExp(
    `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${identifier})?(?:\\+${identifier})?$`,
    "u",
  );
  if (!semverPattern.test(value)) {
    throw new Error(`Invalid runtime version: ${value || "(empty)"}.`);
  }
  return value.replace(/[^0-9A-Za-z.-]/gu, "_");
}

async function readPackageMetadata(root) {
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (metadata.name !== "@modellix/agent-canvas") throw new Error("Unexpected Modellix runtime package name.");
  versionDirectoryName(metadata.version);
  return metadata;
}

function runtimePackageSpec(metadata) {
  const override = process.env.MODELLIX_AGENT_CANVAS_RUNTIME_SPEC;
  if (!override) return `${metadata.name}@${metadata.version}`;
  if (process.env.MODELLIX_AGENT_CANVAS_BOOTSTRAP_TEST !== "1") {
    throw new Error("A runtime package override is only allowed during an explicit bootstrap test.");
  }
  return override;
}

async function runtimePackageRoot(versionRoot, packageName, packageVersion) {
  const packageRoot = path.join(versionRoot, "node_modules", ...packageName.split("/"));
  try {
    const packageDetails = await lstat(packageRoot);
    if (!packageDetails.isDirectory() || packageDetails.isSymbolicLink()) return null;
    const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (metadata.name !== packageName || metadata.version !== packageVersion) return null;
    const entryDetails = await stat(path.join(packageRoot, "scripts", "start-mcp.mjs"));
    if (!entryDetails.isFile()) return null;
    return packageRoot;
  } catch {
    return null;
  }
}

async function acquireInstallLock({ lockRoot, ready }) {
  const startedAt = Date.now();
  while (true) {
    const available = await ready();
    if (available) return { ready: available, release: async () => {} };
    let acquired = false;
    try {
      await mkdir(lockRoot, { recursive: false });
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    if (acquired) {
      try {
        await writeFile(
          path.join(lockRoot, "owner.json"),
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          { flag: "wx" },
        );
      } catch (error) {
        await rm(lockRoot, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return {
        ready: null,
        release: async () => rm(lockRoot, { recursive: true, force: true }),
      };
    }

    if (await lockIsStale(lockRoot)) {
      await rm(lockRoot, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (Date.now() - startedAt >= LOCK_WAIT_MS) {
      throw new Error("Timed out waiting for another Codex session to install the Modellix runtime.");
    }
    await delay(LOCK_POLL_MS);
  }
}

async function lockIsStale(lockRoot) {
  try {
    const details = await stat(lockRoot);
    return Date.now() - details.mtimeMs >= LOCK_STALE_MS;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function installRuntime({ packageSpec, stagingRoot }) {
  const args = [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--save=false",
    "--prefix",
    stagingRoot,
    packageSpec,
  ];
  const npmCli = await findNpmCli();
  if (npmCli) {
    await runInstaller(process.execPath, [npmCli, ...args]);
    return;
  }
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  await runInstaller(command, args, { shell: process.platform === "win32" });
}

async function findNpmCli() {
  const nodeDirectory = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDirectory, "..", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next common Node/npm layout.
    }
  }
  return null;
}

async function runInstaller(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
      shell: options.shell === true,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_NPM_ERROR_BYTES);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        const safeStderr = sanitizeInstallerError(stderr.trim());
        reject(new Error(`npm runtime installation failed (${signal || `exit ${code}`}).${safeStderr ? ` ${safeStderr}` : ""}`));
      }
    });
  });
}

export function sanitizeInstallerError(value) {
  return String(value || "")
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[redacted]@")
    .replace(/((?:authorization)\s*:\s*(?:bearer|basic)\s+)[^\s]+/giu, "$1[redacted]")
    .replace(/((?:_authToken|_auth|password|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/giu, "$1[redacted]")
    .replace(/\bnpm_[0-9A-Za-z]{20,}\b/gu, "[redacted npm token]")
    .replace(/\bAIzaSy[0-9A-Za-z_-]{20,}\b/gu, "[redacted Google API key]");
}

function safeCacheChild(cacheRoot, name) {
  const target = path.resolve(cacheRoot, name);
  const relative = path.relative(path.resolve(cacheRoot), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refused to access a runtime path outside the Modellix cache.");
  }
  return target;
}

async function removeCacheChild(cacheRoot, target) {
  const safeTarget = safeCacheChild(cacheRoot, path.relative(cacheRoot, target));
  await rm(safeTarget, { recursive: true, force: true });
}

function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  if (major === 20 && minor >= 19) return;
  if (major >= 22 && (major > 22 || minor >= 12)) return;
  throw new Error(`Modellix Agent Canvas requires Node ^20.19.0 or >=22.12.0; found ${version}.`);
}

function samePath(first, second) {
  return process.platform === "win32"
    ? path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase()
    : path.resolve(first) === path.resolve(second);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (samePath(invokedPath, fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`Modellix Agent Canvas bootstrap failed: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
