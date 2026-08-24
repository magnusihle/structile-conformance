import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { command, hashFile, listFiles, sha256, writeJson } from "./io.ts";
import { runnerRoot, type ProtectedTest } from "./catalog.ts";

export interface CandidateIdentity {
  repository: string;
  commitSha: string;
  dirty: boolean;
}

interface BuildEvidenceInput {
  test: ProtectedTest;
  candidate: string;
  status: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  measurements: Record<string, unknown>;
  artifactDir: string;
  artifactNames: string[];
  configDigest: string;
  unsigned?: boolean;
}

function normalizeRepository(remote: string): string {
  const value = remote.trim();
  const ssh = /^git@github\.com:([^/]+\/.+?)(?:\.git)?$/.exec(value);
  if (ssh?.[1]) return `https://github.com/${ssh[1].replace(/\.git$/, "")}`;
  return value.replace(/\.git$/, "");
}

export async function candidateIdentity(candidate: string): Promise<CandidateIdentity> {
  const [commit, status, remote] = await Promise.all([
    command("git", ["rev-parse", "HEAD"], { cwd: candidate }),
    command("git", ["status", "--porcelain"], { cwd: candidate }),
    command("git", ["config", "--get", "remote.origin.url"], { cwd: candidate })
  ]);
  return {
    repository: normalizeRepository(remote.stdout),
    commitSha: commit.stdout.trim(),
    dirty: status.stdout.trim().length > 0
  };
}

export function isOracleInput(path: string): boolean {
  return (
    path.startsWith("src/") ||
    path.startsWith("fixtures/") ||
    path === "verification/test-catalog.json" ||
    path === "verification/evidence.schema.json"
  );
}

export async function runnerDigests(): Promise<{ imageDigest: string; testSourceDigest: string; localUnsigned: boolean }> {
  const root = runnerRoot();
  const files = (await listFiles(root)).filter(isOracleInput);
  const content: string[] = [];
  for (const path of files) content.push(`${path}\0${await readFile(resolve(root, path), "utf8")}\0`);
  const testSource = sha256(content.join(""));
  return {
    imageDigest: process.env.STRUCTILE_RUNNER_IMAGE_DIGEST ?? `sha256:${testSource}`,
    testSourceDigest: `sha256:${testSource}`,
    localUnsigned: !process.env.STRUCTILE_RUNNER_IMAGE_DIGEST
  };
}

export async function buildEvidence({ test, candidate, status, exitCode, startedAt, finishedAt, measurements, artifactDir, artifactNames, configDigest, unsigned = false }: BuildEvidenceInput): Promise<any> {
  const identity = await candidateIdentity(candidate);
  const runner = await runnerDigests();
  const artifacts: Array<{ name: string; sha256: string }> = [];
  for (const name of artifactNames) artifacts.push({ name, sha256: await hashFile(resolve(artifactDir, name)) });
  const evidenceId = `ev:${test.id}:${identity.commitSha.slice(0, 12)}:${Date.now()}`;
  return {
    schemaVersion: "1.0.0",
    evidenceId,
    testId: test.id,
    requirementIds: test.requirements,
    status,
    candidate: identity,
    runner: {
      name: "structile-conformance",
      version: "0.1.0",
      imageDigest: runner.imageDigest,
      testSourceDigest: runner.testSourceDigest
    },
    environment: {
      profile: process.env.STRUCTILE_CONFORMANCE_PROFILE ?? "local-g0",
      configDigest: `sha256:${configDigest}`,
      region: process.env.STRUCTILE_CONFORMANCE_REGION ?? "local",
      hardware: process.env.STRUCTILE_CONFORMANCE_HARDWARE ?? `${process.platform}-${process.arch}`
    },
    startedAt,
    finishedAt,
    exitCode,
    measurements: { ...measurements, localUnsigned: runner.localUnsigned || unsigned },
    artifacts,
    provenance: {
      ciRunId: process.env.GITHUB_RUN_ID ?? `local-${process.pid}`,
      workflowIdentity: process.env.STRUCTILE_WORKFLOW_IDENTITY ?? "local-unsigned/not-release-evidence",
      attestationRef: process.env.STRUCTILE_ATTESTATION_REF ?? `local-unsigned:sha256:${sha256(evidenceId)}`
    }
  };
}

export async function writeEvidence(path: string, evidence: unknown): Promise<void> {
  await writeJson(path, evidence);
}
