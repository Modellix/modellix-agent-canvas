import { randomBytes } from "node:crypto";
import http from "node:http";

import { PRODUCTION_API_KEY_URL } from "./modellix-contracts.mjs";
import { asModellixCanvasError, sanitizeMessage } from "./modellix-errors.mjs";

const SETUP_TTL_MS = 5 * 60 * 1000;
const OPEN_TTL_MS = 5 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_JSON_BYTES = 50 * 1024 * 1024;

export class ModellixLocalWebServer {
  constructor(options) {
    this.context = options.context;
    this.cli = options.cli;
    this.service = options.service;
    this.taskStore = options.taskStore;
    this.projectStore = options.projectStore;
    this.canvasHtml = options.canvasHtml;
    this.server = null;
    this.origin = null;
    this.openTokens = new Map();
    this.setupTokens = new Map();
    this.sessions = new Map();
  }

  async createCanvasUrl() {
    this.context.requireWorkspace();
    await this.ensureListening();
    const token = secretToken();
    const expiresAtMs = Date.now() + OPEN_TTL_MS;
    this.openTokens.set(token, expiresAtMs);
    this.prune();
    return `${this.origin}/open/${token}`;
  }

  async createSetupUrl() {
    await this.ensureListening();
    const token = secretToken();
    const expiresAtMs = Date.now() + SETUP_TTL_MS;
    this.setupTokens.set(token, expiresAtMs);
    this.prune();
    return { ok: true, setupUrl: `${this.origin}/setup/${token}`, expiresAt: new Date(expiresAtMs).toISOString(), apiKeyPageUrl: PRODUCTION_API_KEY_URL };
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.origin = null;
    await new Promise((resolve) => server.close(resolve));
  }

  async ensureListening() {
    if (this.server) return;
    this.server = http.createServer((request, response) => this.handle(request, response).catch((error) => this.sendError(response, error)));
    this.server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    this.server.unref();
  }

  async handle(request, response) {
    this.securityHeaders(response);
    const url = new URL(request.url || "/", this.origin);
    if (request.headers.host !== new URL(this.origin).host) return this.send(response, 400, "Invalid Host.");
    if (url.pathname.startsWith("/setup/")) return this.handleSetup(request, response, url.pathname.slice(7), url.searchParams.get("embedded") === "1");
    if (url.pathname.startsWith("/open/")) return this.handleOpen(request, response, url.pathname.slice(6));

    if (!this.authorizeSession(request)) return this.send(response, 401, "Canvas session expired. Run open_modellix_canvas again.");
    this.assertSameOrigin(request, { required: !["GET", "HEAD"].includes(request.method || "") });
    if (url.pathname === "/" && request.method === "GET") return this.sendHtml(response, await this.canvasHtml());
    if (url.pathname === "/api/project") return this.handleProject(request, response);
    if (url.pathname === "/api/context" && request.method === "GET") return this.sendJson(response, 200, await this.projectStore.getContext());
    if (url.pathname === "/api/assets" && request.method === "POST") return this.sendJson(response, 200, await this.projectStore.saveAsset(await readJson(request)));
    if (url.pathname === "/api/modellix/status" && request.method === "GET") return this.sendJson(response, 200, await this.service.status({ refresh: url.searchParams.get("refresh") === "1" }));
    if (url.pathname === "/api/modellix/setup" && request.method === "POST") return this.sendJson(response, 200, await this.createSetupUrl());
    if (url.pathname === "/api/modellix/prepare" && request.method === "POST") return this.sendJson(response, 200, await this.service.prepare(await readJson(request)));
    if (url.pathname === "/api/modellix/submit" && request.method === "POST") return this.sendJson(response, 200, await this.service.submit(await readJson(request)));
    if (url.pathname === "/api/modellix/task" && request.method === "GET") return this.sendJson(response, 200, await this.service.getTask(url.searchParams.get("taskId")));
    if (url.pathname === "/api/modellix/finalize" && request.method === "POST") {
      const body = await readJson(request);
      return this.sendJson(response, 200, await this.service.finalize(body.taskId, body));
    }
    if (url.pathname === "/api/modellix/tasks" && request.method === "GET") {
      return this.sendJson(response, 200, await this.taskStore.list({
        status: url.searchParams.get("status") || undefined,
        limit: Number(url.searchParams.get("limit") || 50),
        cursor: Number(url.searchParams.get("cursor") || 0),
      }));
    }
    return this.send(response, 404, "Not found.");
  }

