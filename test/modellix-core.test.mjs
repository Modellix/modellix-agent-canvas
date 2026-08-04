import assert from "node:assert/strict";
import { appendFile, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CanvasProjectStore } from "../mcp/lib/canvas-project-store.mjs";
import { createHostContext } from "../mcp/lib/host-context.mjs";
import { ModellixImageService } from "../mcp/lib/modellix-image-service.mjs";
import { ModellixLocalWebServer } from "../mcp/lib/local-web-server.mjs";
import { ModellixTaskStore } from "../mcp/lib/modellix-task-store.mjs";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("host context binds one real workspace and rejects the plugin directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-context-"));
  const pluginRoot = await mkdtemp(path.join(tmpdir(), "modellix-plugin-"));
  try {
    const context = createHostContext({ pluginRoot, originalCwd: root, argv: ["--host", "cursor"] });
    assert.equal((await context.initialize()).supportsMcpApps, true);
    assert.equal(context.requireWorkspace(), await import("node:fs/promises").then(({ realpath }) => realpath(root)));
    const pluginContext = createHostContext({ pluginRoot, originalCwd: pluginRoot });
    await pluginContext.initialize();
    await assert.rejects(() => pluginContext.bindWorkspace(pluginRoot), (error) => error.code === "WORKSPACE_BOUNDARY_VIOLATION");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(pluginRoot, { recursive: true, force: true });
  }
});

