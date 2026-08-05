# Modellix Agent Canvas 安装指南

Modellix Agent Canvas 是本地 `stdio` MCP 插件，不需要部署 Canvas 服务。安装方式必须二选一：Codex、Cursor、Claude 用户只从宿主的 Git 或 Marketplace 入口安装一次，插件会在后台自动解析并缓存固定版本的公开 npm 运行包 [`@modellix/agent-canvas`](https://www.npmjs.com/package/@modellix/agent-canvas)；OpenCode 和通用 MCP 用户只添加一次 npm MCP。用户不需要再执行第二次 npm 或 CLI 安装命令。运行包包含完整生产依赖和精确版本的 `modellix-cli`；已有有效 CLI 凭证会被自动复用，否则首次使用只提示输入 Modellix API Key。

任意宿主都可以用以下命令检查 Node.js、运行依赖、内置 Widget 和包版本：

```bash
npx -y --package @modellix/agent-canvas@0.1.15 modellix-agent-canvas --doctor
```

## 安装前检查

- Node.js `^20.19.0 || >=22.12.0`
- npm 可执行命令
- 可访问 `https://api.modellix.ai` 和 `https://registry.npmjs.org`
- 一个可用的 [Modellix API Key](https://www.modellix.ai/console/api-key)

安装配置不得包含 API Key。首次连接后直接在 Canvas 凭证卡片的隔离输入框中配置。Canvas 默认英语，可通过右上角在英语、简体中文和日语之间切换，凭证输入框会同步使用所选语言。

## Codex

添加 Modellix Marketplace 并安装插件：

```sh
codex plugin marketplace add Modellix/modellix-agent-canvas
codex plugin add modellix-agent-canvas@modellix
```

Git Marketplace 会直接从仓库根目录安装插件文件。Codex MCP 适配器只启动一个 Node bootstrap：首次使用时把固定版本 npm 运行包安装到用户级缓存，热启动校验缓存后在同一进程内载入 MCP。这样既不依赖 Codex 插件缓存中存在 `node_modules`，也不再常驻 `npx` 包装进程。

也可以进入 Codex CLI 的 `/plugins` 或桌面端 Plugins 页面，从 Modellix Marketplace 选择 **Modellix Agent Canvas**。安装后新建任务，让新会话加载 Skills 和 MCP 工具。

验证：

```sh
codex plugin marketplace list
codex plugin list
```

## Cursor 2.6 及以上

在 Agent 中从 Cursor Marketplace 安装：

```text
/add-plugin modellix-agent-canvas
```

从 GitHub 或本地检出添加个人 Marketplace 时，进入 **Customize → Plugins → + Add**，选择包含 `.cursor-plugin/marketplace.json` 的仓库根目录，再从 `modellix` Marketplace 安装 **Modellix Agent Canvas**。

Cursor Directory 是独立的社区目录，会从仓库的 `.plugin/plugin.json`、根 `.mcp.json` 和三个 Skills 自动发现插件；该适配器启动固定版本 npm 包，并通过 MCP roots 绑定当前工作区。也可以把仓库根目录的 `mcp.json` 配置加入 Cursor，直接使用标准 MCP。等价的项目配置如下：

```json
{
  "mcpServers": {
    "modellix-agent-canvas": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "--package", "@modellix/agent-canvas@0.1.15", "modellix-agent-canvas", "--host", "cursor", "--supports-mcp-apps", "true"]
    }
  }
}
```

Cursor 会通过 MCP Roots 绑定当前工作区。不要在插件 MCP 配置中加入字面量 `${workspaceFolder}`；插件安装场景不会可靠展开该占位符，服务端会把它判定为不存在的目录并拒绝启动。

重新加载 Cursor 后，在 MCP 设置中确认 `modellix-agent-canvas` 已连接。

## Claude Code

添加 Marketplace 并安装到用户范围：

```sh
claude plugin marketplace add Modellix/modellix-agent-canvas
claude plugin install modellix-agent-canvas@modellix
```

在 Claude Code 中执行：

```text
/reload-plugins
/mcp
```

插件使用 `${CLAUDE_PROJECT_DIR}` 绑定当前项目，并通过与 Codex、Cursor、OpenCode 相同的固定版本 npm 运行时启动。即使 Marketplace 缓存只有插件文件，也会由 npm 补齐完整生产依赖。API Key 不会写入 Claude 插件配置。

## OpenCode

把下面的服务器配置合并到项目 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "modellix-agent-canvas": {
      "type": "local",
      "command": ["npx", "-y", "--package", "@modellix/agent-canvas@0.1.15", "modellix-agent-canvas", "--host", "opencode", "--supports-mcp-apps", "false"],
      "cwd": ".",
      "enabled": true
    }
  }
}
```

OpenCode V2 beta 使用嵌套的 `mcp.servers` 结构，应改用 `adapters/opencode/opencode-v2.json`。加入相应适配器后重启 OpenCode；固定版本 npm 命令会自动安装并启动完整运行时，用户不需要另装全局 CLI。工具名可能显示为 `modellix-agent-canvas_<tool>`。OpenCode 当前使用短期本地页面承载完整画布。

## 其他支持 stdio MCP 的应用

在宿主的 MCP 配置中使用：

```json
{
  "command": "npx",
  "args": [
    "-y",
    "--package",
    "@modellix/agent-canvas@0.1.15",
    "modellix-agent-canvas",
    "--host",
    "generic",
    "--supports-mcp-apps",
    "false",
    "--project-dir",
    "/absolute/path/to/project"
  ]
}
```

`--project-dir` 必须是真实存在、非符号链接的用户项目绝对路径。一个 MCP 进程只绑定一个工作区；切换项目时需要重新启动 MCP。

## 首次使用和 API Key

安装后让宿主执行：

```text
get_modellix_canvas_status { "refresh": true, "workspacePath": "<当前项目绝对路径>" }
open_modellix_canvas { "workspacePath": "<同一当前项目绝对路径>" }
```

如果状态为 `missing` 或 `invalid`，Canvas 会直接在凭证卡片内显示密码输入框。该输入框由隔离的本机一次性表单承载，5 分钟后失效；提交后会通过内置 CLI 验证、写入系统凭证库并自动刷新状态。Key 不会进入 Canvas 状态或 MCP 参数。不要把 Key 发送到聊天、URL、仓库、截图或项目文件。`start_modellix_api_key_setup` 可供集成方显式取得同一短时表单。

配置成功后 Canvas 会自动执行状态检测；也可以手动执行 `get_modellix_canvas_status`。Codex skill 会自动传递宿主当前项目路径；路径必须是现有的真实绝对目录，且一个 MCP 会话只能绑定一个工作区。有效 Key 会保存在操作系统凭证库；若已配置兼容的 `modellix-cli` 当前 Profile，插件会直接复用。

## 升级与卸载

Codex：

```sh
codex plugin marketplace upgrade modellix
codex plugin add modellix-agent-canvas@modellix
```

Claude Code：执行 `claude plugin marketplace update modellix`，然后从 `/plugin` 更新或重新安装插件并运行 `/reload-plugins`。

Cursor：从插件页面更新；标准 MCP 配置用户把 npm 版本更新到目标版本后重新加载窗口。

OpenCode/通用 MCP：修改配置中的 npm 精确版本并重启宿主。

卸载插件不会删除项目中的 `.modellix/canvas/`，也不会删除与其他 Modellix 工具共享的系统凭证。删除项目数据前请先备份；可先用 `modellix-cli auth status --json` 确认当前 profile，需要删除该凭证时再执行 `modellix-cli auth logout --profile <PROFILE>`。

## 从源码开发

```sh
git clone https://github.com/Modellix/modellix-agent-canvas.git
cd modellix-agent-canvas
npm ci
node scripts/start-mcp.mjs --host generic --supports-mcp-apps false --project-dir /absolute/path/to/project
```

源码开发模式需要完整开发依赖。正式 npm 包已经包含预构建 Widget，启动时不会在插件缓存目录执行 `npm install` 或 `npm ci`。
