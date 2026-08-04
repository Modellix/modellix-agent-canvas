import { createHash } from "node:crypto";

import {
  APPROVED_MODELS,
  canonicalJson,
  MAX_OUTPUT_TASKS,
  MAX_REFERENCE_IMAGES,
  ROUTER_VERSION,
} from "./modellix-contracts.mjs";
import { ModellixCanvasError } from "./modellix-errors.mjs";

const OPENAI_STANDARD_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const GPT_IMAGE_2_SIZES = new Set([
  "1024x1024",
  "2048x2048",
  "1536x1024",
  "3072x2048",
  "1024x1536",
  "2048x3072",
  "1024x768",
  "2048x1536",
  "768x1024",
  "1536x2048",
  "2048x1152",
  "3840x2160",
  "1152x2048",
  "2160x3840",
]);
const HIGH_RESOLUTION_SIZES = new Set([
  "2048x2048",
  "3072x2048",
  "2048x3072",
  "2048x1536",
  "1536x2048",
  "3840x2160",
  "2160x3840",
]);
const NANO_SPECS = new Map([
  ["1024x1024", { aspectRatio: "1:1", imageSize: "1K" }],
  ["1536x1024", { aspectRatio: "3:2", imageSize: "1K" }],
  ["1024x1536", { aspectRatio: "2:3", imageSize: "1K" }],
  ["1024x768", { aspectRatio: "4:3", imageSize: "1K" }],
  ["768x1024", { aspectRatio: "3:4", imageSize: "1K" }],
  ["2048x1152", { aspectRatio: "16:9", imageSize: "1K" }],
  ["1152x2048", { aspectRatio: "9:16", imageSize: "1K" }],
  ["2048x2048", { aspectRatio: "1:1", imageSize: "2K" }],
  ["3072x2048", { aspectRatio: "3:2", imageSize: "2K" }],
  ["2048x3072", { aspectRatio: "2:3", imageSize: "2K" }],
  ["2048x1536", { aspectRatio: "4:3", imageSize: "2K" }],
  ["1536x2048", { aspectRatio: "3:4", imageSize: "2K" }],
  ["3840x2160", { aspectRatio: "16:9", imageSize: "4K" }],
  ["2160x3840", { aspectRatio: "9:16", imageSize: "4K" }],
]);

export function routeModellixImageTask(rawInput) {
  const input = normalizeIntent(rawInput);
  validateIntent(input);
  const referenceCount = input.inputAssetDigests.length;
  const specialEdit = input.background === "transparent" || input.inputFidelity === "strict";
  const requestedOpenAiSize = OPENAI_STANDARD_SIZES.has(input.size);
  const requestedHighResolution = HIGH_RESOLUTION_SIZES.has(input.size)
    || NANO_SPECS.get(input.size)?.imageSize !== "1K";

  if (specialEdit && (requestedHighResolution || !requestedOpenAiSize)) {
    if (input.fitPolicy === "exact" || requestedHighResolution) {
      throw capabilityConflict(
        "Transparent or strict-fidelity editing cannot satisfy the requested exact ratio or 2K/4K size.",
      );
    }
  }

  let modelSlug;
  let routeReasonCode;
  if (referenceCount === 0) {
    if (input.background === "transparent") {
      modelSlug = "openai/gpt-image-1.5";
      routeReasonCode = "TRANSPARENT_GENERATE";
    } else {
      modelSlug = "openai/gpt-image-2";
      routeReasonCode = "DEFAULT_OPAQUE_GENERATE";
    }
  } else if (specialEdit) {
    modelSlug = "openai/gpt-image-1.5-edit";
    routeReasonCode = "TRANSPARENT_OR_STRICT_EDIT";
  } else if (referenceCount === 1) {
    modelSlug = "openai/gpt-image-2-edit";
    routeReasonCode = "DEFAULT_SINGLE_EDIT";
  } else if (requestedOpenAiSize && !requestedHighResolution) {
    modelSlug = "openai/gpt-image-1.5-edit";
    routeReasonCode = "MULTI_REFERENCE_STANDARD_EDIT";
  } else {
    modelSlug = "google/nano-banana-pro-edit";
    routeReasonCode = "MULTI_REFERENCE_HIGH_RES_EDIT";
  }

  const effectiveOutput = effectiveOutputFor({ input, modelSlug });
  const capabilityWarnings = outputWarnings(input, effectiveOutput, modelSlug);
  const effectiveModelParams = effectiveModelParamsFor({ input, modelSlug, effectiveOutput });
  const fingerprintPayload = {
    routerVersion: ROUTER_VERSION,
    modelSlug,
    routeReasonCode,
    orderedInputAssetDigests: input.inputAssetDigests,
    requestedOutput: requestedOutputFor(input),
    effectiveModelParams,
    count: input.count,
  };

  return {
    routerVersion: ROUTER_VERSION,
    modelSlug,
    routeReasonCode,
    requestedOutput: requestedOutputFor(input),
    effectiveOutput,
    effectiveModelParams,
    capabilityWarnings,
    referenceCount,
    taskCount: input.count,
    routeFingerprint: sha256(canonicalJson(fingerprintPayload)),
  };
}

export function approvedModelSet() {
  return new Set(APPROVED_MODELS);
}

