import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ModellixCli, resolveCliEntry } from "../mcp/lib/modellix-cli.mjs";

test("CLI adapter resolves the installed dependency through Node package resolution", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const entry = resolveCliEntry(root);
  assert.match(entry, /[\\/]node_modules[\\/]modellix-cli[\\/]bin[\\/]run\.js$/u);
});

test("CLI adapter pins one auto-updated entry for the MCP process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-canvas-cli-test-"));
  const packageRoot = path.join(root, "node_modules", "modellix-cli");
  const bundledEntry = path.join(packageRoot, "bin", "run.js");
  const updatedEntry = path.join(root, "updated-cli.mjs");
  await writeFile(updatedEntry, `
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("modellix-cli/0.0.9");
else console.log("ok");
`, "utf8");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(bundledEntry), { recursive: true }));
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: "modellix-cli", version: "0.0.8" })}\n`);
  await writeFile(bundledEntry, "console.log('modellix-cli/0.0.8');\n", "utf8");
  let resolutions = 0;
  try {
    const cli = new ModellixCli({
      pluginRoot: root,
      workspaceRoot: root,
      resolveLatestEntry: async () => {
        resolutions += 1;
        return { entry: updatedEntry, source: "auto-updated", version: "0.0.9", updateWarning: null };
      },
    });
    const first = await cli.compatibility();
    const second = await cli.compatibility();
    assert.equal(first.version, "0.0.9");
    assert.equal(first.source, "auto-updated");
    assert.equal(second.version, "0.0.9");
    assert.equal(resolutions, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI adapter inherits and then pins modellix-cli's current profile", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "modellix-canvas-cli-test-"));
  const entry = path.join(directory, "fake-cli.mjs");
  await writeFile(entry, `
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ ok: true, valid: true, profile: "work", args }));
} else if (args[0] === "model" && args[1] === "list") {
  console.log(JSON.stringify({ models: [{ args }] }));
} else {
  console.log(JSON.stringify({ args }));
}
`, "utf8");

  try {
    const cli = new ModellixCli({ entry, pluginRoot: directory, workspaceRoot: directory });
    const status = await cli.authStatus();
    assert.equal(status.profile, "work");
    assert.equal(status.args.includes("--profile"), false);
    assert.equal(cli.profile, "work");

    const models = await cli.listModels();
    const profileIndex = models[0].args.indexOf("--profile");
    assert.equal(models[0].args[profileIndex + 1], "work");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI adapter preserves an explicitly selected profile", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "modellix-canvas-cli-test-"));
  const entry = path.join(directory, "fake-cli.mjs");
  await writeFile(entry, `console.log(JSON.stringify({ ok: true, valid: true, profile: "explicit", args: process.argv.slice(2) }));\n`, "utf8");

  try {
    const cli = new ModellixCli({ entry, pluginRoot: directory, workspaceRoot: directory, profile: "explicit" });
    const status = await cli.authStatus();
    const profileIndex = status.args.indexOf("--profile");
    assert.equal(status.args[profileIndex + 1], "explicit");
    assert.equal(cli.profile, "explicit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI adapter runs the compiled CLI in production mode and preserves structured errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "modellix-canvas-cli-test-"));
  const entry = path.join(directory, "fake-cli.mjs");
  await writeFile(entry, `
const message = process.env.NODE_ENV === "production"
  ? "The Modellix API key is invalid or inactive."
  : "The CLI was not started in production mode.";
console.log(JSON.stringify({ ok: false, error: { message } }));
console.error("Could not find typescript. Falling back to compiled source.");
process.exitCode = 1;
`, "utf8");

  try {
    const cli = new ModellixCli({ entry, pluginRoot: directory, workspaceRoot: directory });
    await assert.rejects(
      cli.loginWithStdin("not-a-real-key"),
      /API key is invalid or inactive/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
