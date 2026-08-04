import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { PRODUCTION_API_ORIGIN } from "./modellix-contracts.mjs";
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
    this.entry = resolveCliEntry(this.pluginRoot, options.entry);
  }

  async compatibility() {
    if (!this.entry) return { available: false, compatible: false, version: null };
    try {
      const versionOutput = (await this.runRaw(["--version"], { timeoutMs: 10_000 })).stdout.trim();
      const version = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u)?.[0] || null;
      await this.runRaw(["file", "upload", "--help"], { timeoutMs: 10_000 });
      return { available: true, compatible: true, version };
    } catch (error) {
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

  async getTask(taskId) {
    return this.runJson(["task", "get", taskId, ...this.profileArgs(), "--json"]);
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
    });
    if (result.code !== 0 && !options.allowFailure) throw classifyCliFailure(result);
    return result;
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
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
