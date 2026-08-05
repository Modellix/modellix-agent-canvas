import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { MODELLIX_WIDGET_URI } from "../mcp/lib/modellix-tools.mjs";

const mcpEntry = path.resolve(process.env.MODELLIX_MCP_ENTRY || "./scripts/start-mcp.mjs");
const projectDir = await mkdtemp(path.join(tmpdir(), "modellix-agent-canvas-probe-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpEntry, "--host", "codex", "--supports-mcp-apps", "true", "--project-dir", projectDir],
  env: { ...process.env, MODELLIX_API_KEY: "" },
  stderr: "pipe",
});
const client = new Client({ name: "modellix-agent-canvas-probe", version: "0.1.0" });
let serverStderr = "";
let phase = "connect primary host";
transport.stderr?.on("data", (chunk) => {
  serverStderr += chunk.toString("utf8");
});

try {
  await client.connect(transport);
  phase = "list primary tools";
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  const required = [
    "get_canvas_project", "save_canvas_project", "get_canvas_context", "create_canvas_page", "rename_canvas_page", "delete_canvas_page", "save_canvas_asset",
    "get_modellix_canvas_status", "start_modellix_api_key_setup", "open_modellix_canvas", "prepare_modellix_image_task", "submit_modellix_image_task",
    "get_modellix_image_task", "finalize_modellix_image_task", "cleanup_modellix_canvas_uploads", "list_modellix_canvas_tasks",
  ];
  for (const name of required) if (!names.has(name)) throw new Error(`Missing MCP tool: ${name}`);
  for (const tool of listed.tools) if (tool.outputSchema?.type !== "object") throw new Error(`${tool.name} must expose an object output schema.`);

  phase = "read Canvas status";
  const status = await client.callTool({ name: "get_modellix_canvas_status", arguments: { refresh: false, workspacePath: projectDir } });
  if (!status.structuredContent?.workspaceBound || !status.structuredContent?.workspaceId) throw new Error("Status did not report the workspace binding.");
  if (JSON.stringify(status).match(/mod-[A-Za-z0-9_-]{16,}/u)) throw new Error("Status leaked an API key.");

  phase = "open MCP Apps Canvas";
  const opened = await client.callTool({ name: "open_modellix_canvas", arguments: {} });
  if (opened.structuredContent?.mode !== "mcp-app") throw new Error("Codex probe did not receive MCP Apps mode.");
  if (opened._meta?.["openai/outputTemplate"] !== MODELLIX_WIDGET_URI) throw new Error("Open tool outputTemplate is missing or stale.");

  phase = "exercise project lifecycle";
  const project = await client.callTool({ name: "get_canvas_project", arguments: { hydrateFiles: false } });
  if (project.structuredContent?.pages?.length !== 1 || project.structuredContent?.revision !== 1) throw new Error("Fresh Canvas project is invalid.");
  const created = await client.callTool({ name: "create_canvas_page", arguments: { name: "Probe Page" } });
  await client.callTool({ name: "rename_canvas_page", arguments: { pageId: created.structuredContent.pageId, name: "Renamed Probe" } });
  await client.callTool({ name: "delete_canvas_page", arguments: { pageId: created.structuredContent.pageId } });
  const context = await client.callTool({ name: "get_canvas_context", arguments: {} });
  if (context.structuredContent?.pages?.length !== 1) throw new Error("Page lifecycle probe did not return to one page.");
  const guardedDelete = await client.callTool({ name: "delete_canvas_page", arguments: { pageId: context.structuredContent.activePageId } });
  if (!guardedDelete.isError || guardedDelete.structuredContent?.error?.code !== "INPUT_INVALID") throw new Error("Last-page deletion did not preserve its structured business error.");

  phase = "store project asset";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const asset = await client.callTool({ name: "save_canvas_asset", arguments: { dataBase64: png.toString("base64"), mimeType: "image/png", fileName: "probe.png" } });
  if (!asset.structuredContent?.assetId?.startsWith("asset_")) throw new Error("Canvas asset was not content-addressed.");

  phase = "read packaged Widget resource";
  const resource = await client.readResource({ uri: MODELLIX_WIDGET_URI });
  const html = resource.contents?.[0]?.text || "";
  if (!html.includes("window.modellixMcp") || !html.includes("Modellix Agent Canvas")) throw new Error("Widget bridge or product shell is missing.");
  const firstScript = html.search(/<script\b/iu);
  const shell = html.slice(0, firstScript < 0 ? html.length : firstScript);
  if (/<script[^>]+src=|<link[^>]+href=/iu.test(shell)) throw new Error("Widget shell references an external build asset.");
  if (!/^\s*<script\s+type="module">\s*$/imu.test(html)) throw new Error("Widget scripts must retain module semantics.");

  phase = "probe cursor host";
  await probeHostMode({ host: "cursor", supportsMcpApps: true, expectedMode: "mcp-app", required, bindThroughRoots: true });
  phase = "probe claude-code host";
  await probeHostMode({ host: "claude-code", supportsMcpApps: false, expectedMode: "local-web", required });
  phase = "probe opencode host";
  await probeHostMode({ host: "opencode", supportsMcpApps: false, expectedMode: "local-web", required });
  process.stdout.write(`MCP probe OK: ${required.length} tools, 4 host modes, project lifecycle, asset storage, fallback URLs, and embedded Widget resource.\n`);
} catch (error) {
  if (serverStderr.trim()) process.stderr.write(`MCP server stderr:\n${serverStderr}`);
  throw new Error(`MCP probe failed while attempting to ${phase}.`, { cause: error });
} finally {
  await client.close().catch(() => {});
  await rm(projectDir, { recursive: true, force: true });
}