test("host context binds the first valid MCP client root when cwd is the plugin", async () => {
  const pluginRoot = await mkdtemp(path.join(tmpdir(), "modellix-plugin-root-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "modellix-client-root-"));
  try {
    const context = createHostContext({
      pluginRoot,
      originalCwd: pluginRoot,
      rootProvider: async () => [pluginRoot, workspaceRoot],
    });
    const snapshot = await context.initialize();
    assert.equal(snapshot.workspaceBound, true);
    assert.equal(context.requireWorkspace(), await realpath(workspaceRoot));
  } finally {
    await rm(pluginRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("host context retries MCP roots when the host was not ready on first use", async () => {
  const pluginRoot = await mkdtemp(path.join(tmpdir(), "modellix-plugin-root-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "modellix-client-root-"));
  let attempts = 0;
  try {
    const context = createHostContext({
      pluginRoot,
      originalCwd: pluginRoot,
      rootProvider: async () => (++attempts === 1 ? [] : [workspaceRoot]),
    });
    assert.equal((await context.initialize()).workspaceBound, false);
    assert.equal((await context.initialize()).workspaceBound, true);
    assert.equal(attempts, 2);
  } finally {
    await rm(pluginRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("reading a new Canvas returns an in-memory default without creating files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-readonly-project-"));
  try {
    const project = await new CanvasProjectStore(root).readProject({ hydrateFiles: true });
    assert.equal(project.settings.language, "en");
    assert.equal(project.pages.length, 1);
    await assert.rejects(lstat(path.join(root, ".modellix")), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project storage externalizes images, hydrates them, and rejects stale revisions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-project-"));
  try {
    const store = new CanvasProjectStore(root);
    const project = await store.initialize();
    const pageId = project.activePageId;
    const dataURL = `data:image/png;base64,${PNG_1X1.toString("base64")}`;
    project.pages[0].files = { file_test: { id: "file_test", dataURL, mimeType: "image/png", created: Date.now() } };
    project.pages[0].elements = [{
      id: "image_test", type: "image", x: 10, y: 20, width: 100, height: 100, angle: 0,
      opacity: 100, fileId: "file_test", isDeleted: false,
      customData: { modellix: { schemaVersion: 1, kind: "source-image", objectId: "obj_test" } },
    }];
    project.pages[0].appData.htmlDrafts = {
      obj_html_test: { title: "Draft", entryFile: "index.html", revision: 3, source: "<!doctype html><h1>External HTML source</h1>" },
    };
    const saved = await store.saveProject(project);
    assert.equal(saved.revision, 2);
    const hydrated = await store.readProject({ hydrateFiles: true });
    assert.equal(hydrated.pages[0].id, pageId);
    assert.match(hydrated.pages[0].files.file_test.dataURL, /^data:image\/png;base64,/u);
    assert.match(hydrated.pages[0].files.file_test.assetPath, /^assets\/images\//u);
    assert.equal(hydrated.pages[0].appData.htmlDrafts.obj_html_test.source, "<!doctype html><h1>External HTML source</h1>");
    const rawPage = await readFile(path.join(root, ".modellix", "canvas", "pages", `${pageId}.json`), "utf8");
    assert.doesNotMatch(rawPage, /External HTML source/u);
    assert.match(rawPage, /assets\/html\/obj_html_test\/index\.html/u);
    assert.equal((await store.resolveImageObject("obj_test")).pageId, pageId);
    await assert.rejects(() => store.saveProject(project), (error) => error.code === "REVISION_CONFLICT");
    const latest = await store.readProject({ hydrateFiles: true });
    latest.pages[0].appData = { apiKey: "must-never-persist" };
    await assert.rejects(() => store.saveProject(latest), (error) => error.code === "INPUT_INVALID");
    const wrongSchema = await store.readProject({ hydrateFiles: true });
    wrongSchema.schemaVersion = 99;
    await assert.rejects(() => store.saveProject(wrongSchema), (error) => error.code === "INPUT_INVALID");
    const fitProject = await store.readProject({ hydrateFiles: true });
    fitProject.pages[0].elements.push({
      id: "holder_fit", type: "rectangle", x: 100, y: 200, width: 400, height: 200, angle: 0,
      opacity: 100, isDeleted: false,
      customData: { modellix: { schemaVersion: 1, kind: "image-holder", objectId: "obj_holder_fit", ratio: "2:1" } },
    });
    await store.saveProject(fitProject);
    const generatedFile = path.join(root, "generated.png");
    await writeFile(generatedFile, PNG_1X1);
    const inserted = await store.insertImage({
      imagePath: generatedFile, pageId, anchorObjectId: "obj_holder_fit", replaceHolder: true,
      metadata: { workflowId: "operation-fit", taskId: "task-fit", resourceIndex: 0, fitPolicy: "contain" },
    });
    assert.deepEqual(inserted.bounds, { x: 200, y: 200, w: 200, h: 200 });
    const fitted = await store.readProject({ hydrateFiles: true });
    assert.equal(fitted.pages[0].elements.find((element) => element.id === "holder_fit").isDeleted, true);
    const assetFile = path.join(root, ".modellix", "canvas", hydrated.pages[0].files.file_test.assetPath);
    await rm(assetFile);
    const missing = await store.readProject({ hydrateFiles: true });
    assert.equal(missing.pages[0].files.file_test.missing, true);
    assert.match(missing.pages[0].files.file_test.dataURL, /^data:image\/svg\+xml;base64,/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asset imports reject workspace escape and symlink escape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-boundary-"));
  const outside = await mkdtemp(path.join(tmpdir(), "modellix-outside-"));
  try {
    const store = new CanvasProjectStore(root);
    await store.initialize();
    await assert.rejects(() => store.saveAsset({ dataBase64: Buffer.from("not-a-png").toString("base64"), mimeType: "image/png" }), (error) => error.code === "INPUT_INVALID");
    await assert.rejects(() => store.saveAsset({ dataBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64"), mimeType: "image/svg+xml" }), (error) => error.code === "INPUT_INVALID");
    const safeFile = path.join(root, "safe.png");
    await writeFile(safeFile, PNG_1X1);
    await assert.rejects(() => store.saveAsset({ sourcePath: `${root}${path.sep}folder${path.sep}..${path.sep}safe.png`, mimeType: "image/png" }), (error) => error.code === "WORKSPACE_BOUNDARY_VIOLATION");
    if (process.platform === "win32") {
      await assert.rejects(() => store.saveAsset({ sourcePath: `${safeFile}:hidden`, mimeType: "image/png" }), (error) => error.code === "WORKSPACE_BOUNDARY_VIOLATION");
    }
    const outsideFile = path.join(outside, "outside.png");
    await writeFile(outsideFile, PNG_1X1);
    await assert.rejects(() => store.saveAsset({ sourcePath: outsideFile }), (error) => error.code === "WORKSPACE_BOUNDARY_VIOLATION");
    const link = path.join(root, "linked.png");
    try {
      await symlink(outsideFile, link, "file");
      await assert.rejects(() => store.saveAsset({ sourcePath: link }), (error) => error.code === "WORKSPACE_BOUNDARY_VIOLATION");
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error.code)) throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("task store keeps an append-only redacted ledger and ignores one incomplete tail line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-ledger-"));
  try {
    const store = new ModellixTaskStore(root);
    const now = new Date().toISOString();
    await store.createOperation({
      operationId: "operation-ledger-test", fingerprint: "fingerprint-ledger-test", status: "preparing", modelSlug: "openai/gpt-image-2",
      routeReasonCode: "DEFAULT_OPAQUE_GENERATE", requestedOutput: { size: "1024x1024" }, pricing: { currency: "USD", unitPriceUsd: 0.1, estimatedTotalUsd: 0.1 }, uploadedMediaFileIds: [],
      tasks: [{ ordinal: 1, taskId: null, status: "preparing", createdAt: now, updatedAt: now }], createdAt: now, updatedAt: now,
    });
    await store.updateTask("operation-ledger-test", 1, { status: "submitted", taskId: "task-ledger-1", prompt: "must-not-persist", remoteUrl: "https://temporary.invalid/result" });
    await appendFile(store.eventsPath, '{"incomplete":');
    const events = await store.readEvents();
    assert.ok(events.some((event) => event.type === "workflow_created"));
    assert.ok(events.some((event) => event.type === "task_id_received"));
    assert.equal((await store.list()).operations[0].pricing.estimatedTotalUsd, 0.1);
    await store.updateTask("operation-ledger-test", 1, { status: "cancelled" });
    assert.equal((await store.list()).operations[0].status, "cancelled");
    const combined = `${await readFile(store.filePath, "utf8")}\n${await readFile(store.eventsPath, "utf8")}`;
    assert.doesNotMatch(combined, /must-not-persist|temporary\.invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paid submission consumes exact confirmation and concurrent duplicates create one paid task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-paid-"));
  try {
    const context = await testContext(root);
    let submissions = 0;
    const cli = validCli({
      submitModel: async () => { submissions += 1; return "task-paid-1"; },
      uploadFile: async () => assert.fail("generation must not upload references"),
    });
    const taskStore = new ModellixTaskStore(root);
    const service = new ModellixImageService({ context, cli, taskStore, projectStore: new CanvasProjectStore(root) });
    await service.projectStore.initialize();
    const intent = { prompt: "draw a blue circle", mode: "generate", sourceObjectIds: [], sourceAssetIds: [], size: "1024x1024", count: 1 };
    const prepared = await service.prepare(intent);
    await assert.rejects(() => service.submit({ ...intent, prompt: "draw a red square", operationId: "operation-changed-prompt", routeFingerprint: prepared.routeFingerprint, confirmedPaidSubmission: true }), (error) => error.code === "ROUTE_CHANGED_RECONFIRM_REQUIRED");
    const exact = await service.prepare(intent);
    const results = await Promise.allSettled([
      service.submit({ ...intent, operationId: "operation-concurrent-a", routeFingerprint: exact.routeFingerprint, confirmedPaidSubmission: true }),
      service.submit({ ...intent, operationId: "operation-concurrent-b", routeFingerprint: exact.routeFingerprint, confirmedPaidSubmission: true }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(submissions, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalize downloads once, persists a project image, and is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-finalize-"));
  try {
    const context = await testContext(root);
    const taskStore = new ModellixTaskStore(root);
    const projectStore = new CanvasProjectStore(root);
    await projectStore.initialize();
    const project = await projectStore.readProject({ hydrateFiles: true });
    const now = new Date().toISOString();
    await taskStore.createOperation({
      operationId: "operation-finalize-test", fingerprint: "fingerprint-finalize-test", pageId: project.activePageId, anchorObjectId: null,
      uploadedMediaFileIds: [], tasks: [{ ordinal: 1, taskId: "task-finalize-1", status: "submitted", createdAt: now, updatedAt: now, localAssets: [], finalizedObjectIds: [], finalizedElementIds: [] }],
      createdAt: now, updatedAt: now,
    });
    let downloads = 0;
    const service = new ModellixImageService({
      context, taskStore, projectStore,
      cli: {
        getTask: async () => ({ data: { task_id: "task-finalize-1", status: "success", result_expires_at: 1_786_418_800_891, result: { resources: [{}] } } }),
        downloadTask: async (_taskId, destination) => {
          downloads += 1;
          const file = path.join(destination, "result.png");
          await writeFile(file, PNG_1X1);
          return { files: [{ path: file }] };
        },
        deleteFile: async () => ({}),
      },
    });
    const observed = await service.getTask("task-finalize-1");
    assert.equal(observed.resultExpiresAt, new Date(1_786_418_800_891).toISOString());
    const first = await service.finalize("task-finalize-1");
    const second = await service.finalize("task-finalize-1");
    assert.equal(downloads, 1);
    assert.equal(first.objectIds.length, 1);
    assert.deepEqual(second.objectIds, first.objectIds);
    assert.equal(second.alreadyFinalized, true);
    assert.equal((await projectStore.findTaskResources("task-finalize-1")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local fallback uses loopback, one-time bootstrap, strict cookie, Host and Origin checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-web-"));
  const context = await testContext(root, ["--host", "opencode", "--supports-mcp-apps", "false"]);
  const projectStore = new CanvasProjectStore(root);
  const savedKeys = [];
  const server = new ModellixLocalWebServer({
    context, projectStore,
    cli: { loginWithStdin: async (apiKey) => {
      if (apiKey === "invalid-key") throw new Error("The API key is invalid or inactive.");
      savedKeys.push(apiKey);
      return { ok: true };
    } },
    service: { status: async () => ({ ok: true }) },
    taskStore: { list: async () => ({ schemaVersion: 1, operations: [] }) },
    canvasHtml: async () => "<!doctype html><title>Canvas fallback</title>",
  });
  try {
    const openUrl = await server.createCanvasUrl();
    assert.match(openUrl, /^http:\/\/127\.0\.0\.1:\d+\/open\//u);
    const bootstrap = await fetch(openUrl, { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    const cookie = bootstrap.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; SameSite=Strict/u);
    const origin = new URL(openUrl).origin;
    const sessionCookie = cookie.split(";", 1)[0];
    const page = await fetch(`${origin}/`, { headers: { cookie: sessionCookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/u);
    assert.equal((await fetch(openUrl, { redirect: "manual" })).status, 410);
    assert.equal((await fetch(`${origin}/api/project`, { method: "PUT", headers: { cookie: sessionCookie, origin: "https://evil.invalid", "content-type": "application/json" }, body: "{}" })).status, 400);
    assert.equal((await fetch(`${origin}/api/project`, { method: "PUT", headers: { cookie: sessionCookie, origin, "content-type": "text/plain" }, body: "{}" })).status, 415);
    const setup = await server.createSetupUrl();
    assert.match(setup.setupUrl, /language=en/u);
    const embeddedSetup = await fetch(`${setup.setupUrl}&embedded=1`);
    assert.match(await embeddedSetup.text(), /type="password"/u);
    assert.equal(embeddedSetup.headers.get("x-frame-options"), null);
    assert.match(embeddedSetup.headers.get("content-security-policy"), /frame-ancestors \*/u);
    const japaneseSetup = await server.createSetupUrl("ja-JP");
    const japaneseHtml = await (await fetch(`${japaneseSetup.setupUrl}&embedded=1`)).text();
    assert.match(japaneseHtml, /lang="ja-JP"/u);
    assert.match(japaneseHtml, /保存して検証/u);
    const sameOriginSetup = await fetch(setup.setupUrl, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: "apiKey=same-origin-key",
    });
    assert.equal(sameOriginSetup.status, 200);
    assert.match(await sameOriginSetup.text(), /Configuration complete/u);
    const rejectedSetup = await server.createSetupUrl();
    assert.equal((await fetch(rejectedSetup.setupUrl, {
      method: "POST",
      headers: { origin: "https://evil.invalid", "content-type": "application/x-www-form-urlencoded" },
      body: "apiKey=evil-key",
    })).status, 400);
    const opaqueSetup = await server.createSetupUrl();
    assert.equal((await fetch(opaqueSetup.setupUrl, {
      method: "POST",
      headers: { origin: "null", "content-type": "application/x-www-form-urlencoded" },
      body: "apiKey=opaque-origin-key",
    })).status, 200);
    const invalidSetup = await server.createSetupUrl("zh-CN");
    const invalidResponse = await fetch(`${invalidSetup.setupUrl}&embedded=1`, {
      method: "POST",
      headers: { origin: "null", "content-type": "application/x-www-form-urlencoded" },
      body: "apiKey=invalid-key",
    });
    assert.equal(invalidResponse.status, 200);
    const invalidHtml = await invalidResponse.text();
    assert.match(invalidHtml, /API Key 无效或已停用/u);
    assert.match(invalidHtml, /type="password"/u);
    assert.deepEqual(savedKeys, ["same-origin-key", "opaque-origin-key"]);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function testContext(root, argv = []) {
  const context = createHostContext({ pluginRoot: path.join(root, "plugin"), originalCwd: root, argv });
  await context.initialize();
  return context;
}

function validCli(overrides = {}) {
  return {
    baseUrl: "https://api.modellix.ai", profile: "test",
    compatibility: async () => ({ available: true, compatible: true, version: "0.0.8" }),
    authStatus: async () => ({ ok: true, authenticated: true, valid: true, apiKeySource: "keychain" }),
    listModels: async () => [{ slug: "openai/gpt-image-2", name: "GPT Image 2", price: 0.01 }],
    submitModel: async () => "task-default", deleteFile: async () => ({}),
    ...overrides,
  };
}
