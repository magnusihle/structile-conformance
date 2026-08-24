import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const suiteIds = Object.freeze({
  "architecture-boundaries": "ARCH-001",
  "compose-smoke": "DEV-001",
  "agent-adapters": "HAR-001",
  "harness-policy": "HAR-003",
  "open-source": "OSS-001",
  "design-system": "DS-001"
});

export type SuiteSlug = keyof typeof suiteIds;

export interface ProtectedTest {
  id: string;
  gate: string;
  requirements: string[];
}

interface TestCatalog {
  tests: ProtectedTest[];
}

export async function loadCatalog(): Promise<TestCatalog> {
  return JSON.parse(await readFile(resolve(root, "verification/test-catalog.json"), "utf8"));
}

export async function resolveSuite(slug: string): Promise<ProtectedTest | undefined> {
  const id = suiteIds[slug as SuiteSlug];
  if (!id) return undefined;
  const catalog = await loadCatalog();
  return catalog.tests.find((test: ProtectedTest) => test.id === id);
}

export function runnerRoot(): string {
  return root;
}
