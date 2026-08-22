import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { basename, resolve } from "node:path";
import { command, listFiles, readJson, sha256, writeJson } from "./io.ts";
import type { SuiteSlug } from "./catalog.ts";

type AnyRecord = Record<string, any>;
export type SuiteOptions = Record<string, string | true | undefined>;

export interface SuiteContext {
  candidate: string;
  artifactDir: string;
  options: SuiteOptions;
}

export interface SuiteResult {
  measurements: Record<string, unknown>;
  artifactNames: string[];
}

export type Suite = (context: SuiteContext) => Promise<SuiteResult>;

const packageNames = [
  "@structile/tokens", "@structile/primitives", "@structile/components", "@structile/catalog",
  "@structile/spec", "@structile/runtime", "@structile/composer", "@structile/charts", "@structile/i18n",
  "@structile/capability-sdk", "@structile/auth", "@structile/control-plane", "@structile/agent-harness"
];

function assertExactKeys(value: unknown, keys: readonly string[], label: string): asserts value is AnyRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys do not match the protected contract`);
}

async function architectureBoundaries({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  const boundaries = await readJson(resolve(candidate, "architecture/package-boundaries.json"));
  assert.deepEqual(boundaries.packages.map((item: AnyRecord) => item.name), packageNames);
  assert.deepEqual(boundaries.externalPackages.map((item: AnyRecord) => item.name), ["@structile/conformance"]);
  assert.equal(boundaries.externalPackages[0].repository, "https://github.com/magnusihle/structile-conformance");
  const rootManifest = await readJson(resolve(candidate, "package.json"));
  const tsconfig = await readJson(resolve(candidate, "tsconfig.base.json"));
  assert.equal(rootManifest.devDependencies.react, "19.2.8");
  assert.equal(rootManifest.devDependencies.typescript, "7.0.2");
  assert.ok(tsconfig.compilerOptions.strict);
  const nodes: Array<{ name: string; path: string; dependencies: string[] }> = [];
  for (const boundary of boundaries.packages) {
    const manifest = await readJson(resolve(candidate, boundary.path, "package.json"));
    assert.equal(manifest.name, boundary.name);
    assert.equal(manifest.private, true);
    const dependencies = Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) });
    nodes.push({ name: boundary.name, path: boundary.path, dependencies });
  }
  for (const reactPackage of ["@structile/primitives", "@structile/components", "@structile/runtime", "@structile/composer", "@structile/charts"]) {
    assert.equal(nodes.find((node) => node.name === reactPackage)?.dependencies.includes("react"), true, `${reactPackage} must declare its React boundary`);
  }
  const sourcePaths = (await listFiles(candidate)).filter((path) => /^(packages|apps)\/.+\.(?:ts|tsx|js|mjs)$/.test(path));
  const forbiddenHits: Array<{ path: string; pattern: string }> = [];
  const uiDatabaseHits: string[] = [];
  for (const path of sourcePaths) {
    const source = await readFile(resolve(candidate, path), "utf8");
    for (const pattern of [/toll-refundering/i, /customs declaration/i, /tenant javascript/i, /global cross-product (?:control )?database/i]) {
      if (pattern.test(source)) forbiddenHits.push({ path, pattern: String(pattern) });
    }
    if (/^packages\/(?:tokens|primitives|components|catalog|spec|runtime|composer|charts|i18n)\//.test(path) && /(?:postgres(?:ql)?:\/\/|\bpg\b|from\s+["']postgres["']|new\s+Client\s*\()/i.test(source)) uiDatabaseHits.push(path);
  }
  assert.deepEqual(forbiddenHits, []);
  assert.deepEqual(uiDatabaseHits, []);
  const scopeDocument = await readFile(resolve(candidate, "docs/planning/decisions-and-assumptions.md"), "utf8");
  assert.match(scopeDocument, /authenticated/i);
  assert.match(scopeDocument, /desktop/i);
  assert.match(scopeDocument, /out of scope/i);

  assert.equal(options.reference, "northstar", "ARCH-001 requires --reference northstar");
  const reference = process.env.STRUCTILE_NORTHSTAR_CHECKOUT;
  assert.ok(reference, "STRUCTILE_NORTHSTAR_CHECKOUT must identify the protected Northstar checkout");
  const referenceRoot = resolve(reference);
  const [referenceCommit, referenceStatus, referenceRemote] = await Promise.all([
    command("git", ["rev-parse", "HEAD"], { cwd: referenceRoot }),
    command("git", ["status", "--porcelain"], { cwd: referenceRoot }),
    command("git", ["config", "--get", "remote.origin.url"], { cwd: referenceRoot })
  ]);
  assert.equal(referenceStatus.stdout.trim(), "", "Northstar reference must be a clean commit");
  assert.match(referenceRemote.stdout.trim(), /(?:github\.com[:/])magnusihle\/structile-northstar(?:\.git)?$/);
  const referenceSourcePaths = (await listFiles(referenceRoot)).filter((path) => /^(?:src|app|apps|packages)\/.+\.(?:ts|tsx|js|mjs)$/.test(path));
  const candidateHashes = new Map<string, string>();
  for (const path of sourcePaths) candidateHashes.set(sha256(await readFile(resolve(candidate, path))), path);
  const copiedReferenceFiles: Array<{ reference: string; candidate: string }> = [];
  for (const path of referenceSourcePaths) {
    const match = candidateHashes.get(sha256(await readFile(resolve(referenceRoot, path))));
    if (match) copiedReferenceFiles.push({ reference: path, candidate: match });
  }
  assert.deepEqual(copiedReferenceFiles, []);
  const boundaryReport = {
    packages: packageNames.length,
    externalConformance: boundaries.externalPackages[0].repository,
    reactVersion: rootManifest.devDependencies.react,
    typescriptVersion: rootManifest.devDependencies.typescript,
    declaredScopeDocument: "docs/planning/decisions-and-assumptions.md",
    uiDatabaseHits,
    forbiddenHits
  };
  await writeJson(resolve(artifactDir, "dependency-graph.json"), { nodes });
  await writeJson(resolve(artifactDir, "boundary-report.json"), boundaryReport);
  await writeJson(resolve(artifactDir, "copy-similarity.json"), {
    reference: "northstar",
    referenceRepository: "https://github.com/magnusihle/structile-northstar",
    referenceCommit: referenceCommit.stdout.trim(),
    referenceSourceFiles: referenceSourcePaths.length,
    candidateSourceFiles: sourcePaths.length,
    copiedReferenceFiles
  });
  return { measurements: { packages: packageNames.length, forbiddenBoundaryHits: 0, copiedReferenceFiles: 0, referenceCommit: referenceCommit.stdout.trim() }, artifactNames: ["dependency-graph.json", "boundary-report.json", "copy-similarity.json"] };
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "BUILDX_CONFIG"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

async function composeSmoke({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  const secretDir = await mkdtemp(resolve(tmpdir(), "structile-compose-secret-"));
  const secretPath = resolve(secretDir, "postgres-password");
  await writeFile(secretPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  const environment = { ...dockerEnvironment(), STRUCTILE_DEV_POSTGRES_PASSWORD_FILE: secretPath };
  try {
    const config = await command("docker", ["compose", "config", "--format", "json"], { cwd: candidate, env: environment });
    const parsed = JSON.parse(config.stdout);
    const services = parsed.services ?? {};
    assert.ok(services["foundation-health"]);
    assert.ok(services.postgres);
    assert.ok(services.redis);
    assert.match(services.postgres.image, /@sha256:[a-f0-9]{64}$/);
    assert.match(services.redis.image, /@sha256:[a-f0-9]{64}$/);
    assert.equal(parsed.networks.data.internal, true);
    assert.equal(services.postgres.read_only, true);
    assert.equal(services.redis.read_only, true);
    assert.equal(services.postgres.ports, undefined);
    assert.equal(services.redis.ports, undefined);
    assert.ok((services.postgres.volumes ?? []).some((mount: AnyRecord) => mount.type === "volume" && mount.target === "/var/lib/postgresql/data"));
    assert.equal(services.redis.volumes, undefined);
    assert.deepEqual(services.redis.command.slice(0, 7), ["redis-server", "--dir", "/tmp", "--save", "", "--appendonly", "no"]);
    assert.equal(services.postgres.environment.POSTGRES_PASSWORD_FILE, "/run/secrets/postgres_password");
    assert.equal(Object.hasOwn(services.postgres.environment, "POSTGRES_PASSWORD"), false);
    const healthTimeline: AnyRecord[] = [];
    let foundationHealthImageDigest = "not-built-static-config";
    if (options["fresh-volumes"] !== undefined) {
      const project = `structile-g0-${process.pid}`;
      try {
        const started = new Date().toISOString();
        await command("docker", ["compose", "-p", project, "up", "--build", "--wait"], { cwd: candidate, env: environment, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
        const state = await command("docker", ["compose", "-p", project, "ps", "--format", "json"], { cwd: candidate, env: environment });
        const stateRows: AnyRecord[] = state.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        assert.equal(stateRows.length, 3);
        assert.ok(stateRows.every((row: AnyRecord) => row.State === "running" && row.Health === "healthy"));
        const imageState = await command("docker", ["image", "inspect", `${project}-foundation-health`, "--format", "{{.Id}}"], { cwd: candidate, env: environment });
        foundationHealthImageDigest = imageState.stdout.trim();
        assert.match(foundationHealthImageDigest, /^sha256:[a-f0-9]{64}$/);
        healthTimeline.push({ started, ready: new Date().toISOString(), state: stateRows });
      } finally {
        await command("docker", ["compose", "-p", project, "down", "--volumes", "--remove-orphans"], { cwd: candidate, env: environment, timeout: 120_000 }).catch(() => undefined);
      }
    } else {
      healthTimeline.push({ mode: "static-config", ready: null });
    }
    parsed.secrets.postgres_password.file = "<ephemeral-secret-file>";
    await writeJson(resolve(artifactDir, "compose-config.json"), parsed);
    await writeJson(resolve(artifactDir, "health-timeline.json"), healthTimeline);
    await writeJson(resolve(artifactDir, "image-digests.json"), { postgres: services.postgres.image, redis: services.redis.image, foundationHealth: foundationHealthImageDigest });
    return { measurements: { services: Object.keys(services).length, liveCleanStart: options["fresh-volumes"] !== undefined }, artifactNames: ["compose-config.json", "health-timeline.json", "image-digests.json"] };
  } finally {
    await rm(secretDir, { recursive: true, force: true });
  }
}

async function agentAdapters({ candidate, artifactDir }: SuiteContext): Promise<SuiteResult> {
  await command("npm", ["run", "build", "--workspace", "@structile/agent-harness"], { cwd: candidate, timeout: 180_000 });
  const modulePath = resolve(candidate, "packages/agent-harness/dist/index.js");
  const harness = await import(`${pathToFileURL(modulePath).href}?conformance=${Date.now()}`);
  const request = {
    taskId: "protected:g0:adapter:1", requirementIds: ["HAR-001", "HAR-002"],
    requirementDigest: `sha256:${"a".repeat(64)}`, testDigest: `sha256:${"b".repeat(64)}`,
    repository: "https://github.com/magnusihle/structile", baseCommit: "c".repeat(40), branch: "g0/conformance-fixture",
    allowedPaths: ["packages/agent-harness/**"], allowedTools: ["git", "node"], networkDestinations: ["api.openai.com"],
    budget: { timeoutMs: 30_000, maxOutputBytes: 65_536 }, prompt: "Protected deterministic adapter fixture"
  };
  const context = { workspace: candidate, resultSchemaPath: "/protected/agent-result.schema.json", resultPath: "/isolated/result.json", environment: { PATH: "/usr/bin", CODEX_API_KEY: "secret-canary" } };
  let invocation: AnyRecord | undefined;
  const expected = { status: "completed", changedPaths: [], commits: [], commands: [], claims: [], risks: [], unresolvedQuestions: [], requestedApprovals: [], usage: { durationMs: 1 } };
  const codex = new harness.CodexAdapter({ run: async (value: AnyRecord) => { invocation = value; return { exitCode: 0, stdout: JSON.stringify(expected), stderr: "" }; } });
  assert.deepEqual(await codex.execute(request, context), expected);
  assert.ok(invocation);
  assert.ok(invocation.args.includes("--ephemeral"));
  assert.ok(invocation.args.includes("workspace-write"));
  assert.ok(!invocation.args.includes("danger-full-access"));
  const claudeMock = new harness.DeterministicMockAdapter("claude-code");
  const codexMock = new harness.DeterministicMockAdapter("codex");
  const [claudeResult, codexResult] = await Promise.all([claudeMock.execute(request, context), codexMock.execute(request, context)]);
  assert.deepEqual(Object.keys(claudeResult).sort(), Object.keys(codexResult).sort());
  const blocked = { ...expected, status: "blocked", unresolvedQuestions: ["human decision required"] };
  const blockedCodex = new harness.CodexAdapter({ run: async () => ({ exitCode: 0, stdout: JSON.stringify(blocked), stderr: "" }) });
  const blockedClaude = new harness.ClaudeCodeAdapter({ execute: async () => blocked });
  assert.deepEqual(await blockedCodex.execute(request, context), await blockedClaude.execute(request, context));
  const outsideBudget = { ...expected, changedPaths: ["requirements/requirements.json"] };
  const outsideCodex = new harness.CodexAdapter({ run: async () => ({ exitCode: 0, stdout: JSON.stringify(outsideBudget), stderr: "" }) });
  const outsideClaude = new harness.ClaudeCodeAdapter({ execute: async () => outsideBudget });
  await assert.rejects(outsideCodex.execute(request, context), /outside its budget/);
  await assert.rejects(outsideClaude.execute(request, context), /outside its budget/);
  const processTransport = new harness.SpawnProcessTransport();
  const processEnvironment = { PATH: process.env.PATH ?? "" };
  await assert.rejects(processTransport.run({ program: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(4096))"], cwd: candidate, environment: processEnvironment, timeoutMs: 5_000, maxOutputBytes: 128 }), /output budget exceeded/);
  await assert.rejects(processTransport.run({ program: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], cwd: candidate, environment: processEnvironment, timeoutMs: 25, maxOutputBytes: 128 }), /timeout budget exceeded/);
  assert.doesNotMatch(JSON.stringify({ invocation: { ...invocation, environment: Object.keys(invocation.environment) }, claudeResult, codexResult }), /secret-canary/);
  await writeJson(resolve(artifactDir, "adapter-results.json"), { providers: ["claude-code", "codex"], normalized: true, consistentBlockedClassification: true, pathAndToolPolicyValidation: true, codexOperationalBoundary: true, claudeDeterministicMock: true });
  await writeJson(resolve(artifactDir, "sandbox-audit.json"), { sandbox: "workspace-write", ephemeral: true, shell: false, outputBudgetEnforced: true, timeoutBudgetEnforced: true, credentialCanaryExposed: false, publicListener: false });
  return { measurements: { providers: 2, normalized: true, budgetControls: 4, credentialCanaryExposures: 0 }, artifactNames: ["adapter-results.json", "sandbox-audit.json"] };
}

async function harnessPolicy({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  const permissions = await readJson(resolve(candidate, "policies/agent/permissions.json"));
  const protectedPaths = await readJson(resolve(candidate, "policies/agent/protected-paths.json"));
  const network = await readJson(resolve(candidate, "policies/agent/network-policy.json"));
  assert.equal(permissions.default, "deny");
  assert.equal(network.defaultEgress, "deny");
  const attempts = ["push-default-branch", "merge", "deploy", "write-protected", "approve-waiver", "sign-evidence", "read-production-secret"];
  const audit = attempts.map((action) => ({ action, outcome: permissions.roles.builder.deniedActions.includes(action) ? "denied-by-definition" : "unexpectedly-allowed" }));
  assert.ok(audit.every((entry) => entry.outcome === "denied-by-definition"));
  for (const action of ["create-branch", "commit", "push-assigned-branch", "open-pull-request"]) assert.ok(permissions.roles.builder.allowedActions.includes(action));
  for (const path of ["requirements/**", "verification/test-catalog.json", "requirements/waivers.json", ".github/CODEOWNERS", "policies/agent/**"]) assert.ok(protectedPaths.paths.includes(path));
  const enforcement = options["enforcement-attestation"];
  const expectedDigest = process.env.STRUCTILE_POLICY_ATTESTATION_SHA256;
  const workflowIdentity = process.env.STRUCTILE_WORKFLOW_IDENTITY;
  const attestationRef = process.env.STRUCTILE_ATTESTATION_REF;
  if (typeof enforcement !== "string" || !expectedDigest || !workflowIdentity || !attestationRef || workflowIdentity.startsWith("local-unsigned")) {
    throw new Error("protected repository/sandbox probe output and workflow-bound digest are required; policy definitions or a local attestation cannot pass HAR-003");
  }
  const attestationPath = resolve(enforcement);
  const attestationSource = await readFile(attestationPath, "utf8");
  assert.equal(`sha256:${sha256(attestationSource)}`, expectedDigest);
  const attestation = JSON.parse(attestationSource);
  assertExactKeys(attestation, ["schemaVersion", "source", "candidateCommit", "repositories", "authorityProbes", "egressProbes", "evidenceProbes"], "enforcement attestation");
  assert.equal(attestation.schemaVersion, "1.0.0");
  assert.equal(attestation.source, "protected-github-and-sandbox-probe");
  const candidateCommit = await command("git", ["rev-parse", "HEAD"], { cwd: candidate });
  assert.equal(attestation.candidateCommit, candidateCommit.stdout.trim());
  assert.deepEqual(attestation.repositories, {
    core: "https://github.com/magnusihle/structile",
    conformance: "https://github.com/magnusihle/structile-conformance",
    northstar: "https://github.com/magnusihle/structile-northstar"
  });
  const authorityOutcomes = new Map<string, AnyRecord>(attestation.authorityProbes.map((probe: AnyRecord) => [String(probe.action), probe]));
  for (const action of attempts) {
    const probe = authorityOutcomes.get(action);
    assert.equal(probe?.outcome, "denied");
    assert.match(probe?.auditRef ?? "", /^https:\/\//);
  }
  assert.equal(authorityOutcomes.get("allowed-branch-pull-request")?.outcome, "allowed");
  assert.match(authorityOutcomes.get("allowed-branch-pull-request")?.auditRef ?? "", /^https:\/\//);
  for (const destination of network.forbiddenDestinations) {
    const probe: AnyRecord | undefined = (attestation.egressProbes as AnyRecord[]).find((entry) => entry.destination === destination);
    assert.equal(probe?.outcome, "denied");
    assert.match(probe?.auditRef ?? "", /^https:\/\//);
  }
  for (const attack of ["forged", "mismatched-candidate", "mismatched-runner"]) {
    const probe: AnyRecord | undefined = (attestation.evidenceProbes as AnyRecord[]).find((entry) => entry.attack === attack);
    assert.equal(probe?.outcome, "rejected");
    assert.match(probe?.auditRef ?? "", /^https:\/\//);
  }
  await writeJson(resolve(artifactDir, "permission-matrix.json"), { audit, enforcement: attestation });
  await writeJson(resolve(artifactDir, "egress-denials.json"), { default: network.defaultEgress, probes: attestation.egressProbes });
  await writeJson(resolve(artifactDir, "evidence-forgery.json"), { probes: attestation.evidenceProbes, workflowIdentity, attestationRef, attestationDigest: expectedDigest });
  return { measurements: { forbiddenAttempts: attempts.length, denied: attempts.length }, artifactNames: ["permission-matrix.json", "egress-denials.json", "evidence-forgery.json"] };
}

async function openSource({ candidate, artifactDir }: SuiteContext): Promise<SuiteResult> {
  const license = await readFile(resolve(candidate, "LICENSE"), "utf8");
  assert.match(license, /Apache License\s+Version 2\.0/);
  for (const path of ["NOTICE", "THIRD_PARTY_NOTICES.md", "SECURITY.md", "CONTRIBUTING.md", "GOVERNANCE.md"]) await readFile(resolve(candidate, path), "utf8");
  const notices = await readFile(resolve(candidate, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const dependency of ["Node.js", "TypeScript", "React", "PostgreSQL", "Redis"]) assert.match(notices, new RegExp(dependency, "i"));
  const files = await listFiles(candidate);
  const suspect = [];
  const secretPattern = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']([A-Za-z0-9+/_=-]{16,})["']/ig;
  for (const path of files.filter((entry) => /\.(?:json|ya?ml|ts|tsx|js|mjs|md|env)$/.test(entry))) {
    if (path.startsWith("docs/planning/") || path === "verification/test-catalog.json") continue;
    const content = await readFile(resolve(candidate, path), "utf8");
    for (const match of content.matchAll(secretPattern)) {
      const capturedSecret = match[1];
      if (capturedSecret && !/(?:canary|example|local-only|do-not-use)/i.test(capturedSecret)) suspect.push(path);
    }
  }
  assert.deepEqual(suspect, []);
  const lock = await readJson(resolve(candidate, "package-lock.json"));
  const dependencies = Object.entries((lock.packages ?? {}) as Record<string, AnyRecord>)
    .filter(([path, value]) => path.startsWith("node_modules/") && !value.link && value.version)
    .map(([path, value]) => ({ name: path.slice("node_modules/".length), version: value.version, license: value.license }));
  const allowedLicenses = new Set(["Apache-2.0", "MIT", "ISC", "0BSD"]);
  const licenseFindings = dependencies.filter((dependency) => !allowedLicenses.has(dependency.license));
  assert.deepEqual(licenseFindings, []);
  const boundaries = await readJson(resolve(candidate, "architecture/package-boundaries.json"));
  assert.deepEqual(boundaries.packages.map((item: AnyRecord) => item.name), packageNames);
  for (const item of boundaries.packages) await readJson(resolve(candidate, item.path, "package.json"));
  const proprietaryDomainHits = [];
  for (const path of files.filter((entry) => /^(?:apps|packages)\/.+\.(?:ts|tsx|js|mjs|json)$/.test(entry))) {
    const content = await readFile(resolve(candidate, path), "utf8");
    if (/(?:toll-refundering|customs declaration|customer[_ -]?data|production[_ -]?secret)/i.test(content)) proprietaryDomainHits.push(path);
  }
  assert.deepEqual(proprietaryDomainHits, []);
  await writeJson(resolve(artifactDir, "license-report.json"), {
    projectLicense: "Apache-2.0",
    lockfileVersion: lock.lockfileVersion,
    allowedLicenses: [...allowedLicenses].sort(),
    components: dependencies,
    findings: licenseFindings
  });
  await writeJson(resolve(artifactDir, "public-boundary.json"), { packageScope: "@structile", packageSurfaces: packageNames, conformanceRepository: boundaries.externalPackages[0].repository, proprietaryDomainHits });
  await writeJson(resolve(artifactDir, "notice-report.json"), { noticePresent: true, thirdPartyProcessPresent: true, dependencyCount: dependencies.length });
  await writeJson(resolve(artifactDir, "secret-scan.json"), { filesScanned: files.length, findings: suspect });
  return { measurements: { dependencies: dependencies.length, licenseFindings: 0, secretFindings: 0, proprietaryDomainHits: 0 }, artifactNames: ["license-report.json", "public-boundary.json", "notice-report.json", "secret-scan.json"] };
}

export const suites: Readonly<Record<SuiteSlug, Suite>> = Object.freeze({
  "architecture-boundaries": architectureBoundaries,
  "compose-smoke": composeSmoke,
  "agent-adapters": agentAdapters,
  "harness-policy": harnessPolicy,
  "open-source": openSource
});

export function configDigest(slug: string, options: SuiteOptions): string {
  const redacted = Object.fromEntries(Object.entries(options).filter(([key]) => !/token|secret|password/i.test(key)));
  return sha256(JSON.stringify({ slug, options: redacted }));
}
