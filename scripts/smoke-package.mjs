import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    "adapters/opencode/opencode.json",
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
    MODELLIX_MCP_ENTRY: path.join(packageRoot, "scripts", "start-mcp.mjs"),
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
