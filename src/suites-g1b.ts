/**
 * G1 protected suites, re-cut wave 2. Ported from the superseded `g1/protected-suites`
 * branch onto the hardened `g1-support.ts` shared module, appended in re-cut order: HAR-004
 * (graphify-policy), SPEC-002 (spec-migrations), PKG-001 (package-matrix), then DEL-001
 * (delivery-guardrails, a fresh suite with no salvage source).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { command, readJson, sha256, writeJson } from "./io.ts";
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

/* ----------------------------------------------------------------- PKG-001 */

/**
 * Pinned versioned distribution (ARC-003/ARC-004), rewritten for the released-majors
 * amendment (planning#1): the salvage suite at `origin/g1/protected-suites:src/suites-g1b.ts`
 * L213-301 asserted unconditionally that the published compatibility matrix names two
 * installable schema majors ("a single supported major cannot demonstrate N/N-1
 * distribution"). That presupposes a released major 2, which does not exist. The amended
 * catalog oracle (`verification/test-catalog.json`, PKG-001) reads: "every released
 * supported schema major installs and runs (current only before a second major exists;
 * current and N-1 thereafter)". The rewrite below branches on `previous`, exactly as
 * SPEC-002 does: before a second major ships, the matrix must truthfully declare only the
 * current major installable, and demanding a second would itself be the fabrication the
 * amendment forbids; once a second major genuinely releases, both must be installable and
 * the matrix must name them. Everything else -- exact-pinning, frozen-lockfile and
 * provenance enforcement -- is unaffected by the amendment and is carried unchanged.
 */
export async function packageMatrix({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  assert.equal(options.schema, "released", "PKG-001 requires --schema released");
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
  // and must name every genuinely released major -- never more, never fewer.
  const spec = await buildAndImport(candidate, "@structile/spec", "packages/spec");
  const matrix = spec.compatibilityMatrix() as AnyRecord;
  const supported = [...(matrix.supported as number[])].sort((a, b) => b - a);
  const current = supported[0] as number;
  const previous = supported.length > 1 ? (supported[1] as number) : null;
  assert.equal(matrix.current, spec.SPEC_SCHEMA_VERSION.major);
  assert.equal(matrix.current, current, "the matrix must declare the current major");
  assert.equal(matrix.previous, previous, "the matrix must declare the previous major honestly");

  if (previous === null) {
    // Nothing has released beyond the first major: only the current major may be declared
    // installable. Requiring a second here would demand a fabricated schema major exactly
    // as the amendment forbids.
    assert.deepEqual(supported, [current],
      "before a second schema major exists, the matrix may declare only the current major installable");
  } else {
    // A second major has genuinely released: both it and the current major must be
    // installable, and the matrix must name both -- this is the N/N-1 distribution ARC-004
    // requires once there is a previous major to distribute against.
    assert.ok(supported.includes(current) && supported.includes(previous),
      "PKG-001 requires both the current and previously released schema majors to be installable");
  }

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

  const branch = previous === null ? "single-major-not-applicable" : "n-and-n-minus-one";
  await writeJson(resolve(artifactDir, "package-matrix.json"), {
    packages, lockfileVersion: lock.lockfileVersion, frozen: true,
    supportedSchemaMajors: supported, current, previous, branch,
    requiredByProduct: requiredPackages.packages
  });
  await writeJson(resolve(artifactDir, "provenance-report.json"), {
    note: "signature and provenance verification is performed by the protected workflow against published artifacts",
    releasePinning: { runnerImageDigest: "sha256", testSourceDigest: "sha256", corePackages: "exact semver" },
    floatingRangeFindings: findings
  });

  return {
    measurements: {
      packages: packages.length, floatingRanges: 0, unresolvedLockEntries: 0,
      lockfileRewritten: false, supportedSchemaMajors: supported.length, branch
    },
    artifactNames: ["package-matrix.json", "provenance-report.json"]
  };
}

/* ----------------------------------------------------------------- DEL-001 */

/**
 * Delivery guardrail enforcement (fresh suite, no salvage source). Verifies DEL-001/002/003 by
 * exercising the candidate's vendored `tooling/task-ready`, `tooling/check-pr-size.mjs` and
 * (oracle-first, same posture as HAR-004) `tooling/verify-mechanical.mjs` against synthetic
 * scenarios in throwaway sandboxes -- never against the candidate's own repository state. The
 * mechanical-reproduction clause is probed behaviorally, via a generic `{ generator, outputs }`
 * contract never pinned to one implementation's bytes; the candidate does not yet vendor it, a
 * genuine gap, not a suite defect. See docs/qualification/DEL-001.md.
 */

/** Pinned from planning authority (structile-planning@f2fc9327bd22f382d4d269ac45b5b1d9ccbb78ed,
 * the lineage architecture/planning-inputs.lock.json already trusts); candidate-independent. */
const CANONICAL_DELIVERY_TOOLING_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "tooling/task-ready": "8550948fe663b75f2bfa4dcbcd98d44a8930144b9377d3c28cc84a11a2c0794f",
  "tooling/task-ready.mjs": "883fa1476df45d38c58cf957e567687404d4e91d23cc409147dc38929d28388b",
  "tooling/validate-task-contract.mjs": "88a5a5eee8d8e12cb3497564c5094d0b0e57c69e824d44ffb3c32e43c835d2ab",
  "tooling/check-pr-size.mjs": "1bb373ee36b51c24f43f15f8d98bf36ba87137b2b74d2e6f39f64ea992dac5b2"
});