  async handleProject(request, response) {
    if (request.method === "GET") return this.sendJson(response, 200, await this.projectStore.readProject({ hydrateFiles: true }));
    if (request.method === "PUT") return this.sendJson(response, 200, await this.projectStore.saveProject(await readJson(request)));
    return this.send(response, 405, "Method not allowed.");
  }

  async handleSetup(request, response, token, embedded = false) {
    const expiresAt = this.setupTokens.get(token);
    if (!expiresAt || expiresAt <= Date.now()) return this.send(response, 410, "This setup link has expired.");
    if (request.method === "GET") return this.sendSetupHtml(response, setupHtml(token, { embedded }));
    if (request.method !== "POST") return this.send(response, 405, "Method not allowed.");
    this.assertSameOrigin(request, { required: true, allowOpaque: true });
    assertContentType(request, "application/x-www-form-urlencoded");
    const body = await readForm(request, 64 * 1024);
    const apiKey = String(body.get("apiKey") || "").trim();
    if (!apiKey) return this.sendSetupHtml(response, setupHtml(token, { embedded, error: "请输入 API Key。" }));
    try {
      await this.cli.loginWithStdin(apiKey);
    } catch (error) {
      return this.sendSetupHtml(response, setupHtml(token, { embedded, error: setupErrorMessage(error) }));
    }
    this.setupTokens.delete(token);
    return this.sendSetupHtml(response, successHtml(embedded));
  }

