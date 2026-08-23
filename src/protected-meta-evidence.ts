#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildEvidence, candidateIdentity, writeEvidence } from "./evidence.ts";
import { command, sha256 } from "./io.ts";
import { loadDefaultCatalogs, validateEvidence } from "../tooling/validate-planning.mjs";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["CI", "HOME", "PATH"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

const candidate = resolve(requiredEnvironment("STRUCTILE_CORE_CHECKOUT"));
const outputRoot = resolve(requiredEnvironment("STRUCTILE_EVIDENCE_DIR"));
const identity = await candidateIdentity(candidate);
assert.equal(identity.dirty, false, "candidate must be a clean Git commit before META-001 evidence can be emitted");

const catalogs = await loadDefaultCatalogs();
const test = catalogs.tests.tests.find((entry: { id?: string }) => entry.id === "META-001");
assert.ok(test, "protected catalog must contain META-001");

const runDirectory = resolve(outputRoot, `${test.id}-${identity.commitSha.slice(0, 12)}-${Date.now()}`);
const artifactDirectory = resolve(runDirectory, "artifacts");
await mkdir(artifactDirectory, { recursive: true });

const startedAt = new Date().toISOString();
const environment = childEnvironment();

// Execute the protected catalog command exactly as declared before producing its
// two separately consumable evidence artifacts.
await command("npm", ["--prefix", "tooling", "test"], {
  cwd: candidate,
  env: environment,
  timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024
});

const testFiles = (await readdir(resolve(candidate, "tooling/test")))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => resolve(candidate, "tooling/test", name));
assert.ok(testFiles.length > 0, "META-001 requires protected meta-tests");

const tap = await command(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
  cwd: candidate,
  env: environment,
  timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024
});
const validation = await command(process.execPath, [resolve(candidate, "tooling/validate-planning.mjs")], {
  cwd: candidate,
  env: environment,
  timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024
});
const validationResult = JSON.parse(validation.stdout) as {
  catalog: { requirements: number; tests: number; waivers: number; errors: number };
};
assert.equal(validationResult.catalog.errors, 0);

await writeFile(resolve(artifactDirectory, "test-results.tap"), tap.stdout, { encoding: "utf8", flag: "wx" });
await writeFile(resolve(artifactDirectory, "meta-validation.json"), validation.stdout, { encoding: "utf8", flag: "wx" });

const finishedAt = new Date().toISOString();
const evidence = await buildEvidence({
  test,
  candidate,
  status: "passed",
  exitCode: 0,
  startedAt,
  finishedAt,
  measurements: validationResult.catalog,
  artifactDir: artifactDirectory,
  artifactNames: ["meta-validation.json", "test-results.tap"],
  configDigest: sha256(JSON.stringify({ command: "npm --prefix tooling test", environment: "pinned-node-clean-candidate" }))
});
validateEvidence(evidence, catalogs.requirements, catalogs.tests, {
  candidateSha: identity.commitSha,
  runnerDigest: requiredEnvironment("STRUCTILE_RUNNER_IMAGE_DIGEST")
});

const evidencePath = resolve(runDirectory, "evidence.json");
await writeEvidence(evidencePath, evidence);
process.stdout.write(`${JSON.stringify({ testId: test.id, status: "passed", exitCode: 0, evidence: evidencePath, authoritative: !evidence.measurements.localUnsigned })}\n`);
