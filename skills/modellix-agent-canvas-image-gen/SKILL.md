---
name: modellix-agent-canvas-image-gen
description: Generate one to four images through Modellix and place them in Modellix Agent Canvas, including AI image holders, transparent output, paid confirmation, polling, recovery, and final insertion.
license: MIT
---

# Generate images in Modellix Agent Canvas

Use the Modellix Canvas MCP task tools. Do not choose a model slug; describe the business requirement and use the returned route.

1. Call `get_modellix_canvas_status` with `refresh: true`. If the credential is missing or invalid, open Canvas and direct the user to its embedded, isolated credential field. Never ask for the Key in chat or pass it as a tool argument. Use `start_modellix_api_key_setup` only as recovery when the host cannot display or open Canvas.
2. Read `get_canvas_context` when page, selection, or an AI image holder matters.
3. Call `prepare_modellix_image_task` with:
   - `mode: generate`
   - a non-empty prompt
   - no source object or asset IDs
   - count from 1 through 4
   - requested size, fit, quality, background, and fidelity
   - the active `pageId`
   - an optional image-holder `targetObjectId`
4. Prepare is non-paying. Show the actual model display name, route reason, requested and effective specifications, every warning, output count, unit/total estimate, currency, and confirmation expiry.
5. Obtain explicit user confirmation. Then submit the exact same intent with a fresh stable `operationId`, returned `routeFingerprint`, and `confirmedPaidSubmission: true`.
6. Poll each returned task with `get_modellix_image_task`. Finalize every successful task immediately with `finalize_modellix_image_task` so the image is stored in the project.
7. Never retry `SUBMISSION_UNKNOWN`. Use `list_modellix_canvas_tasks` and query the recorded task IDs.

Finalization replaces a selected AI image holder for the first result. Without a holder, it keeps existing content and places results in a stable grid near the confirmed viewport position.

Use `modellix-agent-canvas-image-edit` when one or more reference images are involved.
