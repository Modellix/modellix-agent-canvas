import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CanvasProjectStore } from "./lib/canvas-project-store.mjs";
import { assertSupportedNode, createHostContext } from "./lib/host-context.mjs";
import { ModellixCli } from "./lib/modellix-cli.mjs";
import { ModellixImageService } from "./lib/modellix-image-service.mjs";
import { modellixStaticHtml } from "./lib/modellix-static-widget.mjs";
import { ModellixTaskStore } from "./lib/modellix-task-store.mjs";
import { MODELLIX_WIDGET_URI, registerModellixTools } from "./lib/modellix-tools.mjs";
import { ModellixLocalWebServer } from "./lib/local-web-server.mjs";
import { pluginPath, pluginRoot } from "./lib/plugin-root.mjs";
import { registerWidgetResource } from "./lib/widget-resource.mjs";

assertSupportedNode();
const manifest = JSON.parse(readFileSync(pluginPath(".codex-plugin", "plugin.json"), "utf8"));
const context = createHostContext({ pluginRoot: pluginRoot() });
await context.initialize();

const cli = new ModellixCli({
  pluginRoot: context.pluginRoot,
  workspaceRoot: context.workspaceRoot || context.originalCwd,
});
const projectStore = lazyStore(context, CanvasProjectStore, [
  "initialize", "readProject", "saveProject", "getContext", "createPage", "renamePage", "deletePage",
  "saveReference", "saveAsset", "readAsset", "resolveImageObject", "locateObject", "findTaskResources", "insertImage",
]);
const taskStore = lazyStore(context, ModellixTaskStore, [
  "read", "list", "getOperation", "getTask", "createOperation", "updateOperation", "updateTask", "appendEvent", "readEvents",
]);
const service = new ModellixImageService({ context, cli, taskStore, projectStore });
const localWeb = new ModellixLocalWebServer({ context, cli, service, taskStore, projectStore, canvasHtml: modellixStaticHtml });

const server = new McpServer(
  { name: manifest.name, version: manifest.version },
  {
    instructions: [
      "Modellix Agent Canvas is a workspace-bound local stdio MCP.",
      "Use open_modellix_canvas to open the app and get_canvas_context to inspect its active selection.",
      "Every paid image request must call prepare_modellix_image_task, show the returned model/specification/cost disclosure, receive explicit confirmation, and only then call submit_modellix_image_task.",
      "Use get_modellix_image_task and finalize_modellix_image_task to recover and persist results; never blindly resubmit submission_unknown tasks.",
    ].join(" "),
  },
);

context.setRootProvider(async () => {
  if (!server.server.getClientCapabilities()?.roots) return [];
  const response = await server.server.listRoots();
  return response.roots
    .map((root) => root.uri)
    .filter((uri) => String(uri).startsWith("file:"))
    .map((uri) => fileURLToPath(uri));
});

registerWidgetResource(server, {
  name: "modellix-agent-canvas-app",
  uri: MODELLIX_WIDGET_URI,
  title: "Modellix Agent Canvas",
  description: "Workspace-local infinite canvas for visual ideation, AI image workflows, HTML drafts, and presentations.",
  html: modellixStaticHtml,
  prefersBorder: false,
  connectDomains: [],
  resourceDomains: ["data:", "blob:"],
  frameDomains: ["data:", "blob:", "http://127.0.0.1:*"],
});

registerModellixTools(server, { context, service, taskStore, localWeb, projectStore });
await server.connect(new StdioServerTransport());

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => localWeb.close().finally(() => process.exit(0)));
}

function lazyStore(hostContext, Store, methods) {
  const proxy = {};
  for (const method of methods) {
    proxy[method] = async (...args) => {
      await hostContext.initialize();
      return new Store(hostContext.requireWorkspace())[method](...args);
    };
  }
  return proxy;
}
