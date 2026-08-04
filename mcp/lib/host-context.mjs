import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { ModellixCanvasError } from "./modellix-errors.mjs";

export function createHostContext(options = {}) {
  const pluginRoot = path.resolve(options.pluginRoot || process.env.MODELLIX_PLUGIN_ROOT || process.cwd());
  const originalCwd = path.resolve(options.originalCwd || process.env.MODELLIX_WORKSPACE_CWD || process.cwd());
  const argv = options.argv || process.argv.slice(2);
  const host = optionValue(argv, "host") || process.env.MODELLIX_HOST || "unknown";
  const explicitProjectDir = optionValue(argv, "project-dir") || process.env.MODELLIX_PROJECT_DIR;
  const supportsMcpApps = parseBoolean(
    optionValue(argv, "supports-mcp-apps") ?? process.env.MODELLIX_SUPPORTS_MCP_APPS,
    host === "codex" || host === "cursor",
  );
  let workspaceRoot = null;
  let workspaceId = null;
  let rootProvider = options.rootProvider || null;
  let rootInitialization = null;

  return {
    host,
    originalCwd,
    pluginRoot,
    supportsMcpApps,
    get workspaceRoot() {
      return workspaceRoot;
    },
    get workspaceId() {
      return workspaceId;
    },
    setRootProvider(provider) {
      rootProvider = typeof provider === "function" ? provider : null;
      if (!workspaceRoot) rootInitialization = null;
    },
    async initialize() {
      const candidate = explicitProjectDir || (originalCwd !== pluginRoot ? originalCwd : null);
      if (candidate) await this.bindWorkspace(candidate);
      if (!workspaceRoot && rootProvider) {
        rootInitialization ||= bindFirstClientRoot(this, rootProvider);
        try {
          await rootInitialization;
        } finally {
          // Roots can be unavailable while a host is still initializing. Cache
          // concurrent attempts, but let a later tool call retry an unbound result.
          if (!workspaceRoot) rootInitialization = null;
        }
      }
      return this.snapshot();
    },
    async bindWorkspace(candidate) {
      const normalized = await validateWorkspace(candidate, pluginRoot);
      if (workspaceRoot && !samePath(workspaceRoot, normalized)) {
        throw new ModellixCanvasError(
          "WORKSPACE_BOUNDARY_VIOLATION",
          "This MCP session is already bound to a different workspace.",
          { recoveryActions: ["Start a new MCP session for the other workspace."] },
        );
      }
      workspaceRoot = normalized;
      workspaceId = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
      return this.snapshot();
    },
    requireWorkspace() {
      if (!workspaceRoot) {
        throw new ModellixCanvasError(
          "WORKSPACE_UNBOUND",
          "Modellix Agent Canvas is not bound to a workspace.",
          { recoveryActions: ["Call the status or open tool with workspacePath set to the active workspace, or restart the MCP server with --project-dir."] },
        );
      }
      return workspaceRoot;
    },
    snapshot() {
      return {
        host,
        supportsMcpApps,
        workspaceBound: Boolean(workspaceRoot),
        workspaceId,
      };
    },
  };
}

async function bindFirstClientRoot(context, rootProvider) {
  let roots;
  try {
    roots = await rootProvider();
  } catch {
    return;
  }
  for (const candidate of Array.isArray(roots) ? roots : []) {
    try {
      // Sequential attempts preserve client root order and bind at most once.
      // eslint-disable-next-line no-await-in-loop
      await context.bindWorkspace(candidate);
      return;
    } catch (error) {
      if (error?.code !== "WORKSPACE_BOUNDARY_VIOLATION") throw error;
    }
  }
}

export function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  if (major === 20 && minor >= 19) return;
  if (major >= 22 && (major > 22 || minor >= 12)) return;
  throw new Error(`Modellix Agent Canvas requires Node ^20.19.0 or >=22.12.0; found ${version}.`);
}

async function validateWorkspace(candidate, pluginRoot) {
  const requested = path.resolve(String(candidate));
  let stats;
  let resolved;
  try {
    stats = await lstat(requested);
    resolved = await realpath(requested);
  } catch (error) {
    throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Workspace directory does not exist or cannot be resolved.", { cause: error });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Workspace root must be a real directory, not a symlink or junction.");
  }
  if (samePath(resolved, pluginRoot) || isWithin(pluginRoot, resolved)) {
    throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "The plugin installation directory cannot be used as the Canvas workspace.");
  }
  return resolved;
}

function optionValue(argv, name) {
  const inline = argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return value === true || value === "1" || value === "true";
}

function samePath(first, second) {
  return process.platform === "win32"
    ? path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase()
    : path.resolve(first) === path.resolve(second);
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