  async handleOpen(request, response, token) {
    if (request.method !== "GET") return this.send(response, 405, "Method not allowed.");
    const expiresAt = this.openTokens.get(token);
    if (!expiresAt || expiresAt <= Date.now()) return this.send(response, 410, "This Canvas link has expired.");
    this.openTokens.delete(token);
    const sessionId = secretToken();
    this.sessions.set(sessionId, Date.now() + SESSION_IDLE_MS);
    response.statusCode = 303;
    response.setHeader("set-cookie", `modellix_canvas_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
    response.setHeader("location", "/");
    response.end();
  }

  authorizeSession(request) {
    const id = parseCookies(request.headers.cookie || "").modellix_canvas_session;
    const expiresAt = this.sessions.get(id);
    if (!expiresAt || expiresAt <= Date.now()) {
      if (id) this.sessions.delete(id);
      return false;
    }
    this.sessions.set(id, Date.now() + SESSION_IDLE_MS);
    return true;
  }

  assertSameOrigin(request, { required = false, allowOpaque = false } = {}) {
    const origin = request.headers.origin;
    if (required && !origin) throw new Error("Origin header is required for state-changing requests.");
    if (allowOpaque && origin === "null") return;
    if (origin && origin !== this.origin) throw new Error("Cross-origin request rejected.");
  }

  prune() {
    const now = Date.now();
    for (const [key, expiry] of this.openTokens) if (expiry <= now) this.openTokens.delete(key);
    for (const [key, expiry] of this.setupTokens) if (expiry <= now) this.setupTokens.delete(key);
    for (const [key, expiry] of this.sessions) if (expiry <= now) this.sessions.delete(key);
  }

  securityHeaders(response) {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  }

  sendHtml(response, html, csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; frame-src data: blob:; font-src data:; worker-src blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'") {
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("content-security-policy", csp);
    response.end(html);
  }

  sendSetupHtml(response, html) {
    response.removeHeader("x-frame-options");
    response.setHeader("cross-origin-resource-policy", "cross-origin");
    return this.sendHtml(response, html, "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors *");
  }

  sendJson(response, status, payload) {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  send(response, status, message) {
    response.statusCode = status;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end(message);
  }

  sendError(response, error) {
    if (response.headersSent) return response.end();
    const normalized = asModellixCanvasError(error);
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : normalized.code === "AUTH_REQUIRED" ? 401 : 400;
    this.sendJson(response, status, {
      ok: false,
      error: { code: normalized.code, message: sanitizeMessage(normalized.message), recoveryActions: normalized.recoveryActions, retryable: normalized.retryable, nextAction: sanitizeMessage(normalized.nextAction) },
    });
  }
}

function secretToken() { return randomBytes(32).toString("base64url"); }
function parseCookies(value) { return Object.fromEntries(value.split(";").map((item) => item.trim().split("=")).filter((entry) => entry.length === 2)); }
async function readJson(request) { assertContentType(request, "application/json"); return JSON.parse((await readBody(request, MAX_JSON_BYTES)) || "{}"); }
async function readForm(request, limit) { return new URLSearchParams(await readBody(request, limit)); }

function assertContentType(request, expected) {
  const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== expected) {
    const error = new Error(`Content-Type must be ${expected}.`);
    error.statusCode = 415;
    throw error;
  }
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new Error("Request body is too large."));
        request.destroy();
      } else chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function setupHtml(token, { embedded = false, error = "" } = {}) {
  const bodyClass = embedded ? "embedded" : "standalone";
  const action = `/setup/${token}${embedded ? "?embedded=1" : ""}`;
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>配置 Modellix API Key</title><style>:root{font-family:Inter,system-ui;color:#19191d;background:#f7f8fa;color-scheme:light}*{box-sizing:border-box}body{max-width:620px;margin:9vh auto;padding:28px}main{padding:28px;border:1px solid #e7e7ec;border-radius:20px;background:#fff;box-shadow:0 22px 70px rgba(25,25,29,.1)}h1{margin:0 0 8px;font-size:23px}p{margin:0 0 12px}form{display:grid;gap:10px}label{display:grid;gap:6px;font-size:12px;font-weight:700}input,button{width:100%;font:inherit;padding:11px;border-radius:9px}input{border:1px solid #d8d8df;outline:0}input:focus{border-color:#605aff;box-shadow:0 0 0 3px rgba(96,90,255,.13)}button{border:0;color:#fff;background:#605aff;font-weight:700;cursor:pointer}small,p{color:#686974;line-height:1.5}a{color:#4b45d6}.meta{display:flex;align-items:center;justify-content:space-between;gap:8px}.error{padding:8px;border-radius:8px;color:#b42318;background:#fff0ee;font-size:12px}.embedded{max-width:none;margin:0;padding:0;background:#fff}.embedded main{padding:10px;border:0;border-radius:0;box-shadow:none}.embedded h1{font-size:13px;margin-bottom:3px}.embedded .intro{display:none}.embedded form{gap:7px}.embedded input,.embedded button{padding:9px;font-size:12px}.embedded .meta{font-size:10px}.embedded small{font-size:9px}</style><body class="${bodyClass}"><main><h1>安全配置 API Key</h1><p class="intro">Key 由随插件提供的 CLI 验证并保存到系统凭证库，不进入工具参数、URL、画布或日志。</p>${errorHtml}<form method="post" action="${action}" autocomplete="off"><label>Modellix API Key<input name="apiKey" type="password" required autocomplete="new-password" spellcheck="false" placeholder="输入可用的 API Key" autofocus></label><button type="submit">保存并验证</button><div class="meta"><a href="${PRODUCTION_API_KEY_URL}" target="_blank" rel="noreferrer">创建 API Key</a><small>5 分钟内有效</small></div></form></main></body></html>`;
}

function successHtml(embedded = false) {
  const compact = embedded ? "body{margin:0;padding:18px;font-size:13px}h1{font-size:16px}" : "body{max-width:560px;margin:12vh auto;padding:24px}";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>配置完成</title><style>body{font:16px/1.55 system-ui;color:#19191d;text-align:center}${compact}h1{color:#16794b}</style><h1>配置完成</h1><p>API Key 已验证并安全保存，Canvas 正在自动刷新状态。</p></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function setupErrorMessage(error) {
  const message = sanitizeMessage(error?.message);
  if (/invalid|inactive|unauthorized|authentication failed/iu.test(message)) return "API Key 无效或已停用，请检查后重新输入。";
  if (/timed?\s*out|timeout|network|fetch failed|connection/iu.test(message)) return "暂时无法连接 Modellix，请检查网络后重试。";
  return message;
}
