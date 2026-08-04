import { randomUUID } from "node:crypto";

import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import { PRODUCTION_API_KEY_URL } from "./modellix-contracts.mjs";
import { errorToolResult } from "./modellix-errors.mjs";

export const MODELLIX_WIDGET_URI = "ui://modellix-agent-canvas/canvas-v1.html";

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const workspacePath = z.string().trim().min(1).max(32_767).optional();
const imageIntentSchema = {
  prompt: z.string().trim().min(1).max(32_000),
  mode: z.enum(["generate", "edit"]),
  sourceObjectIds: z.array(id).max(10).default([]),
  sourceAssetIds: z.array(id).max(10).default([]),
  maskAssetId: id.optional(),
  size: z.string().regex(/^\d{2,5}x\d{2,5}$/u).default("1024x1024"),
  fitPolicy: z.enum(["contain", "exact"]).default("contain"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  background: z.enum(["auto", "opaque", "transparent"]).default("auto"),
  inputFidelity: z.enum(["standard", "strict"]).default("standard"),
  count: z.number().int().min(1).max(4).default(1),
  pageId: id.optional(),
  targetObjectId: id.optional(),
  placementX: z.number().finite().min(-10_000_000).max(10_000_000).optional(),
  placementY: z.number().finite().min(-10_000_000).max(10_000_000).optional(),
};

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const localWriteAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const externalReadOnlyAnnotations = { ...readOnlyAnnotations, openWorldHint: true };
const paidWriteAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const appOnlyMeta = { ui: { visibility: ["app"] } };

const statusOutputSchema = {
  ok: z.boolean(),
  host: z.string(),
  supportsMcpApps: z.boolean(),
  workspaceBound: z.boolean(),
  workspaceId: z.string().nullable(),
  baseUrlOrigin: z.string(),
  profile: z.string().nullable(),
  credentialState: z.enum(["valid", "invalid", "missing"]),
  credentialSource: z.string().nullable(),
  cliVersion: z.string().nullable(),
  cliCompatible: z.boolean(),
  routerVersion: z.number().int().positive(),
  approvedModels: z.record(z.string(), z.boolean()),
  canvasMode: z.enum(["mcp-app", "local-web"]),
  recoveryActions: z.array(z.string()),
};

const taskSummarySchema = z.object({ ordinal: z.number().int().positive(), taskId: z.string().nullable(), status: z.string() }).passthrough();

export function registerModellixTools(server, options) {
  const { context, service, taskStore, localWeb, projectStore } = options;

  register(server, "get_canvas_project", {
    title: "Get Canvas Project",
    description: "Read the workspace-local Canvas project, pages, Excalidraw elements, business metadata, and optionally hydrated image data.",
    inputSchema: { hydrateFiles: z.boolean().default(false) },
    outputSchema: z.object({ schemaVersion: z.number(), projectId: z.string(), name: z.string(), activePageId: z.string(), pages: z.array(z.unknown()) }).passthrough(),
    annotations: readOnlyAnnotations,
    _meta: appOnlyMeta,
  }, (input) => projectStore.readProject({ hydrateFiles: input.hydrateFiles }));

  register(server, "save_canvas_project", {
    title: "Save Canvas Project",
    description: "Atomically save a validated Canvas project inside the bound workspace. Image data is externalized into content-addressed local assets.",
    inputSchema: { project: z.record(z.string(), z.unknown()) },
    outputSchema: { ok: z.boolean(), projectId: z.string(), revision: z.number().int().positive(), activePageId: z.string(), pageCount: z.number().int(), updatedAt: z.string() },
    annotations: localWriteAnnotations,
    _meta: appOnlyMeta,
  }, (input) => projectStore.saveProject(input.project));

  register(server, "get_canvas_context", {
    title: "Get Canvas Context",
    description: "Return the active page and selected Canvas business objects without returning image bytes or secrets.",
    inputSchema: { detailLevel: z.enum(["summary", "selection", "page"]).default("selection") },
    outputSchema: z.object({ ok: z.boolean(), projectId: z.string(), projectName: z.string(), activePageId: z.string().nullable(), pages: z.array(z.unknown()), selection: z.array(z.unknown()), elementCount: z.number() }).passthrough(),
    annotations: readOnlyAnnotations,
  }, (input) => projectStore.getContext(input.detailLevel));

  register(server, "create_canvas_page", {
    title: "Create Canvas Page",
    description: "Create and activate a new workspace-local Canvas page.",
    inputSchema: { name: z.string().trim().max(120).optional() },
    outputSchema: { ok: z.boolean(), pageId: z.string(), name: z.string(), order: z.number().int() },
    annotations: localWriteAnnotations,
  }, (input) => projectStore.createPage(input.name));

  register(server, "rename_canvas_page", {
    title: "Rename Canvas Page",
    description: "Rename an existing Canvas page.",
    inputSchema: { pageId: id, name: z.string().trim().min(1).max(120) },
    outputSchema: { ok: z.boolean(), pageId: z.string(), name: z.string() },
    annotations: localWriteAnnotations,
  }, (input) => projectStore.renamePage(input.pageId, input.name));

  register(server, "delete_canvas_page", {
    title: "Delete Canvas Page",
    description: "Delete a Canvas page while preserving the rule that every project has at least one page.",
    inputSchema: { pageId: id },
    outputSchema: { ok: z.boolean(), pageId: z.string(), activePageId: z.string() },
    annotations: { ...localWriteAnnotations, destructiveHint: true },
  }, (input) => projectStore.deletePage(input.pageId));

  register(server, "save_canvas_asset", {
    title: "Save Canvas Asset",
    description: "Save a bounded bitmap or sanitized SVG as a content-addressed project asset for later Canvas or image-task use.",
    inputSchema: {
      dataBase64: z.string().min(1).max(48_000_000),
      mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]),
      fileName: z.string().trim().max(120).optional(),
    },
    outputSchema: z.object({ assetId: z.string(), mimeType: z.string(), size: z.number(), width: z.number().optional(), height: z.number().optional() }).passthrough(),
    annotations: localWriteAnnotations,
    _meta: appOnlyMeta,
  }, (input) => projectStore.saveAsset(input));

  register(server, "get_modellix_canvas_status", {
    title: "Get Modellix Canvas Status",
    description: "Check workspace binding, CLI dependency compatibility, persistent API-key status, approved models, and Canvas mode without exposing secrets.",
    inputSchema: { refresh: z.boolean().optional(), workspacePath },
    outputSchema: statusOutputSchema,
    annotations: readOnlyAnnotations,
  }, async (input) => {
    if (input.workspacePath) await context.bindWorkspace(input.workspacePath);
    return service.status({ refresh: input.refresh === true });
  });

  register(server, "start_modellix_api_key_setup", {
    title: "Start Modellix API Key Setup",
    description: `Create a short-lived loopback form that validates and stores a Modellix API key through the installed CLI dependency. Create a production key at ${PRODUCTION_API_KEY_URL}. The key is never a tool argument.`,
    inputSchema: { language: z.enum(["en", "zh-CN", "ja-JP"]).optional() },
    outputSchema: { ok: z.boolean(), setupUrl: z.string().url(), expiresAt: z.string(), apiKeyPageUrl: z.string().url() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => localWeb.createSetupUrl(input.language));

  registerAppTool(server, "open_modellix_canvas", {
    title: "Open Modellix Agent Canvas",
    description: "Open the workspace-bound Canvas. MCP Apps hosts receive the embedded app; other compatible MCP hosts receive a short-lived loopback URL.",
    inputSchema: { pageId: id.optional(), workspacePath },
    outputSchema: { ok: z.boolean(), workspaceId: z.string(), pageId: z.string().nullable(), mode: z.enum(["mcp-app", "local-web"]), localUrl: z.string().url().optional(), widget: z.string().optional(), preferredDisplayMode: z.string().optional() },
    annotations: readOnlyAnnotations,
    _meta: {
      ui: { resourceUri: MODELLIX_WIDGET_URI, visibility: ["model", "app"] },
      "ui/resourceUri": MODELLIX_WIDGET_URI,
      "openai/outputTemplate": MODELLIX_WIDGET_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Opening Modellix Canvas…",
      "openai/toolInvocation/invoked": "Modellix Canvas ready",
    },
  }, async (input = {}) => {
    try {
      if (input.workspacePath) await context.bindWorkspace(input.workspacePath);
      await context.initialize();
      context.requireWorkspace();
      const common = { ok: true, workspaceId: context.workspaceId, pageId: input.pageId || null };
      if (!context.supportsMcpApps) {
        return successResult("Opened Modellix Agent Canvas in the local fallback.", { ...common, mode: "local-web", localUrl: await localWeb.createCanvasUrl() });
      }
      return {
        ...successResult("Rendered Modellix Agent Canvas.", { ...common, mode: "mcp-app", widget: "modellix-agent-canvas", preferredDisplayMode: "fullscreen" }),
        _meta: {
          "openai/outputTemplate": MODELLIX_WIDGET_URI,
          widgetData: { workspaceId: context.workspaceId, pageId: input.pageId || null, preferredDisplayMode: "fullscreen" },
        },
      };
    } catch (error) {
      return errorToolResult(error);
    }
  });

  register(server, "prepare_modellix_image_task", {
    title: "Prepare Modellix Image Task",
    description: "Resolve ordered project assets, select an approved model, disclose effective output and estimated cost, and return a short-lived confirmation fingerprint. Does not upload or submit.",
    inputSchema: imageIntentSchema,
    outputSchema: {
      ok: z.boolean(), routerVersion: z.number().int().positive(), modelSlug: z.string(), modelDisplayName: z.string(), routeReasonCode: z.string(),
      requestedOutput: z.record(z.string(), z.unknown()), effectiveOutput: z.record(z.string(), z.unknown()), effectiveModelParams: z.record(z.string(), z.unknown()),
      capabilityWarnings: z.array(z.string()), taskCount: z.number().int().positive(), routeFingerprint: z.string(), routerFingerprint: z.string(),
      referenceCount: z.number().int().nonnegative(), modelAvailable: z.boolean(), pricing: z.record(z.string(), z.unknown()), expiresAt: z.string(), inputDigest: z.string(),
    },
    annotations: externalReadOnlyAnnotations,
  }, (input) => service.prepare(input));

  register(server, "submit_modellix_image_task", {
    title: "Submit Modellix Image Task",
    description: "After explicit confirmation, revalidate the route, upload ordered inputs, and create one paid Modellix task per requested output.",
    inputSchema: { ...imageIntentSchema, operationId: z.string().trim().min(8).max(128).default(() => randomUUID()), routeFingerprint: z.string().trim().min(32), confirmedPaidSubmission: z.literal(true) },
    outputSchema: { ok: z.boolean(), operationId: z.string(), modelSlug: z.string(), routeReasonCode: z.string(), tasks: z.array(taskSummarySchema) },
    annotations: paidWriteAnnotations,
  }, (input) => service.submit(input));

  register(server, "get_modellix_image_task", {
    title: "Get Modellix Image Task",
    description: "Query one task recorded in this workspace and return normalized status without exposing temporary result URLs.",
    inputSchema: { taskId: id },
    outputSchema: { ok: z.boolean(), taskId: z.string(), status: z.enum(["pending", "processing", "success", "cancelled", "failed"]), resourceCount: z.number().int().nonnegative(), resultExpiresAt: z.string().nullable() },
    annotations: externalReadOnlyAnnotations,
  }, (input) => service.getTask(input.taskId));

  register(server, "finalize_modellix_image_task", {
    title: "Finalize Modellix Image Task",
    description: "Download a successful task into controlled staging, insert or replace Canvas objects, persist project assets, and clean temporary uploads.",
    inputSchema: { taskId: id, confirmTargetOverride: z.boolean().optional() },
    outputSchema: { ok: z.boolean(), taskId: z.string(), localAssets: z.array(z.string()), objectIds: z.array(z.string()), elementIds: z.array(z.string()), bounds: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })), alreadyFinalized: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, (input) => service.finalize(input.taskId, { confirmTargetOverride: input.confirmTargetOverride }));

  register(server, "cleanup_modellix_canvas_uploads", {
    title: "Clean Up Modellix Canvas Uploads",
    description: "Retry deletion of temporary File API inputs retained after terminal image tasks.",
    inputSchema: { operationId: z.string().trim().min(8).max(128), confirmCleanup: z.literal(true) },
    outputSchema: { ok: z.boolean(), operationId: z.string(), deletedCount: z.number().int().nonnegative(), remainingCount: z.number().int().nonnegative() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, (input) => service.cleanupOperationUploads(input.operationId));

  register(server, "list_modellix_canvas_tasks", {
    title: "List Modellix Canvas Tasks",
    description: "List redacted workspace-local operation summaries for recovery. Prompts, secrets, absolute paths, and temporary URLs are omitted.",
    inputSchema: { status: z.string().trim().optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.number().int().min(0).default(0) },
    outputSchema: { schemaVersion: z.number().int().positive(), total: z.number().int().nonnegative(), cursor: z.number().int().nonnegative(), operations: z.array(z.object({ operationId: z.string(), status: z.string(), tasks: z.array(taskSummarySchema) }).passthrough()), nextCursor: z.number().int().nonnegative().nullable() },
    annotations: readOnlyAnnotations,
  }, (input) => taskStore.list(input));
}

function register(server, name, definition, handler) {
  server.registerTool(name, definition, async (input = {}) => {
    try {
      return successResult(`${definition.title} completed.`, await handler(input));
    } catch (error) {
      return errorToolResult(error);
    }
  });
}

function successResult(text, structuredContent) { return { content: [{ type: "text", text }], structuredContent }; }
