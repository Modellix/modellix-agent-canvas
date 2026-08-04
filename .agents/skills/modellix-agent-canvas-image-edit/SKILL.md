---
name: modellix-agent-canvas-image-edit
description: Edit one or more ordered Canvas images through Modellix, including annotation composites, transparent output, strict fidelity, multi-reference composition, high-resolution output, recovery, and placement beside originals.
license: MIT
---

# Edit images in Modellix Agent Canvas

Use the Modellix Canvas MCP task tools. Never pass arbitrary local paths or remote image URLs, and never select a provider model slug yourself.

1. Call `get_canvas_context` and obtain project-local image business object IDs. Preserve user order, make the first image the explicit primary reference, remove content duplicates while keeping the first occurrence, and use at most 10 images.
2. For annotation editing, flatten the selected source image, arrows, shapes, strokes, and text with safety padding into a project asset. Keep the source image and every annotation unchanged.
3. Call `get_modellix_canvas_status` with `refresh: true`; if required, open Canvas and let the user configure the Key in its embedded isolated credential field. Use `start_modellix_api_key_setup` only when the host cannot display or open Canvas.
4. Call `prepare_modellix_image_task` with `mode: edit`, ordered `sourceObjectIds` and/or project `sourceAssetIds`, a non-empty prompt, requested size/fit/quality/background/fidelity, count from 1 through 4, active `pageId`, and the primary image as `targetObjectId`.
5. Prepare is non-paying. Show the actual model, route reason, primary/reference count, effective specification, every warning, output count, unit/total estimate, currency, and expiry.
6. After explicit confirmation, submit the unchanged intent with a fresh `operationId`, returned `routeFingerprint`, and `confirmedPaidSubmission: true`.
7. Poll and immediately finalize successful tasks. Report partial failures independently. Never resubmit an unknown outcome; recover it from `list_modellix_canvas_tasks`.
8. Finalization must preserve, not move, hide, delete, or overwrite source images and annotations. Results go to the right in a stable grid unless the confirmed target is an AI image holder.

For ordinary single-image editing, the default route is GPT Image 2 Edit. Transparent, strict-fidelity, and standard multi-reference requests use a compatible GPT Image 1.5 Edit route; multi-reference special-ratio or 2K/4K requests can route to Nano Banana Pro Edit. Treat the prepare response as authoritative.
