import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureRuntime, runtimeCacheRoot, sanitizeInstallerError, versionDirectoryName } from "../codex-bootstrap.mjs";

test("Codex bootstrap resolves platform-local runtime caches", () => {
  assert.equal(
    runtimeCacheRoot({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "win32", "C:\\Users\\test"),
    path.join("C:\\Users\\test\\AppData\\Local", "Modellix", "AgentCanvas", "runtime"),
  );
  assert.equal(
    runtimeCacheRoot({ XDG_CACHE_HOME: "/var/cache/test" }, "linux", "/home/test"),
    path.join("/var/cache/test", "modellix-agent-canvas", "runtime"),
  );
  assert.equal(
    runtimeCacheRoot({}, "darwin", "/Users/test"),
    path.join("/Users/test", "Library", "Caches", "modellix-agent-canvas", "runtime"),
  );
});

test("Codex bootstrap accepts semver cache keys and rejects path-like versions", () => {
  assert.equal(versionDirectoryName("1.2.3-beta.1+codex.local"), "1.2.3-beta.1_codex.local");
  assert.throws(() => versionDirectoryName("../runtime"), /Invalid runtime version/u);
  assert.throws(() => versionDirectoryName("01.2.3"), /Invalid runtime version/u);
  assert.throws(() => versionDirectoryName("1.2.3-.."), /Invalid runtime version/u);
  assert.throws(() => versionDirectoryName("1.2.3+"), /Invalid runtime version/u);
});

test("Codex bootstrap redacts credentials from npm installation errors", () => {
  const googleKey = `${["AI", "za", "Sy"].join("")}${"a".repeat(32)}`;
  const npmToken = `npm_${"a".repeat(36)}`;
  const unsafe = [
    "https://user:password@registry.example.invalid/package",
    `npm_config_authToken=${npmToken}`,
    "Authorization: Bearer secret-value",
    googleKey,
  ].join("\n");
  const safe = sanitizeInstallerError(unsafe);
  assert.doesNotMatch(safe, /password|secret-value/u);
  assert.equal(safe.includes(npmToken), false);
  assert.equal(safe.includes(googleKey), false);
  assert.match(safe, /\[redacted/u);
});

test("Codex bootstrap reuses a valid cached runtime without invoking npm", async () => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "modellix-bootstrap-reuse-"));
  const version = "9.9.9";
  const packageRoot = path.join(cacheRoot, version, "node_modules", "@modellix", "agent-canvas");
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "@modellix/agent-canvas", version })}\n`);
    await writeFile(path.join(packageRoot, "scripts", "start-mcp.mjs"), "export {};\n");
    assert.equal(await ensureRuntime({
      cacheRoot,
      packageName: "@modellix/agent-canvas",
      packageVersion: version,
      packageSpec: "this-package-must-not-be-installed",
    }), packageRoot);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
