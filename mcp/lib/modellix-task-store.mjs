import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";

import { TASK_STORE_SCHEMA_VERSION } from "./modellix-contracts.mjs";
import { ModellixCanvasError } from "./modellix-errors.mjs";

const MAX_STORE_BYTES = 8 * 1024 * 1024;

export class ModellixTaskStore {
  constructor(workspaceRoot) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.filePath = path.join(this.workspaceRoot, ".modellix", "canvas", "tasks", "snapshot.json");
    this.eventsPath = path.join(this.workspaceRoot, ".modellix", "canvas", "tasks", "events.jsonl");
  }

  async read() {
    return readStoreFile(this.filePath);
  }

  async list({ status, limit = 50, cursor = 0 } = {}) {
    const store = await this.read();
    const filtered = status
      ? store.operations.filter((operation) => operation.status === status || operation.tasks.some((task) => task.status === status))
      : store.operations;
    return {
      schemaVersion: store.schemaVersion,
      total: filtered.length,
      cursor,
      operations: filtered.slice(cursor, cursor + limit).map(redactOperation),
      nextCursor: cursor + limit < filtered.length ? cursor + limit : null,
    };
  }

  async getOperation(operationId) {
    const store = await this.read();
    return store.operations.find((operation) => operation.operationId === operationId) || null;
  }

  async getTask(taskId) {
    const store = await this.read();
    for (const operation of store.operations) {
      const task = operation.tasks.find((entry) => entry.taskId === taskId);
      if (task) return { operation, task };
    }
    return null;
  }

  async createOperation(operation) {
    return this.transact((store) => {
      if (store.operations.some((entry) => entry.operationId === operation.operationId)) {
        throw new ModellixCanvasError("DUPLICATE_OPERATION", "This operation ID already exists.");
      }
      if (store.operations.some((entry) => entry.fingerprint === operation.fingerprint && !isTerminalOperation(entry))) {
        throw new ModellixCanvasError("DUPLICATE_OPERATION", "An unfinished operation with the same paid fingerprint already exists.", {
          recoveryActions: ["List Canvas tasks and continue the existing operation."],
        });
      }
      store.operations.unshift(structuredClone(operation));
      return structuredClone(operation);
    }, { type: "workflow_created", workflowId: operation.operationId, modelSlug: operation.modelSlug, taskCount: operation.tasks.length });
  }

  async updateOperation(operationId, mutate) {
    return this.transact((store) => {
      const index = store.operations.findIndex((entry) => entry.operationId === operationId);
      if (index < 0) throw new ModellixCanvasError("INPUT_INVALID", "Operation does not exist in this workspace.");
      const draft = structuredClone(store.operations[index]);
      const updated = mutate(draft) || draft;
      updated.updatedAt = new Date().toISOString();
      updated.status = aggregateOperationStatus(updated.tasks);
      store.operations[index] = updated;
      return structuredClone(updated);
    });
  }

  async updateTask(operationId, ordinal, patch) {
    const updated = await this.updateOperation(operationId, (operation) => {
      const task = operation.tasks.find((entry) => entry.ordinal === ordinal);
      if (!task) throw new ModellixCanvasError("INPUT_INVALID", "Task ordinal does not exist in the operation.");
      Object.assign(task, sanitizeTaskPatch(patch), { updatedAt: new Date().toISOString() });
      return operation;
    });
    await this.appendEvent(eventForTaskPatch(operationId, ordinal, patch));
    return updated;
  }

  async appendEvent(rawEvent) {
    const event = sanitizeEvent(rawEvent);
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const release = await lock(this.filePath, {
      realpath: false,
      retries: { retries: 80, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
      stale: 30_000,
      update: 10_000,
    });
    try {
      await appendEventFile(this.eventsPath, event);
    } finally {
      await release();
    }
    return event;
  }

  async readEvents() {
    try {
      const text = await readFile(this.eventsPath, "utf8");
      const lines = text.split("\n");
      const events = [];
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch (error) {
          if (index === lines.length - 1) break;
          throw new ModellixCanvasError("FINALIZE_CONFLICT", `Task event ledger is corrupted at line ${index + 1}.`, { cause: error });
        }
      }
      return events;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async transact(mutator, event = null) {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const release = await lock(this.filePath, {
      realpath: false,
      retries: { retries: 80, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
      stale: 30_000,
      update: 10_000,
    });
    try {
      const store = await readStoreFile(this.filePath);
      const result = mutator(store);
      await writeStoreFile(this.filePath, store);
      if (event) await appendEventFile(this.eventsPath, sanitizeEvent(event));
      return result;
    } finally {
      await release();
    }
  }
}

async function appendEventFile(filePath, event) {
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function eventForTaskPatch(workflowId, ordinal, patch = {}) {
  let type = "status_observed";
  if (patch.status === "submitting") type = "submit_started";
  else if (patch.taskId) type = "task_id_received";
  else if (patch.status === "submission_unknown") type = "attention_required";
  else if (patch.status === "cancelled") type = "cancelled";
  else if (patch.status === "finalized") type = "canvas_finalized";
  return { type, workflowId, ordinal, taskId: patch.taskId || null, status: patch.status || null };
}

function sanitizeEvent(event = {}) {
  const forbidden = /api.?key|authorization|prompt|remote.?url|resource.?url|confirmation.?token|bearer/iu;
  const clean = {};
  for (const [key, value] of Object.entries(event)) {
    if (forbidden.test(key)) continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) clean[key] = typeof value === "string" ? value.slice(0, 512) : value;
  }
  return { schemaVersion: 1, eventId: randomUUID(), at: new Date().toISOString(), ...clean };
}

export function aggregateOperationStatus(tasks) {
  const statuses = new Set(tasks.map((task) => task.status));
  if (statuses.size === 1 && statuses.has("finalized")) return "finalized";
  if (statuses.size === 1 && statuses.has("cancelled")) return "cancelled";
  if (statuses.has("submission_unknown")) return "needs_attention";
  if ((statuses.has("failed") || statuses.has("cancelled")) && statuses.size > 1) return "partially_failed";
  if (statuses.has("failed")) return "partially_failed";
  if ([...statuses].some((value) => ["preparing", "submitting", "submitted", "pending", "processing", "finalizing"].includes(value))) {
    return statuses.has("preparing") ? "partially_submitted" : "active";
  }
  if (statuses.size === 1 && statuses.has("success")) return "success";
  return "preparing";
}

async function readStoreFile(filePath) {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STORE_BYTES) {
      throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Task store must be a bounded regular file.");
    }
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (parsed.schemaVersion !== TASK_STORE_SCHEMA_VERSION || !Array.isArray(parsed.operations)) {
      throw new ModellixCanvasError("FINALIZE_CONFLICT", "Unsupported Modellix task store schema.");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: TASK_STORE_SCHEMA_VERSION, operations: [] };
    throw error;
  }
}