function normalizeIntent(rawInput = {}) {
  return {
    mode: rawInput.mode === "edit" ? "edit" : "generate",
    inputAssetDigests: Array.isArray(rawInput.inputAssetDigests)
      ? rawInput.inputAssetDigests.map((value) => String(value))
      : [],
    maskDigest: rawInput.maskDigest ? String(rawInput.maskDigest) : null,
    size: String(rawInput.size || "1024x1024"),
    fitPolicy: rawInput.fitPolicy === "exact" ? "exact" : "contain",
    quality: ["low", "medium", "high"].includes(rawInput.quality) ? rawInput.quality : "medium",
    background: ["auto", "opaque", "transparent"].includes(rawInput.background)
      ? rawInput.background
      : "auto",
    inputFidelity: rawInput.inputFidelity === "strict" ? "strict" : "standard",
    count: Number(rawInput.count ?? 1),
  };
}

function validateIntent(input) {
  const references = input.inputAssetDigests.length;
  if (references > MAX_REFERENCE_IMAGES) {
    throw new ModellixCanvasError(
      "REFERENCE_LIMIT_EXCEEDED",
      `At most ${MAX_REFERENCE_IMAGES} ordered reference images are allowed.`,
      { recoveryActions: ["Remove reference images after the tenth item and prepare again."] },
    );
  }
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_OUTPUT_TASKS) {
    throw new ModellixCanvasError("INPUT_INVALID", `Output count must be between 1 and ${MAX_OUTPUT_TASKS}.`);
  }
  if (input.mode === "generate" && references > 0) {
    throw new ModellixCanvasError("INPUT_INVALID", "Generate mode cannot include reference images; use edit mode.");
  }
  if (input.mode === "edit" && references === 0) {
    throw new ModellixCanvasError("INPUT_INVALID", "Edit mode requires at least one reference image.");
  }
  if (input.inputFidelity === "strict" && references === 0) {
    throw new ModellixCanvasError("INPUT_INVALID", "Strict input fidelity requires a reference image.");
  }
  if (input.maskDigest && references !== 1) {
    throw capabilityConflict("A mask must be paired with exactly one reference image.");
  }
  if (!/^\d{2,5}x\d{2,5}$/u.test(input.size)) {
    throw new ModellixCanvasError("INPUT_INVALID", "Output size must use WIDTHxHEIGHT format.");
  }
}

function effectiveOutputFor({ input, modelSlug }) {
  if (modelSlug === "google/nano-banana-pro-edit") {
    const spec = NANO_SPECS.get(input.size);
    if (!spec) throw capabilityConflict("The requested ratio or resolution is not supported by the approved models.");
    return { size: input.size, fitPolicy: "exact", quality: "not_applicable", ...spec };
  }
  if (modelSlug === "openai/gpt-image-1.5" || modelSlug === "openai/gpt-image-1.5-edit") {
    const size = OPENAI_STANDARD_SIZES.has(input.size) ? input.size : closestOpenAiSize(input.size);
    return { size, fitPolicy: size === input.size ? "exact" : "contain", quality: input.quality };
  }
  const size = GPT_IMAGE_2_SIZES.has(input.size)
    ? input.size
    : closestSupportedSize(input.size, GPT_IMAGE_2_SIZES);
  if (size !== input.size && input.fitPolicy === "exact") {
    throw capabilityConflict(`${modelSlug} cannot satisfy the requested exact output size.`);
  }
  return { size, fitPolicy: size === input.size ? "exact" : "contain", quality: input.quality };
}

function effectiveModelParamsFor({ input, modelSlug, effectiveOutput }) {
  if (modelSlug === "google/nano-banana-pro-edit") {
    return {
      aspectRatio: effectiveOutput.aspectRatio,
      imageSize: effectiveOutput.imageSize,
    };
  }
  const params = { size: effectiveOutput.size, quality: input.quality };
  if (modelSlug.includes("1.5")) params.background = input.background;
  if (modelSlug === "openai/gpt-image-1.5-edit") {
    params.input_fidelity = input.inputFidelity === "strict" ? "high" : "low";
  }
  return params;
}

function requestedOutputFor(input) {
  return {
    size: input.size,
    fitPolicy: input.fitPolicy,
    quality: input.quality,
    background: input.background,
    inputFidelity: input.inputFidelity,
  };
}

function outputWarnings(input, effectiveOutput, modelSlug) {
  const warnings = [];
  if (effectiveOutput.size !== input.size) {
    warnings.push(`Requested ${input.size}; ${modelSlug} will return ${effectiveOutput.size} and Canvas will contain-fit it without stretching or cropping.`);
  }
  if (modelSlug === "google/nano-banana-pro-edit") {
    warnings.push("The selected Google model does not accept the OpenAI quality field; imageSize is the effective quality specification.");
  }
  return warnings;
}

function closestOpenAiSize(size) {
  const [width, height] = size.split("x").map(Number);
  if (width > height) return "1536x1024";
  if (height > width) return "1024x1536";
  return "1024x1024";
}

function closestSupportedSize(size, candidates) {
  const [requestedWidth, requestedHeight] = size.split("x").map(Number);
  const requestedRatio = requestedWidth / requestedHeight;
  const requestedArea = requestedWidth * requestedHeight;
  return [...candidates]
    .map((candidate) => {
      const [width, height] = candidate.split("x").map(Number);
      const ratioDistance = Math.abs(Math.log((width / height) / requestedRatio));
      const areaDistance = Math.abs(Math.log((width * height) / requestedArea));
      return { candidate, score: ratioDistance * 4 + areaDistance };
    })
    .sort((first, second) => first.score - second.score || first.candidate.localeCompare(second.candidate))[0].candidate;
}

function capabilityConflict(message) {
  return new ModellixCanvasError("CAPABILITY_CONFLICT", message, {
    recoveryActions: ["Choose contain fit, a standard 1K size, or remove the conflicting transparency, fidelity, or mask requirement."],
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
