import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { buildNanoBananaBody } from "./model-adapters/google-nano-banana.mjs";
import { buildOpenAiImageBody } from "./model-adapters/openai-gpt-image.mjs";
import {
  APPROVED_MODELS,
  canonicalJson,
  PREPARE_TTL_MS,
  ROUTER_VERSION,
} from "./modellix-contracts.mjs";
import { ModellixCanvasError, asModellixCanvasError } from "./modellix-errors.mjs";
import { routeModellixImageTask } from "./modellix-model-router.mjs";

const MAX_PROMPT_LENGTH = 32_000;
const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;
const REFERENCE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const IMPORT_ENV_NAMES = [
  "MODELLIX_PLUGIN_API_KEY",
  "CLAUDE_PLUGIN_OPTION_MODELLIX_API_KEY",
  "CURSOR_MODELLIX_API_KEY",
  "OPENCODE_MODELLIX_API_KEY",
  "MODELLIX_API_KEY",
];

export class ModellixImageService {
  constructor(options) {
    this.context = options.context;
    this.cli = options.cli;
    this.taskStore = options.taskStore;
    this.projectStore = options.projectStore;
    this.now = options.now || (() => Date.now());
    this.preparations = new Map();
  }

  async status({ refresh = false } = {}) {
    await this.context.initialize();
    const contextSnapshot = this.context.snapshot();
    const compatibility = await this.cli.compatibility();
    let authentication = { ok: false, authenticated: false, valid: false };
    if (compatibility.compatible) authentication = await this.ensureAuthentication({ allowImport: refresh });
    let models = [];
    if (authentication.ok && authentication.valid) {
      try {
        models = await this.cli.listModels();
      } catch {
        models = [];
      }
    }
    const available = new Set(modelSlugs(models));
    return {
      ok: compatibility.compatible,
      ...contextSnapshot,
      baseUrlOrigin: this.cli.baseUrl,
      profile: this.cli.profile,
      credentialState: authentication.valid ? "valid" : authentication.authenticated ? "invalid" : "missing",
      credentialSource: authentication.apiKeySource || null,
      cliVersion: compatibility.version,
      cliCompatible: compatibility.compatible,
      routerVersion: ROUTER_VERSION,
      approvedModels: Object.fromEntries(APPROVED_MODELS.map((slug) => [slug, available.has(slug)])),
      canvasMode: this.context.supportsMcpApps ? "mcp-app" : "local-web",
      recoveryActions: statusRecoveryActions({ authentication, compatibility, workspaceBound: contextSnapshot.workspaceBound }),
    };
  }

  async prepare(rawInput) {
    const input = normalizePublicIntent(rawInput);
    await this.requireAuthentication();
    const prepared = await this.buildPreparation(input);
    this.preparations.set(prepared.routeFingerprint, {
      expiresAtMs: prepared.expiresAtMs,
      inputDigest: prepared.inputDigest,
    });
    await this.taskStore.appendEvent?.({
      type: "prepared",
      workflowId: `prepare_${prepared.routeFingerprint.slice(0, 24)}`,
      modelSlug: prepared.modelSlug,
      taskCount: prepared.taskCount,
      routeFingerprint: prepared.routeFingerprint,
    });
    this.prunePreparations();
    const { expiresAtMs: _expiresAtMs, references: _references, ...publicResult } = prepared;
    return publicResult;
  }

