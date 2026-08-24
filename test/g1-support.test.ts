import test from "node:test";
import assert from "node:assert/strict";
import {
  FORBIDDEN_STYLE_PATTERNS,
  INJECTION_PATTERNS,
  LIMIT_CEILINGS,
  CONTRAST_MINIMUM,
  createRandom,
  contrastRatio,
  collectPaths,
  resolveParent,
  assertRejects,
  assertDiscriminates,
  assertPrototypeIntact
} from "../src/g1-support.ts";

test("createRandom is deterministic from its seed and bounded", () => {
  const a = createRandom(42);
  const b = createRandom(42);
  const c = createRandom(43);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
  for (const value of seqA) assert.ok(value >= 0 && value < 1);
});

test("contrastRatio matches WCAG anchors and rejects non-sRGB input", () => {
  assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 0.01);
  assert.equal(contrastRatio("#123456", "#123456"), 1);
  assert.equal(contrastRatio("#000000", "#ffffff"), contrastRatio("#ffffff", "#000000"));
  assert.throws(() => contrastRatio("red", "#ffffff"));
});

test("collectPaths enumerates every nested container path", () => {
  const paths = collectPaths({ a: [{ b: 1 }], c: 2 }).map((path) => path.join("."));
  assert.deepEqual(paths.sort(), ["a", "a.0", "a.0.b", "c"]);
});

test("resolveParent finds present paths and returns undefined otherwise", () => {
  const root = { a: { b: [10] } };
  const hit = resolveParent(root, ["a", "b", "0"]);
  assert.equal(hit?.parent[hit.key], 10);
  assert.equal(resolveParent(root, ["a", "x", "y"]), undefined);
  assert.equal(resolveParent(root, []), undefined);
});

test("assertRejects demands the declared error name", async () => {
  const typeError = () => {
    throw new TypeError("bad");
  };
  const outcome = await assertRejects(typeError, "TypeError", "probe");
  assert.equal(outcome.rejected, true);
  await assert.rejects(assertRejects(() => 1, "TypeError", "accepted-probe"));
  await assert.rejects(assertRejects(typeError, "RangeError", "wrong-name-probe"));
});

test("assertDiscriminates requires control accepted and poison rejected", async () => {
  const poison = () => {
    throw new TypeError("poisoned");
  };
  const outcome = await assertDiscriminates(() => 1, poison, "TypeError", "pair");
  assert.equal(outcome.controlAccepted, true);
  await assert.rejects(assertDiscriminates(poison, poison, "TypeError", "control-rejected"));
  await assert.rejects(assertDiscriminates(() => 1, () => 2, "TypeError", "poison-accepted"));
});

test("prototype canary passes on a clean runtime", () => {
  assertPrototypeIntact();
});

test("style and injection patterns catch their classes and pass clean values", () => {
  const style = new Map(FORBIDDEN_STYLE_PATTERNS);
  assert.match("url(javascript:x)", style.get("url-function") as RegExp);
  assert.match("a { color: red }", style.get("css-block") as RegExp);
  for (const [, pattern] of FORBIDDEN_STYLE_PATTERNS) assert.doesNotMatch("#1a2b3c", pattern);
  const injection = new Map(INJECTION_PATTERNS);
  assert.match("<script>alert(1)</script>", injection.get("script-tag") as RegExp);
  assert.match("1; DROP TABLE users", injection.get("sql-metacharacter") as RegExp);
  for (const [, pattern] of INJECTION_PATTERNS) assert.doesNotMatch("Total revenue", pattern);
});

test("suite-owned ceilings and minimums are frozen and sane", () => {
  assert.ok(Object.isFrozen(LIMIT_CEILINGS));
  assert.ok(Object.isFrozen(CONTRAST_MINIMUM));
  assert.ok(LIMIT_CEILINGS.maxDepth as number >= 5);
  assert.ok((LIMIT_CEILINGS.maxStructuralDepth as number) > (LIMIT_CEILINGS.maxDepth as number));
  assert.equal(CONTRAST_MINIMUM.body, 4.5);
});
