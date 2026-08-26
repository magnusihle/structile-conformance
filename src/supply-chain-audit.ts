/**
 * Supply-chain audit primitives for SEC-005 (requirements ARC-009, SEC-007, SEC-008, OSS-003).
 *
 * Every function here is pure over parsed inputs and returns findings rather than throwing, so
 * the same audit can be run twice: once over the real candidate (the control, which must yield
 * no findings) and once over a synthesized mutant (which must yield exactly the expected finding
 * code). A bare "the candidate passes" assertion cannot tell a working audit from an audit that
 * never fires, which is why the suite in `suites-sec.ts` and the unit tests both drive these in
 * control/mutant pairs.
 *
 * The protected runner has no network, no scanner and no registry, so every check is an offline,
 * deterministic analysis of the candidate tree. A clause that cannot be verified for real is
 * absence-asserted here -- and fails closed the moment the absence ends -- never zeroed out.
 */
import { verify as verifyBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AnyRecord } from "./g1-support.ts";

export interface Finding { code: string; subject: string; detail: string }

const REGISTRY = "https://registry.npmjs.org/";
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;
/** Licenses that may be distributed without a human review checkpoint (OSS-003). */
export const ALLOWED_LICENSES = new Set(["Apache-2.0", "MIT", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause"]);
/** Capabilities that defeat the SEC-007 "minimally privileged" baseline if granted back. */
const PRIVILEGED_CAPABILITIES = new Set(["SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_BOOT", "NET_ADMIN", "NET_RAW", "DAC_READ_SEARCH", "ALL"]);
export const SECRET_ASSIGNMENT = /(?:api[_-]?key|secret|password|token|credential)s?\s*[:=]\s*["']?([A-Za-z0-9+/_=-]{12,})/i;
export const SECRET_PLACEHOLDER = /(?:canary|example|local-only|do-not-use|changeme|placeholder)/i;
/** Where SEC-005 expects a signed release to declare itself. Absence is asserted, not assumed. */
export const RELEASE_MANIFEST = "delivery/release-manifest.json";
export const RELEASE_SIGNATURE = "delivery/release-manifest.sig";
export const RELEASE_PUBLIC_KEY = "delivery/release-signing.pub";

/* ------------------------------------------------------------------ audits */

/** SEC-008 lockfile clause: every external component pinned, integrity-checked and script-free. */
export function auditLockfile(lock: AnyRecord): Finding[] {
  const findings: Finding[] = [];
  if (Number(lock.lockfileVersion) < 3) {
    findings.push({ code: "lockfile-version", subject: "package-lock.json", detail: `lockfileVersion ${String(lock.lockfileVersion)} predates integrity-complete lockfiles` });
  }
  for (const [path, raw] of Object.entries((lock.packages ?? {}) as Record<string, AnyRecord>)) {
    if (!path.startsWith("node_modules/")) continue;
    const entry = raw ?? {};
    const name = path.slice("node_modules/".length);
    const resolved = typeof entry.resolved === "string" ? entry.resolved : "";
    if (entry.link === true) {
      // A workspace link must stay inside the repository; a link that escapes it is an
      // unreviewed dependency wearing a first-party name.
      if (resolved === "" || /^[a-z][a-z0-9+.-]*:/i.test(resolved) || resolved.startsWith("/") || resolved.split("/").includes("..")) {
        findings.push({ code: "workspace-link-escapes-repository", subject: name, detail: `link resolves to ${resolved || "nothing"}` });
      }
      continue;
    }
    if (!resolved.startsWith(REGISTRY)) {
      findings.push({ code: "unpinned-source", subject: name, detail: `resolved from ${resolved || "nothing"} rather than the public registry` });
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(entry.integrity ?? ""))) {
      findings.push({ code: "missing-integrity", subject: name, detail: "no sha512 subresource integrity" });
    }
    if (entry.hasInstallScript === true) {
      findings.push({ code: "install-script", subject: name, detail: "executes an install lifecycle script" });
    }
    if (!ALLOWED_LICENSES.has(String(entry.license ?? ""))) {
      findings.push({ code: "unknown-license", subject: name, detail: `license ${String(entry.license ?? "absent")} is outside the allowed set` });
    }
  }
  return findings;
}

function expandArgs(value: string, args: ReadonlyMap<string, string>): string {
  return value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => args.get(name) ?? whole);
}

/** SEC-007 container baseline, read off the build recipe rather than off a claim about it. */
export function auditContainerfile(text: string): Finding[] {
  const findings: Finding[] = [];
  const args = new Map<string, string>();
  let stages = 0;
  let finalStageUser = "";
  let finalStageHealthcheck = false;
  for (const line of text.split("\n").map((entry) => entry.trim()).filter((entry) => entry.length > 0 && !entry.startsWith("#"))) {
    const [head, ...rest] = line.split(/\s+/);
    const instruction = String(head).toUpperCase();
    const value = rest.join(" ");
    if (instruction === "ARG") {
      const [key, ...defaulted] = value.split("=");
      args.set(String(key).trim(), defaulted.join("=").trim());
    }
    if (instruction === "FROM") {
      stages += 1;
      finalStageUser = "";
      finalStageHealthcheck = false;
      const image = expandArgs(String(rest[0] ?? ""), args);
      if (!DIGEST_PINNED.test(image)) {
        findings.push({ code: "unpinned-base-image", subject: image, detail: "base image is not pinned to a sha256 digest" });
      }
    }
    if (instruction === "USER") finalStageUser = value.trim();
    if (instruction === "HEALTHCHECK") finalStageHealthcheck = !/^NONE\b/i.test(value);
    if (instruction === "ADD" && /https?:\/\//i.test(value)) {
      findings.push({ code: "remote-add", subject: value, detail: "ADD fetches a remote artifact into the image unverified" });
    }
    if (instruction === "RUN" && /\bnpm\s+(?:ci|i|install|add)\b/.test(value) && !/--ignore-scripts\b/.test(value)) {
      findings.push({ code: "lifecycle-scripts-enabled", subject: value, detail: "dependency install runs package lifecycle scripts" });
    }
    if ((instruction === "ENV" || instruction === "ARG") && SECRET_ASSIGNMENT.test(line) && !SECRET_PLACEHOLDER.test(line)) {
      findings.push({ code: "embedded-secret", subject: instruction, detail: "a secret-shaped value is baked into an image layer" });
    }
  }
  if (stages === 0) findings.push({ code: "no-build-stage", subject: "Containerfile", detail: "no FROM instruction" });
  // USER takes a `user[:group]` form, so the group must be stripped before the comparison:
  // `USER root:root` is every bit as root as `USER root`, and a check that misses it hands
  // back the SEC-007 baseline for the price of three characters.
  const runtimeUser = (finalStageUser.split(":")[0] ?? "").trim();
  if (runtimeUser === "" || runtimeUser.toLowerCase() === "root" || /^0+$/.test(runtimeUser)) {
    findings.push({ code: "root-runtime-user", subject: finalStageUser || "implicit root", detail: "the runtime stage does not drop to a non-root user" });
  }
  if (!finalStageHealthcheck) {
    findings.push({ code: "missing-healthcheck", subject: "Containerfile", detail: "the runtime stage declares no HEALTHCHECK" });
  }
  return findings;
}

/** ARC-009/SEC-007 as they apply to the reproducible Compose profile, via docker's own parse. */
export function auditCompose(config: AnyRecord): Finding[] {
  const findings: Finding[] = [];
  for (const [name, raw] of Object.entries((config.services ?? {}) as Record<string, AnyRecord>)) {
    const service = raw ?? {};
    if (typeof service.image === "string" && !DIGEST_PINNED.test(service.image)) {
      findings.push({ code: "unpinned-service-image", subject: name, detail: `image ${service.image} is not digest-pinned` });
    }
    if (service.image === undefined && service.build === undefined) {
      findings.push({ code: "undefined-service-source", subject: name, detail: "service declares neither an image nor a build" });
    }
    if (service.privileged === true) findings.push({ code: "privileged-service", subject: name, detail: "runs privileged" });
    if (service.read_only !== true) findings.push({ code: "writable-root-filesystem", subject: name, detail: "root filesystem is writable" });
    if (!((service.security_opt ?? []) as string[]).includes("no-new-privileges:true")) {
      findings.push({ code: "missing-no-new-privileges", subject: name, detail: "privilege escalation is not blocked" });
    }
    if (!((service.cap_drop ?? []) as string[]).includes("ALL")) {
      findings.push({ code: "capabilities-not-dropped", subject: name, detail: "does not drop ALL capabilities before granting any back" });
    }
    for (const capability of (service.cap_add ?? []) as string[]) {
      if (PRIVILEGED_CAPABILITIES.has(String(capability).toUpperCase())) {
        findings.push({ code: "privileged-capability", subject: `${name}:${capability}`, detail: "grants back a capability that defeats the minimal-privilege baseline" });
      }
    }
    const limits = ((service.deploy ?? {}).resources ?? {}).limits ?? {};
    if (limits.memory === undefined || limits.cpus === undefined) {
      findings.push({ code: "missing-resource-limits", subject: name, detail: "no cpu and memory limit" });
    }
    for (const [key, value] of Object.entries((service.environment ?? {}) as Record<string, unknown>)) {
      if (/_FILE$/.test(key)) continue; // a path to a secret is the required form, not a leak
      if (SECRET_ASSIGNMENT.test(`${key}=${String(value)}`) && !SECRET_PLACEHOLDER.test(String(value))) {
        findings.push({ code: "literal-secret-environment", subject: `${name}:${key}`, detail: "a secret value is passed in the environment rather than by file" });
      }
    }
    for (const port of (service.ports ?? []) as AnyRecord[]) {
      const host = String(port.host_ip ?? "");
      if (host !== "127.0.0.1" && host !== "::1") {
        findings.push({ code: "port-exposed-beyond-loopback", subject: `${name}:${String(port.published)}`, detail: `published on ${host || "all interfaces"}` });
      }
    }
  }
  return findings;
}

/** SPDX 2.3 document generated from the lockfile, so the SBOM cannot drift from what is installed. */
export function buildSbom(lock: AnyRecord, meta: { name: string; candidate: string }): AnyRecord {
  const packages: AnyRecord[] = [];
  const relationships: AnyRecord[] = [];
  for (const [path, raw] of Object.entries((lock.packages ?? {}) as Record<string, AnyRecord>)) {
    if (!path.startsWith("node_modules/")) continue;
    const entry = raw ?? {};
    if (entry.link === true) continue; // first-party workspace, not third-party supply
    const name = path.slice("node_modules/".length);
    const id = `SPDXRef-Package-${name.replace(/[^A-Za-z0-9.-]/g, "-")}`;
    const integrity = String(entry.integrity ?? "");
    packages.push({
      SPDXID: id,
      name,
      versionInfo: String(entry.version ?? ""),
      downloadLocation: String(entry.resolved ?? "NOASSERTION"),
      filesAnalyzed: false,
      licenseDeclared: String(entry.license ?? "NOASSERTION"),
      licenseConcluded: "NOASSERTION",
      supplier: "NOASSERTION",
      checksums: integrity.startsWith("sha512-")
        ? [{ algorithm: "SHA512", checksumValue: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex") }]
        : [],
      // The distributed/dev split is what OSS-003's notice obligation keys off.
      primaryPackagePurpose: "LIBRARY",
      comment: entry.dev === true ? "development-only" : "distributed"
    });
    relationships.push({ spdxElementId: "SPDXRef-Document", relatedSpdxElement: id, relationshipType: entry.dev === true ? "DEV_DEPENDENCY_OF" : "DEPENDS_ON" });
  }
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-Document",
    name: `${meta.name}-${meta.candidate.slice(0, 12)}`,
    documentNamespace: `https://github.com/magnusihle/structile/sbom/${meta.candidate}`,
    creationInfo: { creators: ["Tool: structile-conformance-SEC-005"], created: "1970-01-01T00:00:00Z" },
    packages: packages.sort((left, right) => String(left.name).localeCompare(String(right.name))),
    relationships
  };
}

/**
 * Does the notices text actually document `component`, as opposed to merely containing its
 * letters? A plain substring test lets a package named `co` count as documented by the word
 * "coffee-script". A plain word boundary is equally wrong in the other direction: notices name
 * dependencies the way humans do, so `postgres` legitimately documents "PostgreSQL" and `node`
 * documents "Node.js". The rule that satisfies both is a match at a word start that ends where
 * the identifier ends: at a non-letter, at a camel-case hump, or at a version digit glued
 * straight onto the name, since "react19.2.8", "postgres14" and "node18" are all ordinary ways
 * to write a dependency down. The trailing test reads the original casing deliberately -- a
 * case-insensitive class would treat the "Q" of PostgreSQL as a lowercase letter and reject a
 * genuine notice.
 *
 * The residual trade-off is deliberate and runs toward the safe side of a false alarm: a very
 * short name can still be documented by an unrelated capitalised word ("co" by "CoStar"). The
 * alternative -- a strict word boundary -- would reject "PostgreSQL" as a notice for `postgres`
 * and fail a candidate whose notices are perfectly correct.
 */
export function noticesDocument(notices: string, component: string): boolean {
  const needle = component.toLowerCase();
  const haystack = notices.toLowerCase();
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    const before = index === 0 ? "" : (notices[index - 1] as string);
    const after = notices[index + needle.length] ?? "";
    if ((before === "" || !/[A-Za-z0-9]/.test(before)) && (after === "" || !/[a-z]/.test(after))) return true;
  }
  return false;
}

/** OSS-003: everything distributed must carry a notice, images included. */
export function auditNotices(sbom: AnyRecord, notices: string, imageComponents: readonly string[]): Finding[] {
  const distributed = (sbom.packages as AnyRecord[])
    .filter((entry) => entry.comment === "distributed")
    .map((entry) => String(entry.name).replace(/^@[^/]+\//, ""));
  const findings: Finding[] = [];
  for (const component of [...new Set([...distributed, ...imageComponents])]) {
    if (!noticesDocument(notices, component)) {
      findings.push({ code: "undocumented-distributed-component", subject: component, detail: "distributed component has no third-party notice" });
    }
  }
  return findings;
}

export interface PublicationSurface {
  manifests: ReadonlyArray<{ path: string; manifest: AnyRecord }>;
  releaseTags: readonly string[];
  publishingWorkflows: readonly string[];
  /** Only a release whose signature *verified* suppresses these findings; presence is not proof. */
  verifiedReleasePresent: boolean;
}

/**
 * SEC-008's signing clause applies to releases. At v0.2 nothing is published, so the suite
 * asserts *why* that is true -- every workspace is private, no release tag exists and no
 * workflow publishes -- rather than reporting a vacuous zero. The moment any of those opens
 * without a signed release manifest, this fails closed.
 */
export function auditPublicationSurface(surface: PublicationSurface): Finding[] {
  const findings: Finding[] = [];
  const publishable: string[] = [];
  for (const { path, manifest } of surface.manifests) {
    if (manifest.private !== true || manifest.publishConfig !== undefined) publishable.push(path);
  }
  // Strictly true, never merely truthy: a `"true"` string arriving from untyped JSON must not
  // be able to suppress a finding that protects the gate.
  if (surface.verifiedReleasePresent === true) return findings;
  for (const path of publishable) {
    findings.push({ code: "publication-without-provenance", subject: path, detail: "publishable package with no signed release manifest" });
  }
  for (const tag of surface.releaseTags) {
    findings.push({ code: "release-tag-without-provenance", subject: tag, detail: "release tag with no signed release manifest" });
  }
  for (const workflow of surface.publishingWorkflows) {
    findings.push({ code: "publishing-workflow-without-provenance", subject: workflow, detail: "workflow publishes artifacts with no signed release manifest" });
  }
  return findings;
}

/** The detached-signature check SEC-005 applies to a release manifest when one exists. */
export function verifyDetached(payload: Buffer, signature: Buffer, publicKey: string): boolean {
  if (signature.length === 0) return false;
  try {
    return verifyBytes(null, payload, publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * The real release-verification path. A declared release is verified or it is not a release:
 * a manifest present without a valid detached signature over its exact bytes returns
 * `verified: false`, which leaves every publication finding standing. `root` is a directory
 * holding the three release paths, so the same code runs against the candidate and against
 * the synthesized releases used to qualify it.
 */
export async function verifyDeclaredRelease(root: string): Promise<{ present: boolean; verified: boolean; reason: string }> {
  const paths = [RELEASE_MANIFEST, RELEASE_SIGNATURE, RELEASE_PUBLIC_KEY].map((path) => resolve(root, path));
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length === paths.length) return { present: false, verified: false, reason: "no release manifest, signature or public key is declared" };
  if (missing.length > 0) return { present: true, verified: false, reason: `release declared but incomplete: ${missing.length} of ${paths.length} release files are missing` };
  const [manifest, signature, publicKey] = await Promise.all(paths.map((path) => readFile(path)));
  // A signature proves only that someone signed these bytes. Empty bytes sign perfectly well,
  // so the manifest must also say what it releases before it counts as a release.
  let declaresRelease = false;
  try {
    const parsed = JSON.parse((manifest as Buffer).toString("utf8")) as AnyRecord;
    declaresRelease = typeof parsed?.candidate === "string" && parsed.candidate.length > 0
      && Array.isArray(parsed?.artifacts) && parsed.artifacts.length > 0;
  } catch {
    declaresRelease = false;
  }
  if (!declaresRelease) return { present: true, verified: false, reason: "release manifest does not declare a candidate commit and at least one artifact" };
  const verified = verifyDetached(manifest as Buffer, signature as Buffer, (publicKey as Buffer).toString("utf8"));
  return { present: true, verified, reason: verified ? "detached signature verifies over the manifest bytes" : "detached signature does not verify over the manifest bytes" };
}
