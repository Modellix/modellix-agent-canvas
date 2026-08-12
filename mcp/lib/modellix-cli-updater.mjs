import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, devNull } from "node:os";
import path from "node:path";

const CLI_PACKAGE = "modellix-cli";
const PUBLIC_REGISTRY = "https://registry.npmjs.org";
const QUERY_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_NPM_OUTPUT_BYTES = 64 * 1024;

export async function resolveLatestCliEntry(options = {}) {
  const fallbackEntry = options.fallbackEntry ? path.resolve(options.fallbackEntry) : null;
  const environment = options.environment || process.env;
  if (!autoUpdateEnabled(environment)) {
    return { entry: fallbackEntry, source: "bundled", version: await cliEntryVersion(fallbackEntry), updateWarning: null };
  }

  const cacheRoot = path.resolve(options.cacheRoot || cliCacheRoot(environment));
  const queryLatestVersion = options.queryLatestVersion || (() => npmLatestVersion({ cacheRoot, environment }));
  const installVersion = options.installVersion || ((details) => installCliVersion({ ...details, cacheRoot, environment }));
  const cached = await lastKnownLatest(cacheRoot);
  let lockAcquired = false;
  const lockRoot = safeCacheChild(cacheRoot, ".update.lock");

  try {
    await mkdir(cacheRoot, { recursive: true });
    try {
      await mkdir(lockRoot, { recursive: false });
      lockAcquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return cached || {
        entry: fallbackEntry,
        source: "bundled",
        version: await cliEntryVersion(fallbackEntry),
        updateWarning: "Another Modellix CLI update check is already running; using the available runtime for this session.",
      };
    }

    const latestVersion = validVersion(await queryLatestVersion());
    const fallbackVersion = await cliEntryVersion(fallbackEntry);
    if (latestVersion === fallbackVersion) {
      await writeLatestState(cacheRoot, latestVersion);
      return { entry: fallbackEntry, source: "bundled", version: fallbackVersion, updateWarning: null };
    }

    let entry = await cachedCliEntry(cacheRoot, latestVersion);
    if (!entry) {
      const stagingRoot = safeCacheChild(cacheRoot, `.stage-${latestVersion}-${process.pid}-${randomUUID()}`);
      try {
        await mkdir(stagingRoot, { recursive: false });
        await installVersion({ version: latestVersion, stagingRoot });
        const stagedEntry = await installedCliEntry(stagingRoot, latestVersion);
        if (!stagedEntry) throw new Error(`The installed ${CLI_PACKAGE}@${latestVersion} runtime is invalid.`);
        const versionRoot = safeCacheChild(cacheRoot, latestVersion);
        if (!(await cachedCliEntry(cacheRoot, latestVersion))) {
          await rm(versionRoot, { recursive: true, force: true });
          await rename(stagingRoot, versionRoot);
        }
        entry = await cachedCliEntry(cacheRoot, latestVersion);
      } finally {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!entry) throw new Error(`The cached ${CLI_PACKAGE}@${latestVersion} runtime is invalid.`);
    await writeLatestState(cacheRoot, latestVersion);
    return { entry, source: "auto-updated", version: latestVersion, updateWarning: null };
  } catch (error) {
    return cached || {
      entry: fallbackEntry,
      source: "bundled",
      version: await cliEntryVersion(fallbackEntry),
      updateWarning: `Could not refresh ${CLI_PACKAGE}; using the bundled runtime. ${safeMessage(error)}`,
    };
  } finally {
    if (lockAcquired) await rm(lockRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function cliCacheRoot(environment = process.env, platform = process.platform, home = homedir()) {
  if (environment.MODELLIX_CLI_CACHE_DIR) return path.resolve(environment.MODELLIX_CLI_CACHE_DIR);
  if (platform === "win32") {
    return path.join(environment.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Modellix", "AgentCanvas", "cli");
  }
  if (platform === "darwin") return path.join(home, "Library", "Caches", "modellix-agent-canvas", "cli");
  return path.join(environment.XDG_CACHE_HOME || path.join(home, ".cache"), "modellix-agent-canvas", "cli");
}

export function validVersion(value) {
  const version = String(value || "").trim();
  const identifier = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
  const pattern = new RegExp(
    `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${identifier})?(?:\\+${identifier})?$`,
    "u",
  );
  if (!pattern.test(version)) throw new Error(`npm returned an invalid ${CLI_PACKAGE} version.`);
  return version;
}

export function autoUpdateEnabled(environment = process.env) {
  return !/^(?:0|false|off)$/iu.test(String(environment.MODELLIX_CLI_AUTO_UPDATE || "").trim());
}

async function lastKnownLatest(cacheRoot) {
  try {
    const state = JSON.parse(await readFile(path.join(cacheRoot, "latest.json"), "utf8"));
    const version = validVersion(state.version);
    const entry = await cachedCliEntry(cacheRoot, version);
    return entry ? { entry, source: "cached-latest", version, updateWarning: null } : null;
  } catch {
    return null;
  }
}

async function cachedCliEntry(cacheRoot, version) {
  return installedCliEntry(safeCacheChild(cacheRoot, validVersion(version)), version);
}

async function installedCliEntry(root, expectedVersion) {
  const packageRoot = path.join(root, "node_modules", CLI_PACKAGE);
  const entry = path.join(packageRoot, "bin", "run.js");
  try {
    const rootDetails = await lstat(packageRoot);
    const entryDetails = await lstat(entry);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink() || !entryDetails.isFile() || entryDetails.isSymbolicLink()) return null;
    const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    return metadata.name === CLI_PACKAGE && metadata.version === expectedVersion ? entry : null;
  } catch {
    return null;
  }
}

async function cliEntryVersion(entry) {
  if (!entry) return null;
  try {
    const packageRoot = path.resolve(path.dirname(entry), "..");
    const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    return metadata.name === CLI_PACKAGE ? validVersion(metadata.version) : null;
  } catch {
    return null;
  }
}

async function writeLatestState(cacheRoot, version) {
  const target = safeCacheChild(cacheRoot, "latest.json");
  const temporary = safeCacheChild(cacheRoot, `.latest-${process.pid}-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify({ version, checkedAt: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rm(target, { force: true });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function npmLatestVersion({ cacheRoot, environment }) {
  const result = await runNpm([
    "view", `${CLI_PACKAGE}@latest`, "version", "--json", "--registry", PUBLIC_REGISTRY, "--prefer-online",
  ], { cacheRoot, environment, timeoutMs: QUERY_TIMEOUT_MS });
  const parsed = JSON.parse(result.stdout.trim());
  return Array.isArray(parsed) ? parsed.at(-1) : parsed;
}

async function installCliVersion({ version, stagingRoot, cacheRoot, environment }) {
  await runNpm([
    "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", "--save=false",
    "--prefix", stagingRoot, "--registry", PUBLIC_REGISTRY, `${CLI_PACKAGE}@${validVersion(version)}`,
  ], { cacheRoot, environment, timeoutMs: INSTALL_TIMEOUT_MS });
}

async function runNpm(args, { cacheRoot, environment, timeoutMs }) {
  const npmCli = await findNpmCli(environment);
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const finalArgs = npmCli ? [npmCli, ...args] : args;
  const childEnvironment = publicNpmEnvironment(environment, cacheRoot);
  return new Promise((resolve, reject) => {
    const child = spawn(command, finalArgs, {
      env: childEnvironment,
      shell: !npmCli && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref();
    const capture = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_NPM_OUTPUT_BYTES) child.kill();
      else target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code === 0) resolve(result);
      else reject(new Error(`npm ${args[0]} failed (${signal || `exit ${result.code}`}).`));
    });
  });
}

async function findNpmCli(environment) {
  const nodeDirectory = path.dirname(process.execPath);
  const candidates = [
    environment.npm_execpath,
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

function publicNpmEnvironment(environment, cacheRoot) {
  const safe = {};
  for (const [name, value] of Object.entries(environment)) {
    if (/^(?:NODE_AUTH_TOKEN|NPM_TOKEN)$/iu.test(name) || /npm_config_.*(?:auth|token|password)/iu.test(name)) continue;
    safe[name] = value;
  }
  return {
    ...safe,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_cache: path.join(cacheRoot, "npm"),
    npm_config_fund: "false",
    npm_config_registry: PUBLIC_REGISTRY,
    npm_config_update_notifier: "false",
    npm_config_userconfig: devNull,
  };
}

function safeCacheChild(cacheRoot, name) {
  const root = path.resolve(cacheRoot);
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refused to access a path outside the Modellix CLI cache.");
  }
  return target;
}

function safeMessage(error) {
  return String(error?.message || error || "Update unavailable.")
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[redacted]@")
    .replace(/((?:_authToken|_auth|password|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/giu, "$1[redacted]")
    .replace(/\bnpm_[0-9A-Za-z]{20,}\b/gu, "[redacted npm token]")
    .slice(0, 300);
}
