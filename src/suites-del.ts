/**
 * DEL-002 (self-check), fresh -- no salvage source. Runner-introspective: it exercises the
 * runner's own `run-subset` and `verify-evidence` CLI machinery from the outside, as any other
 * caller would (see docs/qualification/DEL-002.md for what the catalog's "signed and
 * authoritative" phrase means at protected-dispatch time vs local qualification -- this suite's
 * own envelope is local/informative like every other, never authoritative by virtue of testing
 * authority).
 */
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { command, readJson, writeJson } from "./io.ts";
import { runnerRoot, suiteIds } from "./catalog.ts";
import type { SuiteContext, SuiteResult } from "./suites.ts";
import type { AnyRecord } from "./g1-support.ts";

const CLI = resolve(runnerRoot(), "src/cli.ts");

/**
 * Chosen for being pure filesystem probes against `candidate` with no subprocess of their
 * own (no npm build, no docker, no external checkout) -- deterministic and fast whether or
 * not they pass against whatever candidate self-check itself receives. `run-subset` marks
 * every suite it runs `localUnsigned: true` regardless of that suite's own pass/fail
 * outcome, and DEL-004 only asserts the subset-execution and unsigned-marking machinery,
 * not that the inner suites succeed -- so their outcome against an arbitrary candidate is
 * not part of the oracle here.
 */
const PROBE_SLUGS = ["architecture-boundaries", "open-source"] as const;

