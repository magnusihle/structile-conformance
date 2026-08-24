import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { command } from "./io.ts";

export type AnyRecord = Record<string, any>;

/** Values that must never appear in a token, catalog or specification string. */
export const FORBIDDEN_STYLE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ["url-function", /url\s*\(/i],
  ["css-expression", /expression\s*\(/i],
  ["javascript-scheme", /javascript\s*:/i],
  ["data-scheme", /data\s*:/i],
  ["css-import", /@import/i],
  ["css-important", /!important/i],
  ["markup", /<\/?[a-z]/i],
  ["css-block", /[{}]/],
  ["escape", /\\/],
  ["event-handler", /\bon[a-z]+\s*=/i]
] as const);

/** Payload classes a data-only specification must reject. */
export const INJECTION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ["script-tag", /<\s*script/i],
  ["markup", /<\/?[a-z]/i],
  ["javascript-scheme", /javascript\s*:/i],
  ["data-scheme", /data\s*:/i],
  ["event-handler", /\bon[a-z]+\s*=/i],
  ["css-expression", /expression\s*\(/i],
  ["url-function", /url\s*\(/i],
  ["template", /\{\{|\}\}/],
  ["sql-metacharacter", /(--|;|\/\*|\*\/|\bunion\b|\bselect\b|\bdrop\b)/i],
  ["absolute-url", /^[a-z][a-z0-9+.-]*:\/\//i],
  ["scheme-relative-url", /^\/\//]
] as const);

export const POLLUTION_KEYS: readonly string[] = Object.freeze(["__proto__", "constructor", "prototype"]);

/** Deterministic PRNG. Fuzzing must be reproducible from a recorded seed. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build one candidate workspace and import its built entry point. */
export async function buildAndImport(candidate: string, packageName: string, packagePath: string): Promise<AnyRecord> {
  await command("npm", ["run", "build", "--workspace", packageName], { cwd: candidate, timeout: 300_000 });
  const modulePath = resolve(candidate, packagePath, "dist/index.js");
  return await import(`${pathToFileURL(modulePath).href}?conformance=${Date.now()}`) as AnyRecord;
}

export function requireExports(module: AnyRecord, names: readonly string[], label: string): void {
  const missing = names.filter((name) => module[name] === undefined);
  assert.deepEqual(missing, [], `${label} must export ${missing.join(", ")}`);
}

/** Independent sRGB relative luminance; never delegate this to the candidate. */
function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(match, `color token must be #rrggbb sRGB, received ${hex}`);
  const value = match[1] as string;
  const channel = (offset: number): number => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a >= b ? [a, b] : [b, a];
  return ((light as number) + 0.05) / ((dark as number) + 0.05);
}

/**
 * Upper bounds on the complexity limits a candidate may declare. The suite owns these
 * for the same reason it owns the contrast minimums: probes built from candidate-supplied
 * limits only prove "the implementation enforces whatever it declares", which a candidate
 * satisfies trivially by declaring weak limits. A candidate may be stricter, never looser.
 */
export const LIMIT_CEILINGS: Readonly<Record<string, number>> = Object.freeze({
  // Derived from verification/reference-fixture.md, the mandated G4 conformance
  // application, with roughly 3x headroom for real products:
  //   Northstar's seven required routes total ~81 nodes; largest page ~16.
  //   Deepest required nesting (page > section > grid > card > content) is ~5.
  //   ~81 nodes serialises to well under 256 KB.
  maxDepth: 16,
  maxNodes: 400,
  maxBytes: 1_048_576,
  // Runaway-recursion bound over the raw document. Must exceed the node-tree depth (each
  // node level costs roughly three JSON levels) without becoming unbounded.
  maxStructuralDepth: 128,
  // Provisional: the static cost model is not defined until G3 (QRY-*). This bounds
  // the field so a candidate cannot declare an unbounded budget in the meantime.
  maxCost: 10_000
});

/** WCAG 2.2 AA minimums the suite enforces; the candidate cannot lower these. */
export const CONTRAST_MINIMUM: Readonly<Record<string, number>> = Object.freeze({
  body: 4.5,
  large: 3,
  ui: 3
});

/** Every container path in a document, so fuzzing is not limited to the top level. */
export function collectPaths(value: unknown, path: readonly string[] = [], out: Array<readonly string[]> = []): Array<readonly string[]> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      out.push([...path, String(index)]);
      collectPaths(item, [...path, String(index)], out);
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push([...path, key]);
      collectPaths(item, [...path, key], out);
    }
  }
  return out;
}

/** Resolve the container holding `path`'s final segment, or undefined if absent. */
export function resolveParent(root: unknown, path: readonly string[]): { parent: any; key: string } | undefined {
  if (path.length === 0) return undefined;
  let node: any = root;
  for (const segment of path.slice(0, -1)) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[segment];
  }
  if (node === null || typeof node !== "object") return undefined;
  return { parent: node, key: path[path.length - 1] as string };
}

/** Assert a validator rejects a value atomically with its declared error type. */
export async function assertRejects(
  invoke: () => unknown,
  errorName: string,
  label: string
): Promise<{ label: string; rejected: true; error: string }> {
  try {
    await invoke();
  } catch (error) {
    const failure = error as { name?: string; constructor?: { name?: string }; message?: string };
    const actual = failure.name ?? failure.constructor?.name ?? "";
    assert.equal(actual, errorName, `${label} must reject with ${errorName}, received ${actual}`);
    return { label, rejected: true, error: String(failure.message ?? "") };
  }
  assert.fail(`${label} was accepted but must be rejected`);
}

/**
 * Assert a probe *discriminates*: the control must be accepted and the poisoned variant
 * rejected. A bare rejection assertion can pass for an unrelated reason — a poisoned
 * colour value tripping a format check, or a malformed page tripping a shape check —
 * which silently turns the probe into a no-op. Pairing every negative with its control
 * makes that class of masking impossible by construction rather than by vigilance.
 */
export async function assertDiscriminates(
  invokeControl: () => unknown,
  invokePoisoned: () => unknown,
  errorName: string,
  label: string
): Promise<{ label: string; rejected: true; error: string; controlAccepted: true }> {
  try {
    await invokeControl();
  } catch (error) {
    const failure = error as { message?: string };
    assert.fail(`${label}: control input must be accepted, but was rejected (${String(failure.message ?? error)}). ` +
      "The probe cannot attribute a rejection to the injected defect.");
  }
  const outcome = await assertRejects(invokePoisoned, errorName, label);
  return { ...outcome, controlAccepted: true };
}

/** Prove no validator mutated Object.prototype. */
export function assertPrototypeIntact(): void {
  const probe = {} as AnyRecord;
  for (const key of ["polluted", "isAdmin", "__structileCanary"]) {
    assert.equal(probe[key], undefined, `Object.prototype leaked ${key}`);
  }
}
