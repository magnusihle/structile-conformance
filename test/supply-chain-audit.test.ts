import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  RELEASE_MANIFEST, RELEASE_PUBLIC_KEY, RELEASE_SIGNATURE,
  auditCompose, auditContainerfile, auditLockfile, auditNotices, auditPublicationSurface,
  buildSbom, noticesDocument, verifyDeclaredRelease
} from "../src/supply-chain-audit.ts";

const DIGEST = "@sha256:1111111111111111111111111111111111111111111111111111111111111111";

const lock = {
  lockfileVersion: 3,
  packages: {
    "": { name: "structile" },
    "node_modules/react": { version: "19.2.8", resolved: "https://registry.npmjs.org/react/-/react-19.2.8.tgz", integrity: "sha512-AAAA", license: "MIT" },
    "node_modules/typescript": { version: "7.0.2", resolved: "https://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz", integrity: "sha512-BBBB", license: "Apache-2.0", dev: true },
    "node_modules/@structile/tokens": { resolved: "packages/tokens", link: true }
  }
};

const containerfile = [
  `ARG NODE_IMAGE=node:24.19.0-alpine${DIGEST}`,
  "FROM ${NODE_IMAGE} AS build",
  "RUN npm ci --ignore-scripts",
  "FROM ${NODE_IMAGE} AS runtime",
  "USER node",
  'HEALTHCHECK CMD ["node", "-e", "0"]',
  'CMD ["node", "dist/index.js"]'
].join("\n");

const compose = {
  services: {
    api: {
      image: `postgres:18.6-alpine${DIGEST}`,
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      environment: { POSTGRES_PASSWORD_FILE: "/run/secrets/postgres_password" },
      ports: [{ host_ip: "127.0.0.1", published: "8080", target: 8080 }],
      deploy: { resources: { limits: { cpus: 0.5, memory: "134217728" } } }
    }
  }
};

/**
 * Each case mutates one control input and names the finding class that must appear -- and only
 * that class. Codes are de-duplicated because one defect can legitimately fire per occurrence:
 * an unpinned base image in a two-stage build is two findings of one kind, not two defects.
 */
function expectOnly(findings: ReadonlyArray<{ code: string }>, code: string, label: string): void {
  assert.deepEqual([...new Set(findings.map((finding) => finding.code))], [code], label);
}

test("the lockfile audit is silent on a pinned lockfile and specific on each defect", () => {
  assert.deepEqual(auditLockfile(lock), []);
  const mutate = (entry: Record<string, unknown>): Record<string, unknown> =>
    ({ ...lock, packages: { ...lock.packages, "node_modules/react": { ...lock.packages["node_modules/react"], ...entry } } });
  expectOnly(auditLockfile(mutate({ integrity: undefined })), "missing-integrity", "a stripped integrity hash must be caught");
  expectOnly(auditLockfile(mutate({ resolved: "https://registry.internal.example/react.tgz" })), "unpinned-source", "a foreign registry must be caught");
  expectOnly(auditLockfile(mutate({ hasInstallScript: true })), "install-script", "an install lifecycle script must be caught");
  expectOnly(auditLockfile(mutate({ license: "SSPL-1.0" })), "unknown-license", "a non-allow-listed license must be caught");
  expectOnly(auditLockfile({ ...lock, packages: { ...lock.packages, "node_modules/@structile/tokens": { resolved: "/etc/elsewhere", link: true } } }), "workspace-link-escapes-repository", "a link outside the repository must be caught");
  assert.ok(auditLockfile({ ...lock, lockfileVersion: 2 }).some((finding) => finding.code === "lockfile-version"));
});

