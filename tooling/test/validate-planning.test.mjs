import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError, loadDefaultCatalogs, validateCatalogs, validateEvidence } from "../validate-planning.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const clone = (value) => structuredClone(value);

test("authoritative catalogs pass meta-validation", async () => {
  const docs = await loadDefaultCatalogs();
  const result = validateCatalogs(docs.requirements, docs.tests, docs.waivers, new Date("2026-08-22T00:00:00Z"));
  assert.ok(result.requirements > 100);
  assert.ok(result.tests > 30);
  assert.equal(result.waivers, 0);
});

test("missing protected test reference fails", async () => {
  const docs = await loadDefaultCatalogs();
  const requirements = clone(docs.requirements);
  requirements.requirements[0].verification.push("NOPE-999");
  assert.throws(() => validateCatalogs(requirements, docs.tests, docs.waivers), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.ok(error.errors.some((item) => item.includes("unknown verification NOPE-999")));
    return true;
  });
});

test("one-way traceability fails", async () => {
  const docs = await loadDefaultCatalogs();
  const tests = clone(docs.tests);
  tests.tests.find((item) => item.id === "META-001").requirements = ["GOV-002"];
  assert.throws(() => validateCatalogs(docs.requirements, tests, docs.waivers), /Planning validation failed/);
});

test("manual or agent-attested test kind fails", async () => {
  const docs = await loadDefaultCatalogs();
  const tests = clone(docs.tests);
  tests.tests[0].kind = "agent-attestation";
  assert.throws(() => validateCatalogs(docs.requirements, tests, docs.waivers), (error) => {
    assert.ok(error.errors.some((item) => item.includes("forbidden or unknown kind")));
    return true;
  });
});

test("non-waivable and expired waivers fail", async () => {
  const docs = await loadDefaultCatalogs();
  const waivers = {
    schemaVersion: "1.0.0",
    waivers: [{
      id: "W-1", requirementId: "GOV-001", testId: "META-001", scope: "bad",
      reason: "test", risk: "high", compensatingControls: "none", approver: "human:test",
      issue: "https://example.invalid/1", createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-02T00:00:00Z", removalPlan: "remove"
    }]
  };
  assert.throws(() => validateCatalogs(docs.requirements, docs.tests, waivers, new Date("2026-08-22T00:00:00Z")), (error) => {
    assert.ok(error.errors.some((item) => item.includes("non-waivable")));
    assert.ok(error.errors.some((item) => item.includes("expired")));
    return true;
  });
});

test("example evidence validates and commit/digest mismatch fails", async () => {
  const docs = await loadDefaultCatalogs();
  const evidence = JSON.parse(await readFile(resolve(root, "examples/evidence.example.json"), "utf8"));
  const result = validateEvidence(evidence, docs.requirements, docs.tests, {
    candidateSha: evidence.candidate.commitSha,
    runnerDigest: evidence.runner.imageDigest
  });
  assert.equal(result.status, "passed");
  assert.throws(() => validateEvidence(evidence, docs.requirements, docs.tests, {
    candidateSha: "f".repeat(40), runnerDigest: `sha256:${"e".repeat(64)}`
  }), (error) => {
    assert.ok(error.errors.some((item) => item.includes("candidate commit does not match")));
    assert.ok(error.errors.some((item) => item.includes("runner digest does not match")));
    return true;
  });
});

test("skipped evidence cannot masquerade as success", async () => {
  const docs = await loadDefaultCatalogs();
  const evidence = JSON.parse(await readFile(resolve(root, "examples/evidence.example.json"), "utf8"));
  evidence.status = "skipped";
  assert.throws(() => validateEvidence(evidence, docs.requirements, docs.tests), (error) => {
    assert.ok(error.errors.some((item) => item.includes("non-passed status cannot use exitCode 0")));
    return true;
  });
});

