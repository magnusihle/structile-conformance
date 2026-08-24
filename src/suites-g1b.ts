/**
 * G1 protected suites, re-cut wave 2. Ported from the superseded `g1/protected-suites`
 * branch onto the hardened `g1-support.ts` shared module, appended in re-cut order: HAR-004
 * (graphify-policy) here; SPEC-002 (spec-migrations) and PKG-001 (package-matrix) are ported
 * in their own later PRs, not batched into this file.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { command, writeJson } from "./io.ts";
import type { SuiteContext, SuiteResult } from "./suites.ts";
import { assertDiscriminates, assertRejects, buildAndImport, requireExports, type AnyRecord } from "./g1-support.ts";

/* ----------------------------------------------------------------- HAR-004 */

/**
 * Graphify is context, never evidence (`docs/planning/agent-harness.md`). A code-only index
 * may accelerate discovery only while it provably matches the exact commit under review, and
 * an INFERRED edge can never on its own justify a change or satisfy a requirement.
 *
 * Suite HAR-004 (graphify-policy) verifies requirement HAR-009 (commit-pinned Graphify
 * context).
 */
export async function graphifyPolicy({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  const cases = String(options.cases ?? "").split(",").filter(Boolean).sort();
  assert.deepEqual(cases, ["current", "inferred", "missing", "stale"],
    "HAR-004 requires --cases current,stale,inferred,missing");

  const harness = await buildAndImport(candidate, "@structile/agent-harness", "packages/agent-harness");
  requireExports(harness, [
    "evaluateGraphifyIndex", "assertEdgeUsable", "GRAPHIFY_EXTRACTOR_VERSION", "GraphifyPolicyError"
  ], "@structile/agent-harness");

  const head = (await command("git", ["rev-parse", "HEAD"], { cwd: candidate })).stdout.trim();
  const other = "0".repeat(40);
  const index = (overrides: AnyRecord = {}): AnyRecord => ({
    repository: "https://github.com/magnusihle/structile",
    commitSha: head,
    extractorVersion: harness.GRAPHIFY_EXTRACTOR_VERSION,
    contentHash: `sha256:${"a".repeat(64)}`,
    edges: [],
    ...overrides
  });

  const outcomes: AnyRecord[] = [];
  const rejected: Array<{ label: string; rejected: true; error: string }> = [];

  // current: an index bound to this exact commit may inform context.
  const current = harness.evaluateGraphifyIndex(index(), { repository: "https://github.com/magnusihle/structile", commitSha: head });
  assert.equal(current.usable, true, "an index matching the candidate commit must be usable as context");
  assert.equal(current.evidence, false, "Graphify output is never evidence");
  outcomes.push({ case: "current", usable: true, evidence: false });

  // stale: a different commit, or a different extractor, is ignored rather than trusted.
  for (const [label, stale] of [
    ["commit", index({ commitSha: other })],
    ["repository", index({ repository: "https://github.com/magnusihle/other" })],
    ["extractor", index({ extractorVersion: `${String(harness.GRAPHIFY_EXTRACTOR_VERSION)}-old` })]
  ] as Array<[string, AnyRecord]>) {
    const verdict = harness.evaluateGraphifyIndex(stale, { repository: "https://github.com/magnusihle/structile", commitSha: head });
    assert.equal(verdict.usable, false, `a stale index (${label}) must be ignored`);
    assert.ok(String(verdict.reason ?? "").length > 0, "an ignored index must record why");
    outcomes.push({ case: "stale", variant: label, usable: false, reason: verdict.reason });
  }

  // An index without a verifiable content hash cannot be trusted to describe what it claims.
  for (const [label, hash] of [["absent", undefined], ["malformed", "not-a-hash"], ["wrong-algorithm", `md5:${"a".repeat(32)}`], ["empty", ""]] as Array<[string, unknown]>) {
    const verdict = harness.evaluateGraphifyIndex(index({ contentHash: hash }), { repository: "https://github.com/magnusihle/structile", commitSha: head });
    assert.equal(verdict.usable, false, `an index with a ${label} content hash must be ignored`);
    outcomes.push({ case: "stale", variant: `content-hash:${label}`, usable: false, reason: verdict.reason });
  }

  // missing: absence degrades to no context, never to an error or an assumption.
  for (const absent of [undefined, null]) {
    const verdict = harness.evaluateGraphifyIndex(absent, { repository: "https://github.com/magnusihle/structile", commitSha: head });
    assert.equal(verdict.usable, false, "a missing index must simply be unusable");
  }
  outcomes.push({ case: "missing", usable: false });

  // inferred: an unresolved edge cannot authorise anything; resolving it to source can.
  const resolved = { from: "packages/spec", to: "packages/catalog", kind: "RESOLVED", sourceRef: "packages/spec/src/validation.ts:1" };
  const inferred = { from: "packages/spec", to: "packages/catalog", kind: "INFERRED" };
  rejected.push(await assertDiscriminates(
    () => harness.assertEdgeUsable(resolved),
    () => harness.assertEdgeUsable(inferred),
    "GraphifyPolicyError", "inferred:unresolved-edge"));
  rejected.push(await assertRejects(
    () => harness.assertEdgeUsable({ ...inferred, sourceRef: "" }), "GraphifyPolicyError", "inferred:empty-source-ref"));
  // A malformed edge must be refused with the policy error, never a raw TypeError: a caller
  // must be able to tell a policy refusal from a crash.
  for (const [label, edge] of [["not-an-object", "packages/spec"], ["null", null], ["number", 42]] as Array<[string, unknown]>) {
    rejected.push(await assertRejects(() => harness.assertEdgeUsable(edge), "GraphifyPolicyError", `edge:${label}`));
  }
  // An unrecognised edge kind is not silently treated as resolved.
  rejected.push(await assertDiscriminates(
    () => harness.assertEdgeUsable(resolved),
    () => harness.assertEdgeUsable({ from: "a", to: "b", kind: "GUESSED", sourceRef: "x.ts:1" }),
    "GraphifyPolicyError", "edge:unknown-kind"));
  outcomes.push({ case: "inferred", resolvedAccepted: true, inferredRejected: true });

  // An index may never be presented as evidence, whatever its state.
  const currentIndex = harness.evaluateGraphifyIndex(index(), { repository: "https://github.com/magnusihle/structile", commitSha: head });
  assert.equal(currentIndex.evidence, false);

  await writeJson(resolve(artifactDir, "graphify-policy.json"), {
    candidateCommit: head, extractorVersion: harness.GRAPHIFY_EXTRACTOR_VERSION,
    cases: outcomes, rejections: rejected
  });
  return {
    measurements: { cases: cases.length, staleVariantsIgnored: 7, inferredRejections: rejected.length, treatedAsEvidence: 0 },
    artifactNames: ["graphify-policy.json"]
  };
}
