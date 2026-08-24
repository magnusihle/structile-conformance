/**
 * G1 protected suites, ported from the superseded `g1/protected-suites` branch onto the
 * hardened `g1-support.ts` shared module. Suites are appended here in re-cut order, one
 * per PR: DS-001 (design-system), then SPEC-001 (spec-fuzz), then ACT-001 (action-contract),
 * then CAP-001 (capability-contract) here; later suites (SPEC-002, PKG-001, HAR-004) are
 * ported in their own PRs, not batched into this file.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { command, listFiles, readJson, writeJson } from "./io.ts";
import { runnerRoot } from "./catalog.ts";
import type { SuiteContext, SuiteResult } from "./suites.ts";
import {
  CONTRAST_MINIMUM, FORBIDDEN_STYLE_PATTERNS, INJECTION_PATTERNS, LIMIT_CEILINGS, POLLUTION_KEYS,
  assertDiscriminates, assertPrototypeIntact, assertRejects, buildAndImport, collectPaths, contrastRatio,
  createRandom, requireExports, resolveParent, type AnyRecord
} from "./g1-support.ts";

const TOKEN_CATEGORIES = ["color", "typography", "spacing", "elevation", "motion", "density"] as const;

function forbiddenHits(value: string): string[] {
  return FORBIDDEN_STYLE_PATTERNS.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}

/** Scan every string value in a structure. JSON punctuation is not a style value. */
function forbiddenHitsDeep(value: unknown, path = "$"): Array<{ path: string; hits: string[] }> {
  if (typeof value === "string") {
    const hits = forbiddenHits(value);
    return hits.length > 0 ? [{ path, hits }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenHitsDeep(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as AnyRecord).flatMap(([key, item]) => forbiddenHitsDeep(item, `${path}.${key}`));
  }
  return [];
}

/* ------------------------------------------------------------------ DS-001 */

export async function designSystem({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  const tokens = await buildAndImport(candidate, "@structile/tokens", "packages/tokens");
  requireExports(tokens, [
    "TOKENS_CONTRACT_VERSION", "TOKEN_CATEGORIES", "defaultLightTheme", "defaultDarkTheme",
    "contrastRequirements", "tenantOverridableTokens", "validateTheme", "validateThemeOverride",
    "contrastRatio", "TokenContractError"
  ], "@structile/tokens");

  assert.deepEqual([...tokens.TOKEN_CATEGORIES], [...TOKEN_CATEGORIES], "DS-001 token categories are fixed");
  assert.equal(typeof tokens.TOKENS_CONTRACT_VERSION.major, "number");

  const themes: AnyRecord[] = [tokens.defaultLightTheme, tokens.defaultDarkTheme];
  assert.deepEqual(themes.map((theme) => theme.mode), ["light", "dark"], "both default modes are required");

  // --- token lint: no forbidden style values, closed taxonomy, typed values ---
  const lintFindings: Array<{ theme: string; token: string; hits: string[] }> = [];
  const tokenIds = new Set<string>();
  for (const theme of themes) {
    const validated = tokens.validateTheme(theme);
    assert.ok(validated, "default theme must validate");
    for (const [id, value] of Object.entries(theme.tokens as Record<string, unknown>)) {
      tokenIds.add(id);
      const category = id.split(".")[0] ?? "";
      assert.ok((TOKEN_CATEGORIES as readonly string[]).includes(category), `token ${id} is outside the taxonomy`);
      const hits = typeof value === "string" ? forbiddenHits(value) : [];
      if (hits.length > 0) lintFindings.push({ theme: theme.mode, token: id, hits });
      if (category === "color") assert.match(String(value), /^#[0-9a-f]{6}$/i, `color token ${id} must be #rrggbb`);
    }
  }
  assert.deepEqual(lintFindings, [], "no token may carry a forbidden style value");

  // Poisoned values must be rejected, one class at a time.
  const rejected: Array<{ label: string; rejected: true; error: string }> = [];
  const colorToken = [...tokenIds].find((id) => id.startsWith("color.")) as string;
  // Probe one token from EVERY category. A per-category value grammar can reject an
  // injection payload before the forbidden-value scan runs, which silently turns the
  // probe into a no-op for that category; only a category with a permissive grammar
  // exercises the scan itself. Covering all six keeps this correct however the
  // candidate distributes its grammars.
  const probeTokens = TOKEN_CATEGORIES
    .map((category) => [...tokenIds].find((id) => id.startsWith(`${category}.`)))
    .filter((id): id is string => id !== undefined);
  assert.equal(probeTokens.length, TOKEN_CATEGORIES.length, "every token category must be represented");
  const payloads: Record<string, string> = { "url-function": "url(x)", "css-expression": "expression(1)",
    "javascript-scheme": "javascript:x", "data-scheme": "data:x", "css-import": "@import x",
    "css-important": "#000000 !important", markup: "<b>", "css-block": "{}", escape: "\\65",
    "event-handler": "onload=x" };
  for (const [name, ] of FORBIDDEN_STYLE_PATTERNS) {
    for (const probeToken of probeTokens) {
      const control = { ...themes[0], tokens: { ...(themes[0] as AnyRecord).tokens } };
      const poisoned = { ...themes[0], tokens: { ...(themes[0] as AnyRecord).tokens, [probeToken]: payloads[name] } };
      rejected.push(await assertDiscriminates(
        () => tokens.validateTheme(control), () => tokens.validateTheme(poisoned),
        "TokenContractError", `token-lint:${name}:${probeToken}`));
    }
  }
  // Colour tokens must additionally be rejected when they are not sRGB hex.
  for (const malformed of ["red", "rgb(0,0,0)", "#fff", "oklch(0.5 0.1 200)"]) {
    rejected.push(await assertDiscriminates(
      () => tokens.validateTheme({ ...themes[0], tokens: { ...(themes[0] as AnyRecord).tokens } }),
      () => tokens.validateTheme({ ...themes[0], tokens: { ...(themes[0] as AnyRecord).tokens, [colorToken]: malformed } }),
      "TokenContractError", `token-format:${malformed}`));
  }
  // Unknown token IDs are rejected: the taxonomy is closed.
  rejected.push(await assertDiscriminates(
    () => tokens.validateTheme({ ...themes[0], tokens: { ...(themes[0] as AnyRecord).tokens } }),
    () => tokens.validateTheme({ ...themes[0], tokens: { ...(themes[0] as AnyRecord).tokens, "color.not.registered": "#000000" } }),
    "TokenContractError", "token-lint:unknown-token"));

  // The theme envelope itself must be validated, not just its token values.
  for (const [label, broken] of [
    ["mode:missing", { version: themes[0]!.version, tokens: (themes[0] as AnyRecord).tokens }],
    ["mode:unknown", { ...themes[0], mode: "sepia" }],
    ["theme:not-an-object", "light"]
  ] as Array<[string, unknown]>) {
    rejected.push(await assertDiscriminates(
      () => tokens.validateTheme({ ...themes[0], tokens: { ...(themes[0] as AnyRecord).tokens } }),
      () => tokens.validateTheme(broken), "TokenContractError", `theme:${label}`));
  }

  // --- theme override matrix: tenant scope is narrowly bounded ---
  const overridable: string[] = [...tokens.tenantOverridableTokens];
  assert.ok(overridable.length > 0, "tenant override allow-list must be declared");
  const notOverridable = [...tokenIds].filter((id) => !overridable.includes(id));
  assert.ok(notOverridable.length > 0, "tenant scope must not be able to override every token");
  const themeMatrix: Array<{ scope: string; token: string; outcome: string }> = [];
  for (const token of overridable) {
    tokens.validateThemeOverride({ scope: "tenant", tokens: { [token]: "#123456" } });
    themeMatrix.push({ scope: "tenant", token, outcome: "allowed" });
  }
  const probeBound = 25;
  const probedTokens = notOverridable.slice(0, probeBound);
  for (const token of probedTokens) {
    rejected.push(await assertDiscriminates(
      () => tokens.validateThemeOverride({ scope: "tenant", tokens: { [overridable[0] as string]: "#123456" } }),
      () => tokens.validateThemeOverride({ scope: "tenant", tokens: { [token]: "#123456" } }),
      "TokenContractError", `theme-override:tenant:${token}`));
    themeMatrix.push({ scope: "tenant", token, outcome: "denied" });
  }

  // Scope and token identity are enforced on the override path too, not only on themes.
  const allowedToken = overridable[0] as string;
  rejected.push(await assertDiscriminates(
    () => tokens.validateThemeOverride({ scope: "tenant", tokens: { [allowedToken]: "#123456" } }),
    () => tokens.validateThemeOverride({ scope: "root", tokens: { [allowedToken]: "#123456" } }),
    "TokenContractError", "theme-override:unknown-scope"));
  rejected.push(await assertDiscriminates(
    () => tokens.validateThemeOverride({ scope: "product", tokens: { [allowedToken]: "#123456" } }),
    () => tokens.validateThemeOverride({ scope: "product", tokens: { "color.not.registered": "#123456" } }),
    "TokenContractError", "theme-override:unknown-token"));
  rejected.push(await assertDiscriminates(
    () => tokens.validateThemeOverride({ scope: "product", tokens: { [allowedToken]: "#123456" } }),
    () => tokens.validateThemeOverride({ scope: "user", tokens: { [allowedToken]: "#123456" } }),
    "TokenContractError", "theme-override:user-scope-is-mode-only"));

  // --- contrast: the suite owns the minimums, not the candidate ---
  const requirements: AnyRecord[] = [...tokens.contrastRequirements];
  assert.ok(requirements.length > 0, "contrast requirements must be declared");
  const textTokens = [...tokenIds].filter((id) => id.startsWith("color.text."));
  const covered = new Set(requirements.map((item) => String(item.foreground)));
  assert.deepEqual(textTokens.filter((id) => !covered.has(id)), [], "every text token needs a contrast requirement");
  const contrastReport: Array<{ theme: string; foreground: string; background: string; level: string; ratio: number; minimum: number }> = [];
  for (const theme of themes) {
    const map = theme.tokens as Record<string, string>;
    for (const requirement of requirements) {
      const level = String(requirement.level);
      const minimum = CONTRAST_MINIMUM[level];
      assert.ok(minimum !== undefined, `unknown contrast level ${level}`);
      const foreground = map[String(requirement.foreground)] as string;
      const background = map[String(requirement.background)] as string;
      const ratio = contrastRatio(foreground, background);
      contrastReport.push({ theme: theme.mode, foreground: String(requirement.foreground), background: String(requirement.background), level, ratio: Number(ratio.toFixed(3)), minimum: minimum as number });
      assert.ok(ratio >= (minimum as number),
        `${theme.mode} ${requirement.foreground} on ${requirement.background} is ${ratio.toFixed(2)}:1, below ${String(minimum)}:1`);
      // The candidate's own helper must agree with the independent computation.
      assert.ok(Math.abs(Number(tokens.contrastRatio(foreground, background)) - ratio) < 0.01,
        "candidate contrastRatio disagrees with the protected computation");
    }
  }

  // --- catalog contract (DS-003) ---
  const catalogPath = resolve(candidate, String(options.catalog ?? "./dist/catalog.json"));
  const catalogDocument = await readJson(catalogPath);
  const registrations: AnyRecord[] = Array.isArray(catalogDocument.components) ? catalogDocument.components : [];
  const catalogModule = await buildAndImport(candidate, "@structile/catalog", "packages/catalog");
  requireExports(catalogModule, ["validateRegistration", "buildCatalog", "CatalogError"], "@structile/catalog");
  const seenIds = new Set<string>();
  const required = ["id", "version", "props", "slots", "states", "accessibility", "dataNeeds", "permissions", "cost"];
  for (const registration of registrations) {
    catalogModule.validateRegistration(registration);
    for (const field of required) assert.ok(registration[field] !== undefined, `${registration.id}: DS-003 requires ${field}`);
    assert.equal(seenIds.has(String(registration.id)), false, `duplicate component id ${registration.id}`);
    seenIds.add(String(registration.id));
    assert.deepEqual(forbiddenHitsDeep(registration), [], `${registration.id} carries a forbidden style value`);
  }
  // The control is protected, not candidate-supplied: a catalog is legitimately empty
  // until components land, and a candidate must not be able to weaken the probe by
  // shipping a convenient registration.
  const controlRegistration = await readJson(resolve(runnerRoot(), "fixtures/catalog/registration.valid.json")) as AnyRecord;
  const control = () => catalogModule.validateRegistration(JSON.parse(JSON.stringify(controlRegistration)));
  // Each DS-003 field is probed on its own, so no single defect can mask the others.
  for (const field of required) {
    const incomplete = JSON.parse(JSON.stringify(controlRegistration)) as AnyRecord;
    delete incomplete[field];
    rejected.push(await assertDiscriminates(control, () => catalogModule.validateRegistration(incomplete),
      "CatalogError", `catalog:missing:${field}`));
  }
  for (const [label, patch] of [
    ["id:not-dotted", { id: "notdotted" }],
    ["id:uppercase", { id: "Core.Kpi" }],
    ["states:not-array", { states: "ready" }],
    ["states:unknown", { states: ["ready", "teleporting"] }],
    ["cost:not-numeric", { cost: { staticWeight: "one", maxRows: 10 } }],
    ["cost:missing-maxRows", { cost: { staticWeight: 1 } }]
  ] as Array<[string, AnyRecord]>) {
    rejected.push(await assertDiscriminates(control,
      () => catalogModule.validateRegistration({ ...JSON.parse(JSON.stringify(controlRegistration)), ...patch }),
      "CatalogError", `catalog:${label}`));
  }
  // buildCatalog must reject duplicate component IDs; stable IDs are a DS-003 guarantee.
  rejected.push(await assertDiscriminates(
    () => catalogModule.buildCatalog([controlRegistration]),
    () => catalogModule.buildCatalog([controlRegistration, JSON.parse(JSON.stringify(controlRegistration))]),
    "CatalogError", "catalog:duplicate-id"));
  assertPrototypeIntact();

  await writeJson(resolve(artifactDir, "token-lint.json"), {
    categories: TOKEN_CATEGORIES, tokenCount: tokenIds.size, findings: lintFindings,
    forbiddenClassesExercised: FORBIDDEN_STYLE_PATTERNS.map(([name]) => name), rejections: rejected
  });
  await writeJson(resolve(artifactDir, "catalog-report.json"), {
    catalog: catalogPath, registrations: registrations.length,
    componentIds: [...seenIds].sort(), requiredFields: required
  });
  await writeJson(resolve(artifactDir, "theme-matrix.json"), {
    modes: themes.map((theme) => theme.mode), tenantOverridable: overridable,
    deniedTokensTotal: notOverridable.length, deniedTokensProbed: probedTokens.length,
    deniedTokensNotProbed: notOverridable.slice(probeBound),
    matrix: themeMatrix, contrast: contrastReport, minimums: CONTRAST_MINIMUM
  });

  return {
    measurements: {
      tokens: tokenIds.size, themes: themes.length, contrastChecks: contrastReport.length,
      registrations: registrations.length, forbiddenValueFindings: 0, rejections: rejected.length,
      deniedTokensTotal: notOverridable.length, deniedTokensProbed: probedTokens.length
    },
    artifactNames: ["token-lint.json", "catalog-report.json", "theme-matrix.json"]
  };
}

/* ---------------------------------------------------------------- SPEC-001 */

export async function specFuzz({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  assert.equal(options.seeds, "protected", "SPEC-001 requires the protected seed corpus");
  const iterations = Number(options.iterations ?? 100000);
  assert.ok(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be a positive integer");

  const spec = await buildAndImport(candidate, "@structile/spec", "packages/spec");
  requireExports(spec, [
    "SPEC_SCHEMA_VERSION", "SUPPORTED_SPEC_MAJORS", "negotiateSpecVersion",
    "compatibilityMatrix", "validateSpecification", "SpecificationError", "LIMITS"
  ], "@structile/spec");

  const root = runnerRoot();
  const catalog = await readJson(resolve(root, "fixtures/spec/catalog.json"));
  const seedNames = (await listFiles(resolve(root, "fixtures/spec/seeds"))).filter((n) => n.endsWith(".json"));
  assert.ok(seedNames.length >= 3, "protected seed corpus must be non-trivial");

  // --- valid seeds round-trip with normalized equality ---
  const seeds: AnyRecord[] = [];
  for (const name of seedNames) {
    const seed = await readJson(resolve(root, "fixtures/spec/seeds", name));
    const first = spec.validateSpecification(seed, { catalog });
    const second = spec.validateSpecification(JSON.parse(JSON.stringify(first)), { catalog });
    assert.deepEqual(second, first, `${name} must round-trip without semantic drift`);
    seeds.push(seed);
  }

  // --- N/N-1 surface is declared and fails closed on an unsupported major ---
  const matrix = spec.compatibilityMatrix();
  assert.ok(Array.isArray(spec.SUPPORTED_SPEC_MAJORS) && spec.SUPPORTED_SPEC_MAJORS.length >= 1);
  assert.equal(matrix.current, spec.SPEC_SCHEMA_VERSION.major, "matrix must declare the current major");
  const rejected: Array<{ label: string; rejected: true; error: string }> = [];
  rejected.push(await assertDiscriminates(
    () => spec.negotiateSpecVersion({ major: spec.SPEC_SCHEMA_VERSION.major, minor: 0 }),
    () => spec.negotiateSpecVersion({ major: 999, minor: 0 }),
    "SpecificationError", "version:unsupported-major"));

  // --- protected negative corpus, one payload class at a time ---
  const base = seeds[0] as AnyRecord;
  const coverage: Record<string, number> = {};
  const record = (cls: string): void => { coverage[cls] = (coverage[cls] ?? 0) + 1; };

  for (const key of POLLUTION_KEYS) {
    // Build from JSON text: `obj["__proto__"] = x` only sets the prototype, whereas
    // JSON.parse creates a real own property. Specifications arrive as JSON, so the
    // text form is the threat model that matters.
    const payload = JSON.parse(
      JSON.stringify(base).replace(/^\{/, `{${JSON.stringify(key)}:{"polluted":true},`)
    ) as AnyRecord;
    assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `${key} must be an own property for this probe to be meaningful`);
    rejected.push(await assertDiscriminates(
      () => spec.validateSpecification(JSON.parse(JSON.stringify(base)), { catalog }),
      () => spec.validateSpecification(payload, { catalog }),
      "SpecificationError", `pollution:${key}`));
    record("prototype-pollution");
  }
  // A nested pollution attempt must be refused *on its own merits*. Injecting into an
  // otherwise-valid document — and asserting the un-poisoned control still validates —
  // stops an unrelated violation from masking the probe.
  const nestedText = JSON.stringify(base).replace(/"pages"\s*:\s*\[\s*\{/, '"pages":[{"__proto__":{"polluted":true},');
  assert.notEqual(nestedText, JSON.stringify(base), "nested pollution probe failed to inject");
  const nested = JSON.parse(nestedText) as AnyRecord;
  assert.ok(Object.prototype.hasOwnProperty.call(nested.pages[0], "__proto__"), "nested __proto__ must be an own property");
  const nestedControl = JSON.parse(JSON.stringify(nested)) as AnyRecord;
  delete nestedControl.pages[0]["__proto__"];
  rejected.push(await assertDiscriminates(
    () => spec.validateSpecification(nestedControl, { catalog }),
    () => spec.validateSpecification(nested, { catalog }),
    "SpecificationError", "pollution:nested"));
  record("prototype-pollution");

  for (const [name, ] of INJECTION_PATTERNS) {
    const payload: Record<string, string> = {
      "script-tag": "<script>x</script>", markup: "<b>x</b>", "javascript-scheme": "javascript:x",
      "data-scheme": "data:text/html,x", "event-handler": "onload=x", "css-expression": "expression(1)",
      "url-function": "url(x)", template: "{{x}}", "sql-metacharacter": "1; DROP TABLE t --",
      "absolute-url": "https://example.invalid/x", "scheme-relative-url": "//example.invalid/x"
    };
    const poisoned = JSON.parse(JSON.stringify(base)) as AnyRecord;
    poisoned.title = payload[name];
    rejected.push(await assertDiscriminates(
      () => spec.validateSpecification(JSON.parse(JSON.stringify(base)), { catalog }),
      () => spec.validateSpecification(poisoned, { catalog }),
      "SpecificationError", `injection:${name}`));
    record("injection");
  }

  // Unknown catalog identity and unknown props.
  const unknownComponent = JSON.parse(JSON.stringify(base)) as AnyRecord;
  unknownComponent.pages[0].nodes[0].componentId = "not.registered";
  rejected.push(await assertDiscriminates(
    () => spec.validateSpecification(JSON.parse(JSON.stringify(base)), { catalog }),
    () => spec.validateSpecification(unknownComponent, { catalog }),
    "SpecificationError", "catalog:unknown-component"));
  record("catalog-escape");
  const unknownProp = JSON.parse(JSON.stringify(base)) as AnyRecord;
  unknownProp.pages[0].nodes[0].props.__unregistered = 1;
  rejected.push(await assertDiscriminates(
    () => spec.validateSpecification(JSON.parse(JSON.stringify(base)), { catalog }),
    () => spec.validateSpecification(unknownProp, { catalog }),
    "SpecificationError", "catalog:unknown-prop"));
  record("catalog-escape");

  // Limits: depth, nodes, bytes, cost.
  const limits = spec.LIMITS as Record<string, number>;
  for (const limit of ["maxDepth", "maxNodes", "maxBytes", "maxCost", "maxStructuralDepth"]) {
    assert.equal(typeof limits[limit], "number", `LIMITS.${limit} must be declared`);
    const ceiling = LIMIT_CEILINGS[limit] as number;
    assert.ok((limits[limit] as number) > 0, `LIMITS.${limit} must be positive`);
    assert.ok((limits[limit] as number) <= ceiling,
      `LIMITS.${limit} is ${limits[limit]}, above the protected ceiling of ${ceiling}. ` +
      "A candidate may declare stricter limits than the ceiling, never looser.");
  }
  let deep: AnyRecord = { componentId: (base as AnyRecord).pages[0].nodes[0].componentId, props: {}, slots: {} };
  for (let index = 0; index <= (limits.maxDepth as number) + 1; index += 1) {
    deep = { componentId: (base as AnyRecord).pages[0].nodes[0].componentId, props: {}, slots: { content: [deep] } };
  }
  const tooDeep = JSON.parse(JSON.stringify(base)) as AnyRecord;
  tooDeep.pages[0].nodes = [deep];
  rejected.push(await assertDiscriminates(
    () => spec.validateSpecification(JSON.parse(JSON.stringify(base)), { catalog }),
    () => spec.validateSpecification(tooDeep, { catalog }),
    "SpecificationError", "limit:depth"));
  record("limit");
  // Structural depth must be bounded across the WHOLE document, not only the node tree.
  // Deep nesting inside props is an unbounded-recursion vector for any renderer that
  // walks the spec, and the node-depth guard alone does not see it.
  // Probe just past the candidate's DECLARED structural bound rather than a guessed
  // multiple of maxDepth: a candidate that declares a large bound would otherwise sail
  // past a fixed probe. The ceiling above is what stops the declaration being absurd.
  const structuralBound = limits.maxStructuralDepth as number;
  assert.ok(structuralBound > (limits.maxDepth as number) * 3,
    `LIMITS.maxStructuralDepth (${structuralBound}) must exceed the depth a legal node tree reaches, ` +
    `or it shadows maxDepth and the node-tree limit can never be observed`);
  const deepValue = ((): AnyRecord => {
    let node: AnyRecord = {};
    for (let level = 0; level < structuralBound + 2; level += 1) node = { child: node };
    return node;
  })();
  const deepProps = JSON.parse(JSON.stringify(base)) as AnyRecord;
  deepProps.pages[0].nodes[0].props.label = deepValue;
  rejected.push(await assertDiscriminates(
    () => spec.validateSpecification(JSON.parse(JSON.stringify(base)), { catalog }),
    () => spec.validateSpecification(deepProps, { catalog }),
    "SpecificationError", "limit:structural-depth"));
  record("limit");

  // Byte ceiling (SPEC-009): a spec under every other limit but over maxBytes.
  const tooBig = JSON.parse(JSON.stringify(base)) as AnyRecord;
  tooBig.description = "a".repeat((limits.maxBytes as number) + 1024);
  rejected.push(await assertDiscriminates(
    () => spec.validateSpecification(JSON.parse(JSON.stringify(base)), { catalog }),
    () => spec.validateSpecification(tooBig, { catalog }),
    "SpecificationError", "limit:bytes"));
  record("limit");

  // Non-data values cannot appear in a stored specification (SPEC-001).
  for (const [label, value] of [["function", () => 1], ["symbol", Symbol("x")], ["bigint", BigInt(1)]] as Array<[string, unknown]>) {
    const nonData = JSON.parse(JSON.stringify(base)) as AnyRecord;
    nonData.title = value;
    rejected.push(await assertDiscriminates(
      () => spec.validateSpecification(JSON.parse(JSON.stringify(base)), { catalog }),
      () => spec.validateSpecification(nonData, { catalog }),
      "SpecificationError", `non-data:${label}`));
    record("non-data");
  }

  const tooMany = JSON.parse(JSON.stringify(base)) as AnyRecord;
  tooMany.pages[0].nodes = Array.from({ length: (limits.maxNodes as number) + 1 }, () => JSON.parse(JSON.stringify((base as AnyRecord).pages[0].nodes[0])));
  rejected.push(await assertDiscriminates(
    () => spec.validateSpecification(JSON.parse(JSON.stringify(base)), { catalog }),
    () => spec.validateSpecification(tooMany, { catalog }),
    "SpecificationError", "limit:nodes"));
  record("limit");

  // --- deterministic property fuzzing ---
  //
  // Pollution hardening (ported from `g1-support.ts` after this suite's salvage
  // ancestor was written): `resolveParent` now refuses any path that traverses or
  // targets a POLLUTION_KEYS segment, so it can never hand back the live
  // Object.prototype as a mutation target. That refusal is inert here rather than a
  // functional change: `document` is rebuilt fresh from a clean protected seed at the
  // top of every iteration, and both `paths` and `target` are captured from that clean
  // document BEFORE the iteration's single mutation is applied — so a path already
  // carrying a pollution-key segment can never be offered to resolveParent in the
  // first place. The "pollute" mutation reaches its target the same way every other
  // mutation does (an ordinary, pre-mutation own-property path) and only afterwards
  // assigns a payload literal — `{"__proto__": {...}}` as a JSON-parsed OWN property,
  // not a live-prototype write — as that target's new value. No payload synthesis
  // workaround was needed; this is confirmed empirically by qualification (see
  // docs/qualification/SPEC-001.md), where `assertPrototypeIntact()` below passes on
  // every one of the iterations exercising the "pollute" mutation.
  const seedValue = Number(options.seed ?? 20260823);
  const random = createRandom(seedValue);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const mutations = ["drop-key", "retype", "inject-string", "pollute", "explode-array", "null-out", "deep-nest"] as const;
  const injections = ["<script>x</script>", "javascript:x", "{{x}}", "' OR 1=1 --", "url(x)", "//evil.invalid"];
  const mutationCounts: Record<string, number> = {};
  const depthHistogram: Record<string, number> = {};
  let accepted = 0;
  let refused = 0;
  for (let index = 0; index < iterations; index += 1) {
    const document = JSON.parse(JSON.stringify(pick(seeds))) as AnyRecord;
    const mutation = pick(mutations);
    mutationCounts[mutation] = (mutationCounts[mutation] ?? 0) + 1;
    // Mutate anywhere in the tree, not just the top level; a top-level-only fuzzer
    // never reaches node props, slots or nested pages.
    const paths = collectPaths(document);
    const path = paths.length > 0 ? pick(paths) : [];
    depthHistogram[String(path.length)] = (depthHistogram[String(path.length)] ?? 0) + 1;
    const target = resolveParent(document, path);
    if (target) {
      const { parent, key } = target;
      if (mutation === "drop-key") delete parent[key];
      else if (mutation === "retype") parent[key] = random() < 0.5 ? 42 : [];
      else if (mutation === "inject-string") parent[key] = pick(injections);
      else if (mutation === "pollute") parent[key] = JSON.parse(`{${JSON.stringify(pick(POLLUTION_KEYS))}:{"polluted":true}}`);
      else if (mutation === "explode-array") parent[key] = Array.from({ length: 64 }, () => ({}));
      else if (mutation === "deep-nest") {
        let nested: AnyRecord = {};
        for (let depth = 0; depth < 40; depth += 1) nested = { child: nested };
        parent[key] = nested;
      } else parent[key] = null;
    }
    try {
      spec.validateSpecification(document, { catalog });
      accepted += 1;
    } catch (error) {
      const failure = error as { name?: string };
      assert.equal(failure.name, "SpecificationError",
        `fuzz iteration ${index} (seed ${seedValue}, ${mutation}) threw ${failure.name} instead of SpecificationError`);
      refused += 1;
    }
    assertPrototypeIntact();
  }

  const missing = ["prototype-pollution", "injection", "catalog-escape", "limit", "non-data"].filter((cls) => !coverage[cls]);
  assert.deepEqual(missing, [], "every rejection class must be exercised");

  await writeJson(resolve(artifactDir, "spec-fuzz.json"), {
    iterations, seed: seedValue, seeds: seedNames, accepted, refused,
    schemaVersion: spec.SPEC_SCHEMA_VERSION, supportedMajors: spec.SUPPORTED_SPEC_MAJORS, compatibilityMatrix: matrix
  });
  await writeJson(resolve(artifactDir, "rejected-corpus.json"), { rejections: rejected });
  await writeJson(resolve(artifactDir, "coverage.json"), { classes: coverage, limits, ceilings: LIMIT_CEILINGS });

  return {
    measurements: {
      iterations, seed: seedValue, deterministicRejections: rejected.length,
      fuzzAccepted: accepted, fuzzRefused: refused, prototypePolluted: false
    },
    artifactNames: ["spec-fuzz.json", "rejected-corpus.json", "coverage.json"]
  };
}

/* ------------------------------------------------------------------ ACT-001 */

export async function actionContract({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  assert.ok(options["execution-disabled"] !== undefined, "ACT-001 requires --execution-disabled");
  const sdk = await buildAndImport(candidate, "@structile/capability-sdk", "packages/capability-sdk");
  requireExports(sdk, [
    "validateActionDeclaration", "ACTION_EXECUTION_ENABLED", "assertExecutionDisabled",
    "CapabilityErrorCode", "CapabilityContractError"
  ], "@structile/capability-sdk");

  // --- the execution gate is closed and cannot be opened by the candidate ---
  assert.equal(sdk.ACTION_EXECUTION_ENABLED, false, "ACT-001: action execution must remain disabled at G1");
  const gate = await assertRejects(() => sdk.assertExecutionDisabled(), "CapabilityContractError", "execution-gate");
  assert.match(gate.error, /EXECUTION_DISABLED|execution is disabled/i);

  // No execute/preview transport may exist in the shipped source.
  const sdkFiles = (await listFiles(resolve(candidate, "packages/capability-sdk")))
    .filter((path) => /^src\/.+\.ts$/.test(path));
  const transportHits: Array<{ path: string; pattern: string }> = [];
  for (const path of sdkFiles) {
    const source = await readFile(resolve(candidate, "packages/capability-sdk", path), "utf8");
    for (const pattern of [/\bfetch\s*\(/, /node:http/, /XMLHttpRequest/, /WebSocket/, /actions\/[^"'`]*\/execute/, /\bpg\b|postgres:\/\//i]) {
      if (pattern.test(source)) transportHits.push({ path, pattern: String(pattern) });
    }
  }
  assert.deepEqual(transportHits, [], "the G1 capability SDK must contain no execution transport");

  // --- every ACT-001 field is enforced ---
  // The protected declaration is the authority: a candidate cannot weaken the contract by
  // shipping a convenient fixture. Its own example must validate too.
  const declaration = await readJson(resolve(runnerRoot(), "fixtures/action/declaration.valid.json"));
  sdk.validateActionDeclaration(declaration);
  const candidateDeclaration = await readJson(resolve(candidate, "packages/capability-sdk/fixtures/action-declaration.valid.json"));
  sdk.validateActionDeclaration(candidateDeclaration);
  const requiredFields = [
    "id", "version", "input", "output", "permissions", "scope", "risk", "preview",
    "idempotency", "concurrency", "maxBatchSize", "mode", "timeoutMs", "retry", "audit", "redaction"
  ];
  const rejected: Array<{ label: string; rejected: true; error: string }> = [];
  for (const field of requiredFields) {
    const incomplete = { ...declaration };
    delete (incomplete as AnyRecord)[field];
    rejected.push(await assertDiscriminates(
      () => sdk.validateActionDeclaration({ ...declaration }),
      () => sdk.validateActionDeclaration(incomplete),
      "CapabilityContractError", `missing:${field}`));
  }
  for (const mode of ["sync", "async"]) sdk.validateActionDeclaration({ ...declaration, mode });
  rejected.push(await assertDiscriminates(
    () => sdk.validateActionDeclaration({ ...declaration }),
    () => sdk.validateActionDeclaration({ ...declaration, mode: "fire-and-forget" }),
    "CapabilityContractError", "mode:unknown"));
  // Pair risk with a coherent batch size: a bulk action that cannot batch is a
  // contradiction, so asserting acceptance requires an otherwise-valid declaration.
  for (const risk of ["normal", "destructive", "bulk", "high-impact"]) {
    sdk.validateActionDeclaration({ ...declaration, risk, maxBatchSize: risk === "bulk" ? 10 : 1 });
  }
  // Risk and capability must agree: a batching action labelled low-risk would escape the
  // reauthentication that bulk and high-impact carry.
  rejected.push(await assertDiscriminates(
    () => sdk.validateActionDeclaration({ ...declaration, risk: "bulk", maxBatchSize: 10 }),
    () => sdk.validateActionDeclaration({ ...declaration, risk: "bulk", maxBatchSize: 1 }),
    "CapabilityContractError", "risk:bulk-cannot-batch"));
  rejected.push(await assertDiscriminates(
    () => sdk.validateActionDeclaration({ ...declaration, risk: "high-impact", maxBatchSize: 50 }),
    () => sdk.validateActionDeclaration({ ...declaration, risk: "normal", maxBatchSize: 50 }),
    "CapabilityContractError", "risk:normal-cannot-batch"));
  // architecture.md: "Normal updates require preview and confirmation."
  rejected.push(await assertDiscriminates(
    () => sdk.validateActionDeclaration({ ...declaration, preview: { required: true, effectSummary: "reviewed" } }),
    () => sdk.validateActionDeclaration({ ...declaration, preview: { required: false, effectSummary: "reviewed" } }),
    "CapabilityContractError", "preview:mandatory-for-every-risk"));
  // A retry after a timeout must still fall inside the idempotency window.
  rejected.push(await assertDiscriminates(
    () => sdk.validateActionDeclaration({ ...declaration, timeoutMs: 15_000, idempotency: { keyRule: "client-supplied", windowSeconds: 15 } }),
    () => sdk.validateActionDeclaration({ ...declaration, timeoutMs: 300_000, idempotency: { keyRule: "client-supplied", windowSeconds: 1 } }),
    "CapabilityContractError", "idempotency:window-shorter-than-timeout"));
  rejected.push(await assertDiscriminates(
    () => sdk.validateActionDeclaration({ ...declaration }),
    () => sdk.validateActionDeclaration({ ...declaration, risk: "trivial" }),
    "CapabilityContractError", "risk:unknown"));

  // --- forbidden scopes ---
  for (const scope of [
    { kind: "code", value: "eval" }, { kind: "sql", value: "SELECT 1" },
    { kind: "network", value: "https://example.invalid" }, { kind: "infrastructure", value: "kubectl" }
  ]) {
    rejected.push(await assertDiscriminates(
      () => sdk.validateActionDeclaration({ ...declaration }),
      () => sdk.validateActionDeclaration({ ...declaration, scope: [scope] }),
      "CapabilityContractError", `scope:${scope.kind}`));
  }
  assertPrototypeIntact();

  await writeJson(resolve(artifactDir, "action-contract.json"), {
    validatedDeclaration: declaration.id, requiredFields,
    riskLevels: ["normal", "destructive", "bulk", "high-impact"], rejections: rejected
  });
  await writeJson(resolve(artifactDir, "execution-gate.json"), {
    executionEnabled: false, assertThrows: true, gateError: gate.error,
    transportHits, scannedSources: sdkFiles.length
  });

  return {
    measurements: {
      executionEnabled: false, requiredFields: requiredFields.length,
      rejections: rejected.length, transportHits: 0
    },
    artifactNames: ["action-contract.json", "execution-gate.json"]
  };
}

/* ----------------------------------------------------------------- CAP-001 */

interface AdapterVerdict { case: string; accepted: boolean; code: string | null }

/** Prefer the prebuilt adapter; fall back to compiling from the same source. */
function goAdapterCommand(root: string): readonly string[] {
  const override = process.env.STRUCTILE_GO_ADAPTER;
  if (override) return [override];
  for (const candidate of ["/usr/local/bin/capability-adapter-go", resolve(root, "fixtures/capability/adapters/go/capability-adapter-go")]) {
    if (existsSync(candidate)) return [candidate];
  }
  return ["go", "run", resolve(root, "fixtures/capability/adapters/go/adapter.go")];
}

export async function capabilityContract({ candidate, artifactDir, options }: SuiteContext): Promise<SuiteResult> {
  const requested = String(options["reference-adapters"] ?? "").split(",").filter(Boolean).sort();
  assert.deepEqual(requested, ["go", "node", "python"], "CAP-001 requires the node, python and go reference adapters");
  assert.equal(options["negative-corpus"], "protected", "CAP-001 requires the protected negative corpus");

  const sdk = await buildAndImport(candidate, "@structile/capability-sdk", "packages/capability-sdk");
  requireExports(sdk, [
    "CAPABILITY_PROTOCOL_VERSION", "SUPPORTED_PROTOCOL_VERSIONS", "negotiateProtocolVersion",
    "validateCapabilityManifest", "CapabilityErrorCode", "CapabilityContractError"
  ], "@structile/capability-sdk");

  // The published contract is the only input the adapters get. If a language cannot
  // implement the protocol from it, ARC-006 is not satisfied.
  const contract = {
    supportedMajors: [...sdk.SUPPORTED_PROTOCOL_VERSIONS].map((version: AnyRecord) => Number(version.major)),
    errorCodes: Object.values(sdk.CapabilityErrorCode as Record<string, string>).sort(),
    requiredManifestKeys: ["contractVersion", "resources", "fields", "metrics", "filters",
      "relationships", "queries", "exports", "actions", "signature"],
    audience: "structile-control-plane"
  };
  const root = runnerRoot();
  const workDir = resolve(artifactDir, "capability");
  const contractPath = resolve(workDir, "contract.json");
  const corpusPath = resolve(root, "fixtures/capability/corpus.json");
  await writeJson(contractPath, contract);
  const corpus: AnyRecord[] = (await readJson(corpusPath)).cases;
  assert.ok(corpus.length >= 10, "protected negative corpus must be non-trivial");

  const adapters: Record<string, readonly string[]> = {
    node: [process.execPath, resolve(root, "fixtures/capability/adapters/node/adapter.ts")],
    python: ["python3", resolve(root, "fixtures/capability/adapters/python/adapter.py")],
    // Prebuilt into the runner image from the same pinned source, so the 190 MB Go
    // toolchain never ships. Falls back to `go run` when the binary is absent, so the
    // suite stays runnable on a developer machine.
    go: goAdapterCommand(root)
  };
  const verdicts: Record<string, AdapterVerdict[]> = {};
  for (const [language, argv] of Object.entries(adapters)) {
    const [program, ...args] = argv;
    const result = await command(program as string, [...args, contractPath, corpusPath], {
      cwd: workDir, timeout: 600_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? workDir, TMPDIR: process.env.TMPDIR ?? workDir,
             GOCACHE: resolve(workDir, "gocache"), GOFLAGS: "-mod=mod" }
    });
    verdicts[language] = JSON.parse(result.stdout) as AdapterVerdict[];
  }

  // --- every adapter must agree, case for case ---
  const reference = verdicts.node as AdapterVerdict[];
  assert.equal(reference.length, corpus.length, "node adapter must answer every case");
  const disagreements: Array<{ case: string; language: string; expected: AdapterVerdict; actual: AdapterVerdict }> = [];
  for (const language of ["python", "go"]) {
    const rows = verdicts[language] as AdapterVerdict[];
    assert.equal(rows.length, corpus.length, `${language} adapter must answer every case`);
    for (const [index, expected] of reference.entries()) {
      const actual = rows[index] as AdapterVerdict;
      if (actual.case !== expected.case || actual.accepted !== expected.accepted || actual.code !== expected.code) {
        disagreements.push({ case: expected.case, language, expected, actual });
      }
    }
  }
  assert.deepEqual(disagreements, [], "ARC-006: all reference adapters must decide identically");

  // --- the corpus expectations themselves must hold, and negatives must fail closed ---
  const mismatches: Array<{ case: string; expected: AnyRecord; actual: AdapterVerdict }> = [];
  for (const [index, item] of corpus.entries()) {
    const actual = reference[index] as AdapterVerdict;
    if (actual.accepted !== Boolean(item.expectAccepted) || (item.expectCode ?? null) !== actual.code) {
      mismatches.push({ case: String(item.name), expected: item, actual });
    }
  }
  assert.deepEqual(mismatches, [], "reference adapters must match the protected expectations");
  const negatives = corpus.filter((item) => !item.expectAccepted);
  assert.ok(negatives.length >= 6, "negative corpus must cover malformed, unsigned, expired, wrong-audience and version cases");
  for (const required of ["UNSUPPORTED_CONTRACT_VERSION", "MALFORMED_MANIFEST", "UNSIGNED_MANIFEST", "UNAUTHORIZED_CAPABILITY"]) {
    assert.ok(negatives.some((item) => item.expectCode === required), `negative corpus must exercise ${required}`);
    assert.ok(contract.errorCodes.includes(required), `CAP-004: ${required} must be a published stable code`);
  }

  // --- the candidate's own SDK must agree with the language-neutral contract ---
  const sdkRejections: Array<{ label: string; rejected: true; error: string }> = [];
  const validManifest = (corpus.find((item) => item.kind === "manifest" && item.expectAccepted) as AnyRecord).payload;
  sdkRejections.push(await assertDiscriminates(
    () => sdk.negotiateProtocolVersion([{ major: sdk.CAPABILITY_PROTOCOL_VERSION.major, minor: 0 }]),
    () => sdk.negotiateProtocolVersion([{ major: 999, minor: 0 }]),
    "CapabilityContractError", "negotiate:unsupported"));
  sdkRejections.push(await assertDiscriminates(
    () => sdk.validateCapabilityManifest(validManifest),
    () => sdk.validateCapabilityManifest({}),
    "CapabilityContractError", "manifest:malformed"));
  for (const item of corpus) {
    if (item.kind !== "manifest") continue;
    if (item.expectAccepted) sdk.validateCapabilityManifest(item.payload);
    else await assertRejects(() => sdk.validateCapabilityManifest(item.payload), "CapabilityContractError", `sdk:${item.name}`);
  }

  // --- no browser or database shortcut may exist (ARC-006) ---
  const sdkFiles = (await listFiles(resolve(candidate, "packages/capability-sdk"))).filter((path) => /^src\/.+\.ts$/.test(path));
  const shortcuts: Array<{ path: string; pattern: string }> = [];
  for (const path of sdkFiles) {
    const source = await readFile(resolve(candidate, "packages/capability-sdk", path), "utf8");
    for (const pattern of [/postgres(?:ql)?:\/\//i, /from\s+["']pg["']/, /new\s+Client\s*\(/, /document\./, /window\./]) {
      if (pattern.test(source)) shortcuts.push({ path, pattern: String(pattern) });
    }
  }
  assert.deepEqual(shortcuts, [], "the capability SDK must not reach a database or the DOM directly");
  assertPrototypeIntact();

  await writeJson(resolve(artifactDir, "adapter-matrix.json"), {
    adapters: Object.keys(adapters).sort(), cases: corpus.length,
    disagreements, expectationMismatches: mismatches,
    contract: { supportedMajors: contract.supportedMajors, errorCodes: contract.errorCodes }
  });
  await writeJson(resolve(artifactDir, "protocol-transcripts-redacted.json"), {
    note: "decisions only; no payload bodies, credentials or customer values are recorded",
    transcripts: reference.map((row) => ({ case: row.case, accepted: row.accepted, code: row.code })),
    sdkRejections: sdkRejections.map((row) => ({ label: row.label, rejected: row.rejected }))
  });

  return {
    measurements: {
      adapters: 3, cases: corpus.length, disagreements: 0, expectationMismatches: 0,
      negativeCases: negatives.length, databaseOrDomShortcuts: 0
    },
    artifactNames: ["adapter-matrix.json", "protocol-transcripts-redacted.json"]
  };
}
