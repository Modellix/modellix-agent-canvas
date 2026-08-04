import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CanvasProjectStore } from "../mcp/lib/canvas-project-store.mjs";
import { DEFAULT_LANGUAGE, normalizeLanguage, TRANSLATIONS, translate } from "../mcp/lib/modellix-i18n.mjs";

test("English, Simplified Chinese, and Japanese catalogs stay complete", () => {
  const englishKeys = Object.keys(TRANSLATIONS.en).sort();
  assert.equal(DEFAULT_LANGUAGE, "en");
  assert.deepEqual(Object.keys(TRANSLATIONS).sort(), ["en", "ja-JP", "zh-CN"]);
  for (const catalog of Object.values(TRANSLATIONS)) assert.deepEqual(Object.keys(catalog).sort(), englishKeys);
  assert.equal(normalizeLanguage("zh-Hans"), "zh-CN");
  assert.equal(normalizeLanguage("ja"), "ja-JP");
  assert.equal(normalizeLanguage("unsupported"), "en");
  assert.equal(translate("ja-JP", "pages.defaultName", { number: 2 }), "ページ 2");
});

test("Canvas project language defaults to English and persists supported values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "modellix-i18n-"));
  try {
    const store = new CanvasProjectStore(root);
    const project = await store.initialize();
    assert.equal(project.settings.language, "en");
    project.settings.language = "ja-JP";
    await store.saveProject(project);
    const latest = await store.readProject({ hydrateFiles: false });
    assert.equal(latest.settings.language, "ja-JP");
    latest.settings.language = "invalid";
    await store.saveProject(latest);
    assert.equal((await store.readProject({ hydrateFiles: false })).settings.language, "en");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