async function writeStoreFile(filePath, store) {
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(payload) > MAX_STORE_BYTES) throw new Error("Modellix task store size limit exceeded.");
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function sanitizeTaskPatch(patch) {
  const forbidden = new Set(["apiKey", "prompt", "remoteUrl", "resourceUrl", "authorization"]);
  return Object.fromEntries(Object.entries(patch || {}).filter(([key]) => !forbidden.has(key)));
}

function isTerminalOperation(operation) {
  return operation.tasks.length > 0
    && operation.tasks.every((task) => ["cancelled", "failed", "finalized"].includes(task.status));
}

function redactOperation(operation) {
  return {
    operationId: operation.operationId,
    status: operation.status,
    modelSlug: operation.modelSlug,
    routeReasonCode: operation.routeReasonCode,
    requestedOutput: operation.requestedOutput,
    pricing: operation.pricing || null,
    taskCount: operation.tasks.length,
    tasks: operation.tasks.map((task) => ({
      ordinal: task.ordinal,
      taskId: task.taskId || null,
      status: task.status,
      resultExpiresAt: task.resultExpiresAt || null,
      localAssets: task.localAssets || [],
      finalizedObjectIds: task.finalizedObjectIds || [],
      finalizedElementIds: task.finalizedElementIds || task.finalizedShapeIds || [],
      finalizedBounds: task.finalizedBounds || [],
    })),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}
