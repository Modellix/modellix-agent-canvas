import { normalizeLanguage } from '../mcp/lib/modellix-i18n.mjs'

const ENDPOINTS = {
  project: '/api/project',
  context: '/api/context',
  assets: '/api/assets',
  status: '/api/modellix/status',
  setup: '/api/modellix/setup',
  prepare: '/api/modellix/prepare',
  submit: '/api/modellix/submit',
  task: '/api/modellix/task',
  tasks: '/api/modellix/tasks',
  finalize: '/api/modellix/finalize'
}

const TOOLS = {
  getProject: 'get_canvas_project',
  saveProject: 'save_canvas_project',
  getContext: 'get_canvas_context',
  saveAsset: 'save_canvas_asset',
  status: 'get_modellix_canvas_status',
  setup: 'start_modellix_api_key_setup',
  prepare: 'prepare_modellix_image_task',
  submit: 'submit_modellix_image_task',
  task: 'get_modellix_image_task',
  tasks: 'list_modellix_canvas_tasks',
  finalize: 'finalize_modellix_image_task'
}

const WIDGET_PAYLOAD_TIMEOUT_MS = 5000

export function hasMcpBridge() {
  return Boolean(window.modellixMcp && typeof window.modellixMcp.callServerTool === 'function')
}

export function hostPayload() {
  return window.openai?.toolOutput && typeof window.openai.toolOutput === 'object'
    ? window.openai.toolOutput
    : {}
}

async function waitForPayload(signal) {
  if (!hasMcpBridge() || hostPayload().workspaceId) return
  await new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const timer = window.setTimeout(() => finish(new Error('The MCP Apps workspace payload was not received.')), WIDGET_PAYLOAD_TIMEOUT_MS)
    const onGlobals = () => hostPayload().workspaceId && finish()
    const onAbort = () => finish(new DOMException('Aborted', 'AbortError'))
    const finish = error => {
      window.clearTimeout(timer)
      window.removeEventListener('openai:set_globals', onGlobals)
      signal?.removeEventListener('abort', onAbort)
      error ? reject(error) : resolve()
    }
    window.addEventListener('openai:set_globals', onGlobals)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function callTool(name, args = {}, { signal, timeoutMs = 30000 } = {}) {
  await waitForPayload(signal)
  const result = await window.modellixMcp.callServerTool({ name, arguments: args }, { timeoutMs })
  if (result?.isError || result?.structuredContent?.ok === false) {
    const error = result?.structuredContent?.error
    const message = error?.message || result?.content?.find(item => item.type === 'text')?.text || `${name} failed`
    const thrown = new Error(message)
    thrown.code = error?.code
    thrown.recoveryActions = error?.recoveryActions || []
    thrown.retryable = Boolean(error?.retryable)
    thrown.nextAction = error?.nextAction
    throw thrown
  }
  return result?.structuredContent ?? result
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...(options.headers || {}) } : options.headers
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload?.ok === false) {
    const thrown = new Error(payload?.error?.message || `Request failed (${response.status})`)
    thrown.code = payload?.error?.code
    thrown.recoveryActions = payload?.error?.recoveryActions || []
    thrown.retryable = Boolean(payload?.error?.retryable)
    thrown.nextAction = payload?.error?.nextAction
    throw thrown
  }
  return payload
}

export async function loadProject(signal) {
  return hasMcpBridge()
    ? callTool(TOOLS.getProject, { hydrateFiles: true }, { signal, timeoutMs: 120000 })
    : fetchJson(ENDPOINTS.project, { signal })
}

export async function saveProject(project) {
  return hasMcpBridge()
    ? callTool(TOOLS.saveProject, { project }, { timeoutMs: 120000 })
    : fetchJson(ENDPOINTS.project, { method: 'PUT', body: JSON.stringify(project) })
}

export async function getCanvasContext() {
  return hasMcpBridge() ? callTool(TOOLS.getContext) : fetchJson(ENDPOINTS.context)
}

export async function saveAsset(blob, fileName = 'reference.png') {
  const dataBase64 = await blobToBase64(blob)
  const input = { dataBase64, mimeType: blob.type || 'image/png', fileName }
  return hasMcpBridge()
    ? callTool(TOOLS.saveAsset, input, { timeoutMs: 120000 })
    : fetchJson(ENDPOINTS.assets, { method: 'POST', body: JSON.stringify(input) })
}

export async function getCanvasStatus(refresh = false) {
  return hasMcpBridge()
    ? callTool(TOOLS.status, { refresh })
    : fetchJson(`${ENDPOINTS.status}?refresh=${refresh ? '1' : '0'}`)
}

export async function startApiKeySetup(language = 'en') {
  const normalizedLanguage = normalizeLanguage(language)
  return hasMcpBridge()
    ? callTool(TOOLS.setup, { language: normalizedLanguage })
    : fetchJson(`${ENDPOINTS.setup}?language=${encodeURIComponent(normalizedLanguage)}`, { method: 'POST' })
}

export async function prepareImageTask(intent) {
  return hasMcpBridge()
    ? callTool(TOOLS.prepare, intent, { timeoutMs: 120000 })
    : fetchJson(ENDPOINTS.prepare, { method: 'POST', body: JSON.stringify(intent) })
}

export async function submitImageTask(input) {
  return hasMcpBridge()
    ? callTool(TOOLS.submit, input, { timeoutMs: 180000 })
    : fetchJson(ENDPOINTS.submit, { method: 'POST', body: JSON.stringify(input) })
}

export async function getImageTask(taskId) {
  return hasMcpBridge()
    ? callTool(TOOLS.task, { taskId })
    : fetchJson(`${ENDPOINTS.task}?taskId=${encodeURIComponent(taskId)}`)
}

export async function listImageTasks() {
  return hasMcpBridge()
    ? callTool(TOOLS.tasks, { limit: 100, cursor: 0 })
    : fetchJson(`${ENDPOINTS.tasks}?limit=100&cursor=0`)
}

export async function finalizeImageTask(taskId) {
  return hasMcpBridge()
    ? callTool(TOOLS.finalize, { taskId }, { timeoutMs: 600000 })
    : fetchJson(ENDPOINTS.finalize, { method: 'POST', body: JSON.stringify({ taskId }) })
}

export function requestFullscreen() {
  return window.modellixMcp?.requestDisplayMode?.('fullscreen')
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error || new Error('Unable to read file.'))
    reader.readAsDataURL(blob)
  })
}