  async submit(rawInput) {
    if (rawInput.confirmedPaidSubmission !== true) {
      throw new ModellixCanvasError("PAID_CONFIRMATION_REQUIRED", "Explicit confirmation is required before creating paid tasks.");
    }
    const input = normalizePublicIntent(rawInput);
    const operationId = normalizeOperationId(rawInput.operationId);
    const confirmedFingerprint = String(rawInput.routeFingerprint || "");
    const confirmed = this.preparations.get(confirmedFingerprint);
    await this.requireAuthentication();
    const prepared = await this.buildPreparation(input);
    if (
      !confirmed
      || confirmed.expiresAtMs <= this.now()
      || confirmedFingerprint !== prepared.routeFingerprint
      || confirmed.inputDigest !== prepared.inputDigest
    ) {
      throw new ModellixCanvasError("ROUTE_CHANGED_RECONFIRM_REQUIRED", "The model route or effective output changed after confirmation.", {
        recoveryActions: ["Run prepare again and confirm the updated model, specifications, and cost disclosure."],
      });
    }
    this.preparations.delete(confirmedFingerprint);

    const references = prepared.references;
    const anchor = input.targetObjectId ? await this.projectStore.locateObject(input.targetObjectId) : null;
    const now = new Date(this.now()).toISOString();
    const operation = {
      schemaVersion: 1,
      operationId,
      fingerprint: prepared.inputDigest,
      routeFingerprint: prepared.routeFingerprint,
      promptHash: sha256(input.prompt),
      inputAssetDigests: references.images.map((item) => item.digest),
      maskDigest: references.mask?.digest || null,
      routerVersion: prepared.routerVersion,
      routeReasonCode: prepared.routeReasonCode,
      modelSlug: prepared.modelSlug,
      baseUrlOrigin: this.cli.baseUrl,
      profile: this.cli.profile,
      requestedOutput: prepared.requestedOutput,
      effectiveModelParams: prepared.effectiveModelParams,
      pricing: prepared.pricing,
      pageId: input.pageId,
      anchorObjectId: input.targetObjectId,
      anchorSnapshot: anchor ? {
        pageId: anchor.pageId,
        kind: anchor.element.customData?.modellix?.kind || anchor.element.type,
        bounds: { x: anchor.element.x, y: anchor.element.y, width: anchor.element.width, height: anchor.element.height, angle: anchor.element.angle || 0 },
      } : null,
      placementOrigin: input.placementX === null || input.placementY === null ? null : { x: input.placementX, y: input.placementY },
      status: "preparing",
      uploadedMediaFileIds: [],
      tasks: Array.from({ length: prepared.taskCount }, (_, index) => ({
        ordinal: index + 1,
        taskId: null,
        status: "preparing",
        createdAt: now,
        updatedAt: now,
        resultExpiresAt: null,
        localAssets: [],
        finalizedObjectIds: [],
        finalizedElementIds: [],
      })),
      createdAt: now,
      updatedAt: now,
    };
    await this.taskStore.createOperation(operation);
    await this.taskStore.appendEvent?.({ type: "confirmed", workflowId: operationId, routeFingerprint: prepared.routeFingerprint });

    const uploads = [];
    try {
      for (const reference of [...references.images, ...(references.mask ? [references.mask] : [])]) {
        // Uploads remain sequential so reference order and cleanup checkpoints are deterministic.
        // eslint-disable-next-line no-await-in-loop
        uploads.push(await this.cli.uploadFile(reference.filePath));
        // eslint-disable-next-line no-await-in-loop
        await this.taskStore.updateOperation(operationId, (draft) => {
          draft.uploadedMediaFileIds = uploads.map((item) => item.fileId);
          return draft;
        });
      }
    } catch (error) {
      const remaining = await cleanupFileIds(this.cli, uploads.map((entry) => entry.fileId));
      await this.taskStore.updateOperation(operationId, (draft) => {
        draft.uploadedMediaFileIds = remaining;
        for (const task of draft.tasks) Object.assign(task, { status: "failed", errorCode: "INPUT_UPLOAD_FAILED" });
        return draft;
      });
      throw error;
    }

    const imageUrls = uploads.slice(0, references.images.length).map((item) => item.url);
    const maskUrl = references.mask ? uploads.at(-1)?.url : undefined;
    const body = buildModelBody({ route: prepared, prompt: input.prompt, imageUrls, maskUrl });
    const accepted = [];
    for (let ordinal = 1; ordinal <= prepared.taskCount; ordinal += 1) {
      const submissionAttemptId = randomUUID();
      // eslint-disable-next-line no-await-in-loop
      await this.taskStore.updateTask(operationId, ordinal, { status: "submitting", submissionAttemptId });
      let taskId;
      try {
        // This call can create a paid task. The durable submitting marker above prevents blind retry.
        // eslint-disable-next-line no-await-in-loop
        taskId = await this.cli.submitModel(prepared.modelSlug, body);
      } catch (error) {
        const normalized = asModellixCanvasError(error);
        const status = normalized.code === "SUBMISSION_UNKNOWN" ? "submission_unknown" : "failed";
        // eslint-disable-next-line no-await-in-loop
        await this.taskStore.updateTask(operationId, ordinal, { status, errorCode: normalized.code });
        // eslint-disable-next-line no-await-in-loop
        await this.taskStore.updateOperation(operationId, (draft) => {
          for (const task of draft.tasks) {
            if (task.ordinal > ordinal && task.status === "preparing") Object.assign(task, { status: "failed", errorCode: "NOT_SUBMITTED_AFTER_FAILURE" });
          }
          return draft;
        });
        if (accepted.length === 0 && status === "failed") await this.cleanupOperationUploads(operationId, { allowNonTerminal: true });
        throw normalized;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.taskStore.updateTask(operationId, ordinal, { status: "submitted", taskId });
      } catch (error) {
        throw new ModellixCanvasError("SUBMISSION_UNKNOWN", `Paid task ${taskId} was accepted, but its recovery record could not be saved. Do not submit it again.`, {
          cause: error,
          recoveryActions: [`Use modellix-cli task get ${taskId} and preserve this task ID.`],
        });
      }
      accepted.push({ ordinal, taskId, status: "submitted" });
    }
    return { ok: true, operationId, modelSlug: prepared.modelSlug, routeReasonCode: prepared.routeReasonCode, tasks: accepted };
  }