test("the container audit is silent on the hardened recipe and specific on each defect", () => {
  assert.deepEqual(auditContainerfile(containerfile), []);
  expectOnly(auditContainerfile(containerfile.replace("USER node", "USER root")), "root-runtime-user", "a root runtime user must be caught");
  expectOnly(auditContainerfile(containerfile.replaceAll(DIGEST, "")), "unpinned-base-image", "a mutable base tag must be caught");
  expectOnly(auditContainerfile(containerfile.replace(/^HEALTHCHECK.*$/m, "")), "missing-healthcheck", "a missing health probe must be caught");
  expectOnly(auditContainerfile(containerfile.replace(" --ignore-scripts", "")), "lifecycle-scripts-enabled", "install lifecycle scripts must be caught");
  expectOnly(auditContainerfile(`${containerfile}\nADD https://example.invalid/payload.tgz /payload.tgz`), "remote-add", "an unverified remote ADD must be caught");
  expectOnly(auditContainerfile(`${containerfile}\nENV API_KEY=abcdef0123456789`), "embedded-secret", "a baked-in secret must be caught");
  // USER takes a user[:group] form; the group must not smuggle root past the comparison.
  for (const user of ["USER root", "USER root:root", "USER 0", "USER 0:0", "USER ROOT"]) {
    expectOnly(auditContainerfile(containerfile.replace("USER node", user)), "root-runtime-user", `${user} must be caught as a root runtime user`);
  }
  for (const user of ["USER node:node", "USER 1000", "USER 1000:1000", "USER 10"]) {
    assert.deepEqual(auditContainerfile(containerfile.replace("USER node", user)), [], `${user} is not root and must not be flagged`);
  }
});

test("a notice documents a component at a word boundary, a camel-case hump or a glued version", () => {
  // Notices name dependencies the way humans do, so these must count as documented...
  assert.equal(noticesDocument("PostgreSQL image", "postgres"), true);
  assert.equal(noticesDocument("Node.js build foundation", "node"), true);
  assert.equal(noticesDocument("React and type declarations", "react"), true);
  assert.equal(noticesDocument("Redis Open Source image", "redis"), true);
  // A version glued straight onto the name is ordinary notation and still documents it. Closing
  // the "co"/"coffee-script" collision must not reject these, which a bare letter-or-digit
  // boundary did.
  assert.equal(noticesDocument("react19.2.8 MIT", "react"), true);
  assert.equal(noticesDocument("postgres14 base image", "postgres"), true);
  assert.equal(noticesDocument("Built on node18 LTS", "node"), true);
  assert.equal(noticesDocument("python3-based tooling", "python"), true);
  // ...and these must not: a component's letters appearing inside an unrelated word is not a notice.
  assert.equal(noticesDocument("This project depends on coffee-script tooling.", "co"), false);
  assert.equal(noticesDocument("uses nodemailer somewhere", "node"), false);
  assert.equal(noticesDocument("reactivity helpers", "react"), false);
  assert.equal(noticesDocument("no mention at all", "redis"), false);
});

test("the compose audit is silent on the hardened profile and specific on each defect", () => {
  assert.deepEqual(auditCompose(compose), []);
  const mutate = (entry: Record<string, unknown>): Record<string, unknown> =>
    ({ services: { api: { ...compose.services.api, ...entry } } });
  expectOnly(auditCompose(mutate({ privileged: true })), "privileged-service", "a privileged service must be caught");
  expectOnly(auditCompose(mutate({ deploy: {} })), "missing-resource-limits", "missing resource limits must be caught");
  expectOnly(auditCompose(mutate({ read_only: false })), "writable-root-filesystem", "a writable root filesystem must be caught");
  expectOnly(auditCompose(mutate({ security_opt: [] })), "missing-no-new-privileges", "unblocked privilege escalation must be caught");
  expectOnly(auditCompose(mutate({ cap_drop: [] })), "capabilities-not-dropped", "undropped capabilities must be caught");
  expectOnly(auditCompose(mutate({ cap_add: ["SYS_ADMIN"] })), "privileged-capability", "a privileged capability grant must be caught");
  expectOnly(auditCompose(mutate({ image: "postgres:18.6-alpine" })), "unpinned-service-image", "an unpinned service image must be caught");
  expectOnly(auditCompose(mutate({ environment: { POSTGRES_PASSWORD: "s3cret-inline-value" } })), "literal-secret-environment", "an inlined secret must be caught");
  expectOnly(auditCompose(mutate({ ports: [{ host_ip: "0.0.0.0", published: "8080", target: 8080 }] })), "port-exposed-beyond-loopback", "a port on every interface must be caught");
  // An empty service is not a single-defect mutant: it legitimately trips every baseline clause.
  assert.ok(auditCompose({ services: { api: {} } }).some((finding) => finding.code === "undefined-service-source"), "a service with neither image nor build must be caught");
});