interface CliResult { code: number; stdout: string; stderr: string }

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await command(process.execPath, [CLI, ...args], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

export async function selfCheck({ candidate, artifactDir }: SuiteContext): Promise<SuiteResult> {
  const evidenceDir = resolve(artifactDir, "subset-evidence");

  // --- (a) run-subset executes exactly the requested suites, no more, no fewer ---
  const subset = await runCli(["run-subset", PROBE_SLUGS.join(","), "--candidate", candidate, "--evidence-dir", evidenceDir]);
  const lines = subset.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as AnyRecord);
  const summary = lines.pop() as AnyRecord | undefined;
  assert.deepEqual(summary?.subset, [...PROBE_SLUGS], "run-subset must report exactly the requested suites, in the requested order");
  assert.equal(summary?.localUnsigned, true, "run-subset's summary line must declare localUnsigned true");
  assert.equal(lines.length, PROBE_SLUGS.length, "run-subset must emit exactly one result line per requested suite, no more and no fewer");

  const expectedTestIds = PROBE_SLUGS.map((slug) => suiteIds[slug]).sort();
  const executedTestIds = lines.map((line) => String(line.testId)).sort();
  assert.deepEqual(executedTestIds, expectedTestIds, "run-subset must run exactly the requested tests, identified by testId");

  const emittedRunDirs = await readdir(evidenceDir);
  assert.equal(emittedRunDirs.length, PROBE_SLUGS.length, "run-subset must write exactly one evidence run directory per requested suite, no stray output");

  // --- (b) every internally emitted envelope carries measurements.localUnsigned true ---
  const envelopes: AnyRecord[] = [];
  for (const line of lines) {
    assert.equal(line.authoritative, false, `${String(line.testId)}: a run-subset result can never be authoritative`);
    const envelope = await readJson(String(line.evidence)) as AnyRecord;
    assert.equal(envelope.measurements?.localUnsigned, true, `${String(line.testId)}: every internally emitted envelope must carry measurements.localUnsigned true`);
    envelopes.push({ testId: envelope.testId, status: envelope.status, localUnsigned: envelope.measurements.localUnsigned });
  }

  // --- (c)/(d) the evidence gate fails closed: type confusion, unsigned authority, malformed shape ---
  const example = await readJson(resolve(runnerRoot(), "examples/evidence.example.json")) as AnyRecord;
  const authorityChecks: AnyRecord[] = [];

  // Control: the protected example is a well-formed, non-unsigned envelope and must pass
  // verify-evidence outright. Pairing every negative below with this control keeps a probe
  // from being credited for an unrelated rejection.
  {
    const path = resolve(artifactDir, "control.json");
    await writeJson(path, example);
    const result = await runCli(["verify-evidence", path]);
    assert.equal(result.code, 0, "the protected example envelope must validate as authoritative");
    authorityChecks.push({ label: "control:well-formed", expected: "accepted", accepted: true });
  }

  // Type confusion: a truthy non-boolean localUnsigned must still fail closed, with or
  // without --allow-unsigned -- a string/number cannot be laundered into authority by the
  // informational escape hatch.
  for (const [label, value] of [["string-true", "true"], ["number-one", 1]] as const) {
    const mutated = { ...example, measurements: { ...example.measurements, localUnsigned: value } };
    const path = resolve(artifactDir, `type-confusion-${label}.json`);
    await writeJson(path, mutated);
    for (const flags of [[], ["--allow-unsigned"]]) {
      const result = await runCli(["verify-evidence", path, ...flags]);
      assert.notEqual(result.code, 0, `verify-evidence must reject localUnsigned:${label}${flags.length ? " even with --allow-unsigned" : ""}`);
      assert.match(result.stderr, /must be a boolean/, `verify-evidence's rejection of localUnsigned:${label} must name the type-confusion failure`);
      authorityChecks.push({ label: `type-confusion:${label}`, flags, expected: "rejected", rejected: true, error: result.stderr.trim() });
    }
  }

  // localUnsigned: true (a well-typed boolean) must be rejected as authority by default,
  // and accepted only for informational validation under --allow-unsigned.
  {
    const mutated = { ...example, measurements: { ...example.measurements, localUnsigned: true } };
    const path = resolve(artifactDir, "unsigned-authority.json");
    await writeJson(path, mutated);
    const withoutFlag = await runCli(["verify-evidence", path]);
    assert.notEqual(withoutFlag.code, 0, "localUnsigned:true must never be authoritative by default");
    assert.match(withoutFlag.stderr, /never authoritative/, "the rejection must name that localUnsigned evidence is never authoritative");
    const withFlag = await runCli(["verify-evidence", path, "--allow-unsigned"]);
    assert.equal(withFlag.code, 0, "localUnsigned:true must still validate informationally under --allow-unsigned");
    authorityChecks.push({ label: "unsigned:default", expected: "rejected", rejected: true, error: withoutFlag.stderr.trim() });
    authorityChecks.push({ label: "unsigned:allow-unsigned", expected: "accepted", accepted: true });
  }

  // Malformed: an envelope missing a required field must be rejected regardless of
  // --allow-unsigned, since it is not a claim about signing, but about shape.
  for (const field of ["testId", "candidate"]) {
    const mutated = { ...example } as AnyRecord;
    delete mutated[field];
    const path = resolve(artifactDir, `malformed-missing-${field}.json`);
    await writeJson(path, mutated);
    const result = await runCli(["verify-evidence", path, "--allow-unsigned"]);
    assert.notEqual(result.code, 0, `verify-evidence must reject an envelope missing ${field}, even with --allow-unsigned`);
    assert.match(result.stderr, /Planning validation failed/, `the rejection of a missing ${field} must come from schema validation, not an unrelated crash`);
    authorityChecks.push({ label: `malformed:missing-${field}`, expected: "rejected", rejected: true, error: result.stderr.trim() });
  }

  await writeJson(resolve(artifactDir, "subset-run.json"), {
    requestedSubset: [...PROBE_SLUGS], expectedTestIds, executedTestIds, envelopes, summary
  });
  await writeJson(resolve(artifactDir, "authority-rejection.json"), { checks: authorityChecks });

  return {
    measurements: {
      subsetRequested: PROBE_SLUGS.length, subsetExecuted: executedTestIds.length,
      strayRunDirectories: emittedRunDirs.length - PROBE_SLUGS.length,
      internalEnvelopesUnsigned: envelopes.length, authorityChecks: authorityChecks.length
    },
    artifactNames: ["subset-run.json", "authority-rejection.json"]
  };
}
