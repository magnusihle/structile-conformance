#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveSuite, suiteIds } from "./catalog.mjs";
import { configDigest, suites } from "./suites.mjs";
import { buildEvidence, candidateIdentity, writeEvidence } from "./evidence.mjs";
import { loadDefaultCatalogs, validateEvidence } from "../tooling/validate-planning.mjs";
import { readJson } from "./io.mjs";

function usage() {
  process.stderr.write("Usage: platform-conformance list | run <suite> [--candidate PATH] [--evidence-dir PATH] | verify-evidence <path> [--candidate-sha SHA] [--runner-digest DIGEST]\n");
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current?.startsWith("--")) throw new Error(`unexpected argument ${current}`);
    const key = current.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return options;
}

async function runSuite(slug, rawOptions) {
  const test = await resolveSuite(slug);
  const suite = suites[slug];
  if (!test || !suite) throw new Error(`unknown or unimplemented suite ${slug}`);
  const candidate = resolve(String(rawOptions.candidate ?? process.cwd()));
  const identity = await candidateIdentity(candidate);
  if (identity.dirty) throw new Error("candidate must be a clean Git commit before evidence can be emitted");
  const outputRoot = resolve(String(rawOptions["evidence-dir"] ?? resolve(candidate, "evidence")));
  const runDirectory = resolve(outputRoot, `${test.id}-${identity.commitSha.slice(0, 12)}-${Date.now()}`);
  const artifactDir = resolve(runDirectory, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const startedAt = new Date().toISOString();
  let status = "passed";
  let exitCode = 0;
  let result = { measurements: {}, artifactNames: [] };
  try {
    result = await suite({ candidate, artifactDir, options: rawOptions });
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      status = "failed";
      exitCode = 1;
    } else {
      status = "error";
      exitCode = 2;
    }
    result = { measurements: { error: String(error?.message ?? error) }, artifactNames: [] };
  }
  const finishedAt = new Date().toISOString();
  const evidence = await buildEvidence({
    test, candidate, status, exitCode, startedAt, finishedAt,
    measurements: result.measurements, artifactDir, artifactNames: result.artifactNames,
    configDigest: configDigest(slug, rawOptions)
  });
  const evidencePath = resolve(runDirectory, "evidence.json");
  await writeEvidence(evidencePath, evidence);
  process.stdout.write(`${JSON.stringify({ testId: test.id, status, exitCode, evidence: evidencePath, authoritative: !evidence.measurements.localUnsigned })}\n`);
  return exitCode;
}

async function verifyEvidence(path, rawOptions) {
  const catalogs = await loadDefaultCatalogs();
  const evidence = await readJson(resolve(path));
  const result = validateEvidence(evidence, catalogs.requirements, catalogs.tests, {
    candidateSha: rawOptions["candidate-sha"],
    runnerDigest: rawOptions["runner-digest"]
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main() {
  const [command, subject, ...rest] = process.argv.slice(2);
  if (command === "list") {
    process.stdout.write(`${JSON.stringify(Object.entries(suiteIds).map(([suite, testId]) => ({ suite, testId })))}\n`);
    return;
  }
  if (command === "run" && subject) {
    process.exitCode = await runSuite(subject, parseOptions(rest));
    return;
  }
  if (command === "verify-evidence" && subject) {
    await verifyEvidence(subject, parseOptions(rest));
    return;
  }
  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
  process.exitCode = 2;
});
