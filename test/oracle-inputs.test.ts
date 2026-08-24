import test from "node:test";
import assert from "node:assert/strict";
import { isOracleInput } from "../src/evidence.ts";

test("testSourceDigest covers every oracle-affecting input class", () => {
  for (const path of [
    "src/cli.ts",
    "src/suites.ts",
    "fixtures/spec/seeds/minimal.json",
    "fixtures/capability/corpus.json",
    "verification/test-catalog.json",
    "verification/evidence.schema.json"
  ]) {
    assert.equal(isOracleInput(path), true, path);
  }
});

test("non-oracle files stay out of the test-source digest", () => {
  for (const path of [
    "test/runner.test.ts",
    "tooling/task-ready.mjs",
    "README.md",
    "delivery/planning-pin.json",
    "package.json"
  ]) {
    assert.equal(isOracleInput(path), false, path);
  }
});
