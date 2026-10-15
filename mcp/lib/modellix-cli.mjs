import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { PRODUCTION_API_ORIGIN } from "./modellix-contracts.mjs";
import { resolveLatestCliEntry } from "./modellix-cli-updater.mjs";
import { ModellixCanvasError, sanitizeMessage } from "./modellix-errors.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export class ModellixCli {
  constructor(options = {}) {
    this.pluginRoot = path.resolve(options.pluginRoot || process.cwd());
    this.workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : process.cwd();
    // Let modellix-cli apply its native profile selection order on first use.
    // Once resolved, pin the profile for this MCP process so paid-task prepare,
    // submit, polling, and recovery cannot drift across credentials.
    this.profile = options.profile || process.env.MODELLIX_PROFILE || null;
    this.baseUrl = options.baseUrl || process.env.MODELLIX_BASE_URL || PRODUCTION_API_ORIGIN;
    this.bundledEntry = resolveCliEntry(this.pluginRoot, options.entry);
    this.entry = this.bundledEntry;
    this.entrySource = "bundled";
    this.updateWarning = null;
    this.resolveLatestEntry = options.resolveLatestEntry || resolveLatestCliEntry;
    this.autoUpdate = options.autoUpdate !== false && !options.entry && !process.env.MODELLIX_CLI_ENTRY;
    this.entryResolution = null;
  }

  async compatibility() {
    await this.ensureEntry();
    if (!this.entry) return { available: false, compatible: false, version: null };
    try {
      const versionOutput = (await this.runRaw(["--version"], { timeoutMs: 10_000 })).stdout.trim();
      const version = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u)?.[0] || null;
      await this.runRaw(["file", "upload", "--help"], { timeoutMs: 10_000 });
      return { available: true, compatible: true, version, source: this.entrySource, updateWarning: this.updateWarning };
    } catch (error) {
      if (this.entry !== this.bundledEntry && this.bundledEntry) {
        this.entry = this.bundledEntry;
        this.entrySource = "bundled-fallback";
        this.updateWarning = `The auto-updated modellix-cli was incompatible; using the bundled runtime. ${sanitizeMessage(error.message)}`;
        try {
          const versionOutput = (await this.runRaw(["--version"], { timeoutMs: 10_000 })).stdout.trim();
          const version = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u)?.[0] || null;
          await this.runRaw(["file", "upload", "--help"], { timeoutMs: 10_000 });
          return { available: true, compatible: true, version, source: this.entrySource, updateWarning: this.updateWarning };
        } catch {
          // Report the original compatibility failure below.
        }
      }
      return { available: true, compatible: false, version: null, warning: sanitizeMessage(error.message) };
    }
  }

  async authStatus({ ignoreEnvironment = true } = {}) {
    const args = ["auth", "status", ...this.profileArgs(), "--json"];
    if (ignoreEnvironment) args.push("--ignore-env");
    return this.adoptResolvedProfile(await this.runJson(args, { allowFailure: true }));
  }

  async importEnvironmentKey(environmentName) {
    return this.adoptResolvedProfile(await this.runJson([
      "auth",
      "import-env",
      "--env-var",
      environmentName,
      ...this.profileArgs(),
      "--force",
      "--json",
    ], { preserveApiKeyEnvironment: true }));
  }

  async loginWithStdin(apiKey) {
    return this.adoptResolvedProfile(await this.runJson([
      "auth",
      "login",
      "--api-key-stdin",
      ...this.profileArgs(),
      "--force",
      "--json",
    ], { stdin: `${String(apiKey || "").trim()}\n` }));
  }

  async listModels() {
    const payload = await this.runJson(["model", "list", ...this.profileArgs(), "--json"]);
    return payload.models || payload.data?.models || payload.data || [];
  }

  async uploadFile(filePath) {
    const payload = await this.runJson(["file", "upload", filePath, ...this.profileArgs(), "--json"]);
    if (!payload.file?.fileId || !payload.file?.url) throw new Error("modellix-cli returned invalid upload metadata.");
    return payload.file;
  }

  async deleteFile(fileId) {
    return this.runJson(["file", "delete", fileId, ...this.profileArgs(), "--json"]);
  }

  async submitModel(modelSlug, body) {
    const result = await this.runRaw([
      "model",
      "run",
      "--model-slug",
      modelSlug,
      "--body-file",
      "-",
      ...this.profileArgs(),
      "--output",
      "task-id",
    ], { stdin: `${JSON.stringify(body)}\n`, timeoutMs: 60_000 });
    const taskId = result.stdout.trim().split(/\r?\n/u).find(Boolean);
    if (!taskId) throw new Error("modellix-cli did not return a task ID.");
    return taskId;
  }

  async getTask(taskId, options = {}) {
    return this.runJson(["task", "get", taskId, ...this.profileArgs(), "--json"], options);
  }

  async waitTask(taskId, { timeoutSeconds = 30, signal } = {}) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 45) {
      throw new ModellixCanvasError("INPUT_INVALID", "Wait duration must be an integer from 1 to 45 seconds.");
    }
    // The optional immediate snapshot shares cancellation and the original budget.
    const deadlineSignal = AbortSignal.timeout(timeoutSeconds * 1000 + 5000);
    const waitSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
    const result = await this.runRaw(["task", "wait", taskId, ...this.profileArgs(), "--timeout", `${timeoutSeconds}s`, "--json"], {
      allowFailure: true, timeoutMs: timeoutSeconds * 1000 + 5000, signal: waitSignal,
    });
    if (result.code !== 0 && result.code !== 1 && result.code !== 124) throw classifyCliFailure(result);
    let payload;
    try { payload = JSON.parse(result.stdout); } catch { throw classifyCliFailure(result); }
    if (result.code === 124) {
      const snapshot = payload.snapshots?.find((item) => item.taskId === taskId)?.response;
      if (snapshot?.data?.task_id === taskId) return snapshot;
      // The transport deadline can expire before the first wait response. Read
      // one immediate snapshot rather than submitting again or inventing state.
      return this.getTask(taskId, { signal: waitSignal });
    }
    if (payload?.data?.task_id !== taskId) throw classifyCliFailure(result);
    return payload;
  }

  async downloadTask(taskId, outputDirectory) {
    return this.runJson([
      "task",
      "download",
      taskId,
      ...this.profileArgs(),
      "--output-dir",
      outputDirectory,
      "--json",
    ], { timeoutMs: 10 * 60 * 1000 });
  }

  profileArgs() {
    return this.profile ? ["--profile", this.profile] : [];
  }

  adoptResolvedProfile(payload) {
    const resolved = typeof payload?.profile === "string" ? payload.profile.trim() : "";
    if (resolved) this.profile = resolved;
    return payload;
  }

  async runJson(args, options = {}) {
    const result = await this.runRaw(args, options);
    const text = result.stdout.trim();
    try {
      return JSON.parse(text || "{}");
    } catch (error) {
      throw new Error(`modellix-cli returned invalid JSON: ${sanitizeMessage(text.slice(0, 300))}`, { cause: error });
    }
  }

  async runRaw(args, options = {}) {
    await this.ensureEntry();
    if (!this.entry) {
      throw new ModellixCanvasError("CLI_MISSING", "The installed modellix-cli entry point is missing.", {
        recoveryActions: ["Reinstall Modellix Agent Canvas and retry."],
      });
    }
    const finalArgs = [this.entry, ...args, "--base-url", this.baseUrl, "--no-color", "--no-progress"];
    const result = await spawnCaptured(process.execPath, finalArgs, {
      cwd: this.workspaceRoot,
      env: {
        NODE_ENV: "production",
        ...(options.preserveApiKeyEnvironment ? {} : { MODELLIX_API_KEY: "" }),
        ...options.env,
      },
      stdin: options.stdin,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });
    if (result.code !== 0 && !options.allowFailure) throw classifyCliFailure(result);
    return result;
  }

  async ensureEntry() {
    if (!this.autoUpdate) return this.entry;
    if (!this.entryResolution) {
      this.entryResolution = this.resolveLatestEntry({
        pluginRoot: this.pluginRoot,
        fallbackEntry: this.bundledEntry,
      }).then((resolution) => {
        if (resolution?.entry) this.entry = path.resolve(resolution.entry);
        this.entrySource = resolution?.source || "bundled";
        this.updateWarning = resolution?.updateWarning || null;
        return this.entry;
      }).catch((error) => {
        this.entry = this.bundledEntry;
        this.entrySource = "bundled";
        this.updateWarning = `Could not refresh modellix-cli; using the bundled runtime. ${sanitizeMessage(error.message)}`;
        return this.entry;
      });
    }
    return this.entryResolution;
  }
}