  async getTask(taskId) {
    const normalizedId = normalizeTaskId(taskId);
    const stored = await this.taskStore.getTask(normalizedId);
    if (!stored) throw new ModellixCanvasError("INPUT_INVALID", "Task does not belong to this Canvas workspace.");
    const normalized = normalizeRemoteTask(await this.cli.getTask(normalizedId), normalizedId);
    await this.taskStore.updateOperation(stored.operation.operationId, (draft) => {
      const task = draft.tasks.find((entry) => entry.ordinal === stored.task.ordinal);
      if (!task) throw new ModellixCanvasError("INPUT_INVALID", "Task ordinal does not exist in the operation.");
      if (!["finalizing", "finalized"].includes(task.status)) {
        Object.assign(task, {
          status: normalized.status,
          resultExpiresAt: normalized.resultExpiresAt,
          resourceCount: normalized.resourceCount,
          ...(normalized.status === "failed" ? { errorCode: "TASK_FAILED" } : {}),
        });
      }
      return draft;
    });
    await this.taskStore.appendEvent?.({
      type: normalized.status === "cancelled" ? "cancelled" : "status_observed",
      workflowId: stored.operation.operationId,
      taskId: normalizedId,
      status: normalized.status,
      resourceCount: normalized.resourceCount,
    });
    const operation = await this.taskStore.getOperation(stored.operation.operationId);
    if (operation?.uploadedMediaFileIds?.length && operation.tasks.every((task) => ["cancelled", "failed", "finalized"].includes(task.status))) {
      await this.cleanupOperationUploads(operation.operationId);
    }
    return { ok: true, taskId: normalizedId, ...normalized };
  }

