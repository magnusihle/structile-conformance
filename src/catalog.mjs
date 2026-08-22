import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const suiteIds = Object.freeze({
  "architecture-boundaries": "ARCH-001",
  "compose-smoke": "DEV-001",
  "agent-adapters": "HAR-001",
  "harness-policy": "HAR-003",
  "open-source": "OSS-001"
});

export async function loadCatalog() {
  return JSON.parse(await readFile(resolve(root, "verification/test-catalog.json"), "utf8"));
}

export async function resolveSuite(slug) {
  const id = suiteIds[slug];
  if (!id) return undefined;
  const catalog = await loadCatalog();
  return catalog.tests.find((test) => test.id === id);
}

export function runnerRoot() {
  return root;
}