async function sandboxGit(dir: string, ...args: string[]): Promise<string> {
  return (await command("git", args, { cwd: dir })).stdout;
}

async function sandboxCommit(dir: string, message: string): Promise<void> {
  await sandboxGit(dir, "add", "-A");
  await sandboxGit(dir, "commit", "-q", "-m", message);
}

async function initSandbox(root: string, name: string): Promise<string> {
  const dir = resolve(root, name);
  await mkdir(resolve(dir, "delivery/tasks"), { recursive: true });
  await mkdir(resolve(dir, "scratch"), { recursive: true });
  await writeFile(resolve(dir, "README.md"), "sandbox\n");
  await sandboxGit(dir, "init", "-q");
  await sandboxGit(dir, "config", "user.email", "conformance@example.com");
  await sandboxGit(dir, "config", "user.name", "conformance");
  await sandboxCommit(dir, "init");
  return dir;
}

/** Writes and commits a task contract (sensible defaults, overridable) as its own commit. */
async function addContract(dir: string, overrides: AnyRecord = {}): Promise<void> {
  const baseCommit = (await sandboxGit(dir, "rev-parse", "HEAD")).trim();
  await writeJson(resolve(dir, "delivery/tasks/DEL-001-T01.json"), {
    id: "DEL-001-T01",
    behavior: "Adds a synthetic probe fixture for the DEL-001 delivery-guardrails suite.",
    gate: "G1", requirements: ["DEL-001"], protectedTests: ["DEL-001"], baseCommit,
    runnerDigest: `sha256:${"a".repeat(64)}`, testSourceDigest: `sha256:${"b".repeat(64)}`,
    allowedPaths: ["scratch/**"], commands: ["true"], owner: "conformance-probe",
    escalation: "spec-checkpoint", localArtifacts: ["scratch/report.json"],
    budget: { maxLines: 50, maxFiles: 5 }, ...overrides
  });
  await sandboxCommit(dir, "add task contract");
}

