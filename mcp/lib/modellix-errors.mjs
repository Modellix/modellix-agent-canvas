export const MODELLIX_ERROR_CODES = Object.freeze([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "CREDENTIAL_STORE_UNAVAILABLE",
  "CLI_MISSING",
  "CLI_INCOMPATIBLE",
  "WORKSPACE_UNBOUND",
  "WORKSPACE_BOUNDARY_VIOLATION",
  "INPUT_INVALID",
  "REVISION_CONFLICT",
  "REFERENCE_LIMIT_EXCEEDED",
  "CAPABILITY_CONFLICT",
  "MODEL_UNAVAILABLE",
  "ROUTE_CHANGED_RECONFIRM_REQUIRED",
  "PAID_CONFIRMATION_REQUIRED",
  "DUPLICATE_OPERATION",
  "SUBMISSION_UNKNOWN",
  "INSUFFICIENT_BALANCE",
  "RATE_LIMITED",
  "TASK_FAILED",
  "RESULT_EXPIRED",
  "DOWNLOAD_FAILED",
  "FINALIZE_CONFLICT",
]);

const CODE_SET = new Set(MODELLIX_ERROR_CODES);
const RETRYABLE_CODES = new Set(["RATE_LIMITED", "DOWNLOAD_FAILED"]);

export class ModellixCanvasError extends Error {
  constructor(code, message, options = {}) {
    if (!CODE_SET.has(code)) throw new TypeError(`Unknown Modellix Canvas error code: ${code}`);
    super(String(message || code), options.cause ? { cause: options.cause } : undefined);
    this.name = "ModellixCanvasError";
    this.code = code;
    this.recoveryActions = Array.isArray(options.recoveryActions)
      ? options.recoveryActions.map((value) => String(value)).slice(0, 8)
      : [];
    this.details = options.details && typeof options.details === "object"
      ? sanitizeDetails(options.details)
      : undefined;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.nextAction = String(options.nextAction || this.recoveryActions[0] || defaultNextAction(code));
  }
}

export function asModellixCanvasError(error, fallbackCode = "INPUT_INVALID") {
  if (error instanceof ModellixCanvasError) return error;
  const message = error instanceof Error ? error.message : "Modellix Canvas operation failed.";
  return new ModellixCanvasError(fallbackCode, sanitizeMessage(message), { cause: error });
}

export function errorToolResult(error) {
  const normalized = asModellixCanvasError(error);
  const structuredContent = {
    ok: false,
    error: {
      code: normalized.code,
      message: sanitizeMessage(normalized.message),
      recoveryActions: normalized.recoveryActions,
      retryable: normalized.retryable,
      nextAction: sanitizeMessage(normalized.nextAction),
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: `${normalized.code}: ${structuredContent.error.message}` }],
    structuredContent,
  };
}

function defaultNextAction(code) {
  if (code === "SUBMISSION_UNKNOWN") return "Query the existing operation from the task ledger; do not resubmit.";
  if (code === "AUTH_REQUIRED" || code === "AUTH_INVALID") return "Open a new one-time API-key setup page.";
  if (code === "REVISION_CONFLICT") return "Reload the project and reapply the pending local change.";
  return "Review the input and recovery actions before retrying.";
}

export function sanitizeMessage(message) {
  return String(message || "Operation failed.")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:api[_-]?key|key|token|signature)=)[^&\s]*/giu, "$1[REDACTED]")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .slice(0, 1200);
}

function sanitizeDetails(details) {
  return JSON.parse(JSON.stringify(details, (key, value) => {
    if (/api.?key|authorization|prompt|remote.?url|absolute.?path/iu.test(key)) return undefined;
    return typeof value === "string" ? sanitizeMessage(value).slice(0, 300) : value;
  }));
}
