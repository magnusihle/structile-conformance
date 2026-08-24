import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "src/cli.ts");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await runFile(process.execPath, [cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function makeDirtyCandidate(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "unsigned-candidate-"));
  const git = (...args: string[]) => runFile("git", args, { cwd: dir });
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "test");
  await git("remote", "add", "origin", "git@github.com:example/candidate.git");
  await writeFile(join(dir, "README.md"), "candidate\n");
  await git("add", "-A");
  await git("commit", "-m", "base");
  await writeFile(join(dir, "README.md"), "candidate dirty\n");
  return dir;
}

test("run without --unsigned refuses a dirty candidate", async () => {
  const candidate = await makeDirtyCandidate();
  const result = await runCli(["run", "open-source", "--candidate", candidate]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /clean Git commit/);
});

test("run --unsigned permits a dirty candidate and marks the envelope localUnsigned", async () => {
  const candidate = await makeDirtyCandidate();
  const result = await runCli(["run", "open-source", "--candidate", candidate, "--unsigned"]);
  const line = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as { evidence?: string; authoritative?: boolean };
  assert.equal(line.authoritative, false);
  const envelope = JSON.parse(await readFile(String(line.evidence), "utf8")) as {
    measurements: { localUnsigned?: boolean };
    candidate: { dirty?: boolean };
  };
  assert.equal(envelope.measurements.localUnsigned, true);
  assert.equal(envelope.candidate.dirty, true);
});

test("run-subset executes exactly the named suites, all unsigned", async () => {
  const candidate = await makeDirtyCandidate();
  const result = await runCli(["run-subset", "open-source,harness-policy", "--candidate", candidate]);
  const lines = result.stdout.trim().split("\n").map((entry) => JSON.parse(entry) as Record<string, unknown>);
  const summary = lines.pop() as { subset?: string[]; localUnsigned?: boolean; exitCode?: number };
  assert.deepEqual(summary.subset, ["open-source", "harness-policy"]);
  assert.equal(summary.localUnsigned, true);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.equal(line.authoritative, false);
  assert.equal(result.code, summary.exitCode);
});

test("verify-evidence rejects localUnsigned envelopes as authority, allows informational validation", async () => {
  const example = JSON.parse(await readFile(resolve(root, "examples/evidence.example.json"), "utf8")) as {
    measurements: Record<string, unknown>;
  };
  example.measurements.localUnsigned = true;
  const dir = await mkdtemp(join(tmpdir(), "unsigned-evidence-"));
  const path = join(dir, "evidence.json");
  await writeFile(path, JSON.stringify(example));
  const rejected = await runCli(["verify-evidence", path]);
  assert.equal(rejected.code, 2);
  assert.match(rejected.stderr, /never authoritative/);
  const allowed = await runCli(["verify-evidence", path, "--allow-unsigned"]);
  assert.equal(allowed.code, 0);
});