test("the SBOM covers third-party packages only, split by distribution, and notices must match", () => {
  const sbom = buildSbom(lock, { name: "structile", candidate: "c00a79c894346d364b243c17dab38edf66f60a3d" });
  assert.deepEqual((sbom.packages as Array<{ name: string }>).map((entry) => entry.name), ["react", "typescript"], "workspace links are first-party and never enter the SBOM");
  assert.equal((sbom.packages as Array<{ comment: string }>).filter((entry) => entry.comment === "distributed").length, 1, "only the non-dev dependency is distributed");
  assert.deepEqual(auditNotices(sbom, "React and Node.js and PostgreSQL", ["node", "postgres"]), []);
  expectOnly(auditNotices(sbom, "React and Node.js", ["node", "redis"]), "undocumented-distributed-component", "an image with no notice must be caught");
});

test("only a release whose signature verifies suppresses a publication finding", async () => {
  const surface = { manifests: [{ path: "packages/tokens/package.json", manifest: { private: true } }], releaseTags: [], publishingWorkflows: [], verifiedReleasePresent: false };
  assert.deepEqual(auditPublicationSurface(surface), []);
  expectOnly(auditPublicationSurface({ ...surface, manifests: [{ path: "packages/tokens/package.json", manifest: { private: false } }] }), "publication-without-provenance", "a publishable workspace must be caught");
  expectOnly(auditPublicationSurface({ ...surface, releaseTags: ["v0.2.0"] }), "release-tag-without-provenance", "a release tag must be caught");
  expectOnly(auditPublicationSurface({ ...surface, publishingWorkflows: ["publish.yml"] }), "publishing-workflow-without-provenance", "a publishing workflow must be caught");
  assert.deepEqual(auditPublicationSurface({ ...surface, releaseTags: ["v0.2.0"], verifiedReleasePresent: true }), [], "a verified release clears the finding");

  const root = await mkdtemp(resolve(tmpdir(), "structile-release-"));
  try {
    assert.deepEqual(await verifyDeclaredRelease(root), { present: false, verified: false, reason: "no release manifest, signature or public key is declared" });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const manifest = Buffer.from('{"candidate":"c00a79c","artifacts":["structile-foundation-health"]}\n');
    await mkdir(resolve(root, dirname(RELEASE_MANIFEST)), { recursive: true });
    await writeFile(resolve(root, RELEASE_MANIFEST), manifest);
    const incomplete = await verifyDeclaredRelease(root);
    assert.deepEqual({ present: incomplete.present, verified: incomplete.verified }, { present: true, verified: false }, "a manifest with no signature is a declared, unverified release");
    await writeFile(resolve(root, RELEASE_SIGNATURE), signBytes(null, manifest, privateKey));
    await writeFile(resolve(root, RELEASE_PUBLIC_KEY), publicKey.export({ type: "spki", format: "pem" }) as string);
    assert.equal((await verifyDeclaredRelease(root)).verified, true, "a valid detached signature verifies");
    await writeFile(resolve(root, RELEASE_MANIFEST), Buffer.concat([manifest, Buffer.from(" ")]));
    assert.equal((await verifyDeclaredRelease(root)).verified, false, "a tampered manifest must not verify");
    // A signature proves someone signed these bytes; empty bytes sign perfectly well.
    const empty = Buffer.alloc(0);
    await writeFile(resolve(root, RELEASE_MANIFEST), empty);
    await writeFile(resolve(root, RELEASE_SIGNATURE), signBytes(null, empty, privateKey));
    const emptySigned = await verifyDeclaredRelease(root);
    assert.deepEqual({ present: emptySigned.present, verified: emptySigned.verified }, { present: true, verified: false }, "an empty but validly signed manifest declares no release");
    // Nor may a truthy non-boolean suppress a finding that protects the gate.
    assert.equal(auditPublicationSurface({ ...surface, releaseTags: ["v0.2.0"], verifiedReleasePresent: "true" as unknown as boolean }).length, 1, "only a strictly true verified release clears a finding");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
