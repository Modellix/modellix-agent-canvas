import assert from "node:assert/strict";
import test from "node:test";

import { buildNanoBananaBody } from "../mcp/lib/model-adapters/google-nano-banana.mjs";
import { buildOpenAiImageBody } from "../mcp/lib/model-adapters/openai-gpt-image.mjs";
import { routeModellixImageTask } from "../mcp/lib/modellix-model-router.mjs";

const digest = (index) => `sha256-reference-${index}`;
const base = {
  mode: "generate",
  inputAssetDigests: [],
  size: "1024x1024",
  fitPolicy: "contain",
  quality: "medium",
  background: "opaque",
  inputFidelity: "standard",
  count: 1,
};

test("routes opaque generation to GPT Image 2", () => {
  const route = routeModellixImageTask(base);
  assert.equal(route.modelSlug, "openai/gpt-image-2");
  assert.equal(route.routeReasonCode, "DEFAULT_OPAQUE_GENERATE");
});

test("preserves documented GPT Image 2 2K/4K sizes for generation and single-image editing", () => {
  for (const size of ["2048x2048", "3840x2160", "2160x3840"]) {
    const generated = routeModellixImageTask({ ...base, size, fitPolicy: "exact" });
    assert.equal(generated.modelSlug, "openai/gpt-image-2");
    assert.equal(generated.effectiveOutput.size, size);
    assert.equal(generated.effectiveOutput.fitPolicy, "exact");

    const edited = routeModellixImageTask({
      ...base,
      mode: "edit",
      inputAssetDigests: [digest(1)],
      size,
      fitPolicy: "exact",
    });
    assert.equal(edited.modelSlug, "openai/gpt-image-2-edit");
    assert.equal(edited.effectiveOutput.size, size);
  }
});

test("routes transparent generation to GPT Image 1.5", () => {
  const route = routeModellixImageTask({ ...base, background: "transparent" });
  assert.equal(route.modelSlug, "openai/gpt-image-1.5");
  assert.equal(route.routeReasonCode, "TRANSPARENT_GENERATE");
});

test("routes one ordinary reference to GPT Image 2 Edit", () => {
  const route = routeModellixImageTask({
    ...base,
    mode: "edit",
    inputAssetDigests: [digest(1)],
  });
  assert.equal(route.modelSlug, "openai/gpt-image-2-edit");
  assert.equal(route.routeReasonCode, "DEFAULT_SINGLE_EDIT");
});

test("routes strict, transparent, and standard multi-reference edits deterministically", () => {
  const strict = routeModellixImageTask({
    ...base,
    mode: "edit",
    inputAssetDigests: [digest(1)],
    inputFidelity: "strict",
  });
  assert.equal(strict.modelSlug, "openai/gpt-image-1.5-edit");
  assert.equal(strict.routeReasonCode, "TRANSPARENT_OR_STRICT_EDIT");

  const multi = routeModellixImageTask({
    ...base,
    mode: "edit",
    inputAssetDigests: [digest(1), digest(2)],
    size: "1536x1024",
  });
  assert.equal(multi.modelSlug, "openai/gpt-image-1.5-edit");
  assert.equal(multi.routeReasonCode, "MULTI_REFERENCE_STANDARD_EDIT");
});

test("routes multi-reference wide or high-resolution output to Nano Banana Pro Edit", () => {
  for (const size of ["1024x768", "3840x2160"]) {
    const route = routeModellixImageTask({
      ...base,
      mode: "edit",
      inputAssetDigests: [digest(1), digest(2)],
      size,
    });
    assert.equal(route.modelSlug, "google/nano-banana-pro-edit");
    assert.equal(route.routeReasonCode, "MULTI_REFERENCE_HIGH_RES_EDIT");
  }
});

test("preserves ordered reference digests in the route fingerprint", () => {
  const first = routeModellixImageTask({
    ...base,
    mode: "edit",
    inputAssetDigests: [digest(1), digest(2)],
  });
  const reversed = routeModellixImageTask({
    ...base,
    mode: "edit",
    inputAssetDigests: [digest(2), digest(1)],
  });
  assert.notEqual(first.routeFingerprint, reversed.routeFingerprint);
});

test("accepts ten references and rejects the eleventh before routing", () => {
  assert.doesNotThrow(() => routeModellixImageTask({
    ...base,
    mode: "edit",
    inputAssetDigests: Array.from({ length: 10 }, (_, index) => digest(index)),
  }));
  assert.throws(
    () => routeModellixImageTask({
      ...base,
      mode: "edit",
      inputAssetDigests: Array.from({ length: 11 }, (_, index) => digest(index)),
    }),
    (error) => error.code === "REFERENCE_LIMIT_EXCEEDED",
  );
});

test("rejects transparent high resolution and multi-image masks before submission", () => {
  assert.throws(
    () => routeModellixImageTask({
      ...base,
      background: "transparent",
      size: "2048x2048",
    }),
    (error) => error.code === "CAPABILITY_CONFLICT",
  );
  assert.throws(
    () => routeModellixImageTask({
      ...base,
      mode: "edit",
      inputAssetDigests: [digest(1), digest(2)],
      maskDigest: "mask",
    }),
    (error) => error.code === "CAPABILITY_CONFLICT",
  );
});

test("model adapters whitelist exact provider fields", () => {
  const openAiRoute = routeModellixImageTask({
    ...base,
    mode: "edit",
    inputAssetDigests: [digest(1), digest(2)],
  });
  const openAiBody = buildOpenAiImageBody({
    modelSlug: openAiRoute.modelSlug,
    prompt: "Combine both references",
    imageUrls: ["https://cdn.example/1.png", "https://cdn.example/2.png"],
    route: openAiRoute,
  });
  assert.deepEqual(Object.keys(openAiBody).sort(), ["background", "images", "input_fidelity", "prompt", "quality", "size"]);

  const googleRoute = routeModellixImageTask({
    ...base,
    mode: "edit",
    inputAssetDigests: [digest(1), digest(2)],
    size: "3840x2160",
  });
  const googleBody = buildNanoBananaBody({
    modelSlug: googleRoute.modelSlug,
    prompt: "Combine both references",
    imageUrls: ["https://cdn.example/1.png", "https://cdn.example/2.png"],
    route: googleRoute,
  });
  assert.deepEqual(Object.keys(googleBody).sort(), ["aspectRatio", "image", "imageSize", "prompt"]);
  assert.equal(googleBody.imageSize, "4K");
});
