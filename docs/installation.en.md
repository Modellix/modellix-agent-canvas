# Modellix Agent Canvas installation

Modellix Agent Canvas is a local `stdio` MCP plugin and does not require a deployed Canvas service. Choose exactly one installation path. Codex, Cursor, and Claude users install once from the host's Git or Marketplace entry; the plugin automatically resolves and caches the pinned public [`@modellix/agent-canvas`](https://www.npmjs.com/package/@modellix/agent-canvas) runtime. OpenCode and generic MCP users add the npm-backed MCP once. No user runs a second npm or CLI installation command. The runtime includes the complete production dependency tree and exact `modellix-cli` dependency. Compatible existing CLI credentials are reused; otherwise first use only prompts for a Modellix API Key.

To diagnose Node.js, runtime dependencies, the bundled Widget, and package version on any host, run:

```bash
npx -y --package @modellix/agent-canvas@0.1.12 modellix-agent-canvas --doctor
```

## Requirements

- Node.js `^20.19.0 || >=22.12.0`
- npm on `PATH`
- Access to `https://api.modellix.ai` and `https://registry.npmjs.org`
- A valid [Modellix API Key](https://www.modellix.ai/console/api-key)

Never place the API Key in an MCP configuration. Configure it in the isolated credential field embedded directly in Canvas after the first connection. Canvas defaults to English; the upper-right language switch changes English, Simplified Chinese, or Japanese and also localizes this credential field.

## Codex

```sh
codex plugin marketplace add Modellix/modellix-agent-canvas
codex plugin add modellix-agent-canvas@modellix
```

The Git marketplace installs the plugin files directly from the repository root. Its bundled Codex MCP adapter starts the pinned npm runtime with `npx`, so runtime dependencies are resolved normally instead of being assumed to exist in Codex's plugin cache.

You can also install **Modellix Agent Canvas** from the Modellix source in `/plugins` or the desktop Plugins directory. Start a new task after installation so the session loads the skills and MCP tools.

## Cursor 2.6+

Install it from Cursor Marketplace with `/add-plugin modellix-agent-canvas`. Cursor Directory discovers the vendor-neutral `.plugin/plugin.json`, root `.mcp.json`, and three skills; that adapter starts the pinned npm package and binds the active workspace through MCP roots. For a direct MCP setup, add the repository's `mcp.json` or this equivalent configuration:

For a personal Marketplace from GitHub or a local checkout, open **Customize → Plugins → + Add** and select the repository root. Cursor discovers `.cursor-plugin/marketplace.json` and lists **Modellix Agent Canvas** under the `modellix` Marketplace. Cursor Directory is a separate community directory and continues to use the Open Plugins files above.

```json
{
  "mcpServers": {
    "modellix-agent-canvas": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "--package", "@modellix/agent-canvas@0.1.12", "modellix-agent-canvas", "--host", "cursor", "--supports-mcp-apps", "true"]
    }
  }
}
```

Cursor binds the active workspace through MCP Roots. Do not add a literal `${workspaceFolder}` argument to a plugin MCP configuration: plugin installations do not reliably expand that placeholder and the server will reject it as a nonexistent directory.

Reload Cursor and confirm that `modellix-agent-canvas` is connected in MCP settings.

## Claude Code

```sh
claude plugin marketplace add Modellix/modellix-agent-canvas
claude plugin install modellix-agent-canvas@modellix
```

Run `/reload-plugins`, then `/mcp`. The adapter binds `${CLAUDE_PROJECT_DIR}` and starts the same pinned npm runtime used by Codex, Cursor, and OpenCode. This ensures production dependencies are installed even when the Marketplace cache contains only plugin files. It does not store an API Key in plugin configuration.

## OpenCode

Merge this server into the project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "modellix-agent-canvas": {
      "type": "local",
      "command": ["npx", "-y", "--package", "@modellix/agent-canvas@0.1.12", "modellix-agent-canvas", "--host", "opencode", "--supports-mcp-apps", "false"],
      "cwd": ".",
      "enabled": true
    }
  }
}
```

OpenCode V2 beta uses the nested `mcp.servers` shape instead; copy `adapters/opencode/opencode-v2.json` for that channel. Restart OpenCode after adding the appropriate adapter. The pinned npm command installs and launches the complete runtime automatically, so users do not need a separate global CLI installation. OpenCode may expose a tool as `modellix-agent-canvas_<tool>` and uses the short-lived local page for the full canvas.

## Other stdio MCP hosts

Configure the host to run:

```json
{
  "command": "npx",
  "args": ["-y", "--package", "@modellix/agent-canvas@0.1.12", "modellix-agent-canvas", "--host", "generic", "--supports-mcp-apps", "false", "--project-dir", "/absolute/path/to/project"]
}
```

The project directory must be an existing real absolute directory, not a symlink. One MCP process remains bound to one workspace.

## First use and API Key

Call `get_modellix_canvas_status` and `open_modellix_canvas` with the host's active project root as `workspacePath`. The Codex skill supplies this automatically. The path must be an existing real absolute directory, and one MCP session binds to one workspace. If the status is `missing` or `invalid`, Canvas embeds an isolated five-minute loopback password form directly in its credential card. Submit the Key there once; the bundled CLI validates and stores it, and Canvas refreshes status automatically. The Key does not enter Canvas state or MCP arguments. `start_modellix_api_key_setup` remains available for integrations that need the same short-lived form explicitly.

## Upgrade and uninstall

- Codex: `codex plugin marketplace upgrade modellix`, then reinstall or update `modellix-agent-canvas@modellix`.
- Claude Code: `claude plugin marketplace update modellix`, update from `/plugin`, then run `/reload-plugins`.
- Cursor: update from the plugin page, or change the exact npm version in direct MCP configuration.
- OpenCode and generic MCP hosts: change the exact npm version and restart the host.

Uninstalling does not remove `.modellix/canvas/` project data or shared system credentials. Back up project data before deleting it. Check the selected profile with `modellix-cli auth status --json`, then use `modellix-cli auth logout --profile <PROFILE>` only when that credential should also be removed.

## Source development

```sh
git clone https://github.com/Modellix/modellix-agent-canvas.git
cd modellix-agent-canvas
npm ci
node scripts/start-mcp.mjs --host generic --supports-mcp-apps false --project-dir /absolute/path/to/project
```

The published package carries the prebuilt Widget and never runs `npm install` or `npm ci` inside the installed plugin cache.
