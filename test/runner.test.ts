import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveSuite, suiteIds, type SuiteSlug } from "../src/catalog.ts";
import { suites } from "../src/suites.ts";

const runFile = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("protected planning inputs match the approved bootstrap hashes", async () => {
  const lock = JSON.parse(await readFile(resolve(root, "architecture/planning-inputs.lock.json"), "utf8")) as { files: Record<string, string> };
  for (const [path, expected] of Object.entries(lock.files)) {
    const actual = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
    assert.equal(actual, expected, path);
  }
});

test("runner exposes only the fourteen CLI-backed G0/G1 suites", async () => {
  assert.deepEqual(Object.keys(suiteIds), ["architecture-boundaries", "compose-smoke", "agent-adapters", "harness-policy", "open-source", "design-system", "spec-fuzz", "action-contract", "capability-contract", "graphify-policy", "spec-migrations", "package-matrix", "delivery-guardrails", "self-check"]);
  const gates: Record<string, string> = { "design-system": "G1", "spec-fuzz": "G1", "action-contract": "G1", "capability-contract": "G1", "graphify-policy": "G1", "spec-migrations": "G1", "package-matrix": "G1", "delivery-guardrails": "G1", "self-check": "G1" };
  for (const [slug, id] of Object.entries(suiteIds)) {
    const suite = await resolveSuite(slug);
    assert.ok(suite);
    assert.equal(suite.id, id);
    assert.equal(suite.gate, gates[slug] ?? "G0");
    assert.equal(typeof suites[slug as SuiteSlug], "function");
  }
  const { stdout } = await runFile(process.execPath, [resolve(root, "src/cli.ts"), "list"]);
  assert.equal(JSON.parse(stdout).length, 14);
});

test("unknown or not-yet-implemented suites fail closed with exit 2", async () => {
  await assert.rejects(
    runFile(process.execPath, [resolve(root, "src/cli.ts"), "run", "accessibility"]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      return failure.code === 2 && /unknown or unimplemented suite/.test(failure.stderr ?? "");
    }
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