/** Run a tool expected to sometimes exit non-zero; captures the outcome instead of throwing. */
async function tryRun(program: string, args: readonly string[], options: AnyRecord = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await command(program, args, options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

export async function deliveryGuardrails({ candidate, artifactDir }: SuiteContext): Promise<SuiteResult> {
  const taskReadyEntry = resolve(candidate, "tooling/task-ready");
  const checkPrSizePath = resolve(candidate, "tooling/check-pr-size.mjs");
  const mechanicalPath = resolve(candidate, "tooling/verify-mechanical.mjs");

  // DEL-003: the entry point must exist at the pinned path and be directly executable.
  const entryStat = await stat(taskReadyEntry);
  assert.ok((entryStat.mode & 0o111) !== 0, "tooling/task-ready must be executable (DEL-003)");

  // Vendored tooling must byte-match the planning-pinned canonical source. Collected now but
  // asserted only at the very end: three of the four pinned files are also exactly what the
  // behavioral probes below exercise, so asserting here would fail-fast on hash mismatch alone,
  // masking whether a logic regression is *independently* caught by its own behavioral probe --
  // exactly the distinction mutation testing needs to see.
  const vendorMismatches: AnyRecord[] = [];
  for (const [path, expected] of Object.entries(CANONICAL_DELIVERY_TOOLING_SHA256)) {
    const actual = sha256(await readFile(resolve(candidate, path)));
    if (actual !== expected) vendorMismatches.push({ path, expected, actual });
  }

  const root = await mkdtemp(resolve(tmpdir(), "structile-del001-"));

  // task-ready: control plus one isolated violation per scenario, so each failure attributes to
  // exactly one cause. Run as the real ./tooling/task-ready entry point (DEL-003), not a helper.
  const taskReadyOutcomes: AnyRecord[] = [];
  const probeTaskReady = async (dir: string, label: string, taskId: string, expectPass: boolean, pattern?: RegExp): Promise<{ stdout: string }> => {
    const result = await tryRun(taskReadyEntry, [taskId, "--repo", dir]);
    if (expectPass) assert.equal(result.code, 0, `${label}: expected task-ready to pass, got exit ${result.code}\n${result.stderr}`);
    else {
      assert.notEqual(result.code, 0, `${label}: must fail closed`);
      if (pattern) assert.match(result.stderr, pattern, `${label}: unexpected failure reason`);
    }
    taskReadyOutcomes.push({ label, code: result.code, passed: result.code === 0 });
    return result;
  };

  const controlDir = await initSandbox(root, "control");
  await addContract(controlDir);
  await writeJson(resolve(controlDir, "scratch/report.json"), { ok: true });
  await sandboxCommit(controlDir, "in-scope change");
  const control = await probeTaskReady(controlDir, "control: valid contract, in-scope change", "DEL-001-T01", true);
  assert.match(control.stdout, /ready\./);
  // A green task-ready run is never release evidence: plain, non-machine-readable text only.
  assert.match(control.stdout, /Advisory only — not evidence; only the protected verifier produces evidence\./,
    "a green task-ready run must say plainly it is not evidence (DEL-003)");
  assert.throws(() => JSON.parse(control.stdout), "a green task-ready run must not be machine-parseable as an evidence envelope");

  await probeTaskReady(controlDir, "nonexistent task id", "NOPE-999-T99", false, /cannot read delivery\/tasks\/NOPE-999-T99\.json/);

  const schemaCases: ReadonlyArray<readonly [string, AnyRecord, RegExp]> = [
    ["missing budget", { budget: undefined }, /budget must be an object/],
    ["invalid baseCommit format", { baseCommit: "not-a-sha" }, /baseCommit must be a 40-hex commit SHA/],
    ["missing owner", { owner: "" }, /owner must name the approving human/]
  ];
  for (const [label, override, pattern] of schemaCases) {
    const dir = await initSandbox(root, `schema-${label.replace(/\s+/g, "-")}`);
    await addContract(dir, override);
    await probeTaskReady(dir, `schema violation: ${label}`, "DEL-001-T01", false, pattern);
  }

  const oosDir = await initSandbox(root, "out-of-scope");
  await addContract(oosDir);
  await writeJson(resolve(oosDir, "scratch/report.json"), { ok: true });
  await writeFile(resolve(oosDir, "outside.txt"), "not allowed\n");
  await sandboxCommit(oosDir, "touch a path outside allowedPaths");
  await probeTaskReady(oosDir, "diff touches a path outside allowedPaths", "DEL-001-T01", false, /out of scope: outside\.txt/);

  const bigDir = await initSandbox(root, "oversized");
  await addContract(bigDir, { budget: { maxLines: 5, maxFiles: 5 } });
  await writeFile(resolve(bigDir, "scratch/big.txt"), `${Array.from({ length: 50 }, (_, index) => index).join("\n")}\n`);
  await writeJson(resolve(bigDir, "scratch/report.json"), { ok: true });
  await sandboxCommit(bigDir, "exceed the declared line budget");
  await probeTaskReady(bigDir, "diff exceeds the declared line budget", "DEL-001-T01", false, /gross churn \d+ lines exceeds budget 5/);

  const modDir = await initSandbox(root, "contract-modified");
  await addContract(modDir);
  await writeJson(resolve(modDir, "scratch/report.json"), { ok: true });
  await sandboxCommit(modDir, "in-scope change");
  const contractPath = resolve(modDir, "delivery/tasks/DEL-001-T01.json");
  const widened = JSON.parse(await readFile(contractPath, "utf8")) as AnyRecord;
  widened.behavior = `${String(widened.behavior)} Modified after baseCommit.`;
  await writeFile(contractPath, JSON.stringify(widened));
  await sandboxCommit(modDir, "modify the task contract after baseCommit");
  await probeTaskReady(modDir, "task contract modified after baseCommit", "DEL-001-T01", false,
    /task contract must be introduced by exactly one approved commit after baseCommit and never modified/);

  // check-pr-size: the hard ceilings (DEL-002), independent of task-ready's per-contract budgets.
  const sizeOutcomes: AnyRecord[] = [];
  const sizeCases: ReadonlyArray<readonly [string, boolean, (dir: string) => Promise<void>]> = [
    ["within budget", true, async (dir) => writeFile(resolve(dir, "scratch/small.txt"), "a change\n")],
    ["exceeds the 500-line ceiling", false, async (dir) =>
      writeFile(resolve(dir, "scratch/big.txt"), `${Array.from({ length: 600 }, (_, index) => index).join("\n")}\n`)],
    ["exceeds the 10-file ceiling", false, async (dir) => {
      for (let index = 0; index < 11; index += 1) await writeFile(resolve(dir, `scratch/file-${index}.txt`), "x\n");
    }]
  ];
  for (const [label, expectPass, setup] of sizeCases) {
    const dir = await initSandbox(root, `check-pr-size-${label.replace(/\s+/g, "-")}`);
    const base = (await sandboxGit(dir, "rev-parse", "HEAD")).trim();
    await setup(dir);
    await sandboxCommit(dir, label);
    const result = await tryRun(process.execPath, [checkPrSizePath, base], { cwd: dir });
    if (expectPass) assert.equal(result.code, 0, `${label}: expected check-pr-size to pass\n${result.stderr}`);
    else {
      assert.notEqual(result.code, 0, `${label}: expected check-pr-size to fail closed`);
      assert.match(result.stderr, /DEL-002/);
    }
    sizeOutcomes.push({ label, code: result.code, passed: result.code === 0 });
  }

  // Mechanical-PR byte-for-byte reproduction (DEL-002), oracle-first: capability presence, then
  // fail-closed/pass-on-reproduce behavior via a generic { generator, outputs } contract.
  const mechanicalPresent = existsSync(mechanicalPath);
  assert.ok(mechanicalPresent,
    "tooling/verify-mechanical.mjs must exist and verify mechanical-PR byte-for-byte reproduction (DEL-002); " +
    "this capability is not yet vendored by this candidate (see docs/qualification/DEL-001.md follow-ups)");
  const mechanical = await import(`${pathToFileURL(mechanicalPath).href}?conformance=${Date.now()}`) as AnyRecord;
  requireExports(mechanical, ["verifyMechanicalReproduction"], "tooling/verify-mechanical.mjs");

  const generatorSource = "import{readFileSync,writeFileSync,mkdirSync}from\"node:fs\";mkdirSync(\"output\",{recursive:true});" +
    "writeFileSync(\"output/generated.txt\",readFileSync(\"source.txt\",\"utf8\").toUpperCase());";
  const mechanicalCases: ReadonlyArray<readonly [string, string | undefined, string, boolean, string | undefined]> = [
    ["reproduces exactly", "HELLO WORLD", "node generate.mjs", true, undefined],
    ["drifted output", "HAND EDITED", "node generate.mjs", false, "regenerated output differs"],
    ["missing declared output", undefined, "node generate.mjs", false, "missing declared output"],
    ["generator fails", "HELLO WORLD", "node does-not-exist.mjs", false, "generator failed"]
  ];
  const mechanicalOutcomes: AnyRecord[] = [];
  for (const [label, content, generator, expectReproduced, messageFragment] of mechanicalCases) {
    const dir = resolve(root, `mechanical-${label.replace(/\s+/g, "-")}`);
    await mkdir(resolve(dir, "output"), { recursive: true });
    await writeFile(resolve(dir, "source.txt"), "hello world");
    await writeFile(resolve(dir, "generate.mjs"), generatorSource);
    if (content !== undefined) await writeFile(resolve(dir, "output/generated.txt"), content);
    const outcome = mechanical.verifyMechanicalReproduction({ generator, outputs: ["output/generated.txt"] }, dir) as AnyRecord;
    assert.equal(outcome.reproduced, expectReproduced, `${label}: reproduced must be ${expectReproduced}`);
    if (messageFragment) assert.ok(String(outcome.mismatches?.[0] ?? "").includes(messageFragment), `${label}: unexpected mismatch reason`);
    mechanicalOutcomes.push({ label, reproduced: outcome.reproduced, mismatches: outcome.mismatches });
  }

  // Asserted last, deliberately: see the comment where vendorMismatches is collected above.
  assert.deepEqual(vendorMismatches, [], "vendored delivery tooling must byte-match the planning-pinned canonical source");

  await writeJson(resolve(artifactDir, "guardrail-report.json"), {
    entryPoint: { path: "tooling/task-ready", executable: true },
    vendoredToolingIntegrity: { pinned: CANONICAL_DELIVERY_TOOLING_SHA256, mismatches: vendorMismatches },
    taskReadyProbes: taskReadyOutcomes,
    checkPrSizeProbes: sizeOutcomes,
    neverEvidence: { controlStdout: control.stdout.trim(), machineParseable: false },
    mechanicalReproduction: { capabilityPresent: mechanicalPresent, probes: mechanicalOutcomes }
  });

  return {
    measurements: {
      taskReadyProbes: taskReadyOutcomes.length,
      taskReadyFailClosed: taskReadyOutcomes.filter((outcome) => !outcome.passed).length,
      checkPrSizeProbes: sizeOutcomes.length,
      vendoredToolingMismatches: vendorMismatches.length,
      mechanicalReproductionCapabilityPresent: mechanicalPresent,
      mechanicalReproductionProbes: mechanicalOutcomes.length
    },
    artifactNames: ["guardrail-report.json"]
  };
}
