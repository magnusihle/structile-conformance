/**
 * SEC-005 (supply-chain), fresh -- no salvage source. Requirements ARC-009, SEC-007, SEC-008,
 * OSS-003. This is the candidate-facing driver: it feeds the real candidate tree through the
 * pure audits in `supply-chain-audit.ts`, proves each audit discriminates by re-running it over
 * a synthesized mutant, and emits the five evidence artifacts the catalog declares.
 *
 * What cannot be measured offline is not zeroed out. The dependency vulnerability scan is
 * recorded as not performed with its reason; the release-signature clause is absence-asserted
 * against the candidate and qualified end to end against synthesized signed releases, so it
 * fails closed the moment a real release appears. See docs/qualification/SEC-005.md.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { command, listFiles, readJson, sha256, writeJson } from "./io.ts";
import type { SuiteContext, SuiteResult } from "./suites.ts";
import type { AnyRecord } from "./g1-support.ts";
import {
  ALLOWED_LICENSES, RELEASE_MANIFEST, RELEASE_PUBLIC_KEY, RELEASE_SIGNATURE, SECRET_ASSIGNMENT, SECRET_PLACEHOLDER,
  auditCompose, auditContainerfile, auditLockfile, auditNotices, auditPublicationSurface, buildSbom, verifyDeclaredRelease,
  type Finding, type PublicationSurface
} from "./supply-chain-audit.ts";

/* ------------------------------------------------------------------ SEC-005 */

function requireNoFindings(findings: readonly Finding[], label: string): void {
  assert.deepEqual(findings, [], `${label}: ${findings.map((finding) => `${finding.code}(${finding.subject})`).join(", ")}`);
}

/** Prove an audit discriminates: silent on the real candidate, specific on an injected defect. */
function assertDetects(control: readonly Finding[], mutant: readonly Finding[], code: string, label: string): AnyRecord {
  assert.equal(control.some((finding) => finding.code === code), false, `${label}: the control candidate must not already carry ${code}`);
  assert.ok(mutant.some((finding) => finding.code === code), `${label}: mutant must be detected as ${code}, received ${mutant.map((finding) => finding.code).join(", ") || "no finding"}`);
  return { mutant: label, code, controlClean: true, detected: true };
}

async function distTree(candidate: string): Promise<Record<string, string>> {
  const files = await listFiles(candidate, { ignored: [".git", "node_modules", "evidence", "artifacts", "coverage"] });
  const tree: Record<string, string> = {};
  for (const path of files.filter((entry) => entry.includes("/dist/"))) {
    tree[path] = sha256(await readFile(resolve(candidate, path)));
  }
  return tree;
}