export function resolveCliEntry(pluginRoot, explicitEntry) {
  const candidates = [
    explicitEntry,
    process.env.MODELLIX_CLI_ENTRY,
    resolveInstalledCliEntry(pluginRoot),
    path.join(pluginRoot, "node_modules", "modellix-cli", "bin", "run.js"),
    path.resolve(pluginRoot, "..", "modellix-cli", "bin", "run.js"),
  ].filter(Boolean).map((value) => path.resolve(String(value)));
  return candidates.find((value) => existsSync(value)) || null;
}

function resolveInstalledCliEntry(pluginRoot) {
  try {
    return createRequire(path.join(pluginRoot, "package.json")).resolve("modellix-cli/bin/run.js");
  } catch {
    return null;
  }
}

function spawnCaptured(command, args, options) {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    timer.unref();
    const capture = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) child.kill();
      else target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) { reject(new DOMException("Task wait was canceled.", "AbortError")); return; }
      resolve({
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(options.stdin || "");
  });
}

function classifyCliFailure(result) {
  const message = sanitizeMessage(structuredCliError(result.stdout) || result.stderr || result.stdout || `modellix-cli exited ${result.code}.`);
  if (/outcome is unknown|do not submit|upload outcome is unknown/iu.test(message)) {
    return new ModellixCanvasError("SUBMISSION_UNKNOWN", message);
  }
  if (/payment required|insufficient|recharge/iu.test(message)) return new ModellixCanvasError("INSUFFICIENT_BALANCE", message);
  if (/429|rate limit/iu.test(message)) return new ModellixCanvasError("RATE_LIMITED", message);
  if (/missing api key|not authenticated/iu.test(message)) return new ModellixCanvasError("AUTH_REQUIRED", message);
  if (/invalid or inactive|unauthorized|401/iu.test(message)) return new ModellixCanvasError("AUTH_INVALID", message);
  return new Error(message);
}

function structuredCliError(stdout) {
  try {
    const payload = JSON.parse(String(stdout || "").trim());
    return typeof payload?.error?.message === "string" ? payload.error.message : null;
  } catch {
    return null;
  }
}
