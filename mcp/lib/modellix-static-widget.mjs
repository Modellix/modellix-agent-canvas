import { readFile } from "node:fs/promises";

import { pluginPath } from "./plugin-root.mjs";

const packagedCanvas = pluginPath("mcp", "static", "canvas.html");
const maximumWidgetBytes = 9 * 1024 * 1024;
let cachedCanvas = null;

export async function modellixStaticHtml() {
  if (cachedCanvas !== null) return cachedCanvas;
  let html;
  try {
    html = await readFile(packagedCanvas, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw new Error("The packaged Canvas widget is missing. Reinstall the plugin or run npm run build:widget in a source checkout.", { cause: error });
  }
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes === 0 || bytes > maximumWidgetBytes) throw new Error("The packaged Canvas widget is empty or exceeds the 9 MiB transport budget.");
  if (!/<html\b/iu.test(html) || !/<script\b/iu.test(html)) throw new Error("The packaged Canvas widget is not a complete HTML application.");
  assertSelfContainedDocument(html);
  cachedCanvas = html;
  return cachedCanvas;
}

function assertSelfContainedDocument(html) {
  const tag = /<(script|link)\b[^>]*>/giu;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    if (/\b(?:src|href)\s*=\s*["'](?!data:|blob:)/iu.test(match[0])) {
      throw new Error("The packaged Canvas widget contains an external build resource.");
    }
    if (match[1].toLowerCase() !== "script") continue;
    const closingTag = html.indexOf("</script>", tag.lastIndex);
    if (closingTag < 0) throw new Error("The packaged Canvas widget contains an unterminated script.");
    tag.lastIndex = closingTag + "</script>".length;
  }
}