export async function supplyChain({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  for (const flag of ["frozen-lockfile", "reproducible", "verify-signatures"]) {
    assert.equal(options[flag], true, `SEC-005 requires --${flag}; the catalog command declares it and the suite fails closed without it`);
  }

  // --- (a) lockfile: pinned, integrity-complete, script-free, allow-listed ---
  const lock = await readJson(resolve(candidate, "package-lock.json")) as AnyRecord;
  const lockFindings = auditLockfile(lock);
  requireNoFindings(lockFindings, "SEC-008 lockfile audit");

  const mutations: AnyRecord[] = [];
  const mutateLock = (mutate: (entry: AnyRecord) => AnyRecord): AnyRecord => {
    const clone = JSON.parse(JSON.stringify(lock)) as AnyRecord;
    const [path] = Object.entries(clone.packages as Record<string, AnyRecord>)
      .filter(([key, value]) => key.startsWith("node_modules/") && value?.link !== true)[0] as [string, AnyRecord];
    clone.packages[path] = mutate(clone.packages[path] as AnyRecord);
    return clone;
  };
  mutations.push(assertDetects(lockFindings, auditLockfile(mutateLock((entry) => ({ ...entry, integrity: undefined }))), "missing-integrity", "lockfile entry stripped of its integrity hash"));
  mutations.push(assertDetects(lockFindings, auditLockfile(mutateLock((entry) => ({ ...entry, resolved: "https://registry.internal.example/tarball.tgz" }))), "unpinned-source", "dependency redirected to a foreign registry"));
  mutations.push(assertDetects(lockFindings, auditLockfile(mutateLock((entry) => ({ ...entry, hasInstallScript: true }))), "install-script", "dependency that executes an install script"));
  mutations.push(assertDetects(lockFindings, auditLockfile(mutateLock((entry) => ({ ...entry, license: "SSPL-1.0" }))), "unknown-license", "dependency under a non-allow-listed license"));

  // --- (b) container baseline and compose profile ---
  const containerfile = await readFile(resolve(candidate, "Containerfile"), "utf8");
  const containerFindings = auditContainerfile(containerfile);
  requireNoFindings(containerFindings, "SEC-007 container audit");
  mutations.push(assertDetects(containerFindings, auditContainerfile(containerfile.replace(/^USER .*$/m, "USER root")), "root-runtime-user", "runtime stage left running as root"));
  mutations.push(assertDetects(containerFindings, auditContainerfile(containerfile.replace(/@sha256:[0-9a-f]{64}/, "")), "unpinned-base-image", "base image reduced to a mutable tag"));
  mutations.push(assertDetects(containerFindings, auditContainerfile(containerfile.replace(/^HEALTHCHECK .*$/m, "")), "missing-healthcheck", "runtime stage with no health probe"));
  mutations.push(assertDetects(containerFindings, auditContainerfile(containerfile.replace(/--ignore-scripts/, "")), "lifecycle-scripts-enabled", "build install re-enabling package lifecycle scripts"));

  // Same allowlist the G0 compose suite hands docker (src/suites.ts `dockerEnvironment`), kept
  // local because importing it from suites.ts would close an import cycle. A conformance run
  // gives a subprocess the variables it needs and nothing else.
  const dockerEnvironment = Object.fromEntries(
    ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "BUILDX_CONFIG"]
      .flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])
  );
  const composeConfig = JSON.parse((await command("docker", ["compose", "config", "--format", "json"], {
    cwd: candidate,
    env: { ...dockerEnvironment, STRUCTILE_DEV_POSTGRES_PASSWORD_FILE: "/dev/null" },
    timeout: 120_000
  })).stdout) as AnyRecord;
  const composeFindings = auditCompose(composeConfig);
  requireNoFindings(composeFindings, "ARC-009 compose audit");
  const mutateService = (mutate: (service: AnyRecord) => AnyRecord): AnyRecord => {
    const clone = JSON.parse(JSON.stringify(composeConfig)) as AnyRecord;
    const [name] = Object.keys(clone.services as AnyRecord);
    clone.services[String(name)] = mutate(clone.services[String(name)] as AnyRecord);
    return clone;
  };
  mutations.push(assertDetects(composeFindings, auditCompose(mutateService((service) => ({ ...service, privileged: true }))), "privileged-service", "compose service escalated to privileged"));
  mutations.push(assertDetects(composeFindings, auditCompose(mutateService((service) => ({ ...service, deploy: {} }))), "missing-resource-limits", "compose service with its resource limits removed"));
  mutations.push(assertDetects(composeFindings, auditCompose(mutateService((service) => ({ ...service, environment: { ...service.environment, POSTGRES_PASSWORD: "s3cret-inline-value" } }))), "literal-secret-environment", "secret inlined into the service environment"));
  mutations.push(assertDetects(composeFindings, auditCompose(mutateService((service) => ({ ...service, ports: [{ host_ip: "0.0.0.0", published: "8080", target: 8080 }] }))), "port-exposed-beyond-loopback", "service port published on every interface"));

  // --- (c) reproducible build: the same tree must emit the same bytes from a clean start ---
  await command("npm", ["run", "build"], { cwd: candidate, timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  const firstTree = await distTree(candidate);
  assert.ok(Object.keys(firstTree).length > 0, "the candidate must emit build output to compare");
  for (const directory of new Set(Object.keys(firstTree).map((path) => resolve(candidate, path.slice(0, path.indexOf("/dist/") + "/dist".length))))) {
    await rm(directory, { recursive: true, force: true });
  }
  await command("npm", ["run", "build"], { cwd: candidate, timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  const secondTree = await distTree(candidate);
  assert.deepEqual(secondTree, firstTree, "SEC-008: a clean rebuild of the same commit must emit byte-identical output");
  const pathLeaks: string[] = [];
  for (const path of Object.keys(firstTree)) {
    if ((await readFile(resolve(candidate, path), "utf8")).includes(candidate)) pathLeaks.push(path);
  }
  assert.deepEqual(pathLeaks, [], "build output must not embed the absolute path of the build host");

  // --- (d) SBOM and notices ---
  const imageComponents = [
    ...containerfile.matchAll(/(?:^|[\s=])([a-z0-9][a-z0-9._/-]*):[^\s@]+@sha256:[0-9a-f]{64}/gm),
    ...JSON.stringify(composeConfig).matchAll(/"([a-z0-9][a-z0-9._/-]*):[^\s@"]+@sha256:[0-9a-f]{64}"/g)
  ].map((match) => String(match[1]).split("/").pop() as string);
  const identity = (await command("git", ["-C", candidate, "rev-parse", "HEAD"])).stdout.trim();
  const sbom = buildSbom(lock, { name: "structile", candidate: identity });
  const notices = await readFile(resolve(candidate, "THIRD_PARTY_NOTICES.md"), "utf8");
  const noticeFindings = auditNotices(sbom, notices, imageComponents);
  requireNoFindings(noticeFindings, "OSS-003 notice audit");
  const distributedNames = (sbom.packages as AnyRecord[]).filter((entry) => entry.comment === "distributed").map((entry) => String(entry.name));
  assert.ok(distributedNames.length > 0 || imageComponents.length > 0, "the SBOM must cover a non-empty distributed surface");
  mutations.push(assertDetects(noticeFindings, auditNotices(sbom, notices, [...imageComponents, "unlisted-base-image"]), "undocumented-distributed-component", "distributed image absent from the notices"));

  // --- (e) publication surface and signature verification ---
  const workspaceManifests: Array<{ path: string; manifest: AnyRecord }> = [];
  for (const [path, raw] of Object.entries((lock.packages ?? {}) as Record<string, AnyRecord>)) {
    if (!path.startsWith("node_modules/") || raw?.link !== true) continue;
    const manifestPath = `${String(raw.resolved)}/package.json`;
    workspaceManifests.push({ path: manifestPath, manifest: await readJson(resolve(candidate, manifestPath)) as AnyRecord });
  }
  const releaseTags = (await command("git", ["-C", candidate, "tag", "--list", "v*"])).stdout.split("\n").map((tag) => tag.trim()).filter(Boolean);
  const publishingWorkflows: string[] = [];
  const workflowDirectory = resolve(candidate, ".github/workflows");
  if (existsSync(workflowDirectory)) {
    for (const path of await listFiles(workflowDirectory)) {
      const text = await readFile(resolve(workflowDirectory, path), "utf8");
      if (/npm\s+publish|docker\s+push|actions\/attest|cosign\s+sign/.test(text)) publishingWorkflows.push(path);
    }
  }
  const declaredRelease = await verifyDeclaredRelease(candidate);
  const surface: PublicationSurface = { manifests: workspaceManifests, releaseTags, publishingWorkflows, verifiedReleasePresent: declaredRelease.verified };
  const publicationFindings = auditPublicationSurface(surface);
  requireNoFindings(publicationFindings, "SEC-008 publication-surface audit");
  mutations.push(assertDetects(publicationFindings, auditPublicationSurface({ ...surface, manifests: [{ path: "packages/tokens/package.json", manifest: { private: false } }] }), "publication-without-provenance", "workspace made publishable with no signed release"));
  mutations.push(assertDetects(publicationFindings, auditPublicationSurface({ ...surface, releaseTags: ["v0.2.0"] }), "release-tag-without-provenance", "release tag cut with no signed release"));
  mutations.push(assertDetects(publicationFindings, auditPublicationSurface({ ...surface, publishingWorkflows: ["publish.yml"] }), "publishing-workflow-without-provenance", "publishing workflow added with no signed release"));

  // The candidate declares no release, so `verifyDeclaredRelease` above had nothing to verify.
  // Qualify that exact code path end to end against synthesized release directories, so its
  // fail-closed behaviour is proven now rather than asserted later: only a manifest whose
  // detached signature verifies over its exact bytes counts as a release, and only a verified
  // release suppresses a publication finding.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { publicKey: foreignKey } = generateKeyPairSync("ed25519");
  const manifestBytes = Buffer.from(`${JSON.stringify({ candidate: identity, artifacts: ["structile-foundation-health"] }, null, 2)}\n`);
  const unshapedBytes = Buffer.from(`${JSON.stringify({ note: "signed, but declares no candidate and no artifacts" }, null, 2)}\n`);
  const releaseCases: Array<{ label: string; expected: boolean; files: Record<string, Buffer> }> = [
    { label: "valid-signature", expected: true, files: { manifest: manifestBytes, signature: signBytes(null, manifestBytes, privateKey), key: Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string) } },
    { label: "tampered-manifest", expected: false, files: { manifest: Buffer.concat([manifestBytes, Buffer.from(" ")]), signature: signBytes(null, manifestBytes, privateKey), key: Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string) } },
    { label: "truncated-signature", expected: false, files: { manifest: manifestBytes, signature: signBytes(null, manifestBytes, privateKey).subarray(0, 32), key: Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string) } },
    { label: "empty-signature", expected: false, files: { manifest: manifestBytes, signature: Buffer.alloc(0), key: Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string) } },
    { label: "foreign-key", expected: false, files: { manifest: manifestBytes, signature: signBytes(null, manifestBytes, privateKey), key: Buffer.from(foreignKey.export({ type: "spki", format: "pem" }) as string) } },
    // Validly signed, but it declares no candidate and no artifacts. A signature proves someone
    // signed these bytes, not that the bytes release anything.
    { label: "unshaped-manifest", expected: false, files: { manifest: unshapedBytes, signature: signBytes(null, unshapedBytes, privateKey), key: Buffer.from(publicKey.export({ type: "spki", format: "pem" }) as string) } }
  ];
  const signatureChecks: AnyRecord[] = [];
  for (const testCase of releaseCases) {
    const root = resolve(artifactDir, "release-qualification", testCase.label);
    await mkdir(resolve(root, dirname(RELEASE_MANIFEST)), { recursive: true });
    await writeFile(resolve(root, RELEASE_MANIFEST), testCase.files.manifest as Buffer);
    await writeFile(resolve(root, RELEASE_SIGNATURE), testCase.files.signature as Buffer);
    await writeFile(resolve(root, RELEASE_PUBLIC_KEY), testCase.files.key as Buffer);
    const outcome = await verifyDeclaredRelease(root);
    assert.equal(outcome.present, true, `SEC-005 release verification: ${testCase.label} must be seen as a declared release`);
    assert.equal(outcome.verified, testCase.expected, `SEC-005 release verification: ${testCase.label} must be ${testCase.expected ? "verified" : "rejected"} (${outcome.reason})`);
    // A rejected release must leave the publication findings standing, which is the property
    // that actually protects the gate; a verified one may suppress them.
    const publishable = auditPublicationSurface({ ...surface, manifests: [{ path: "packages/tokens/package.json", manifest: { private: false } }], verifiedReleasePresent: outcome.verified });
    assert.equal(publishable.length === 0, testCase.expected, `SEC-005: a ${testCase.label} release must ${testCase.expected ? "clear" : "leave"} the publication finding standing`);
    signatureChecks.push({ label: testCase.label, verified: outcome.verified, expected: testCase.expected, reason: outcome.reason, publicationFindings: publishable.length });
  }
  // An incomplete release -- manifest without its signature -- is a release, and it fails. It is
  // measured against the same publishable-surface override as the cases above: the real
  // candidate's surface is already clean, so reporting a finding count against it would record a
  // zero that proves nothing about whether the release was rejected.
  {
    const root = resolve(artifactDir, "release-qualification", "missing-signature");
    await mkdir(resolve(root, dirname(RELEASE_MANIFEST)), { recursive: true });
    await writeFile(resolve(root, RELEASE_MANIFEST), manifestBytes);
    const outcome = await verifyDeclaredRelease(root);
    assert.deepEqual({ present: outcome.present, verified: outcome.verified }, { present: true, verified: false }, "SEC-005: a manifest with no signature must count as a declared, unverified release");
    const publishable = auditPublicationSurface({ ...surface, manifests: [{ path: "packages/tokens/package.json", manifest: { private: false } }], verifiedReleasePresent: outcome.verified });
    assert.equal(publishable.length, 1, "SEC-005: a release with no signature must leave the publication finding standing");
    signatureChecks.push({ label: "missing-signature", verified: outcome.verified, expected: false, reason: outcome.reason, publicationFindings: publishable.length });
  }

  // --- (f) secret scan over what the image build actually copies ---
  const copied = [...containerfile.matchAll(/^COPY\s+(?:--[^\s]+\s+)*(.+)$/gm)]
    .flatMap((match) => String(match[1]).split(/\s+/).slice(0, -1))
    .filter((source) => !source.startsWith("--"));
  const contextFiles = (await listFiles(candidate)).filter((path) => copied.some((source) => path === source || path.startsWith(`${source.replace(/\/$/, "")}/`)));
  const secretFindings: Finding[] = [];
  for (const path of contextFiles) {
    const match = SECRET_ASSIGNMENT.exec(await readFile(resolve(candidate, path), "utf8"));
    if (match && !SECRET_PLACEHOLDER.test(String(match[1]))) {
      secretFindings.push({ code: "secret-in-build-context", subject: path, detail: "secret-shaped assignment inside the image build context" });
    }
  }
  requireNoFindings(secretFindings, "SEC-007 build-context secret scan");
  assert.ok(contextFiles.length > 0, "the build-context scan must have files to scan");

  await writeJson(resolve(artifactDir, "container-policy.json"), {
    containerfile: { findings: containerFindings, stages: (containerfile.match(/^FROM /gm) ?? []).length },
    compose: { services: Object.keys(composeConfig.services ?? {}), findings: composeFindings },
    buildContextFilesScanned: contextFiles.length
  });
  await writeJson(resolve(artifactDir, "sbom.spdx.json"), sbom);
  await writeJson(resolve(artifactDir, "license-report.json"), {
    allowedLicenses: [...ALLOWED_LICENSES].sort(),
    lockfileVersion: lock.lockfileVersion,
    components: (sbom.packages as AnyRecord[]).map((entry) => ({ name: entry.name, version: entry.versionInfo, license: entry.licenseDeclared, distributed: entry.comment === "distributed" })),
    distributedComponents: distributedNames,
    imageComponents: [...new Set(imageComponents)],
    findings: [...lockFindings, ...noticeFindings]
  });
  await writeJson(resolve(artifactDir, "scan-report.json"), {
    secretScan: { scope: "container build context", filesScanned: contextFiles.length, findings: secretFindings },
    lifecycleScriptScan: { scope: "every locked dependency", findings: lockFindings.filter((finding) => finding.code === "install-script") },
    licenseScan: { findings: lockFindings.filter((finding) => finding.code === "unknown-license") },
    iacScan: { scope: "Containerfile and compose profile", findings: [...containerFindings, ...composeFindings] },
    dependencyVulnerabilityScan: {
      performed: false,
      findings: null,
      reason: "the protected runner has no network and no vulnerability database; a CVE scan cannot be performed offline and this suite will not emit a zero it did not measure"
    },
    mutants: mutations
  });
  await writeJson(resolve(artifactDir, "provenance.json"), {
    candidate: identity,
    releaseSurface: {
      publishableWorkspaces: workspaceManifests.filter(({ manifest }) => manifest.private !== true).map(({ path }) => path),
      workspacesInspected: workspaceManifests.length,
      releaseTags,
      publishingWorkflows,
      declaredRelease
    },
    signatureVerification: {
      performedAgainstRelease: declaredRelease.present,
      verified: declaredRelease.verified,
      reason: `${declaredRelease.reason}; every workspace is private, no release tag exists and no workflow publishes. Expected release paths: ${RELEASE_MANIFEST}, ${RELEASE_SIGNATURE}, ${RELEASE_PUBLIC_KEY}`,
      failClosedChecks: signatureChecks
    },
    pinnedImageDigests: [...new Set([...containerfile.matchAll(/@sha256:[0-9a-f]{64}/g)].map((match) => match[0]))],
    findings: publicationFindings
  });

  return {
    measurements: {
      lockedComponents: (sbom.packages as AnyRecord[]).length,
      distributedComponents: distributedNames.length + new Set(imageComponents).size,
      lockfileFindings: lockFindings.length,
      containerFindings: containerFindings.length,
      composeFindings: composeFindings.length,
      noticeFindings: noticeFindings.length,
      publicationFindings: publicationFindings.length,
      secretFindings: secretFindings.length,
      reproducibleBuildOutputs: Object.keys(firstTree).length,
      signatureFailClosedChecks: signatureChecks.length,
      dependencyVulnerabilityScanPerformed: false,
      mutantsDetected: mutations.length
    },
    artifactNames: ["container-policy.json", "sbom.spdx.json", "license-report.json", "scan-report.json", "provenance.json"]
  };
}
