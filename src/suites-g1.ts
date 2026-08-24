/**
 * G1 protected suites, ported from the superseded `g1/protected-suites` branch onto the
 * hardened `g1-support.ts` shared module. Suites are appended here in re-cut order, one
 * per PR: DS-001 (design-system) lands first; later suites (ACT-001, SPEC-001, SPEC-002,
 * CAP-001, PKG-001, HAR-004) are ported in their own PRs, not batched into this file.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readJson, writeJson } from "./io.ts";
import { runnerRoot } from "./catalog.ts";
import type { SuiteContext, SuiteResult } from "./suites.ts";
import {
  CONTRAST_MINIMUM, FORBIDDEN_STYLE_PATTERNS,
  assertDiscriminates, assertPrototypeIntact, buildAndImport, contrastRatio,
  requireExports, type AnyRecord
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
