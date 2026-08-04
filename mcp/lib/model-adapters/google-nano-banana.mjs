import { ModellixCanvasError } from "../modellix-errors.mjs";

export function buildNanoBananaBody({ modelSlug, prompt, imageUrls = [], route, maskUrl }) {
  if (modelSlug !== "google/nano-banana-pro-edit") {
    throw new ModellixCanvasError("INPUT_INVALID", `Unsupported Google adapter model: ${modelSlug}`);
  }
  if (maskUrl) throw new ModellixCanvasError("CAPABILITY_CONFLICT", "Nano Banana Pro Edit does not accept a mask.");
  if (imageUrls.length < 2 || imageUrls.length > 10) {
    throw new ModellixCanvasError("INPUT_INVALID", "Nano Banana Pro Edit requires 2 to 10 ordered images in Canvas.");
  }
  const normalizedPrompt = String(prompt || "").trim();
  if (!normalizedPrompt) throw new ModellixCanvasError("INPUT_INVALID", "Prompt must not be empty.");
  return {
    prompt: normalizedPrompt,
    image: imageUrls.map((value) => {
      const url = new URL(String(value));
      if (url.protocol !== "https:") throw new ModellixCanvasError("INPUT_INVALID", "Model image URLs must use HTTPS.");
      return url.toString();
    }),
    aspectRatio: route.effectiveModelParams.aspectRatio,
    imageSize: route.effectiveModelParams.imageSize,
  };
}
