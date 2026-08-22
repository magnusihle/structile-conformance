import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveSuite, suiteIds } from "../src/catalog.mjs";
import { suites } from "../src/suites.mjs";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("protected planning inputs match the approved bootstrap hashes", async () => {
  const lock = JSON.parse(await readFile(resolve(root, "architecture/planning-inputs.lock.json"), "utf8"));
  for (const [path, expected] of Object.entries(lock.files)) {
    const actual = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
    assert.equal(actual, expected, path);
  }
});

test("runner exposes only the five CLI-backed G0 suites", async () => {
  assert.deepEqual(Object.keys(suiteIds), ["architecture-boundaries", "compose-smoke", "agent-adapters", "harness-policy", "open-source"]);
  for (const [slug, id] of Object.entries(suiteIds)) {
    const suite = await resolveSuite(slug);
    assert.equal(suite.id, id);
    assert.equal(suite.gate, "G0");
    assert.equal(typeof suites[slug], "function");
  }
  const { stdout } = await runFile(process.execPath, [resolve(root, "src/cli.mjs"), "list"]);
  assert.equal(JSON.parse(stdout).length, 5);
});

test("unknown or not-yet-implemented suites fail closed with exit 2", async () => {
  await assert.rejects(
    runFile(process.execPath, [resolve(root, "src/cli.mjs"), "run", "spec-fuzz"]),
    (error) => error.code === 2 && /unknown or unimplemented suite/.test(error.stderr)
  );
});

test("HAR-003 cannot pass from policy definitions without human enforcement", async () => {
  const candidate = await mkdtemp(resolve(tmpdir(), "structile-policy-fixture-"));
  const artifactDir = resolve(candidate, "artifacts");
  await mkdir(resolve(candidate, "policies/agent"), { recursive: true });
  await mkdir(artifactDir);
  await writeFile(resolve(candidate, "policies/agent/permissions.json"), JSON.stringify({
    default: "deny",
    roles: { builder: {
      allowedActions: ["create-branch","commit","push-assigned-branch","open-pull-request"],
      deniedActions: ["push-default-branch","merge","deploy","write-protected","approve-waiver","sign-evidence","read-production-secret"]
    } }
  }));
  await writeFile(resolve(candidate, "policies/agent/protected-paths.json"), JSON.stringify({
    paths: ["requirements/**","verification/test-catalog.json","requirements/waivers.json",".github/CODEOWNERS","policies/agent/**"]
  }));
  await writeFile(resolve(candidate, "policies/agent/network-policy.json"), JSON.stringify({ defaultEgress: "deny", forbiddenDestinations: ["production-databases"] }));
  await assert.rejects(
    suites["harness-policy"]({ candidate, artifactDir, options: {} }),
    /protected repository\/sandbox probe output and workflow-bound digest are required/
  );
});