  async finalize(taskId, options = {}) {
    const normalizedId = normalizeTaskId(taskId);
    let stored = await this.taskStore.getTask(normalizedId);
    if (!stored) throw new ModellixCanvasError("INPUT_INVALID", "Task does not belong to this Canvas workspace.");
    if (stored.task.status === "finalized") return finalizedResult(normalizedId, stored.task, true);
    const remote = await this.getTask(normalizedId);
    if (remote.status !== "success") {
      throw new ModellixCanvasError(["failed", "cancelled"].includes(remote.status) ? "TASK_FAILED" : "DOWNLOAD_FAILED", `Task ${normalizedId} is ${remote.status}, not ready to finalize.`);
    }
    stored = await this.taskStore.getTask(normalizedId);
    const finalizeAttemptId = randomUUID();
    const claimed = await this.taskStore.updateOperation(stored.operation.operationId, (draft) => {
      const task = draft.tasks.find((entry) => entry.ordinal === stored.task.ordinal);
      if (!task) throw new ModellixCanvasError("INPUT_INVALID", "Task ordinal does not exist in the operation.");
      if (task.status === "finalized") return draft;
      const activeAt = Date.parse(task.finalizeAttemptStartedAt || task.updatedAt || "");
      if (task.status === "finalizing" && Number.isFinite(activeAt) && this.now() - activeAt < 5 * 60_000) {
        throw new ModellixCanvasError("FINALIZE_CONFLICT", "This task is already being finalized by another process.");
      }
      Object.assign(task, { status: "finalizing", finalizeAttemptId, finalizeAttemptStartedAt: new Date(this.now()).toISOString() });
      return draft;
    });
    const claimedTask = claimed.tasks.find((entry) => entry.ordinal === stored.task.ordinal);
    if (claimedTask.status === "finalized") return finalizedResult(normalizedId, claimedTask, true);
    stored = { operation: claimed, task: claimedTask };

    const existing = await this.projectStore.findTaskResources(normalizedId);
    const workspaceRoot = this.context.requireWorkspace();
    const staging = path.join(workspaceRoot, ".modellix", "canvas", "tasks", "staging", safeId(normalizedId));
    try {
      const target = await this.resolveFinalizationTarget(stored.operation, stored.task, existing, options.confirmTargetOverride === true);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await this.taskStore.appendEvent?.({ type: "download_started", workflowId: stored.operation.operationId, taskId: normalizedId });
      const download = await this.cli.downloadTask(normalizedId, staging);
      const files = Array.isArray(download.files) ? download.files : [];
      if (!files.length) throw new ModellixCanvasError("DOWNLOAD_FAILED", "The successful task did not produce a downloadable image.");
      const localAssets = [];
      const objectIds = [];
      const elementIds = [];
      const bounds = [];
      let anchorObjectId = target.anchorObjectId;
      let pageId = target.pageId;
      for (const [index, file] of files.entries()) {
        const recovered = existing.find((item) => item.resourceIndex === index);
        if (recovered) {
          localAssets.push(recovered.assetPath);
          objectIds.push(recovered.objectId);
          elementIds.push(recovered.elementId);
          bounds.push(recovered.bounds);
          anchorObjectId = recovered.objectId;
          pageId = recovered.pageId;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const imagePath = await assertStagedFile(staging, file.path);
        // eslint-disable-next-line no-await-in-loop
        const completedBefore = stored.operation.tasks
          .filter((entry) => entry.ordinal < stored.task.ordinal)
          .reduce((total, entry) => total + Math.max(entry.finalizedObjectIds?.length || 0, entry.status === "finalized" ? 1 : 0), 0);
        const globalResultIndex = completedBefore + index;
        const layoutIndex = stored.operation.anchorSnapshot?.kind === "image-holder" ? Math.max(0, globalResultIndex - 1) : globalResultIndex;
        const inserted = await this.projectStore.insertImage({
          imagePath,
          pageId,
          anchorObjectId: stored.operation.anchorSnapshot ? anchorObjectId : null,
          anchorBounds: stored.operation.anchorSnapshot?.bounds,
          replaceHolder: index === 0 && target.replaceOriginalAnchor,
          placement: "right",
          gridIndex: layoutIndex,
          placementOrigin: stored.operation.placementOrigin,
          margin: 40,
          metadata: {
            workflowId: stored.operation.operationId,
            taskId: normalizedId,
            resourceIndex: index,
            fitPolicy: stored.operation.requestedOutput?.fitPolicy,
          },
        });
        localAssets.push(path.relative(workspaceRoot, inserted.assetFile).replaceAll("\\", "/"));
        objectIds.push(inserted.objectId);
        elementIds.push(inserted.elementId);
        bounds.push(inserted.bounds);
        anchorObjectId = inserted.objectId;
        pageId = inserted.pageId;
        // eslint-disable-next-line no-await-in-loop
        await this.taskStore.appendEvent?.({ type: "asset_saved", workflowId: stored.operation.operationId, taskId: normalizedId, resourceIndex: index, assetId: inserted.assetId });
      }
      await this.taskStore.updateTask(stored.operation.operationId, stored.task.ordinal, {
        status: "finalized",
        localAssets,
        finalizedObjectIds: objectIds,
        finalizedElementIds: elementIds,
        finalizedBounds: bounds,
        finalizeAttemptId: null,
        finalizeAttemptStartedAt: null,
      });
      const updated = await this.taskStore.getOperation(stored.operation.operationId);
      if (updated?.tasks.every((task) => ["finalized", "failed"].includes(task.status))) await this.cleanupOperationUploads(updated.operationId);
      return { ok: true, taskId: normalizedId, localAssets, objectIds, elementIds, bounds, alreadyFinalized: false };
    } catch (error) {
      await this.taskStore.updateOperation(stored.operation.operationId, (draft) => {
        const task = draft.tasks.find((entry) => entry.ordinal === stored.task.ordinal);
        if (task?.status === "finalizing" && task.finalizeAttemptId === finalizeAttemptId) {
          Object.assign(task, { status: "success", finalizeAttemptId: null, finalizeAttemptStartedAt: null });
        }
        return draft;
      }).catch(() => {});
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  async cleanupOperationUploads(rawOperationId, { allowNonTerminal = false } = {}) {
    const operationId = normalizeOperationId(rawOperationId);
    const operation = await this.taskStore.getOperation(operationId);
    if (!operation) throw new ModellixCanvasError("INPUT_INVALID", "Operation does not exist in this workspace.");
    if (!allowNonTerminal && !operation.tasks.every((task) => ["cancelled", "failed", "finalized"].includes(task.status))) {
      throw new ModellixCanvasError("FINALIZE_CONFLICT", "Temporary inputs cannot be deleted until every task has failed or been finalized.");
    }
    const original = operation.uploadedMediaFileIds || [];
    const remaining = await cleanupFileIds(this.cli, original);
    await this.taskStore.updateOperation(operationId, (draft) => {
      draft.uploadedMediaFileIds = remaining;
      return draft;
    });
    return { ok: remaining.length === 0, operationId, deletedCount: original.length - remaining.length, remainingCount: remaining.length };
  }

  async buildPreparation(input) {
    const references = await this.resolveReferences(input);
    const route = routeModellixImageTask({
      ...input,
      inputAssetDigests: references.images.map((item) => item.digest),
      maskDigest: references.mask?.digest || null,
    });
    const models = await this.cli.listModels();
    const model = models.find((entry) => modelSlug(entry) === route.modelSlug);
    if (!model) {
      throw new ModellixCanvasError("MODEL_UNAVAILABLE", `The routed model ${route.modelSlug} is unavailable for this API origin.`, {
        recoveryActions: ["Retry after the model becomes available or change the conflicting output requirement."],
      });
    }
    const inputDigest = paidFingerprint({
      origin: this.cli.baseUrl,
      profile: this.cli.profile,
      promptHash: sha256(input.prompt),
      routerFingerprint: route.routeFingerprint,
      pageId: input.pageId,
      targetObjectId: input.targetObjectId,
      placementX: input.placementX,
      placementY: input.placementY,
      orderedReferences: references.images.map((item) => item.digest),
      maskDigest: references.mask?.digest || null,
    });
    const expiresAtMs = this.now() + PREPARE_TTL_MS;
    return {
      ok: true,
      ...route,
      capabilityWarnings: [
        ...(route.capabilityWarnings || []),
        ...(references.duplicateReferenceCount ? [`已按内容去除 ${references.duplicateReferenceCount} 张重复参考图，并保留首次出现的顺序。`] : []),
      ],
      routerFingerprint: route.routeFingerprint,
      routeFingerprint: inputDigest,
      modelAvailable: true,
      modelDisplayName: model.name || model.display_name || route.modelSlug,
      pricing: priceDisclosure(model, route.taskCount),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      inputDigest,
      references,
    };
  }

  async resolveReferences(input) {
    const images = [];
    for (const objectId of input.sourceObjectIds) {
      // eslint-disable-next-line no-await-in-loop
      const item = await this.projectStore.resolveImageObject(objectId);
      validateReference(item);
      images.push(item);
    }
    for (const assetId of input.sourceAssetIds) {
      // eslint-disable-next-line no-await-in-loop
      const item = await this.projectStore.readAsset(assetId);
      const reference = { ...item, digest: assetId, assetId };
      validateReference(reference);
      images.push(reference);
    }
    let mask = null;
    if (input.maskAssetId) {
      const item = await this.projectStore.readAsset(input.maskAssetId);
      mask = { ...item, digest: input.maskAssetId, assetId: input.maskAssetId };
      validateReference(mask, true);
    }
    const unique = [];
    const seen = new Set();
    for (const image of images) {
      const key = image.assetId || image.digest;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(image);
    }
    return { images: unique, mask, duplicateReferenceCount: images.length - unique.length };
  }

  async resolveFinalizationTarget(operation, task, existing, confirmedOverride) {
    const original = operation.anchorObjectId ? await this.projectStore.locateObject(operation.anchorObjectId) : null;
    const currentTaskAnchor = [...existing].sort((a, b) => b.resourceIndex - a.resourceIndex)[0] || null;
    const priorObjectId = [...operation.tasks]
      .filter((entry) => entry.ordinal < task.ordinal)
      .sort((left, right) => right.ordinal - left.ordinal)
      .flatMap((entry) => [...(entry.finalizedObjectIds || [])].reverse())[0];
    const prior = priorObjectId ? await this.projectStore.locateObject(priorObjectId) : null;
    if (operation.anchorObjectId && !original && !currentTaskAnchor && !prior && !confirmedOverride) {
      throw new ModellixCanvasError("FINALIZE_CONFLICT", "The confirmed Canvas target no longer exists.", {
        recoveryActions: ["Inspect the Canvas, then retry with confirmTargetOverride=true to place the result on the active page."],
      });
    }
    const recovered = currentTaskAnchor || prior;
    const anchorObjectId = original?.objectId || recovered?.objectId || null;
    const pageId = original?.pageId || recovered?.pageId || operation.pageId || undefined;
    return { anchorObjectId, pageId, replaceOriginalAnchor: task.ordinal === 1 && Boolean(original) };
  }

  async requireAuthentication() {
    const authentication = await this.ensureAuthentication({ allowImport: true });
    if (!authentication.ok || !authentication.valid) {
      throw new ModellixCanvasError(authentication.authenticated ? "AUTH_INVALID" : "AUTH_REQUIRED", "A valid Modellix API key is required.", {
        recoveryActions: ["Configure a key from https://www.modellix.ai/console/api-key and retry."],
      });
    }
    return authentication;
  }

  async ensureAuthentication({ allowImport }) {
    let status = await this.cli.authStatus({ ignoreEnvironment: true });
    if (status.ok && status.valid) {
      clearInjectedEnvironment();
      return status;
    }
    if (allowImport) {
      const environmentName = IMPORT_ENV_NAMES.find((name) => process.env[name]?.trim());
      if (environmentName) {
        try {
          await this.cli.importEnvironmentKey(environmentName);
        } finally {
          delete process.env[environmentName];
          if (environmentName === "MODELLIX_API_KEY") delete process.env.MODELLIX_API_KEY;
        }
        status = await this.cli.authStatus({ ignoreEnvironment: true });
      }
    }
    return status;
  }

  prunePreparations() {
    for (const [fingerprint, preparation] of this.preparations) {
      if (preparation.expiresAtMs <= this.now()) this.preparations.delete(fingerprint);
    }
  }
}

function normalizePublicIntent(input = {}) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new ModellixCanvasError("INPUT_INVALID", `Prompt must contain 1 to ${MAX_PROMPT_LENGTH} characters.`);
  return {
    prompt,
    mode: input.mode === "edit" ? "edit" : "generate",
    sourceObjectIds: uniqueIds(input.sourceObjectIds, "sourceObjectIds"),
    sourceAssetIds: uniqueIds(input.sourceAssetIds, "sourceAssetIds"),
    maskAssetId: input.maskAssetId ? normalizeId(input.maskAssetId, "maskAssetId") : null,
    size: String(input.size || "1024x1024"),
    fitPolicy: input.fitPolicy === "exact" ? "exact" : "contain",
    quality: ["low", "medium", "high"].includes(input.quality) ? input.quality : "medium",
    background: ["auto", "opaque", "transparent"].includes(input.background) ? input.background : "auto",
    inputFidelity: input.inputFidelity === "strict" ? "strict" : "standard",
    count: Number(input.count ?? 1),
    pageId: input.pageId ? normalizeId(input.pageId, "pageId") : null,
    targetObjectId: input.targetObjectId ? normalizeId(input.targetObjectId, "targetObjectId") : null,
    placementX: optionalCoordinate(input.placementX, "placementX"),
    placementY: optionalCoordinate(input.placementY, "placementY"),
  };
}

function uniqueIds(values, field) {
  const list = Array.isArray(values) ? values.map((value) => normalizeId(value, field)) : [];
  if (new Set(list).size !== list.length) throw new ModellixCanvasError("INPUT_INVALID", `${field} contains duplicate IDs.`);
  return list;
}

function validateReference(reference, requirePng = false) {
  if (reference.size > MAX_REFERENCE_BYTES || reference.fileSize > MAX_REFERENCE_BYTES) throw new ModellixCanvasError("INPUT_INVALID", "Reference image exceeds the 16 MiB File API limit.");
  if (!REFERENCE_MIME_TYPES.has(reference.mimeType)) throw new ModellixCanvasError("INPUT_INVALID", "References must be PNG, JPEG, or WebP bitmaps.");
  if (requirePng && reference.mimeType !== "image/png") throw new ModellixCanvasError("INPUT_INVALID", "Mask reference must be a PNG image.");
}

function buildModelBody({ route, prompt, imageUrls, maskUrl }) {
  return route.modelSlug.startsWith("openai/")
    ? buildOpenAiImageBody({ modelSlug: route.modelSlug, prompt, imageUrls, maskUrl, route })
    : buildNanoBananaBody({ modelSlug: route.modelSlug, prompt, imageUrls, maskUrl, route });
}

function normalizeRemoteTask(response, expectedTaskId) {
  const data = response?.data && typeof response.data === "object" ? response.data : response;
  const taskId = data?.task_id || data?.taskId;
  if (taskId && taskId !== expectedTaskId) throw new ModellixCanvasError("TASK_FAILED", "Task response identity did not match the requested task.");
  const rawStatus = String(data?.status || "").toLowerCase();
  const status = ["canceled", "cancelled"].includes(rawStatus) ? "cancelled" : rawStatus;
  if (!["pending", "processing", "success", "cancelled", "failed"].includes(status)) throw new ModellixCanvasError("TASK_FAILED", "Task response contained an unsupported status.");
  const resources = Array.isArray(data?.result?.resources) ? data.result.resources : [];
  return { status, resourceCount: resources.length, resultExpiresAt: normalizeRemoteExpiry(data?.result_expires_at ?? data?.resultExpiresAt) };
}

function normalizeRemoteExpiry(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 100_000_000_000 ? numeric * 1000 : numeric)
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function priceDisclosure(model, count) {
  const unit = [model.price, model.price_usd, model.pricing?.usd, model.pricing?.price].find((value) => typeof value === "number" && Number.isFinite(value));
  return unit === undefined
    ? { currency: "USD", unitPriceUsd: null, estimatedTotalUsd: null, statement: `Price could not be estimated. ${count} paid task(s) may still incur charges.` }
    : { currency: "USD", unitPriceUsd: unit, estimatedTotalUsd: unit * count, statement: `Estimated cost for ${count} paid task(s): $${(unit * count).toFixed(4)} USD.` };
}

function modelSlug(model) { return model?.slug || model?.model_slug || model?.id; }
function modelSlugs(models) { return Array.isArray(models) ? models.map(modelSlug).filter(Boolean) : []; }

function finalizedResult(taskId, task, alreadyFinalized) {
  return {
    ok: true,
    taskId,
    localAssets: task.localAssets || [],
    objectIds: task.finalizedObjectIds || [],
    elementIds: task.finalizedElementIds || task.finalizedShapeIds || [],
    bounds: task.finalizedBounds || [],
    alreadyFinalized,
  };
}

function statusRecoveryActions({ authentication, compatibility, workspaceBound }) {
  if (!compatibility.available) return ["Reinstall the plugin so its modellix-cli runtime dependency is present."];
  if (!compatibility.compatible) return ["Reinstall Modellix Agent Canvas and restart the MCP server."];
  if (!authentication.valid) return ["Create an API key at https://www.modellix.ai/console/api-key and start setup."];
  if (!workspaceBound) return ["Call the status or open tool again with workspacePath set to the active project root."];
  return [];
}

function clearInjectedEnvironment() { for (const name of IMPORT_ENV_NAMES) delete process.env[name]; }
function paidFingerprint(value) { return sha256(canonicalJson(value)); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function normalizeId(value, field) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(normalized)) throw new ModellixCanvasError("INPUT_INVALID", `${field} is invalid.`);
  return normalized;
}

function optionalCoordinate(value, field) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 10_000_000) throw new ModellixCanvasError("INPUT_INVALID", `${field} is invalid.`);
  return number;
}

function normalizeTaskId(value) { return normalizeId(value, "taskId"); }
function normalizeOperationId(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9._~:@+-]{8,128}$/u.test(normalized)) throw new ModellixCanvasError("INPUT_INVALID", "operationId is invalid.");
  return normalized;
}

async function cleanupFileIds(cli, fileIds) {
  const remaining = [];
  for (const fileId of fileIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await cli.deleteFile(fileId);
    } catch {
      remaining.push(fileId);
    }
  }
  return remaining;
}

async function assertStagedFile(staging, candidate) {
  const stagingReal = await realpath(staging);
  const candidatePath = path.resolve(String(candidate));
  const stats = await lstat(candidatePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new ModellixCanvasError("DOWNLOAD_FAILED", "Downloaded result is not a regular non-symlink file.");
  const candidateReal = await realpath(candidatePath);
  const relative = path.relative(stagingReal, candidateReal);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Downloaded result escaped the controlled staging directory.");
  return candidateReal;
}

function safeId(value) { return String(value).replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 120); }
