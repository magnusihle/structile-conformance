/**
 * G1 protected suites, re-cut wave 2. Ported from the superseded `g1/protected-suites`
 * branch onto the hardened `g1-support.ts` shared module, appended in re-cut order: HAR-004
 * (graphify-policy), then SPEC-002 (spec-migrations); PKG-001 (package-matrix) is ported
 * in its own later PR, not batched into this file.
 */
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { command, readJson, writeJson } from "./io.ts";
import { runnerRoot } from "./catalog.ts";
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

/* ---------------------------------------------------------------- SPEC-002 */

/**
 * N/N-1 compatibility and rollback (SPEC-002/SPEC-003), rewritten for the released-majors
 * amendment (planning#1): before a second major specification version is actually
 * released, the compatibility matrix must truthfully report there is nothing to migrate
 * rather than simulate one against a synthetic major, and any unknown, future, fractional
 * or unavailable version must fail closed. The two-majors branch below reads off the same
 * `supported` set the one-major branch does, so it is not skipped code waiting for a
 * rewrite -- it engages, and gets exercised, the moment a second major genuinely ships.
 */
export async function specMigrations({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  assert.equal(options.matrix, "released", "SPEC-002 requires --matrix released");
  assert.ok(options.roundtrip !== undefined, "SPEC-002 requires --roundtrip");

  const spec = await buildAndImport(candidate, "@structile/spec", "packages/spec");
  requireExports(spec, [
    "SPEC_SCHEMA_VERSION", "SUPPORTED_SPEC_MAJORS", "compatibilityMatrix",
    "negotiateSpecVersion", "validateSpecification", "SpecificationError"
  ], "@structile/spec");

  const matrix = spec.compatibilityMatrix() as AnyRecord;
  const supported = [...(spec.SUPPORTED_SPEC_MAJORS as number[])].sort((a, b) => b - a);
  const current = supported[0] as number;
  const previous = supported.length > 1 ? (supported[1] as number) : null;

  // The matrix is the published claim; it must match what the code actually supports,
  // and only what actually released -- never a synthetic major.
  assert.equal(matrix.current, current, "the matrix must declare the current major");
  assert.equal(matrix.previous, previous, "the matrix must declare the previous major honestly");
  assert.deepEqual([...(matrix.supported as number[])].sort((a, b) => b - a), supported);

  const root = runnerRoot();
  const catalog = await readJson(resolve(root, "fixtures/spec/catalog.json"));
  const corpusDir = resolve(root, "fixtures/spec/migrations");
  const roundtrips: AnyRecord[] = [];
  const rejected: Array<{ label: string; rejected: true; error: string }> = [];

  // The corpus on disk must cover exactly the released majors -- never more. A v2.json
  // sitting in the corpus ahead of a real major-2 release would be exactly the fabricated
  // history SPEC-002 forbids, so its absence is asserted here, not assumed.
  const corpusFiles = (await readdir(corpusDir)).filter((name) => name.endsWith(".json")).sort();
  const expectedCorpusFiles = supported.map((major) => `v${major}.json`).sort();
  assert.deepEqual(corpusFiles, expectedCorpusFiles,
    "the migration corpus must contain exactly one fixture per released major, no synthetic majors");

  for (const major of supported) {
    const document = await readJson(resolve(corpusDir, `v${major}.json`));
    assert.equal(document.specVersion.major, major, `corpus v${major} must declare major ${major}`);
    spec.validateSpecification(document, { catalog });
  }

  if (previous === null) {
    // Nothing has released beyond the first major: migration and rollback are declared
    // not-applicable, and the matrix must not pretend otherwise.
    assert.deepEqual(matrix.migrations, [], "no migration may be declared before a second major exists");
    assert.equal(matrix.rollback, "not-yet-applicable", "rollback must be declared not-applicable before a second major exists");
  } else {
    requireExports(spec, ["migrateSpecification", "rollbackSpecification"], "@structile/spec");

    const declared = new Set((matrix.migrations as AnyRecord[]).map((m) => `${String(m.from)}->${String(m.to)}`));
    for (let index = 1; index < supported.length; index += 1) {
      const older = supported[index] as number;
      const newer = supported[index - 1] as number;
      assert.ok(declared.has(`${older}->${newer}`), `missing forward migration ${older}->${newer}`);
      assert.ok(declared.has(`${newer}->${older}`), `missing rollback migration ${newer}->${older}`);
    }
    assert.equal(matrix.rollback, "supported", "rollback must be supported once a previous major exists");

    const older = await readJson(resolve(corpusDir, `v${previous}.json`));

    // Forward, then back, must return the original document exactly.
    const forward = spec.migrateSpecification(older, { to: current, catalog });
    assert.equal(forward.specVersion.major, current, "migration must reach the requested major");
    spec.validateSpecification(forward, { catalog });
    const back = spec.rollbackSpecification(forward, { to: previous, catalog });
    assert.deepEqual(back, older, "forward then rollback must be lossless within the declared contract");
    roundtrips.push({ from: previous, to: current, lossless: true });

    // Deterministic: the same input yields byte-identical output.
    assert.deepEqual(spec.migrateSpecification(older, { to: current, catalog }), forward, "migration must be deterministic");
    // Idempotent: migrating an already-current document changes nothing.
    assert.deepEqual(spec.migrateSpecification(forward, { to: current, catalog }), forward, "migration must be idempotent");
    assert.deepEqual(spec.rollbackSpecification(older, { to: previous, catalog }), older, "rollback must be idempotent");
    roundtrips.push({ deterministic: true, idempotent: true });

    // Semantics are preserved: the same component instances survive the trip.
    const shape = (document: AnyRecord): string[] =>
      (document.pages as AnyRecord[]).flatMap((page) => (page.nodes as AnyRecord[]).map((node) => String(node.componentId))).sort();
    assert.deepEqual(shape(forward), shape(older), "migration must preserve the component instances");

    // Fail closed on a major outside the matrix, in both directions.
    rejected.push(await assertDiscriminates(
      () => spec.migrateSpecification(older, { to: current, catalog }),
      () => spec.migrateSpecification(older, { to: 999, catalog }),
      "SpecificationError", "migrate:unsupported-target"));
    rejected.push(await assertDiscriminates(
      () => spec.rollbackSpecification(forward, { to: previous, catalog }),
      () => spec.rollbackSpecification(forward, { to: 999, catalog }),
      "SpecificationError", "rollback:unsupported-target"));
  }

  // Fail closed on every version that is not a genuinely released major, regardless of how
  // many majors exist: unknown, future, fractional and unavailable versions must all be
  // refused, never accepted as though they were the next release.
  const control = (): unknown => spec.negotiateSpecVersion({ major: current, minor: 0 });
  rejected.push(await assertDiscriminates(control,
    () => spec.negotiateSpecVersion({ major: current + 1, minor: 0 }), "SpecificationError", "negotiate:future-major"));
  rejected.push(await assertDiscriminates(control,
    () => spec.negotiateSpecVersion({ major: current + 0.5, minor: 0 }), "SpecificationError", "negotiate:fractional-major"));
  rejected.push(await assertDiscriminates(control,
    () => spec.negotiateSpecVersion({ major: -1, minor: 0 }), "SpecificationError", "negotiate:unavailable-major"));
  rejected.push(await assertDiscriminates(control,
    () => spec.negotiateSpecVersion({ major: 999_999, minor: 0 }), "SpecificationError", "negotiate:unknown-major"));
  rejected.push(await assertDiscriminates(control,
    () => spec.negotiateSpecVersion(undefined), "SpecificationError", "negotiate:missing-specVersion"));
  rejected.push(await assertDiscriminates(control,
    () => spec.negotiateSpecVersion({}), "SpecificationError", "negotiate:empty-specVersion"));

  const branch = previous === null ? "single-major-not-applicable" : "n-and-n-minus-one";
  await writeJson(resolve(artifactDir, "migration-matrix.json"), {
    supported, current, previous, matrix, corpusFiles, branch
  });
  await writeJson(resolve(artifactDir, "roundtrip-diffs.json"), { roundtrips, rejections: rejected, differences: [] });

  return {
    measurements: {
      supportedMajors: supported.length, branch,
      roundtrips: roundtrips.length, rejections: rejected.length
    },
    artifactNames: ["migration-matrix.json", "roundtrip-diffs.json"]
  };
}
