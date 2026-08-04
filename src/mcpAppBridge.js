import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps'

const DEFAULT_TIMEOUT_MS = 30_000
let appInstance = null

export function initializeMcpAppBridge() {
  if (window.parent === window || appInstance) return appInstance
  const app = new App(
    { name: 'modellix-agent-canvas', version: '0.1.10' },
    { availableDisplayModes: ['inline', 'fullscreen'] },
    { autoResize: true }
  )
  appInstance = app
  installCanvasApi(app)
  app.addEventListener('hostcontextchanged', event => applyHostContext(event))
  app.addEventListener('toolresult', event => publishToolResult(event))
  app.ready = app.connect()
    .then(async () => {
      publishGlobals({
        hostCapabilities: app.getHostCapabilities?.(),
        hostInfo: app.getHostVersion?.()
      })
      applyHostContext(app.getHostContext?.())
      await app.requestDisplayMode?.({ mode: 'fullscreen' }).catch(() => {})
      return app
    })
    .catch(error => {
      window.__MODELLIX_MCP_HOST_ERROR__ = error
      throw error
    })
  // Retain rejection semantics for API callers without creating an unhandled
  // promise when an iframe host does not implement MCP Apps.
  void app.ready.catch(() => {})
  window.__MODELLIX_MCP_APP__ = app
  return app
}

function installCanvasApi(app) {
  window.modellixMcp = {
    callServerTool: async (request, options = {}) => {
      await app.ready
      const { timeoutMs = DEFAULT_TIMEOUT_MS, ...requestOptions } = options
      return withDeadline(
        app.callServerTool(request, requestOptions),
        timeoutMs,
        'Server tool call timed out.'
      )
    },
    requestDisplayMode: async mode => {
      await app.ready
      return app.requestDisplayMode?.(typeof mode === 'string' ? { mode } : mode) || {}
    },
    updateModelContext: async (payload, options) => {
      await app.ready
      return app.updateModelContext?.(payload, options) || {}
    },
    getHostCapabilities: () => app.getHostCapabilities?.() || null
  }
}

function applyHostContext(eventOrContext) {
  const context = eventOrContext?.detail || eventOrContext
  if (!context) return
  try {
    if (context.theme) applyDocumentTheme(context.theme)
    if (context.styles?.variables) applyHostStyleVariables(context.styles.variables)
    if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts)
  } catch {
    // Host styling is optional; the Canvas theme remains usable without it.
  }
  publishGlobals({
    hostContext: context,
    displayMode: context.displayMode,
    availableDisplayModes: context.availableDisplayModes,
    widgetInstanceId: context.widgetInstanceId || context.widgetId
  })
}

function publishToolResult(eventOrResult) {
  const result = eventOrResult?.detail || eventOrResult
  const metadata = result?._meta || {}
  publishGlobals({
    rawToolResult: result,
    toolOutput: metadata.widgetData || result?.structuredContent || result || {},
    toolResponseMetadata: metadata
  })
}

function publishGlobals(values) {
  window.openai = Object.assign(window.openai || {}, values || {})
  window.dispatchEvent(new CustomEvent('openai:set_globals', {
    detail: { globals: window.openai }
  }))
}

function withDeadline(promise, timeoutMs, message) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, deadline]).finally(() => window.clearTimeout(timer))
}
