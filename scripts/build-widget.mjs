import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { build } from "vite";

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputFile = path.join(projectRoot, "mcp", "static", "canvas.html");
const buildDirectory = await mkdtemp(path.join(tmpdir(), "modellix-canvas-widget-"));

try {
  await build({
    root: projectRoot,
    build: { outDir: buildDirectory, emptyOutDir: true },
  });
  const html = await createSingleFileWidget(buildDirectory);
  await mkdir(path.dirname(outputFile), { recursive: true });
  const pendingFile = `${outputFile}.${process.pid}.tmp`;
  await writeFile(pendingFile, html, "utf8");
  await rename(pendingFile, outputFile);
  process.stdout.write(`Built packaged MCP Apps widget: ${outputFile}\n`);
} finally {
  await rm(buildDirectory, { recursive: true, force: true });
}

async function createSingleFileWidget(directory) {
  let html = await readFile(path.join(directory, "index.html"), "utf8");
  const consumedAssets = new Set();
  const scripts = [];
  html = html.replace(/<link\s+rel="modulepreload"[^>]*>\s*/giu, "");
  html = html.replace(/<link\b(?=[^>]*\brel=["'][^"']*\bicon\b[^"']*["'])[^>]*>\s*/giu, "");
  html = await replaceMatches(html, /<link\s+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/giu, async (_tag, href) => {
    const css = await loadBuildAsset(directory, href, consumedAssets);
    return `<style>\n${escapeClosingTag(css, "style")}\n</style>`;
  });
  html = await replaceMatches(html, /<script\s+type="module"[^>]+src="([^"]+)"[^>]*><\/script>/giu, async (_tag, source) => {
    const javascript = migrateDeprecatedUnloadHandler(await loadBuildAsset(directory, source, consumedAssets));
    scripts.push(`<script type="module">\n${escapeClosingTag(javascript, "script")}\n</script>`);
    return "";
  });
  const assetsDirectory = path.join(directory, "assets");
  const emittedAssets = await readdir(assetsDirectory).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const leftovers = emittedAssets.filter((name) => !consumedAssets.has(`assets/${name}`));
  if (leftovers.length > 0) throw new Error(`Widget build emitted non-inlined assets: ${leftovers.join(", ")}`);
  if (/<(?:script|link)\b[^>]*(?:src|href)=/iu.test(html)) throw new Error("Widget HTML still references an external build asset.");
  const inlineScripts = scripts.join("\n");
  return html.includes("</body>") ? html.replace("</body>", () => `${inlineScripts}\n</body>`) : `${html}\n${inlineScripts}`;
}

async function loadBuildAsset(directory, reference, consumedAssets) {
  const relative = String(reference).replace(/^(?:\.\/|\/)+/u, "");
  if (!relative || relative.split(/[\\/]/u).includes("..") || path.isAbsolute(relative)) throw new Error("Widget build emitted an unsafe asset path.");
  consumedAssets.add(relative);
  return readFile(path.join(directory, ...relative.split("/")), "utf8");
}

async function replaceMatches(source, pattern, replacement) {
  const matches = [...source.matchAll(pattern)];
  let cursor = 0;
  let result = "";
  for (const match of matches) {
    result += source.slice(cursor, match.index);
    // Ordered replacement keeps the generated document deterministic.
    // eslint-disable-next-line no-await-in-loop
    result += await replacement(...match);
    cursor = match.index + match[0].length;
  }
  return result + source.slice(cursor);
}

function escapeClosingTag(source, tagName) {
  return source.replace(new RegExp(`</${tagName}`, "giu"), `<\\/${tagName}`);
}

function migrateDeprecatedUnloadHandler(source) {
  return source.replace(/window,\s*["']unload["']\s*,\s*this\.onUnload/gu, 'window,"pagehide",this.onUnload');
}
