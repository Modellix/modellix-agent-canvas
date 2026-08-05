# Host compatibility

Last reviewed: 2026-08-04.

Modellix Agent Canvas exposes one local `stdio` MCP server and one business contract. Host adapters only decide how the process starts, how the project root is supplied, and whether the host can render MCP Apps. Model routing, API-key persistence, paid confirmation, task recovery, workspace boundaries, and project files are identical in every host.

## Capability levels

- **Protocol validated**: the adapter parses, the MCP process starts, tools and the UI resource can be discovered, tool schemas pass the repository probe, and the workspace binding is enforced.
- **Native UI documented**: the host's current official documentation or release notes state MCP Apps support.
- **Native UI smoke-tested**: the release candidate has been installed in the named host version and the embedded Widget has completed a real interaction test.
- **Fallback validated**: the isolated inline loopback credential form, one-time URL, session, Canvas APIs, and security controls pass automated and browser tests.

Do not interpret protocol validation as proof that every future host version renders an embedded Widget. When native MCP Apps support is absent or disabled by policy, `open_modellix_canvas` returns the local fallback without hiding any business tools.

## Maintained adapters

| Host | Official integration facts | Adapter | Expected UI |
| --- | --- | --- | --- |
| Codex | `.codex-plugin/plugin.json` embeds the server configuration mirrored by `.mcp.codex.json`; the adapter uses one Node bootstrap to install the pinned npm runtime on first use and import it in-process on warm starts; the open skill supplies the active project as validated `workspacePath` | `.codex-plugin/plugin.json`, `.mcp.codex.json`, `codex-bootstrap.mjs` | MCP Apps Widget; fallback remains available |
| Cursor 2.6+ | Cursor 2.6 introduced MCP Apps in Agent chat; plugins can package MCP configuration; personal and local Marketplace imports use a Cursor-specific root catalog | `.cursor-plugin/marketplace.json`, `.cursor-plugin/plugin.json`, `mcp.json` | MCP Apps |
| Claude Code | The plugin manifest explicitly selects `.mcp.claude.json`, so Claude does not fall back to the vendor-neutral root `.mcp.json`; the adapter starts the pinned npm runtime and passes `${CLAUDE_PROJECT_DIR}` while preserving `${CLAUDE_PLUGIN_DATA}` | `.claude-plugin/plugin.json`, `.mcp.claude.json` | local fallback because the referenced terminal documentation does not promise MCP Apps rendering |
| OpenCode | Stable local MCP servers live directly under `mcp.<server>`, use a command array, optional `cwd`/`environment`, and stdio | `adapters/opencode/opencode.json`, `.agents/skills` | local fallback until MCP Apps is documented and smoke-tested |
| OpenCode V2 beta | V2 beta local MCP servers live under `mcp.servers` | `adapters/opencode/opencode-v2.json`, `.agents/skills` | local fallback until MCP Apps is documented and smoke-tested |

Official references:

- Codex: [Build plugins](https://developers.openai.com/plugins/build/plugins), [MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- Cursor: [Cursor 2.6 MCP Apps release](https://cursor.com/changelog/2-6)
- Claude Code: [MCP](https://code.claude.com/docs/en/mcp), [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- OpenCode: [stable MCP servers](https://opencode.ai/docs/mcp-servers/), [stable configuration](https://opencode.ai/docs/config/), [V2 beta MCP servers](https://opencode.ai/v2/docs/mcp-servers)

## Shared acceptance contract

Every maintained adapter must pass:

1. Install or source launch from a clean package.
2. Node version gate and dependency preparation.
3. Tool/resource discovery and MCP output-schema validation.
4. Immutable binding to the actual project root, including symlink/junction escape rejection.
5. Existing CLI credential reuse and isolated inline setup for a missing or invalid key.
6. Text-to-image, single-image editing, ordered multi-image editing, paid disclosure, explicit confirmation, polling, local download, and idempotent finalize.
7. Task recovery after restarting the MCP process.
8. Embedded MCP Apps UI where supported, or the loopback fallback otherwise.
9. No API key, prompt body, temporary remote URL, private file path, or QA origin in tool output, logs, project data, or the release package.

Only `open_modellix_canvas` is associated with `ui://modellix-agent-canvas/canvas-v1.html`. App data tools are marked app-only; model-facing tools remain useful without UI support.

## Workspace mapping

- Codex: the open skill passes the host's active project root as `workspacePath`; MCP Roots or explicit `--project-dir` remain compatible alternatives.
- Cursor: the maintained plugin template uses MCP Roots, which Cursor officially supports, and does not depend on `${workspaceFolder}` interpolation.
- Claude Code: the plugin template passes `${CLAUDE_PROJECT_DIR}` and starts the same pinned npm runtime as the other hosts, so Marketplace extraction never needs to provide `node_modules`.
- OpenCode: `cwd: "."` resolves from the workspace in both the stable and V2 beta adapters.

The server canonicalizes this root once. A data tool cannot replace it with an arbitrary path, and switching projects requires a new MCP process.

## Credentials

- The production key page is `https://www.modellix.ai/console/api-key`.
- The production API origin is `https://api.modellix.ai`.
- Existing `modellix-cli` CredentialStore state wins.
- Maintained host adapters do not persist an API key in their manifest or MCP configuration. Setup is completed through the isolated local form embedded in Canvas.
- The key is never accepted as a Canvas tool argument or URL parameter.

## OpenCode tool names

OpenCode normalizes MCP tools as `<server>_<tool>`. For the maintained server name, a tool such as `open_modellix_canvas` may therefore be presented as `modellix-agent-canvas_open_modellix_canvas`. Skills should refer to the semantic tool name and let the host apply its prefix.

## Release evidence

Release-specific host versions, screenshots, logs, and native-UI results belong in internal acceptance artifacts, not in the public package. README claims must be limited to the matrix above until a release candidate has been smoke-tested in the exact target host versions.
