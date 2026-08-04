---
name: modellix-agent-canvas-open
description: Open or inspect Modellix Agent Canvas in Codex, Cursor, Claude Code, or OpenCode. Use when the user asks to launch the canvas, check its Modellix connection, configure an API key, or recover existing Canvas tasks.
license: MIT
---

# Open Modellix Agent Canvas

1. Call `get_modellix_canvas_status` with `refresh: true` and the host's active project root as the absolute `workspacePath`. Use only the current workspace supplied by the host; never guess or browse for another path.
2. If `workspaceBound` is false, retry once with the confirmed active project root. Hosts that cannot provide it must restart the MCP with that directory as `--project-dir`.
3. Call `open_modellix_canvas` with the same confirmed `workspacePath`. Codex and Cursor normally render the MCP Apps widget. Claude Code and OpenCode normally return a short-lived `localUrl`; tell the user to open it in the same machine's browser.
4. If `credentialState` is not `valid`, tell the user to enter the Key in the isolated credential field displayed directly inside Canvas. The user can create a production key at `https://www.modellix.ai/console/api-key`. Never request the Key in chat or pass it as an MCP argument. Only if the host cannot display or open Canvas, call `start_modellix_api_key_setup` and provide its short-lived local URL as recovery.
5. When the user asks to resume work, call `list_modellix_canvas_tasks`, then query the relevant nonterminal task IDs with `get_modellix_image_task`. Finalize successful tasks with `finalize_modellix_image_task`.

All image generation and editing uses Modellix. Do not inspect or call a host-native image-generation capability.
