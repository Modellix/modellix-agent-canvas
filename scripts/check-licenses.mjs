import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const notice = await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const projectLicense = await readFile(path.join(root, "LICENSE"), "utf8");
const license = normalize(await readFile(path.join(root, "THIRD_PARTY_LICENSES", "excalidraw-LICENSE.md"), "utf8"));
const expectedLicenseHash = "1352d204fdb90d5e482c13139d848bc2c9300a9a7de358a0a558a23e72d0d8be";

if (pkg.license !== "MIT") throw new Error("The project package must remain MIT licensed.");
if (!projectLicense.includes("Copyright (c) 2026 Modellix")) throw new Error("The project MIT license must identify Modellix as the copyright holder.");
if ((projectLicense.match(/^Copyright \(c\) .+$/gmu) || []).length !== 1) throw new Error("The project MIT license must contain exactly one copyright notice.");
if (pkg.devDependencies?.["@excalidraw/excalidraw"] !== "0.18.1") throw new Error("Excalidraw must remain pinned to reviewed version 0.18.1.");
if (lock.packages?.["node_modules/@excalidraw/excalidraw"]?.version !== "0.18.1") throw new Error("package-lock.json must resolve Excalidraw 0.18.1.");
if (lock.packages?.["node_modules/@excalidraw/excalidraw"]?.license !== "MIT") throw new Error("The resolved Excalidraw package must declare MIT.");
if (sha256(license) !== expectedLicenseHash) throw new Error("The reviewed Excalidraw MIT license is missing or changed.");
if (!notice.includes("@excalidraw/excalidraw` 0.18.1") || !notice.includes("modellix-cli` 0.0.8")) throw new Error("Third-party notices must disclose Excalidraw and the CLI runtime dependency.");
const allowedLicenses = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "CC-BY-4.0", "Unlicense", "(MIT AND Zlib)", "(MIT OR CC0-1.0)", "(MPL-2.0 OR Apache-2.0)"]);
const reviewedLegacyDeclarations = new Set(["node_modules/fuzzy", "node_modules/khroma"]);
for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
  if (!packagePath.startsWith("node_modules/")) continue;
  if (!metadata.license && reviewedLegacyDeclarations.has(packagePath)) continue;
  if (!allowedLicenses.has(metadata.license)) throw new Error(`Dependency ${packagePath} has an unreviewed license declaration: ${metadata.license || "missing"}`);
}

process.stdout.write("License checks OK: project MIT, Excalidraw 0.18.1 MIT, and CLI dependency notice verified.\n");

function normalize(value) { return value.replaceAll("\r\n", "\n").trimEnd() + "\n"; }
function sha256(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
