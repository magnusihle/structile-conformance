#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const ID = /^[A-Z][A-Z0-9]*-[0-9]{3}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA = /^[a-f0-9]{40,64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RAW_SHA256 = /^[a-f0-9]{64}$/;
const versions = new Set(["v0.1","v0.2","v0.3","v0.4","v0.5","v0.6","v0.7","v0.8","v0.9","v1.0"]);
const gates = new Set(["G0","G1","G2","G3","G4","G4A","G5","G6"]);
const priorities = new Set(["P0","P1","P2"]);
const waiverPolicies = new Set(["never","human-expiring"]);
const testKinds = new Set(["automated","automated-drill","statistical-automated"]);

export class ValidationError extends Error {
  constructor(errors) {
    super(`Planning validation failed with ${errors.length} error(s)`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

function exactKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value ?? {})) {
    if (!allowed.has(key)) errors.push(`${path}: unknown key ${key}`);
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function duplicateIds(items) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

function sameSet(a, b) {
  return a.length === b.length && a.every((value) => b.includes(value));
}

export function validateCatalogs(requirementsDoc, testsDoc, waiversDoc, now = new Date()) {
  const errors = [];

  if (requirementsDoc?.schemaVersion !== "1.0.0") errors.push("requirements: schemaVersion must be 1.0.0");
  if (!SEMVER.test(requirementsDoc?.catalogVersion ?? "")) errors.push("requirements: invalid catalogVersion");
  if (!Array.isArray(requirementsDoc?.requirements) || requirementsDoc.requirements.length === 0) errors.push("requirements: non-empty requirements array required");

  if (testsDoc?.schemaVersion !== "1.0.0") errors.push("tests: schemaVersion must be 1.0.0");
  if (!SEMVER.test(testsDoc?.catalogVersion ?? "")) errors.push("tests: invalid catalogVersion");
  if (!Array.isArray(testsDoc?.tests) || testsDoc.tests.length === 0) errors.push("tests: non-empty tests array required");

  if (waiversDoc?.schemaVersion !== "1.0.0") errors.push("waivers: schemaVersion must be 1.0.0");
  if (!Array.isArray(waiversDoc?.waivers)) errors.push("waivers: waivers array required");

  const requirements = requirementsDoc?.requirements ?? [];
  const tests = testsDoc?.tests ?? [];
  const waivers = waiversDoc?.waivers ?? [];

  for (const id of duplicateIds(requirements)) errors.push(`requirements: duplicate id ${id}`);
  for (const id of duplicateIds(tests)) errors.push(`tests: duplicate id ${id}`);

  const requirementById = new Map(requirements.map((item) => [item.id, item]));
  const testById = new Map(tests.map((item) => [item.id, item]));

  const requirementKeys = new Set(["id","title","statement","category","introducedIn","gate","priority","waiverPolicy","verification","notes"]);
  for (const requirement of requirements) {
    const path = `requirement ${requirement.id ?? "<missing>"}`;
    exactKeys(requirement, requirementKeys, path, errors);
    if (!ID.test(requirement.id ?? "")) errors.push(`${path}: invalid id`);
    if (!nonEmptyString(requirement.title) || requirement.title.length < 5) errors.push(`${path}: title too short`);
    if (!nonEmptyString(requirement.statement) || !/\bMUST(?: NOT)?\b/.test(requirement.statement)) errors.push(`${path}: normative statement must contain MUST or MUST NOT`);
    if (!nonEmptyString(requirement.category)) errors.push(`${path}: category required`);
    if (!versions.has(requirement.introducedIn)) errors.push(`${path}: invalid introducedIn`);
    if (!gates.has(requirement.gate)) errors.push(`${path}: invalid gate`);
    if (!priorities.has(requirement.priority)) errors.push(`${path}: invalid priority`);
    if (!waiverPolicies.has(requirement.waiverPolicy)) errors.push(`${path}: invalid waiverPolicy`);
    if (!Array.isArray(requirement.verification) || requirement.verification.length === 0) {
      errors.push(`${path}: at least one verification is required`);
    } else {
      if (new Set(requirement.verification).size !== requirement.verification.length) errors.push(`${path}: duplicate verification ids`);
      for (const testId of requirement.verification) {
        const test = testById.get(testId);
        if (!test) errors.push(`${path}: unknown verification ${testId}`);
        else if (!test.requirements?.includes(requirement.id)) errors.push(`${path}: ${testId} does not link back to ${requirement.id}`);
      }
    }
  }

  const testKeys = new Set(["id","title","gate","kind","command","environment","timeoutSeconds","oracle","evidenceArtifacts","independentRerun","requirements"]);
  for (const test of tests) {
    const path = `test ${test.id ?? "<missing>"}`;
    exactKeys(test, testKeys, path, errors);
    if (!ID.test(test.id ?? "")) errors.push(`${path}: invalid id`);
    if (!nonEmptyString(test.title)) errors.push(`${path}: title required`);
    if (!gates.has(test.gate)) errors.push(`${path}: invalid gate`);
    if (!testKinds.has(test.kind)) errors.push(`${path}: forbidden or unknown kind ${test.kind}`);
    if (!nonEmptyString(test.command)) errors.push(`${path}: executable command required`);
    if (!nonEmptyString(test.environment)) errors.push(`${path}: deterministic environment description required`);
    if (!Number.isInteger(test.timeoutSeconds) || test.timeoutSeconds <= 0) errors.push(`${path}: positive timeoutSeconds required`);
    if (!nonEmptyString(test.oracle)) errors.push(`${path}: deterministic oracle required`);
    if (/\b(llm|model)\s+judge\b/i.test(test.oracle) && test.kind !== "statistical-automated") errors.push(`${path}: LLM/model judge cannot be the deterministic oracle`);
    if (!Array.isArray(test.evidenceArtifacts) || test.evidenceArtifacts.length === 0 || test.evidenceArtifacts.some((v) => !nonEmptyString(v))) errors.push(`${path}: evidenceArtifacts required`);
    if (test.independentRerun !== true) errors.push(`${path}: independentRerun must be true`);
    if (!Array.isArray(test.requirements) || test.requirements.length === 0) {
      errors.push(`${path}: at least one requirement required`);
    } else {
      if (new Set(test.requirements).size !== test.requirements.length) errors.push(`${path}: duplicate requirement ids`);
      for (const requirementId of test.requirements) {
        const requirement = requirementById.get(requirementId);
        if (!requirement) errors.push(`${path}: unknown requirement ${requirementId}`);
        else if (!requirement.verification?.includes(test.id)) errors.push(`${path}: ${requirementId} does not link back to ${test.id}`);
      }
    }
  }

  const waiverKeys = new Set(["id","requirementId","testId","scope","reason","risk","compensatingControls","approver","issue","createdAt","expiresAt","removalPlan"]);
  const waiverIds = new Set();
  for (const waiver of waivers) {
    const path = `waiver ${waiver.id ?? "<missing>"}`;
    exactKeys(waiver, waiverKeys, path, errors);
    if (!nonEmptyString(waiver.id)) errors.push(`${path}: id required`);
    if (waiverIds.has(waiver.id)) errors.push(`${path}: duplicate id`);
    waiverIds.add(waiver.id);
    const requirement = requirementById.get(waiver.requirementId);
    const test = testById.get(waiver.testId);
    if (!requirement) errors.push(`${path}: unknown requirement ${waiver.requirementId}`);
    if (!test) errors.push(`${path}: unknown test ${waiver.testId}`);
    if (requirement?.waiverPolicy === "never") errors.push(`${path}: ${requirement.id} is non-waivable`);
    if (requirement && test && (!requirement.verification.includes(test.id) || !test.requirements.includes(requirement.id))) errors.push(`${path}: requirement/test pair is not traceable`);
    for (const key of ["scope","reason","risk","compensatingControls","approver","issue","removalPlan"]) {
      if (!nonEmptyString(waiver[key])) errors.push(`${path}: ${key} required`);
    }
    const created = new Date(waiver.createdAt);
    const expires = new Date(waiver.expiresAt);
    if (Number.isNaN(created.valueOf())) errors.push(`${path}: invalid createdAt`);
    if (Number.isNaN(expires.valueOf())) errors.push(`${path}: invalid expiresAt`);
    if (!Number.isNaN(expires.valueOf()) && expires <= now) errors.push(`${path}: expired`);
    if (!Number.isNaN(created.valueOf()) && !Number.isNaN(expires.valueOf()) && expires - created > 30 * 24 * 60 * 60 * 1000) errors.push(`${path}: duration exceeds 30 days`);
  }

  if (errors.length) throw new ValidationError(errors);
  return { requirements: requirements.length, tests: tests.length, waivers: waivers.length, errors: 0 };
}

export function validateEvidence(evidence, requirementsDoc, testsDoc, options = {}) {
  const errors = [];
  const test = testsDoc.tests.find((item) => item.id === evidence?.testId);
  const requirementIds = new Set(requirementsDoc.requirements.map((item) => item.id));
  if (evidence?.schemaVersion !== "1.0.0") errors.push("evidence: schemaVersion must be 1.0.0");
  if (!nonEmptyString(evidence?.evidenceId)) errors.push("evidence: evidenceId required");
  if (!test) errors.push(`evidence: unknown test ${evidence?.testId}`);
  if (!Array.isArray(evidence?.requirementIds) || evidence.requirementIds.length === 0) errors.push("evidence: requirementIds required");
  else {
    for (const id of evidence.requirementIds) if (!requirementIds.has(id)) errors.push(`evidence: unknown requirement ${id}`);
    if (test && !sameSet(evidence.requirementIds, test.requirements)) errors.push("evidence: requirementIds must exactly match protected test traceability");
  }
  if (!new Set(["passed","failed","skipped","timed-out","error"]).has(evidence?.status)) errors.push("evidence: invalid status");
  if (evidence?.status === "passed" && evidence?.exitCode !== 0) errors.push("evidence: passed status requires exitCode 0");
  if (evidence?.status !== "passed" && evidence?.exitCode === 0) errors.push("evidence: non-passed status cannot use exitCode 0");
  if (!nonEmptyString(evidence?.candidate?.repository)) errors.push("evidence: candidate repository required");
  if (!SHA.test(evidence?.candidate?.commitSha ?? "")) errors.push("evidence: invalid candidate commitSha");
  if (evidence?.candidate?.dirty !== false) errors.push("evidence: candidate must be clean");
  if (options.candidateSha && evidence?.candidate?.commitSha !== options.candidateSha) errors.push("evidence: candidate commit does not match requested commit");
  if (!nonEmptyString(evidence?.runner?.name) || !nonEmptyString(evidence?.runner?.version)) errors.push("evidence: runner name/version required");
  if (!SHA256.test(evidence?.runner?.imageDigest ?? "")) errors.push("evidence: invalid runner imageDigest");
  if (!SHA256.test(evidence?.runner?.testSourceDigest ?? "")) errors.push("evidence: invalid runner testSourceDigest");
  if (options.runnerDigest && evidence?.runner?.imageDigest !== options.runnerDigest) errors.push("evidence: runner digest does not match pinned digest");
  if (!nonEmptyString(evidence?.environment?.profile) || !SHA256.test(evidence?.environment?.configDigest ?? "")) errors.push("evidence: invalid environment profile/configDigest");
  const started = new Date(evidence?.startedAt);
  const finished = new Date(evidence?.finishedAt);
  if (Number.isNaN(started.valueOf()) || Number.isNaN(finished.valueOf()) || finished < started) errors.push("evidence: invalid start/finish timestamps");
  if (!Number.isInteger(evidence?.exitCode)) errors.push("evidence: integer exitCode required");
  if (!evidence?.measurements || typeof evidence.measurements !== "object" || Array.isArray(evidence.measurements)) errors.push("evidence: measurements object required");
  if (!Array.isArray(evidence?.artifacts)) errors.push("evidence: artifacts array required");
  else for (const artifact of evidence.artifacts) if (!nonEmptyString(artifact?.name) || !RAW_SHA256.test(artifact?.sha256 ?? "")) errors.push("evidence: invalid artifact name/hash");
  if (!nonEmptyString(evidence?.provenance?.ciRunId) || !nonEmptyString(evidence?.provenance?.workflowIdentity) || !nonEmptyString(evidence?.provenance?.attestationRef)) errors.push("evidence: complete provenance required");
  if (errors.length) throw new ValidationError(errors);
  return { testId: evidence.testId, status: evidence.status, requirements: evidence.requirementIds.length, errors: 0 };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadDefaultCatalogs() {
  return {
    requirements: await readJson(resolve(root, "requirements/requirements.json")),
    tests: await readJson(resolve(root, "verification/test-catalog.json")),
    waivers: await readJson(resolve(root, "requirements/waivers.json"))
  };
}

async function main() {
  const args = process.argv.slice(2);
  const evidenceIndex = args.indexOf("--evidence");
  const candidateIndex = args.indexOf("--candidate-sha");
  const runnerIndex = args.indexOf("--runner-digest");
  const catalogs = await loadDefaultCatalogs();
  const catalogResult = validateCatalogs(catalogs.requirements, catalogs.tests, catalogs.waivers);
  const result = { catalog: catalogResult };
  if (evidenceIndex >= 0) {
    if (!args[evidenceIndex + 1]) throw new ValidationError(["--evidence requires a JSON path"]);
    const evidence = await readJson(resolve(process.cwd(), args[evidenceIndex + 1]));
    result.evidence = validateEvidence(evidence, catalogs.requirements, catalogs.tests, {
      candidateSha: candidateIndex >= 0 ? args[candidateIndex + 1] : undefined,
      runnerDigest: runnerIndex >= 0 ? args[runnerIndex + 1] : undefined
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const payload = error instanceof ValidationError ? { error: error.message, details: error.errors } : { error: String(error?.stack ?? error) };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
}
