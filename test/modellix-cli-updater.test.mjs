import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  autoUpdateEnabled,
  cliCacheRoot,
  resolveLatestCliEntry,
  validVersion,
} from "../mcp/lib/modellix-cli-updater.mjs";

test("CLI updater uses platform-local caches and validates registry versions", () => {
  assert.equal(
    cliCacheRoot({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "win32", "C:\\Users\\test"),
    path.join("C:\\Users\\test\\AppData\\Local", "Modellix", "AgentCanvas", "cli"),
  );
  assert.equal(validVersion("1.2.3-beta.1+build.2"), "1.2.3-beta.1+build.2");
  assert.throws(() => validVersion("../latest"), /invalid modellix-cli version/u);
  assert.equal(autoUpdateEnabled({}), true);
  assert.equal(autoUpdateEnabled({ MODELLIX_CLI_AUTO_UPDATE: "off" }), false);
});

test("CLI updater installs npm latest once and reuses the validated cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-cli-updater-"));
  const fallbackEntry = await fakeCli(path.join(root, "fallback"), "0.0.8");
  const cacheRoot = path.join(root, "cache");
  let installs = 0;
  const options = {
    cacheRoot,
    fallbackEntry,
    queryLatestVersion: async () => "0.0.9",
    installVersion: async ({ version, stagingRoot }) => {
      installs += 1;
      await fakeCli(stagingRoot, version);
    },
  };
  try {
    const first = await resolveLatestCliEntry(options);
    assert.equal(first.version, "0.0.9");
    assert.equal(first.source, "auto-updated");
    assert.match(first.entry, /[\\/]0\.0\.9[\\/]node_modules[\\/]modellix-cli[\\/]bin[\\/]run\.js$/u);

    const second = await resolveLatestCliEntry(options);
    assert.equal(second.version, "0.0.9");
    assert.equal(second.source, "auto-updated");
    assert.equal(installs, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI updater falls back safely when latest cannot be resolved or updates are disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-cli-updater-"));
  const fallbackEntry = await fakeCli(path.join(root, "fallback"), "0.0.8");
  try {
    const unavailable = await resolveLatestCliEntry({
      cacheRoot: path.join(root, "unavailable"),
      fallbackEntry,
      queryLatestVersion: async () => { throw new Error("registry offline"); },
    });
    assert.equal(unavailable.entry, fallbackEntry);
    assert.equal(unavailable.source, "bundled");
    assert.match(unavailable.updateWarning, /bundled runtime/u);

    let queried = false;
    const disabled = await resolveLatestCliEntry({
      cacheRoot: path.join(root, "disabled"),
      fallbackEntry,
      environment: { MODELLIX_CLI_AUTO_UPDATE: "0" },
      queryLatestVersion: async () => { queried = true; return "0.0.9"; },
    });
    assert.equal(disabled.entry, fallbackEntry);
    assert.equal(disabled.version, "0.0.8");
    assert.equal(queried, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fakeCli(root, version) {
  const packageRoot = path.join(root, "node_modules", "modellix-cli");
  const entry = path.join(packageRoot, "bin", "run.js");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "modellix-cli", version })}\n`);
  await writeFile(entry, "export {};\n");
  return entry;
}
