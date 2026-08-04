import { ModellixCanvasError } from "../modellix-errors.mjs";

const OPENAI_MODELS = new Set([
  "openai/gpt-image-2",
  "openai/gpt-image-2-edit",
  "openai/gpt-image-1.5",
  "openai/gpt-image-1.5-edit",
]);

export function buildOpenAiImageBody({ modelSlug, prompt, imageUrls = [], maskUrl, route }) {
  if (!OPENAI_MODELS.has(modelSlug)) {
    throw new ModellixCanvasError("INPUT_INVALID", `Unsupported OpenAI adapter model: ${modelSlug}`);
  }
  const body = {
    prompt: normalizePrompt(prompt),
    size: route.effectiveModelParams.size,
    quality: route.effectiveModelParams.quality,
  };
  const isEdit = modelSlug.endsWith("-edit");
  if (isEdit) {
    if (modelSlug === "openai/gpt-image-2-edit" && imageUrls.length !== 1) {
      throw new ModellixCanvasError("INPUT_INVALID", "GPT Image 2 Edit requires exactly one image.");
    }
    if (modelSlug === "openai/gpt-image-1.5-edit" && (imageUrls.length < 1 || imageUrls.length > 10)) {
      throw new ModellixCanvasError("INPUT_INVALID", "GPT Image 1.5 Edit requires 1 to 10 images.");
    }
    body.images = imageUrls.map(normalizeHttpsUrl);
    if (maskUrl) body.mask = normalizeHttpsUrl(maskUrl);
  }
  if (modelSlug.includes("gpt-image-1.5")) body.background = route.effectiveModelParams.background;
  if (modelSlug === "openai/gpt-image-1.5-edit") {
    body.input_fidelity = route.effectiveModelParams.input_fidelity;
  }
  return body;
}

function normalizePrompt(value) {
  const prompt = String(value || "").trim();
  if (!prompt || prompt.length > 32_000) {
    throw new ModellixCanvasError("INPUT_INVALID", "Prompt must contain between 1 and 32000 characters.");
  }
  return prompt;
}

function normalizeHttpsUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== "https:") throw new ModellixCanvasError("INPUT_INVALID", "Model image URLs must use HTTPS.");
  return url.toString();
}
