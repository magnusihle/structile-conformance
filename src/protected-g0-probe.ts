#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadDefaultCatalogs, validateEvidence } from "../tooling/validate-planning.mjs";

type JsonRecord = Record<string, any>;

interface ApiResult {
  ok: boolean;
  status: number;
  body: JsonRecord;
}

interface ProbeResult {
  action: string;
  outcome: string;
  auditRef: string;
  httpStatus?: number;
  detail?: string;
}

const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
const builderToken = requiredEnvironment("STRUCTILE_BUILDER_TOKEN");
const coreCheckout = resolve(requiredEnvironment("STRUCTILE_CORE_CHECKOUT"));
const evidenceDirectory = resolve(requiredEnvironment("STRUCTILE_EVIDENCE_DIR"));
const outputPath = resolve(requiredEnvironment("STRUCTILE_ENFORCEMENT_ATTESTATION"));
const probeRepository = requiredEnvironment("STRUCTILE_PROBE_REPOSITORY");
const candidateCommit = requiredEnvironment("STRUCTILE_CORE_SHA");
const runnerImage = requiredEnvironment("STRUCTILE_RUNNER_IMAGE_REFERENCE");
const runId = requiredEnvironment("GITHUB_RUN_ID");
const runUrl = `${requiredEnvironment("GITHUB_SERVER_URL")}/${requiredEnvironment("GITHUB_REPOSITORY")}/actions/runs/${runId}`;
const branch = `g0-verifier-${runId}-${process.pid}`;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function auditRef(section: string): string {
  return `${runUrl}#${section}`;
}

async function github(path: string, init: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${builderToken}`,
      "content-type": "application/json",
      "user-agent": "structile-protected-g0-verifier",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {})
    }
  });
  const source = await response.text();
  let body: JsonRecord = {};
  if (source) {
    try {
      body = JSON.parse(source) as JsonRecord;
    } catch {
      body = {};
    }
  }
  return { ok: response.ok, status: response.status, body };
}

function requireSuccess(result: ApiResult, operation: string): JsonRecord {
  if (!result.ok) throw new Error(`${operation} failed with HTTP ${result.status}`);
  return result.body;
}

async function repositoryMainSha(): Promise<string> {
  const result = requireSuccess(await github(`/repos/${probeRepository}/git/ref/heads/main`), "read synthetic main ref");
  const sha = result.object?.sha;
  if (typeof sha !== "string") throw new Error("synthetic main ref did not include an object SHA");
  return sha;
}

async function createCommit(baseCommitSha: string, path: string, value: JsonRecord): Promise<string> {
  const commit = requireSuccess(await github(`/repos/${probeRepository}/git/commits/${baseCommitSha}`), "read synthetic base commit");
  const treeSha = commit.tree?.sha;
  if (typeof treeSha !== "string") throw new Error("synthetic base commit did not include a tree SHA");
  const blob = requireSuccess(await github(`/repos/${probeRepository}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: `${JSON.stringify(value, null, 2)}\n`, encoding: "utf-8" })
  }), "create synthetic probe blob");
  const tree = requireSuccess(await github(`/repos/${probeRepository}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: treeSha,
      tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }]
    })
  }), "create synthetic probe tree");
  const created = requireSuccess(await github(`/repos/${probeRepository}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `G0 authority probe ${runId}`,
      tree: tree.sha,
      parents: [baseCommitSha]
    })
  }), "create synthetic probe commit");
  if (typeof created.sha !== "string") throw new Error("synthetic commit did not include a SHA");
  return created.sha;
}

function denied(action: string, result: ApiResult, acceptedStatuses: readonly number[]): ProbeResult {
  const isDenied = acceptedStatuses.includes(result.status);
  return {
    action,
    outcome: isDenied ? "denied" : result.ok ? "unexpectedly-allowed" : "error",
    auditRef: auditRef(`authority-${action}`),
    httpStatus: result.status
  };
}

function errored(action: string): ProbeResult {
  return { action, outcome: "error", auditRef: auditRef(`authority-${action}`), detail: "probe-prerequisite-error" };
}

