import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { imageSize } from "image-size";
import { lock } from "proper-lockfile";

import { ModellixCanvasError } from "./modellix-errors.mjs";
import { normalizeLanguage } from "./modellix-i18n.mjs";

export const CANVAS_PROJECT_SCHEMA_VERSION = 1;
export const CANVAS_PAGE_SCHEMA_VERSION = 1;

const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 24 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_ELEMENTS = 20_000;
const MAX_FILES = 2_000;
const MAX_APP_DATA_BYTES = 2 * 1024 * 1024;
const MAX_RECOVERY_PER_PAGE = 20;
const MISSING_IMAGE_DATA_URL = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#f7f8f8"/><rect x="16" y="16" width="608" height="328" rx="16" fill="none" stroke="#ff154c" stroke-width="3" stroke-dasharray="12 8"/><text x="320" y="182" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#ff154c">Missing project image</text><text x="320" y="220" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#68686b">Restore the content-addressed asset, then reload</text></svg>').toString("base64")}`;
const SAFE_ID = /^[A-Za-z0-9_-]{1,96}$/u;
const IMAGE_MIME_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/svg+xml", ".svg"],
]);

export class CanvasProjectStore {
  constructor(workspaceRoot) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.root = path.join(this.workspaceRoot, ".modellix", "canvas");
    this.projectFile = path.join(this.root, "project.json");
    this.pagesDir = path.join(this.root, "pages");
    this.assetsDir = path.join(this.root, "assets", "images");
    this.exportsDir = path.join(this.root, "assets", "exports");
    this.htmlDir = path.join(this.root, "assets", "html");
    this.recoveryDir = path.join(this.root, "recovery");
    this.lockFile = path.join(this.root, "locks", "project.lock");
  }

  async initialize() {
    await this.ensureLayout();
    try {
      await lstat(this.projectFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const project = defaultProject();
      await this.writePage(defaultPage(project.pages[0]));
      await atomicJson(this.projectFile, project, MAX_PROJECT_BYTES);
    }
    return this.readProject({ hydrateFiles: false });
  }

  async readProject({ hydrateFiles = true } = {}) {
    let manifest;
    try {
      manifest = validateProject(await readJsonBounded(this.projectFile, MAX_PROJECT_BYTES));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // A first read is observational: return the default document in memory
      // and create project files only after an explicit write.
      const project = defaultProject();
      return { ...project, pages: [defaultPage(project.pages[0])] };
    }
    const pages = [];
    for (const descriptor of manifest.pages) {
      // Page order is part of the product contract; sequential reads preserve deterministic errors.
      // eslint-disable-next-line no-await-in-loop
      const page = validatePage(await readJsonBounded(this.pageFile(descriptor.id), MAX_PAGE_BYTES), descriptor.id);
      if (hydrateFiles) {
        // eslint-disable-next-line no-await-in-loop
        page.files = await this.hydrateFiles(page.files);
        // eslint-disable-next-line no-await-in-loop
        page.appData = await this.hydrateAppData(page.appData);
      }
      pages.push(page);
    }
    return { ...manifest, pages };
  }

  async saveProject(rawProject) {
    const incoming = normalizeIncomingProject(rawProject);
    return this.transact(async () => {
      const current = await this.readManifestOrDefault();
      const incomingRevision = Number(incoming.revision || 1);
      const currentRevision = Number(current.revision || 1);
      if (incomingRevision !== currentRevision) {
        throw new ModellixCanvasError("REVISION_CONFLICT", "Canvas project changed in another session; reload before saving.", {
          recoveryActions: ["Reload the Canvas project and reapply the pending local change."],
        });
      }
      const now = new Date().toISOString();
      const descriptors = [];
      for (const [index, page] of incoming.pages.entries()) {
        // Assets are externalized before page JSON is written.
        // eslint-disable-next-line no-await-in-loop
        const files = await this.externalizeFiles(page.files || {});
        // HTML source is stored outside page JSON so revisions remain small and recoverable.
        // eslint-disable-next-line no-await-in-loop
        const appData = await this.externalizeAppData(page.appData || {});
        const normalizedPage = validatePage({
          ...page,
          schemaVersion: CANVAS_PAGE_SCHEMA_VERSION,
          id: page.id,
          name: cleanName(page.name, `Page ${index + 1}`),
          files,
          appData,
          updatedAt: now,
        }, page.id);
        // eslint-disable-next-line no-await-in-loop
        await this.backupPageIfPresent(page.id);
        // eslint-disable-next-line no-await-in-loop
        await atomicJson(this.pageFile(page.id), normalizedPage, MAX_PAGE_BYTES);
        descriptors.push({ id: page.id, name: normalizedPage.name, order: index });
      }
      const manifest = validateProject({
        schemaVersion: CANVAS_PROJECT_SCHEMA_VERSION,
        revision: currentRevision + 1,
        projectId: SAFE_ID.test(incoming.projectId || "") ? incoming.projectId : current.projectId,
        name: cleanName(incoming.name, current.name || "Untitled Canvas"),
        engine: { name: "excalidraw", adapterVersion: 1 },
        activePageId: descriptors.some((page) => page.id === incoming.activePageId)
          ? incoming.activePageId
          : descriptors[0].id,
        pages: descriptors,
        settings: sanitizeSettings(incoming.settings || current.settings),
        createdAt: current.createdAt || now,
        updatedAt: now,
      });
      await atomicJson(this.projectFile, manifest, MAX_PROJECT_BYTES);
      return { ok: true, projectId: manifest.projectId, revision: manifest.revision, activePageId: manifest.activePageId, pageCount: manifest.pages.length, updatedAt: now };
    });
  }

  async getContext(detailLevel = "selection") {
    const project = await this.readProject({ hydrateFiles: false });
    const page = project.pages.find((entry) => entry.id === project.activePageId) || project.pages[0];
    const selectedIds = Object.entries(page?.appState?.selectedElementIds || {})
      .filter(([, selected]) => selected)
      .map(([id]) => id);
    const selected = detailLevel === "summary" ? [] : (page?.elements || [])
      .filter((element) => !element.isDeleted && selectedIds.includes(element.id))
      .map(elementSummary);
    const objects = detailLevel === "page"
      ? (page?.elements || []).filter((element) => !element.isDeleted).slice(0, 500).map(elementSummary)
      : undefined;
    return {
      ok: true,
      detailLevel,
      projectId: project.projectId,
      projectName: project.name,
      activePageId: page?.id || null,
      pages: project.pages.map(({ id, name }, order) => ({ id, name, order })),
      selection: selected,
      elementCount: (page?.elements || []).filter((element) => !element.isDeleted).length,
      ...(objects ? { objects } : {}),
      availableActions: ["open", "create_page", "generate_image", ...(selected.length ? ["export_selection"] : [])],
    };
  }

  async createPage(name) {
    const project = await this.readProject({ hydrateFiles: true });
    if (project.pages.length >= MAX_PAGES) throw inputError(`A project supports at most ${MAX_PAGES} pages.`);
    const id = `page_${randomUUID().replaceAll("-", "")}`;
    project.pages.push(defaultPage({ id, name: cleanName(name, `Page ${project.pages.length + 1}`) }));
    project.activePageId = id;
    await this.saveProject(project);
    return { ok: true, pageId: id, name: project.pages.at(-1).name, order: project.pages.length - 1 };
  }

  async renamePage(pageId, name) {
    const project = await this.readProject({ hydrateFiles: true });
    const page = project.pages.find((entry) => entry.id === normalizeId(pageId, "pageId"));
    if (!page) throw inputError("Page does not exist.");
    page.name = cleanName(name, page.name);
    await this.saveProject(project);
    return { ok: true, pageId: page.id, name: page.name };
  }

  async deletePage(pageId) {
    const normalized = normalizeId(pageId, "pageId");
    const project = await this.readProject({ hydrateFiles: true });
    if (project.pages.length === 1) throw inputError("A Canvas project must keep at least one page.");
    const index = project.pages.findIndex((entry) => entry.id === normalized);
    if (index < 0) throw inputError("Page does not exist.");
    project.pages.splice(index, 1);
    if (project.activePageId === normalized) project.activePageId = project.pages[Math.min(index, project.pages.length - 1)].id;
    await this.saveProject(project);
    return { ok: true, pageId: normalized, activePageId: project.activePageId };
  }

  async saveReference({ dataBase64, mimeType, fileName = "reference.png" }) {
    const asset = await this.saveAsset({ dataBase64, mimeType, fileName });
    return { ok: true, assetId: asset.assetId, mimeType: asset.mimeType, size: asset.size };
  }

  async saveAsset({ dataBase64, mimeType, fileName, sourcePath }) {
    let bytes;
    let effectiveMime = String(mimeType || "").toLowerCase();
    if (sourcePath) {
      const safeSource = await assertWorkspaceFile(this.workspaceRoot, sourcePath);
      bytes = await readFile(safeSource);
      effectiveMime ||= mimeFromExtension(path.extname(safeSource));
    } else {
      bytes = Buffer.from(String(dataBase64 || ""), "base64");
    }
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) throw inputError("Image asset is empty or exceeds 32 MiB.");
    const extension = IMAGE_MIME_TYPES.get(effectiveMime);
    if (!extension) throw inputError("Only PNG, JPEG, WebP, GIF, and sanitized SVG assets are supported.");
    const detectedMime = sniffImageMime(bytes);
    if (detectedMime !== effectiveMime) throw inputError("Image content does not match its declared MIME type.");
    if (effectiveMime === "image/svg+xml") validateSvg(bytes.toString("utf8"));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const assetId = `asset_${digest.slice(0, 32)}`;
    const target = path.join(this.assetsDir, `${assetId}${extension}`);
    await mkdir(this.assetsDir, { recursive: true, mode: 0o700 });
    try {
      await lstat(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    const dimensions = safeImageDimensions(bytes, effectiveMime);
    return {
      assetId,
      assetPath: path.relative(this.root, target).replaceAll("\\", "/"),
      absolutePath: target,
      digest,
      mimeType: effectiveMime,
      size: bytes.length,
      fileName: safeFileName(fileName || path.basename(target)),
      ...dimensions,
    };
  }

  async readAsset(assetId) {
    const normalized = normalizeId(assetId, "assetId");
    const entries = await this.findAssetCandidates(normalized);
    if (entries.length !== 1) throw inputError("Asset does not exist or is ambiguous.");
    const filePath = entries[0];
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_ASSET_BYTES) {
      throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Asset must be a bounded regular file.");
    }
    return { assetId: normalized, filePath, mimeType: mimeFromExtension(path.extname(filePath)), size: stats.size };
  }

  async resolveImageObject(objectId) {
    const normalized = normalizeId(objectId, "objectId");
    const project = await this.readProject({ hydrateFiles: false });
    for (const page of project.pages) {
      const element = page.elements.find((entry) => !entry.isDeleted && (
        entry.id === normalized || entry.customData?.modellix?.objectId === normalized
      ));
      if (!element) continue;
      if (element.type !== "image" || !element.fileId) throw inputError(`Canvas object ${normalized} is not an image.`);
      const file = page.files?.[element.fileId];
      if (!file?.assetId) throw inputError(`Canvas image ${normalized} has no project asset.`);
      const asset = await this.readAsset(file.assetId);
      return {
        assetId: file.assetId,
        objectId: element.customData?.modellix?.objectId || element.id,
        elementId: element.id,
        pageId: page.id,
        element,
        digest: file.digest || createHash("sha256").update(await readFile(asset.filePath)).digest("hex"),
        filePath: asset.filePath,
        mimeType: asset.mimeType,
        fileSize: asset.size,
      };
    }
    throw inputError(`Canvas object ${normalized} does not exist.`);
  }

  async locateObject(objectId) {
    const normalized = normalizeId(objectId, "objectId");
    const project = await this.readProject({ hydrateFiles: false });
    for (const page of project.pages) {
      const element = page.elements.find((entry) => !entry.isDeleted && (
        entry.id === normalized || entry.customData?.modellix?.objectId === normalized
      ));
      if (element) return { pageId: page.id, objectId: element.customData?.modellix?.objectId || element.id, elementId: element.id, element };
    }
    return null;
  }

  async findTaskResources(taskId) {
    const normalized = normalizeId(taskId, "taskId");
    const project = await this.readProject({ hydrateFiles: false });
    const resources = [];
    for (const page of project.pages) {
      for (const element of page.elements) {
        const metadata = element.customData?.modellix;
        if (element.isDeleted || element.type !== "image" || metadata?.taskId !== normalized) continue;
        const file = page.files?.[element.fileId];
        if (!file?.assetId) continue;
        resources.push({
          resourceIndex: Number(metadata.resourceIndex) || 0,
          pageId: page.id,
          objectId: metadata.objectId || element.id,
          elementId: element.id,
          assetId: file.assetId,
          assetPath: file.assetPath,
          bounds: { x: Number(element.x) || 0, y: Number(element.y) || 0, w: Number(element.width) || 0, h: Number(element.height) || 0 },
        });
      }
    }
    return resources.sort((left, right) => left.resourceIndex - right.resourceIndex);
  }

  async insertImage({ imagePath, pageId, anchorObjectId, anchorBounds, replaceHolder = false, placement = "right", gridIndex = 0, placementOrigin, margin = 48, metadata = {} }) {
    const project = await this.readProject({ hydrateFiles: true });
    const page = project.pages.find((entry) => entry.id === pageId) || project.pages.find((entry) => entry.id === project.activePageId) || project.pages[0];
    const asset = await this.saveAsset({ sourcePath: imagePath, fileName: path.basename(imagePath) });
    const fileId = `file_${asset.digest.slice(0, 32)}`;
    const now = Date.now();
    const anchor = anchorObjectId
      ? page.elements.find((entry) => !entry.isDeleted && (entry.id === anchorObjectId || entry.customData?.modellix?.objectId === anchorObjectId))
      : null;
    const width = Math.max(64, asset.width || 1024);
    const height = Math.max(64, asset.height || 1024);
    const layoutAnchor = anchorBounds ? { ...anchorBounds } : anchor;
    let target = placementBounds(layoutAnchor, { width, height }, placement, Number(margin) || 48, gridIndex, placementOrigin);
    if (!layoutAnchor) target = avoidExistingContent(target, page.elements, Number(margin) || 48);
    const objectId = `obj_${randomUUID().replaceAll("-", "")}`;
    const element = imageElement({
      id: `img_${randomUUID().replaceAll("-", "")}`,
      objectId,
      fileId,
      x: target.x,
      y: target.y,
      width: target.width,
      height: target.height,
      metadata,
    });
    page.files[fileId] = fileRecord(fileId, asset);
    if (replaceHolder && anchor?.customData?.modellix?.kind === "image-holder") {
      if (metadata.fitPolicy === "contain") {
        const scale = Math.min(anchor.width / width, anchor.height / height);
        const fittedWidth = Math.max(1, width * scale);
        const fittedHeight = Math.max(1, height * scale);
        Object.assign(element, {
          x: anchor.x + (anchor.width - fittedWidth) / 2,
          y: anchor.y + (anchor.height - fittedHeight) / 2,
          width: fittedWidth,
          height: fittedHeight,
          angle: anchor.angle || 0,
        });
      } else {
        Object.assign(element, { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height, angle: anchor.angle || 0 });
      }
      const holderObjectId = anchor.customData.modellix.objectId;
      page.elements = page.elements.map((entry) => (
        entry.id === anchor.id || entry.customData?.modellix?.objectId === holderObjectId
          ? { ...entry, isDeleted: true, updated: now, version: Number(entry.version || 1) + 1 }
          : entry
      ));
    }
    if (replaceHolder && anchor?.customData?.modellix?.kind === "image-holder") {
      const anchorIndex = page.elements.findIndex((entry) => entry.id === anchor.id);
      page.elements.splice(Math.max(0, anchorIndex), 0, element);
    } else page.elements.push(element);
    page.appState = { ...(page.appState || {}), selectedElementIds: { [element.id]: true } };
    project.activePageId = page.id;
    await this.saveProject(project);
    return {
      assetFile: asset.absolutePath,
      assetId: asset.assetId,
      objectId,
      elementId: element.id,
      pageId: page.id,
      bounds: { x: element.x, y: element.y, w: element.width, h: element.height },
    };
  }

  async hydrateFiles(files = {}) {
    const hydrated = {};
    for (const [fileId, file] of Object.entries(files).slice(0, MAX_FILES)) {
      if (!file?.assetId) continue;
      // eslint-disable-next-line no-await-in-loop
      try {
        const asset = await this.readAsset(file.assetId);
        // eslint-disable-next-line no-await-in-loop
        const bytes = await readFile(asset.filePath);
        hydrated[fileId] = {
          ...file,
          id: fileId,
          mimeType: file.mimeType || asset.mimeType,
          dataURL: `data:${file.mimeType || asset.mimeType};base64,${bytes.toString("base64")}`,
        };
      } catch (error) {
        if (error instanceof ModellixCanvasError && error.code === "INPUT_INVALID") {
          hydrated[fileId] = { ...file, id: fileId, originalMimeType: file.mimeType, mimeType: "image/svg+xml", dataURL: MISSING_IMAGE_DATA_URL, missing: true };
          continue;
        }
        throw error;
      }
    }
    return hydrated;
  }

  async externalizeFiles(files = {}) {
    const entries = Object.entries(files);
    if (entries.length > MAX_FILES) throw inputError(`A page supports at most ${MAX_FILES} files.`);
    const result = {};
    for (const [fileId, raw] of entries) {
      const id = normalizeId(fileId, "fileId");
      let asset;
      if (raw?.missing && raw?.assetId) {
        result[id] = {
          id,
          assetId: raw.assetId,
          assetPath: raw.assetPath,
          digest: raw.digest,
          mimeType: raw.originalMimeType || raw.mimeType,
          created: Number(raw.created) || Date.now(),
          lastRetrieved: Number(raw.lastRetrieved) || Date.now(),
        };
        continue;
      } else if (raw?.dataURL) {
        const parsed = parseDataUrl(raw.dataURL);
        // eslint-disable-next-line no-await-in-loop
        asset = await this.saveAsset({ dataBase64: parsed.dataBase64, mimeType: parsed.mimeType, fileName: raw.name || `${id}.png` });
      } else if (raw?.assetId) {
        // eslint-disable-next-line no-await-in-loop
        const existing = await this.readAsset(raw.assetId);
        asset = {
          assetId: raw.assetId,
          assetPath: path.relative(this.root, existing.filePath).replaceAll("\\", "/"),
          digest: raw.digest || raw.assetId.replace(/^asset_/u, ""),
          mimeType: raw.mimeType || existing.mimeType,
          size: existing.size,
        };
      } else {
        continue;
      }
      result[id] = fileRecord(id, asset, raw);
    }
    return result;
  }

  async externalizeAppData(appData = {}) {
    const copy = structuredClone(appData || {});
    const drafts = {};
    for (const [rawObjectId, rawDraft] of Object.entries(copy.htmlDrafts || {})) {
      const objectId = normalizeId(rawObjectId, "htmlDraftObjectId");
      const draft = rawDraft && typeof rawDraft === "object" ? { ...rawDraft } : {};
      const directory = path.join(this.htmlDir, objectId);
      const sourceFile = path.join(directory, "index.html");
      if (typeof draft.source === "string") {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await this.backupHtmlIfPresent(objectId, Number(draft.revision || 0));
        await atomicText(sourceFile, draft.source, MAX_APP_DATA_BYTES);
      }
      delete draft.source;
      delete draft.missingSource;
      drafts[objectId] = {
        ...draft,
        entryFile: "index.html",
        sourcePath: path.relative(this.root, sourceFile).replaceAll("\\", "/"),
      };
    }
    copy.htmlDrafts = drafts;
    return copy;
  }

  async hydrateAppData(appData = {}) {
    const copy = structuredClone(appData || {});
    const drafts = {};
    for (const [rawObjectId, rawDraft] of Object.entries(copy.htmlDrafts || {})) {
      const objectId = normalizeId(rawObjectId, "htmlDraftObjectId");
      const sourceFile = path.join(this.htmlDir, objectId, "index.html");
      let source = "";
      let missingSource = false;
      try {
        const stats = await lstat(sourceFile);
        if (!stats.isFile() || stats.isSymbolicLink()) throw inputError("HTML draft source is not a safe regular file.");
        source = await readTextBounded(sourceFile, MAX_APP_DATA_BYTES);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        missingSource = true;
      }
      drafts[objectId] = { ...(rawDraft || {}), entryFile: "index.html", source, ...(missingSource ? { missingSource: true } : {}) };
    }
    copy.htmlDrafts = drafts;
    return copy;
  }

  async transact(action) {
    await this.ensureLayout();
    const release = await lock(this.lockFile, {
      realpath: false,
      retries: { retries: 100, factor: 1.15, minTimeout: 20, maxTimeout: 250 },
      stale: 30_000,
      update: 10_000,
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }

  async ensureLayout() {
    for (const dir of [this.root, this.pagesDir, this.assetsDir, this.exportsDir, this.htmlDir, this.recoveryDir, path.dirname(this.lockFile)]) {
      // eslint-disable-next-line no-await-in-loop
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    try {
      await lstat(this.lockFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writeFile(this.lockFile, "", { flag: "wx", mode: 0o600 });
    }
  }

  async readManifestOrDefault() {
    try {
      return validateProject(await readJsonBounded(this.projectFile, MAX_PROJECT_BYTES));
    } catch (error) {
      if (error?.code === "ENOENT") return defaultProject();
      throw error;
    }
  }

  pageFile(pageId) {
    return path.join(this.pagesDir, `${normalizeId(pageId, "pageId")}.json`);
  }

  async writePage(page) {
    await atomicJson(this.pageFile(page.id), validatePage(page, page.id), MAX_PAGE_BYTES);
  }

  async backupPageIfPresent(pageId) {
    const source = this.pageFile(pageId);
    try {
      const stats = await stat(source);
      if (!stats.isFile()) return;
      const target = path.join(this.recoveryDir, `${pageId}-${Date.now()}.json`);
      await copyFile(source, target);
      const entries = (await readdir(this.recoveryDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.startsWith(`${pageId}-`) && entry.name.endsWith(".json"))
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const stale of entries.slice(MAX_RECOVERY_PER_PAGE)) {
        // eslint-disable-next-line no-await-in-loop
        await unlink(path.join(this.recoveryDir, stale)).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async backupHtmlIfPresent(objectId, revision) {
    const source = path.join(this.htmlDir, normalizeId(objectId, "htmlDraftObjectId"), "index.html");
    try {
      const stats = await lstat(source);
      if (!stats.isFile() || stats.isSymbolicLink()) return;
      const prefix = `html-${objectId}-`;
      const target = path.join(this.recoveryDir, `${prefix}${Math.max(0, revision)}-${Date.now()}.html`);
      await copyFile(source, target);
      const entries = (await readdir(this.recoveryDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".html"))
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const stale of entries.slice(MAX_RECOVERY_PER_PAGE)) {
        // eslint-disable-next-line no-await-in-loop
        await unlink(path.join(this.recoveryDir, stale));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async findAssetCandidates(assetId) {
    const candidates = [];
    for (const extension of IMAGE_MIME_TYPES.values()) {
      const candidate = path.join(this.assetsDir, `${assetId}${extension}`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await lstat(candidate);
        candidates.push(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return candidates;
  }
}

function defaultProject() {
  const now = new Date().toISOString();
  const page = { id: `page_${randomUUID().replaceAll("-", "")}`, name: "Page 1", order: 0 };
  return {
    schemaVersion: CANVAS_PROJECT_SCHEMA_VERSION,
    revision: 1,
    projectId: `mc_${randomUUID().replaceAll("-", "")}`,
    name: "Untitled Canvas",
    engine: { name: "excalidraw", adapterVersion: 1 },
    activePageId: page.id,
    pages: [page],
    settings: { theme: "light", language: "en", grid: false },
    createdAt: now,
    updatedAt: now,
  };
}

function defaultPage(descriptor) {
  const now = new Date().toISOString();
  return {
    schemaVersion: CANVAS_PAGE_SCHEMA_VERSION,
    id: descriptor.id,
    name: descriptor.name || "Page",
    elements: [],
    files: {},
    appState: {
      viewBackgroundColor: "#F7F8F8",
      currentItemRoughness: 0,
      currentItemStrokeColor: "#19191D",
      currentItemBackgroundColor: "transparent",
      selectedElementIds: {},
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
    },
    appData: { htmlDrafts: {}, decks: {} },
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeIncomingProject(raw) {
  assertNoSensitiveFields(raw);
  if (raw?.schemaVersion !== CANVAS_PROJECT_SCHEMA_VERSION) throw inputError("Unsupported Canvas project schema; this version will not overwrite it.");
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.pages) || raw.pages.length < 1 || raw.pages.length > MAX_PAGES) {
    throw inputError(`Project must contain between 1 and ${MAX_PAGES} pages.`);
  }
  const seen = new Set();
  const pages = raw.pages.map((page, index) => {
    if (page?.schemaVersion !== CANVAS_PAGE_SCHEMA_VERSION) throw inputError(`Unsupported Canvas page schema at index ${index}.`);
    const id = normalizeId(page?.id, `pages[${index}].id`);
    if (seen.has(id)) throw inputError(`Duplicate page ID: ${id}`);
    seen.add(id);
    return { ...page, id };
  });
  return { ...raw, pages };
}

function validateProject(project) {
  if (!project || project.schemaVersion !== CANVAS_PROJECT_SCHEMA_VERSION) throw inputError("Unsupported Canvas project schema.");
  project.revision = Number.isInteger(project.revision) && project.revision > 0 ? project.revision : 1;
  normalizeId(project.projectId, "projectId");
  if (!Array.isArray(project.pages) || project.pages.length < 1 || project.pages.length > MAX_PAGES) throw inputError("Canvas project page list is invalid.");
  const seen = new Set();
  project.pages = project.pages.map((page, index) => {
    const id = normalizeId(page?.id, `pages[${index}].id`);
    if (seen.has(id)) throw inputError(`Duplicate page ID: ${id}`);
    seen.add(id);
    return { id, name: cleanName(page.name, `Page ${index + 1}`), order: index };
  });
  if (!seen.has(project.activePageId)) project.activePageId = project.pages[0].id;
  return project;
}

function validatePage(page, expectedId) {
  if (!page || page.schemaVersion !== CANVAS_PAGE_SCHEMA_VERSION || page.id !== expectedId) throw inputError("Canvas page schema or identity is invalid.");
  if (!Array.isArray(page.elements) || page.elements.length > MAX_ELEMENTS) throw inputError(`A page supports at most ${MAX_ELEMENTS} elements.`);
  if (!page.files || typeof page.files !== "object" || Array.isArray(page.files) || Object.keys(page.files).length > MAX_FILES) throw inputError("Canvas page files are invalid.");
  page.elements = page.elements.map((element, index) => sanitizeElement(element, index));
  page.appState = sanitizeAppState(page.appState);
  page.appData = sanitizeAppData(page.appData);
  page.name = cleanName(page.name, "Page");
  return page;
}

function sanitizeAppData(appData = {}) {
  assertNoSensitiveFields(appData);
  if (!appData || typeof appData !== "object" || Array.isArray(appData)) throw inputError("Canvas page application data is invalid.");
  const copy = structuredClone(appData);
  if (Buffer.byteLength(JSON.stringify(copy)) > MAX_APP_DATA_BYTES) throw inputError("Canvas page application data exceeds 2 MiB.");
  return copy;
}

function sanitizeElement(element, index) {
  assertNoSensitiveFields(element);
  if (!element || typeof element !== "object") throw inputError(`Element ${index} is invalid.`);
  normalizeId(element.id, `elements[${index}].id`);
  if (!/^[a-z]+$/u.test(String(element.type || ""))) throw inputError(`Element ${element.id} has an invalid type.`);
  for (const key of ["x", "y", "width", "height", "angle", "opacity"]) {
    if (element[key] !== undefined && !Number.isFinite(Number(element[key]))) throw inputError(`Element ${element.id} has invalid ${key}.`);
  }
  const copy = structuredClone(element);
  if (copy.customData?.modellix) {
    copy.customData.modellix = sanitizeBusinessMetadata(copy.customData.modellix);
  }
  return copy;
}

function sanitizeAppState(appState = {}) {
  const allowed = [
    "viewBackgroundColor", "scrollX", "scrollY", "zoom", "gridSize", "gridStep", "gridModeEnabled",
    "objectsSnapModeEnabled", "theme", "currentItemStrokeColor", "currentItemBackgroundColor",
    "currentItemFillStyle", "currentItemStrokeWidth", "currentItemStrokeStyle", "currentItemRoughness",
    "currentItemOpacity", "currentItemFontFamily", "currentItemFontSize", "currentItemTextAlign",
    "selectedElementIds", "selectedGroupIds", "name",
  ];
  return Object.fromEntries(allowed.filter((key) => appState?.[key] !== undefined).map((key) => [key, structuredClone(appState[key])]));
}

function sanitizeSettings(settings = {}) {
  return {
    theme: settings.theme === "dark" ? "dark" : "light",
    language: normalizeLanguage(settings.language),
    grid: Boolean(settings.grid),
  };
}

function sanitizeBusinessMetadata(metadata = {}) {
  const allowed = ["schemaVersion", "kind", "objectId", "assetId", "workflowId", "taskId", "resourceIndex", "deckId", "order", "ratio", "entryFile", "revision", "fitPolicy"];
  return Object.fromEntries(allowed.filter((key) => metadata[key] !== undefined).map((key) => [key, typeof metadata[key] === "string" ? metadata[key].slice(0, 256) : metadata[key]]));
}

function fileRecord(fileId, asset, raw = {}) {
  return {
    id: fileId,
    assetId: asset.assetId,
    assetPath: asset.assetPath,
    digest: asset.digest,
    mimeType: asset.mimeType,
    created: Number(raw.created) || Date.now(),
    lastRetrieved: Number(raw.lastRetrieved) || Date.now(),
  };
}

function imageElement({ id, objectId, fileId, x, y, width, height, metadata }) {
  const now = Date.now();
  return {
    id,
    type: "image",
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: randomInt(),
    version: 1,
    versionNonce: randomInt(),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData: {
      modellix: {
        schemaVersion: 1,
        kind: "generated-image",
        objectId,
        ...sanitizeBusinessMetadata(metadata),
      },
    },
  };
}

function placementBounds(anchor, image, placement, margin, gridIndex = 0, placementOrigin = null) {
  const index = Math.max(0, Number(gridIndex) || 0);
  const column = index % 2;
  const row = Math.floor(index / 2);
  if (!anchor) {
    const scale = Math.min(1, 1024 / image.width, 800 / image.height);
    const width = Math.max(64, image.width * scale);
    const height = Math.max(64, image.height * scale);
    const originX = Number.isFinite(placementOrigin?.x) ? placementOrigin.x : 120 + width / 2;
    const originY = Number.isFinite(placementOrigin?.y) ? placementOrigin.y : 120 + height / 2;
    return { x: originX - width / 2 + column * (width + margin), y: originY - height / 2 + row * (height + margin), width, height };
  }
  const width = anchor.width || image.width;
  const height = Math.max(64, width * image.height / image.width);
  if (placement === "left") return { x: anchor.x - width - margin, y: anchor.y, width, height };
  if (placement === "below") return { x: anchor.x, y: anchor.y + anchor.height + margin, width, height };
  return { x: anchor.x + anchor.width + margin + column * (width + margin), y: anchor.y + row * (height + margin), width, height };
}

function avoidExistingContent(initial, elements, margin) {
  const occupied = (elements || []).filter((element) => !element.isDeleted && Number(element.width) > 0 && Number(element.height) > 0);
  let candidate = { ...initial };
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const collision = occupied.some((element) => !(
      candidate.x + candidate.width + margin <= element.x
      || element.x + element.width + margin <= candidate.x
      || candidate.y + candidate.height + margin <= element.y
      || element.y + element.height + margin <= candidate.y
    ));
    if (!collision) return candidate;
    candidate = { ...candidate, x: candidate.x + candidate.width + margin };
    if ((attempt + 1) % 3 === 0) candidate = { ...candidate, x: initial.x, y: candidate.y + candidate.height + margin };
  }
  return candidate;
}

function elementSummary(element) {
  return {
    objectId: element.customData?.modellix?.objectId || element.id,
    elementId: element.id,
    type: element.type,
    kind: element.customData?.modellix?.kind || null,
    x: Number(element.x) || 0,
    y: Number(element.y) || 0,
    width: Number(element.width) || 0,
    height: Number(element.height) || 0,
  };
}

async function atomicJson(filePath, value, limit) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload) > limit) throw inputError("Canvas data exceeds its safe storage limit.");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function atomicText(filePath, value, limit) {
  const payload = String(value || "");
  if (Buffer.byteLength(payload) > limit) throw inputError("HTML draft source exceeds 2 MiB.");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readTextBounded(filePath, limit) {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > limit) throw inputError("HTML draft source is missing, unsafe, or too large.");
  return readFile(filePath, "utf8");
}

async function readJsonBounded(filePath, limit) {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > limit) throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Canvas data must be a bounded regular file.");
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function assertWorkspaceFile(workspaceRoot, candidate) {
  const raw = String(candidate);
  if (raw.split(/[\\/]/u).includes("..")) throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Source asset paths cannot contain parent traversal segments.");
  if (process.platform === "win32") {
    if (/^(?:\\\\[.?]\\|\\[.?]\\)/u.test(raw)) throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Windows device paths are not accepted for Canvas assets.");
    const remainder = raw.slice(path.parse(raw).root.length);
    if (remainder.includes(":")) throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Windows alternate data streams are not accepted for Canvas assets.");
  }
  const rootReal = await realpath(workspaceRoot);
  const resolved = path.resolve(raw);
  const stats = await lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Source asset must be a regular workspace file.");
  const candidateReal = await realpath(resolved);
  const relative = path.relative(rootReal, candidateReal);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new ModellixCanvasError("WORKSPACE_BOUNDARY_VIOLATION", "Source asset must stay inside the bound workspace.");
  return candidateReal;
}

function parseDataUrl(value) {
  const match = String(value).match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/u);
  if (!match) throw inputError("Canvas file data must be a base64 data URL.");
  return { mimeType: match[1].toLowerCase(), dataBase64: match[2] };
}

function safeImageDimensions(bytes, mimeType) {
  if (mimeType === "image/svg+xml") return {};
  try {
    const dimensions = imageSize(bytes);
    if (!dimensions.width || !dimensions.height || dimensions.width > 32768 || dimensions.height > 32768 || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) throw new Error("invalid dimensions");
    return { width: dimensions.width, height: dimensions.height };
  } catch {
    throw inputError("Image dimensions are invalid or exceed 32768 pixels.");
  }
}

function sniffImageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  const text = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("utf8").replace(/^\uFEFF/u, "").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg\b/iu.test(text)) return "image/svg+xml";
  return "application/octet-stream";
}

function validateSvg(source) {
  if (/<!DOCTYPE|<!ENTITY|<(?:script|foreignObject|iframe|object|embed|audio|video)\b|\bon\w+\s*=|javascript:|@import/iu.test(source)) {
    throw inputError("The SVG contains active or external content and cannot be imported.");
  }
  if (/\b(?:href|xlink:href)\s*=\s*["'](?!#|data:image\/)[^"']+["']/iu.test(source)) throw inputError("The SVG contains an external reference.");
  if (/url\(\s*["']?(?!#|data:image\/)[^)]+\)/iu.test(source)) throw inputError("The SVG contains an external CSS resource.");
}

function normalizeId(value, field) {
  const normalized = String(value || "").trim();
  if (!SAFE_ID.test(normalized)) throw inputError(`${field} is invalid.`);
  return normalized;
}

function cleanName(value, fallback) {
  const normalized = String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 120);
  return normalized || fallback;
}

function safeFileName(value) {
  return path.basename(String(value || "asset")).replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 120) || "asset";
}

function mimeFromExtension(extension) {
  const normalized = String(extension || "").toLowerCase();
  if (normalized === ".jpeg") return "image/jpeg";
  return [...IMAGE_MIME_TYPES.entries()].find(([, ext]) => ext === normalized)?.[0] || "application/octet-stream";
}

function assertNoSensitiveFields(value, pathName = "root", seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw inputError(`Circular value at ${pathName}.`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/api.?key|authorization|confirmation.?token|bearer|remote.?url/iu.test(key)) throw inputError(`Sensitive field is not allowed in Canvas data: ${key}`);
    assertNoSensitiveFields(child, `${pathName}.${key}`, seen);
  }
  seen.delete(value);
}

function randomInt() {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}

function inputError(message) {
  return new ModellixCanvasError("INPUT_INVALID", message);
}
