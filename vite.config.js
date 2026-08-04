import { tmpdir } from 'node:os'
import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { CanvasProjectStore } from './mcp/lib/canvas-project-store.mjs'
import { ModellixCli } from './mcp/lib/modellix-cli.mjs'
import { asModellixCanvasError, sanitizeMessage } from './mcp/lib/modellix-errors.mjs'
import { ModellixImageService } from './mcp/lib/modellix-image-service.mjs'
import { ModellixLocalWebServer } from './mcp/lib/local-web-server.mjs'
import { ModellixTaskStore } from './mcp/lib/modellix-task-store.mjs'

const root = process.cwd()
const workspaceRoot = path.resolve(process.env.MODELLIX_PROJECT_DIR || path.join(tmpdir(), 'modellix-agent-canvas-dev-workspace'))
const projectStore = new CanvasProjectStore(workspaceRoot)
const taskStore = new ModellixTaskStore(workspaceRoot)
const context = {
  host: 'vite-dev',
  supportsMcpApps: false,
  workspaceRoot,
  workspaceId: 'vite-development',
  pluginRoot: root,
  originalCwd: workspaceRoot,
  initialize: async () => {},
  requireWorkspace: () => workspaceRoot,
  snapshot: () => ({ host: 'vite-dev', supportsMcpApps: false, workspaceBound: true, workspaceId: 'vite-development' })
}
const cli = new ModellixCli({ pluginRoot: root, workspaceRoot })
const service = new ModellixImageService({ context, cli, taskStore, projectStore })
const localWeb = new ModellixLocalWebServer({ context, cli, taskStore, projectStore, service, canvasHtml: async () => '' })

export default defineConfig({
  base: './',
  plugins: [react(), modellixDevelopmentApi()],
  server: {
    host: '127.0.0.1',
    headers: {
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    }
  },
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 20_000,
    rollupOptions: {
      output: { inlineDynamicImports: true }
    }
  }
})

function modellixDevelopmentApi() {
  return {
    name: 'modellix-development-api',
    configureServer(server) {
      projectStore.initialize().catch(error => server.config.logger.error(error.stack || error.message))
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        if (!url.pathname.startsWith('/api/')) return next()
        try {
          if (url.pathname === '/api/project' && request.method === 'GET') return sendJson(response, 200, await projectStore.readProject({ hydrateFiles: true }))
          if (url.pathname === '/api/project' && request.method === 'PUT') return sendJson(response, 200, await projectStore.saveProject(await readJson(request)))
          if (url.pathname === '/api/context' && request.method === 'GET') return sendJson(response, 200, await projectStore.getContext())
          if (url.pathname === '/api/assets' && request.method === 'POST') return sendJson(response, 200, await projectStore.saveAsset(await readJson(request)))
          if (url.pathname === '/api/modellix/status' && request.method === 'GET') return sendJson(response, 200, await service.status({ refresh: url.searchParams.get('refresh') === '1' }))
          if (url.pathname === '/api/modellix/setup' && request.method === 'POST') return sendJson(response, 200, await localWeb.createSetupUrl())
          if (url.pathname === '/api/modellix/prepare' && request.method === 'POST') return sendJson(response, 200, await service.prepare(await readJson(request)))
          if (url.pathname === '/api/modellix/submit' && request.method === 'POST') return sendJson(response, 200, await service.submit(await readJson(request)))
          if (url.pathname === '/api/modellix/task' && request.method === 'GET') return sendJson(response, 200, await service.getTask(url.searchParams.get('taskId')))
          if (url.pathname === '/api/modellix/tasks' && request.method === 'GET') return sendJson(response, 200, await taskStore.list({ limit: Number(url.searchParams.get('limit') || 100), cursor: Number(url.searchParams.get('cursor') || 0) }))
          if (url.pathname === '/api/modellix/finalize' && request.method === 'POST') {
            const body = await readJson(request)
            return sendJson(response, 200, await service.finalize(body.taskId, body))
          }
          return sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'API route not found.' } })
        } catch (error) {
          const canvasError = asModellixCanvasError(error)
          return sendJson(response, canvasError.code === 'AUTH_REQUIRED' ? 401 : 400, {
            ok: false,
            error: { code: canvasError.code, message: sanitizeMessage(canvasError.message), recoveryActions: canvasError.recoveryActions }
          })
        }
      })
    }
  }
}

function sendJson(response, status, payload) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > 50 * 1024 * 1024) {
        reject(new Error('Request body exceeds 50 MiB.'))
        request.destroy()
      } else chunks.push(Buffer.from(chunk))
    })
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (error) { reject(error) }
    })
    request.on('error', reject)
  })
}
