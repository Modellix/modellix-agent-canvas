import path from "node:path";

const installationDirectory = path.resolve(import.meta.dirname, "..", "..");

export function pluginRoot() {
  return installationDirectory;
}

export function pluginPath(...segments) {
  return path.join(installationDirectory, ...segments);
}