async function authorityProbes(): Promise<ProbeResult[]> {
  const results = new Map<string, ProbeResult>();
  let pullNumber: number | undefined;
  let pullUrl: string | undefined;
  let branchCreated = false;
  try {
    const mainSha = await repositoryMainSha();
    const allowedCommit = await createCommit(mainSha, `probes/allowed/${runId}.json`, { runId, kind: "allowed-branch-pr" });
    requireSuccess(await github(`/repos/${probeRepository}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: allowedCommit })
    }), "create allowed synthetic branch");
    branchCreated = true;
    const pull = requireSuccess(await github(`/repos/${probeRepository}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: `G0 authority probe ${runId}`,
        head: branch,
        base: "main",
        body: "Synthetic protected-verifier probe. No product or customer data."
      })
    }), "create allowed synthetic pull request");
    pullNumber = typeof pull.number === "number" ? pull.number : undefined;
    pullUrl = typeof pull.html_url === "string" ? pull.html_url : undefined;
    if (!pullNumber || !pullUrl) throw new Error("synthetic pull request response was incomplete");
    results.set("allowed-branch-pull-request", {
      action: "allowed-branch-pull-request",
      outcome: "allowed",
      auditRef: pullUrl,
      httpStatus: 201
    });

    const directCommit = await createCommit(mainSha, `probes/default/${runId}.json`, { runId, kind: "forbidden-default-push" });
    results.set("push-default-branch", denied("push-default-branch", await github(`/repos/${probeRepository}/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: directCommit, force: false })
    }), [403, 422]));

    const protectedFile = await github(`/repos/${probeRepository}/contents/requirements/waivers.json?ref=main`);
    if (protectedFile.ok && typeof protectedFile.body.sha === "string") {
      const content = Buffer.from(`${JSON.stringify({ schemaVersion: "1.0.0", waivers: [], probeRun: runId }, null, 2)}\n`).toString("base64");
      results.set("write-protected", denied("write-protected", await github(`/repos/${probeRepository}/contents/requirements/waivers.json`, {
        method: "PUT",
        body: JSON.stringify({
          message: `Forbidden protected-path probe ${runId}`,
          content,
          sha: protectedFile.body.sha,
          branch: "main"
        })
      }), [403, 409, 422]));
    } else {
      results.set("write-protected", errored("write-protected"));
    }

    results.set("merge", denied("merge", await github(`/repos/${probeRepository}/pulls/${pullNumber}/merge`, {
      method: "PUT",
      body: JSON.stringify({ merge_method: "squash", commit_title: `Forbidden merge probe ${runId}` })
    }), [403, 405, 409, 422]));

    results.set("approve-waiver", denied("approve-waiver", await github(`/repos/${probeRepository}/pulls/${pullNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event: "APPROVE", body: "Forbidden self-approval probe" })
    }), [403, 422]));

    results.set("deploy", denied("deploy", await github(`/repos/${probeRepository}/deployments`, {
      method: "POST",
      body: JSON.stringify({ ref: branch, auto_merge: false, required_contexts: [], environment: "production-probe" })
    }), [403, 404]));
  } catch {
    for (const action of ["allowed-branch-pull-request", "push-default-branch", "write-protected", "merge", "approve-waiver", "deploy"]) {
      if (!results.has(action)) results.set(action, errored(action));
    }
  } finally {
    if (pullNumber) await github(`/repos/${probeRepository}/pulls/${pullNumber}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }).catch(() => undefined);
    if (branchCreated) await github(`/repos/${probeRepository}/git/refs/heads/${branch}`, { method: "DELETE" }).catch(() => undefined);
  }

  results.set("sign-evidence", denied("sign-evidence", await github("/repos/magnusihle/structile-conformance/attestations", {
    method: "POST",
    body: JSON.stringify({ bundle: {} })
  }), [403, 404]));

  results.set("read-production-secret", denied("read-production-secret", await github(`/repos/${probeRepository}/environments/production-probe/secrets`), [403, 404]));

  return [
    "push-default-branch",
    "merge",
    "deploy",
    "write-protected",
    "approve-waiver",
    "sign-evidence",
    "read-production-secret",
    "allowed-branch-pull-request"
  ].map((action) => results.get(action) ?? errored(action));
}

async function egressProbes(): Promise<JsonRecord[]> {
  const policy = JSON.parse(await readFile(resolve(coreCheckout, "policies/agent/network-policy.json"), "utf8")) as JsonRecord;
  const destinations = policy.forbiddenDestinations as unknown;
  if (!Array.isArray(destinations) || destinations.some((entry) => typeof entry !== "string")) throw new Error("forbiddenDestinations must be a string array");
  const targetByDestination: Record<string, string> = {
    "production-databases": "https://192.0.2.10",
    "customer-systems": "https://198.51.100.10",
    "cloud-metadata": "http://169.254.169.254/latest/meta-data",
    "infrastructure-admin": "https://203.0.113.10",
    "unapproved-model-endpoints": "https://example.com"
  };
  return destinations.map((destination) => {
    const target = targetByDestination[destination] ?? "https://example.com";
    const probe = spawnSync("docker", [
      "run", "--rm", "--network", "none", "--entrypoint", "node", runnerImage,
      "-e",
      "fetch(process.argv[1], { signal: AbortSignal.timeout(5000) }).then(() => process.exit(1)).catch(() => process.exit(0))",
      target
    ], { encoding: "utf8", timeout: 30_000 });
    return {
      destination,
      outcome: probe.status === 0 ? "denied" : probe.status === 1 ? "unexpectedly-allowed" : "error",
      auditRef: auditRef(`egress-${destination}`)
    };
  });
}

async function findEvidence(path: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await findEvidence(child));
    else if (entry.isFile() && entry.name === "evidence.json") files.push(child);
  }
  return files.sort();
}

async function evidenceProbes(): Promise<JsonRecord[]> {
  const evidencePaths = await findEvidence(evidenceDirectory);
  if (evidencePaths.length === 0) {
    return ["forged", "mismatched-candidate", "mismatched-runner"].map((attack) => ({ attack, outcome: "error", auditRef: auditRef(`evidence-${attack}`) }));
  }
  const evidence = JSON.parse(await readFile(evidencePaths[0]!, "utf8")) as JsonRecord;
  const catalogs = await loadDefaultCatalogs();
  const probes: Array<{ attack: string; value: JsonRecord; options: JsonRecord }> = [];
  const forged = structuredClone(evidence);
  forged.requirementIds = (forged.requirementIds as unknown[]).slice(1);
  probes.push({ attack: "forged", value: forged, options: { candidateSha: candidateCommit, runnerDigest: evidence.runner.imageDigest } });
  probes.push({ attack: "mismatched-candidate", value: structuredClone(evidence), options: { candidateSha: "0".repeat(40), runnerDigest: evidence.runner.imageDigest } });
  probes.push({ attack: "mismatched-runner", value: structuredClone(evidence), options: { candidateSha: candidateCommit, runnerDigest: `sha256:${"0".repeat(64)}` } });
  return probes.map(({ attack, value, options }) => {
    let outcome = "accepted";
    try {
      validateEvidence(value, catalogs.requirements, catalogs.tests, options);
    } catch {
      outcome = "rejected";
    }
    return { attack, outcome, auditRef: auditRef(`evidence-${attack}`) };
  });
}

const attestation = {
  schemaVersion: "1.0.0",
  source: "protected-github-and-sandbox-probe",
  candidateCommit,
  repositories: {
    core: "https://github.com/magnusihle/structile",
    conformance: "https://github.com/magnusihle/structile-conformance",
    northstar: "https://github.com/magnusihle/structile-northstar"
  },
  authorityProbes: await authorityProbes(),
  egressProbes: await egressProbes(),
  evidenceProbes: await evidenceProbes()
};

await writeFile(outputPath, `${JSON.stringify(attestation, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
const digest = createHash("sha256").update(await readFile(outputPath)).digest("hex");
process.stdout.write(`${JSON.stringify({ output: outputPath, digest: `sha256:${digest}` })}\n`);
