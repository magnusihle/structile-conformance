#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

interface LanguagePolicy {
  schemaVersion: "1.0.0";
  policy: "typescript-only-authored-source";
  forbiddenExtensions: string[];
  ignoredDirectories: string[];
  protectedExceptions: string[];
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const policyPath = resolve(repositoryRoot, "language-policy.json");
const requiredForbiddenExtensions = [".cjs", ".js", ".jsx", ".mjs"];
const requiredIgnoredDirectories = [".git", "artifacts", "coverage", "dist", "evidence", "node_modules"];
// tooling/check-pr-size.mjs, task-ready.mjs and validate-task-contract.mjs are
// vendored from structile-planning and byte-for-byte verified in CI against
// delivery/planning-pin.sha256; they are not authored in this repository.
const approvedProtectedExceptions = ["tooling/check-pr-size.mjs", "tooling/task-ready.mjs", "tooling/test/validate-planning.test.mjs", "tooling/validate-planning.mjs", "tooling/validate-task-contract.mjs"];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parsePolicy(value: unknown): LanguagePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("language policy must be an object");
  const candidate = value as Partial<LanguagePolicy>;
  if (candidate.schemaVersion !== "1.0.0") throw new Error("unsupported language policy schema");
  if (candidate.policy !== "typescript-only-authored-source") throw new Error("unexpected language policy");
  if (!isStringArray(candidate.forbiddenExtensions) || !isStringArray(candidate.ignoredDirectories) || !isStringArray(candidate.protectedExceptions)) {
    throw new Error("language policy lists must contain only strings");
  }
  return candidate as LanguagePolicy;
}

function assertExactList(actual: readonly string[], expected: readonly string[], name: string): void {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${name} does not match the approved baseline`);
}

const policy = parsePolicy(JSON.parse(await readFile(policyPath, "utf8")));
assertExactList(policy.forbiddenExtensions, requiredForbiddenExtensions, "forbidden extensions");
assertExactList(policy.ignoredDirectories, requiredIgnoredDirectories, "ignored directories");
assertExactList(policy.protectedExceptions, approvedProtectedExceptions, "protected exceptions");
const ignoredDirectories = new Set(policy.ignoredDirectories);
const protectedExceptions = new Set(policy.protectedExceptions);
const forbiddenExtensions = new Set(policy.forbiddenExtensions);
const forbiddenFiles: string[] = [];

async function visit(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const repositoryPath = relative(repositoryRoot, path);
    if (forbiddenExtensions.has(extname(entry.name)) && !protectedExceptions.has(repositoryPath)) forbiddenFiles.push(repositoryPath);
  }
}

for (const exception of protectedExceptions) {
  if (!forbiddenExtensions.has(extname(exception))) throw new Error(`protected exception is not a forbidden source type: ${exception}`);
  const info = await stat(resolve(repositoryRoot, exception)).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`protected exception does not exist: ${exception}`);
}

await visit(repositoryRoot);
if (forbiddenFiles.length > 0) throw new Error(`authored JavaScript is forbidden:\n${forbiddenFiles.sort().join("\n")}`);
process.stdout.write(`${JSON.stringify({ valid: true, policy: policy.policy, protectedExceptions: [...protectedExceptions].sort() })}\n`);
