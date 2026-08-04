export const ROUTER_VERSION = 1;
export const TASK_STORE_SCHEMA_VERSION = 1;
export const MAX_REFERENCE_IMAGES = 10;
export const MAX_OUTPUT_TASKS = 4;
export const PREPARE_TTL_MS = 10 * 60 * 1000;
export const PRODUCTION_API_ORIGIN = "https://api.modellix.ai";
export const PRODUCTION_API_KEY_URL = "https://www.modellix.ai/console/api-key";
export const DEFAULT_PROFILE = "default";

export const APPROVED_MODELS = Object.freeze([
  "openai/gpt-image-2",
  "openai/gpt-image-2-edit",
  "openai/gpt-image-1.5",
  "openai/gpt-image-1.5-edit",
  "google/nano-banana-pro-edit",
]);

export const ROUTE_REASON_CODES = Object.freeze([
  "DEFAULT_OPAQUE_GENERATE",
  "TRANSPARENT_GENERATE",
  "DEFAULT_SINGLE_EDIT",
  "TRANSPARENT_OR_STRICT_EDIT",
  "MULTI_REFERENCE_STANDARD_EDIT",
  "MULTI_REFERENCE_HIGH_RES_EDIT",
]);

export const TASK_STATUSES = Object.freeze([
  "preparing",
  "submitting",
  "submission_unknown",
  "submitted",
  "pending",
  "processing",
  "success",
  "cancelled",
  "failed",
  "finalizing",
  "finalized",
]);

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}
