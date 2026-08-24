import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
 * N/N-1 compatibility and rollback. A stored specification outlives the code that wrote it,
 * so the runtime must read the previous major and be able to move a document forward and
 * back without changing what it means.
 */
export async function specMigrations({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  assert.equal(options.matrix, "current,previous", "SPEC-002 requires --matrix current,previous");
  assert.ok(options.roundtrip !== undefined, "SPEC-002 requires --roundtrip");

  const spec = await buildAndImport(candidate, "@structile/spec", "packages/spec");
  requireExports(spec, [
    "SPEC_SCHEMA_VERSION", "SUPPORTED_SPEC_MAJORS", "compatibilityMatrix",
    "migrateSpecification", "rollbackSpecification", "validateSpecification", "SpecificationError"
  ], "@structile/spec");

  const matrix = spec.compatibilityMatrix() as AnyRecord;
  const supported = [...(spec.SUPPORTED_SPEC_MAJORS as number[])].sort((a, b) => b - a);
  const current = supported[0] as number;
  const previous = supported.length > 1 ? (supported[1] as number) : null;

  // The matrix is the published claim; it must match what the code actually supports.
  assert.equal(matrix.current, current, "the matrix must declare the current major");
  assert.equal(matrix.previous, previous, "the matrix must declare the previous major honestly");
  assert.deepEqual([...(matrix.supported as number[])].sort((a, b) => b - a), supported);
  assert.ok(previous !== null,
    "SPEC-002 requires a previous major to exist; a runtime that supports only one major " +
    "cannot demonstrate N/N-1 compatibility, and declaring the requirement met would be false");

  // Every supported adjacent pair needs a declared migration in both directions.
  const declared = new Set((matrix.migrations as AnyRecord[]).map((m) => `${String(m.from)}->${String(m.to)}`));
  for (let index = 1; index < supported.length; index += 1) {
    const older = supported[index] as number;
    const newer = supported[index - 1] as number;
    assert.ok(declared.has(`${older}->${newer}`), `missing forward migration ${older}->${newer}`);
    assert.ok(declared.has(`${newer}->${older}`), `missing rollback migration ${newer}->${older}`);
  }
  assert.equal(matrix.rollback, "supported", "rollback must be supported once a previous major exists");

  const root = runnerRoot();
  const catalog = await readJson(resolve(root, "fixtures/spec/catalog.json"));
  const corpusDir = resolve(root, "fixtures/spec/migrations");
  const roundtrips: AnyRecord[] = [];
  const rejected: Array<{ label: string; rejected: true; error: string }> = [];

  for (const major of supported) {
    const document = await readJson(resolve(corpusDir, `v${major}.json`));
    assert.equal(document.specVersion.major, major, `corpus v${major} must declare major ${major}`);
    spec.validateSpecification(document, { catalog });
  }

  const older = await readJson(resolve(corpusDir, `v${previous}.json`));
  const newer = await readJson(resolve(corpusDir, `v${current}.json`));

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

  await writeJson(resolve(artifactDir, "migration-matrix.json"), {
    supported, current, previous, matrix, declaredMigrations: [...declared].sort()
  });
  await writeJson(resolve(artifactDir, "roundtrip-diffs.json"), { roundtrips, rejections: rejected, differences: [] });

  return {
    measurements: {
      supportedMajors: supported.length, roundtrips: roundtrips.length,
      losslessRoundtrips: 1, deterministic: true, idempotent: true, rejections: rejected.length
    },
    artifactNames: ["migration-matrix.json", "roundtrip-diffs.json"]
  };
}

/* ----------------------------------------------------------------- PKG-001 */

/**
 * Pinned versioned distribution (ARC-003/ARC-004). A platform release must not be able to
 * change a deployed product silently, which means exact versions, a frozen lockfile, no
 * floating ranges anywhere, and a published compatibility matrix a product can pin against.
 */
export async function packageMatrix({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  assert.equal(options.schema, "current,previous", "PKG-001 requires --schema current,previous");
  assert.ok(options["frozen-lockfile"] !== undefined, "PKG-001 requires --frozen-lockfile");

  const boundaries = await readJson(resolve(candidate, "architecture/package-boundaries.json"));
  const rootManifest = await readJson(resolve(candidate, "package.json"));
  const lock = await readJson(resolve(candidate, "package-lock.json"));

  const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  const findings: AnyRecord[] = [];
  const packages: AnyRecord[] = [];

  // Every declared dependency, in every workspace, must be an exact version. A caret or
  // tilde is exactly the mechanism by which a platform release reaches a deployed product.
  const manifests: Array<[string, AnyRecord]> = [["package.json", rootManifest]];
  for (const boundary of boundaries.packages as AnyRecord[]) {
    manifests.push([`${String(boundary.path)}/package.json`, await readJson(resolve(candidate, String(boundary.path), "package.json"))]);
  }
  for (const [path, manifest] of manifests) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries((manifest[field] ?? {}) as Record<string, string>)) {
        if (!EXACT.test(range)) findings.push({ path, field, name, range, issue: "not an exact version" });
      }
    }
    if (path !== "package.json") {
      if (manifest.private !== true) findings.push({ path, issue: "must stay private until a signed release publishes it" });
      if (typeof manifest.version !== "string" || !EXACT.test(manifest.version)) {
        findings.push({ path, issue: "package version must be exact semver" });
      }
      packages.push({ name: manifest.name, version: manifest.version, private: manifest.private === true });
    }
  }
  assert.deepEqual(findings, [], "every dependency and package version must be exactly pinned");

  // The lockfile must be complete and internally consistent with the manifests.
  assert.ok(Number(lock.lockfileVersion) >= 3, "a modern lockfile is required");
  assert.equal(lock.name, rootManifest.name);
  const locked = (lock.packages ?? {}) as Record<string, AnyRecord>;
  const unresolved = Object.entries(locked)
    .filter(([path, entry]) => path.startsWith("node_modules/") && !entry.link && (!entry.version || !entry.resolved))
    .map(([path]) => path);
  assert.deepEqual(unresolved, [], "every locked dependency needs a resolved version");

  // `npm ci` must succeed without mutating the lockfile: that is what "frozen" means.
  const before = await readFile(resolve(candidate, "package-lock.json"), "utf8");
  await command("npm", ["ci", "--ignore-scripts"], { cwd: candidate, timeout: 600_000 });
  const after = await readFile(resolve(candidate, "package-lock.json"), "utf8");
  assert.equal(after, before, "npm ci must not rewrite the lockfile");

  // A product pins against the specification compatibility matrix, so it must be published
  // and must name both supported majors.
  const spec = await buildAndImport(candidate, "@structile/spec", "packages/spec");
  const matrix = spec.compatibilityMatrix() as AnyRecord;
  assert.ok(Array.isArray(matrix.supported) && (matrix.supported as number[]).length >= 2,
    "PKG-001 requires current and previous schema majors to be installable; " +
    "a single supported major cannot demonstrate N/N-1 distribution");
  assert.equal(matrix.current, spec.SPEC_SCHEMA_VERSION.major);

  // Northstar consumes pinned releases; its lock contract must demand immutable digests.
  const reference = process.env.STRUCTILE_NORTHSTAR_CHECKOUT;
  assert.ok(reference, "STRUCTILE_NORTHSTAR_CHECKOUT must identify the consuming product");
  const lockSchema = await readJson(resolve(reference, "bootstrap/release-lock.schema.json"));
  const conformance = lockSchema.properties.conformance.properties;
  assert.equal(conformance.runnerImageDigest.pattern, "^sha256:[a-f0-9]{64}$", "the runner must be pinned by digest");
  assert.equal(conformance.testSourceDigest.pattern, "^sha256:[a-f0-9]{64}$");
  assert.equal(lockSchema.properties.core.properties.release.pattern, "^v[0-9]+\\.[0-9]+\\.[0-9]+$");
  const requiredPackages = await readJson(resolve(reference, "bootstrap/required-packages.json"));
  const declared = new Set((boundaries.packages as AnyRecord[]).map((entry) => String(entry.name)));
  const unknown = (requiredPackages.packages as string[]).filter((name) => !declared.has(name));
  assert.deepEqual(unknown, [], "the product may only require declared platform packages");

  await writeJson(resolve(artifactDir, "package-matrix.json"), {
    packages, lockfileVersion: lock.lockfileVersion, frozen: true,
    supportedSchemaMajors: matrix.supported, requiredByProduct: requiredPackages.packages
  });
  await writeJson(resolve(artifactDir, "provenance-report.json"), {
    note: "signature and provenance verification is performed by the protected workflow against published artifacts",
    releasePinning: { runnerImageDigest: "sha256", testSourceDigest: "sha256", corePackages: "exact semver" },
    floatingRangeFindings: findings
  });

  return {
    measurements: {
      packages: packages.length, floatingRanges: 0, unresolvedLockEntries: 0,
      lockfileRewritten: false, supportedSchemaMajors: (matrix.supported as number[]).length
    },
    artifactNames: ["package-matrix.json", "provenance-report.json"]
  };
}
