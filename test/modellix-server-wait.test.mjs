import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ModellixCli } from "../mcp/lib/modellix-cli.mjs";

test("CLI adapter returns an unfinished snapshot from task wait exit 124", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "modellix-canvas-wait-"));
  const entry = path.join(directory, "fake-cli.mjs");
  await writeFile(entry, `
const args=process.argv.slice(2);
if (args[0] !== "task" || args[1] !== "wait") throw new Error("Expected task wait");
console.log(JSON.stringify({ok:false,error:{code:"TASK_WAIT_TIMEOUT",exitCode:124},unfinishedTaskIds:["task-one"],snapshots:[{taskId:"task-one",response:{code:0,data:{task_id:"task-one",status:"pending",wait:{timed_out:true,elapsed_ms:1}}}}]}));
process.exitCode=124;
`, "utf8");
  try {
    const cli = new ModellixCli({ entry, pluginRoot: directory, workspaceRoot: directory });
    const result = await cli.waitTask("task-one", { timeoutSeconds: 1 });
    assert.equal(result.data.task_id, "task-one");
    assert.equal(result.data.status, "pending");
    assert.equal(result.data.wait.timed_out, true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("CLI adapter cancels an in-flight child wait", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "modellix-canvas-wait-"));
  const entry = path.join(directory, "fake-cli.mjs");
  await writeFile(entry, "setInterval(()=>{},1000);\n", "utf8");
  try {
    const cli = new ModellixCli({ entry, pluginRoot: directory, workspaceRoot: directory });
    const controller = new AbortController();
    const pending = cli.waitTask("task-one", { signal: controller.signal, timeoutSeconds: 45 });
    setTimeout(()=>controller.abort(), 50);
    await assert.rejects(pending, { name: "AbortError" });
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("CLI adapter cancellation also stops the immediate snapshot fallback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "modellix-canvas-wait-"));
  const entry = path.join(directory, "fake-cli.mjs");
  const marker = path.join(directory, "snapshot-started");
  await writeFile(entry, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[1] === "wait") {
  console.log(JSON.stringify({ok:false,snapshots:[],error:{code:"TASK_WAIT_TIMEOUT"}}));
  process.exitCode = 124;
} else if (args[1] === "get") {
  writeFileSync(${JSON.stringify(marker)}, "started");
  setTimeout(() => console.log(JSON.stringify({code:0,data:{task_id:"task-one",status:"pending"}})), 400);
} else throw new Error("Unexpected command");
`, "utf8");
  const controller = new AbortController();
  try {
    const cli = new ModellixCli({ entry, pluginRoot: directory, workspaceRoot: directory });
    const pending = cli.waitTask("task-one", { timeoutSeconds: 1, signal: controller.signal });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    const deadline = performance.now() + 3000;
    while (!(await access(marker).then(() => true, () => false))) {
      assert.ok(performance.now() < deadline, "snapshot fallback did not start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort();
    await rejected;
  } finally {
    controller.abort();
    await rm(directory, {recursive: true, force: true});
  }
});