async function probeHostMode({ host, supportsMcpApps, expectedMode, required, bindThroughRoots = false }) {
  const workspace = await mkdtemp(path.join(tmpdir(), `modellix-${host}-probe-`));
  const args = [mcpEntry, "--host", host, "--supports-mcp-apps", String(supportsMcpApps)];
  if (!bindThroughRoots) args.push("--project-dir", workspace);
  const hostTransport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { ...process.env, MODELLIX_API_KEY: "" },
    stderr: "pipe",
  });
  const hostClient = new Client(
    { name: `modellix-${host}-probe`, version: "0.1.0" },
    bindThroughRoots ? { capabilities: { roots: { listChanged: true } } } : undefined,
  );
  if (bindThroughRoots) {
    hostClient.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(workspace).href, name: "Cursor probe workspace" }],
    }));
  }
  let stderr = "";
  hostTransport.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  try {
    await hostClient.connect(hostTransport);
    const tools = await hostClient.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const name of required) if (!names.has(name)) throw new Error(`${host} is missing MCP tool ${name}.`);
    if (bindThroughRoots) {
      const status = await hostClient.callTool({ name: "get_modellix_canvas_status", arguments: { refresh: false } });
      if (!status.structuredContent?.workspaceBound) throw new Error(`${host} did not bind its workspace through MCP roots.`);
    }
    const opened = await hostClient.callTool({ name: "open_modellix_canvas", arguments: {} });
    if (opened.structuredContent?.mode !== expectedMode) throw new Error(`${host} returned ${opened.structuredContent?.mode || "no mode"}; expected ${expectedMode}.`);
    if (expectedMode === "local-web" && !/^http:\/\/127\.0\.0\.1:\d+\//u.test(opened.structuredContent?.localUrl || "")) {
      throw new Error(`${host} did not return a loopback fallback URL.`);
    }
    if (expectedMode === "mcp-app" && opened._meta?.["openai/outputTemplate"] !== MODELLIX_WIDGET_URI) {
      throw new Error(`${host} did not return the MCP Apps output template.`);
    }
  } catch (error) {
    if (stderr.trim()) process.stderr.write(`${host} MCP server stderr:\n${stderr}`);
    throw error;
  } finally {
    await hostClient.close().catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
}
