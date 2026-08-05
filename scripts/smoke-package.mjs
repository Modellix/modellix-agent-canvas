import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "modellix-agent-canvas-package-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required to run the package smoke test.");

try {
  const packResult = runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot], root);
  const packed = JSON.parse(packResult.stdout);
  const tarball = path.join(temporaryRoot, packed[0].filename);
  if (!existsSync(tarball)) throw new Error("npm pack did not create the Canvas tarball.");

  await writeFile(path.join(temporaryRoot, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
  const cacheRoot = path.join(temporaryRoot, "npm-cache");
  const npxDoctor = runNpm([
    "exec", "--yes", "--package", tarball, "--", "modellix-agent-canvas", "--doctor",
  ], temporaryRoot, { npm_config_cache: cacheRoot });
  const npxDoctorReport = JSON.parse(npxDoctor.stdout);
  if (!npxDoctorReport.ok || npxDoctorReport.version !== sourcePackage.version) {
    throw new Error(`Cold npx package launch failed: ${npxDoctor.stdout}`);
  }

  const bootstrapCache = path.join(temporaryRoot, "codex-bootstrap-runtime");
  const bootstrapEnvironment = {
    MODELLIX_AGENT_CANVAS_BOOTSTRAP_TEST: "1",
    MODELLIX_AGENT_CANVAS_RUNTIME_DIR: bootstrapCache,
    MODELLIX_AGENT_CANVAS_RUNTIME_SPEC: tarball,
    npm_config_cache: cacheRoot,
  };
  const bootstrapEntry = path.join(root, "codex-bootstrap.mjs");
  const coldBootstrap = run(process.execPath, [bootstrapEntry, "--doctor"], root, bootstrapEnvironment);
  const coldBootstrapReport = JSON.parse(coldBootstrap.stdout);
  if (!coldBootstrapReport.ok || coldBootstrapReport.version !== sourcePackage.version) {
    throw new Error(`Cold Codex bootstrap failed: ${coldBootstrap.stdout}`);
  }
  const cachedRuntimeMetadata = path.join(
    bootstrapCache,
    sourcePackage.version,
    "node_modules",
    "@modellix",
    "agent-canvas",
    "package.json",
  );
  const firstCacheMtime = (await stat(cachedRuntimeMetadata)).mtimeMs;
  const warmBootstrap = run(process.execPath, [bootstrapEntry, "--doctor"], root, bootstrapEnvironment);
  const warmBootstrapReport = JSON.parse(warmBootstrap.stdout);
  if (!warmBootstrapReport.ok || (await stat(cachedRuntimeMetadata)).mtimeMs !== firstCacheMtime) {
    throw new Error("Warm Codex bootstrap did not reuse the installed runtime.");
  }

  const concurrentCache = path.join(temporaryRoot, "codex-bootstrap-concurrent");
  const concurrentEnvironment = {
    ...bootstrapEnvironment,
    MODELLIX_AGENT_CANVAS_RUNTIME_DIR: concurrentCache,
  };
  const concurrentResults = await Promise.all([
    runAsync(process.execPath, [bootstrapEntry, "--doctor"], root, concurrentEnvironment),
    runAsync(process.execPath, [bootstrapEntry, "--doctor"], root, concurrentEnvironment),
  ]);
  for (const result of concurrentResults) {
    const report = JSON.parse(result.stdout);
    if (!report.ok || report.version !== sourcePackage.version) {
      throw new Error(`Concurrent Codex bootstrap failed: ${result.stdout}`);
    }
  }
  const bootstrapResidue = (await readdir(concurrentCache)).filter((name) => name.startsWith(".install-") || name.startsWith(".stage-"));
  if (bootstrapResidue.length > 0) throw new Error(`Codex bootstrap left temporary cache entries: ${bootstrapResidue.join(", ")}`);

  runNpm(["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball], temporaryRoot, { npm_config_cache: cacheRoot });
  const packageRoot = path.join(temporaryRoot, "node_modules", "@modellix", "agent-canvas");
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (pkg.name !== sourcePackage.name || pkg.version !== sourcePackage.version) {
    throw new Error("Installed Canvas package identity is invalid.");
  }
  for (const required of [
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/marketplace.json",
    ".cursor-plugin/plugin.json",
    ".plugin/plugin.json",
    ".mcp.json",
    ".mcp.codex.json",
    "codex-bootstrap.mjs",
    "adapters/opencode/opencode.json",
    "adapters/opencode/opencode-v2.json",
    "mcp/static/canvas.html",
    "mcp.json",
    "server.json",
    "skills/modellix-agent-canvas-open/SKILL.md",
  ]) {
    if (!existsSync(path.join(packageRoot, required))) throw new Error(`Installed package is missing ${required}.`);
  }
  if (!existsSync(path.join(temporaryRoot, "node_modules", "modellix-cli", "bin", "run.js"))) {
    throw new Error("Installed package is missing its exact modellix-cli runtime dependency.");
  }
  for (const requiredRuntimeFile of [
    "node_modules/ajv/package.json",
    "node_modules/ajv-formats/package.json",
  ]) {
    if (!existsSync(path.join(temporaryRoot, requiredRuntimeFile))) {
      throw new Error(`Installed package is missing the pinned runtime file ${requiredRuntimeFile}.`);
    }
  }
  const shimExtension = process.platform === "win32" ? ".cmd" : "";
  for (const executable of ["agent-canvas", "modellix-agent-canvas"]) {
    if (!existsSync(path.join(temporaryRoot, "node_modules", ".bin", `${executable}${shimExtension}`))) {
      throw new Error(`Installed package is missing the ${executable} executable shim.`);
    }
  }
  for (const forbidden of ["src", "public", "vite.config.js", "package-lock.json"]) {
    if (existsSync(path.join(packageRoot, forbidden))) throw new Error(`Published package contains build-only content: ${forbidden}`);
  }

  const doctor = run(process.execPath, [path.join(packageRoot, "scripts", "start-mcp.mjs"), "--doctor"], temporaryRoot);
  const doctorReport = JSON.parse(doctor.stdout);
  if (!doctorReport.ok || doctorReport.version !== pkg.version || !doctorReport.runtimeDependencies?.complete) {
    throw new Error(`Installed package doctor failed: ${doctor.stdout}`);
  }

  run(process.execPath, [path.join(root, "scripts", "probe-mcp.mjs")], root, {
    ...bootstrapEnvironment,
    MODELLIX_MCP_ENTRY: bootstrapEntry,
  });
  process.stdout.write(`Package smoke test passed for ${pkg.name}@${pkg.version}.\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function runNpm(args, cwd, extraEnvironment = {}) {
  return run(process.execPath, [npmCli, ...args], cwd, extraEnvironment);
}

function run(command, args, cwd, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnvironment, FORCE_COLOR: "0", NO_COLOR: "1" },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}.\n${result.stderr || result.stdout}`);
  }
  return result;
}

function runAsync(command, args, cwd, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnvironment, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with exit ${code}.\n${stderr || stdout}`));
    });
  });
}
