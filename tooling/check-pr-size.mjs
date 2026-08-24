#!/usr/bin/env node
// DEL-002 CI gate: fail any PR whose gross churn (additions plus deletions,
// measured from the merge-base with the target branch) exceeds the hard
// ceilings of the delivery operating model. This planning repository has no
// generated files, so no path is exempt; governed implementation repos apply
// per-task budgets and generatedPaths exemptions through task-ready instead.

import { execFileSync } from "node:child_process";

const HARD_MAX_LINES = 500;
const HARD_MAX_FILES = 10;

export function checkPrSize(baseRef, repo = process.cwd()) {
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const mergeBase = git("merge-base", baseRef, "HEAD").trim();

  let lines = 0;
  let files = 0;
  for (const row of git("diff", "--numstat", `${mergeBase}..HEAD`).split("\n")) {
    if (!row.trim()) continue;
    const [added, deleted] = row.split("\t");
    files += 1;
    if (added !== "-") lines += Number(added) + Number(deleted);
  }

  const violations = [];
  if (lines > HARD_MAX_LINES) {
    violations.push(`gross churn ${lines} lines exceeds the hard ceiling of ${HARD_MAX_LINES} (DEL-002); re-decompose the task`);
  }
  if (files > HARD_MAX_FILES) {
    violations.push(`${files} changed files exceeds the hard ceiling of ${HARD_MAX_FILES} (DEL-002); re-decompose the task`);
  }
  return { mergeBase, lines, files, violations };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error("usage: check-pr-size <base-ref>");
    process.exit(2);
  }
  let result;
  try {
    result = checkPrSize(baseRef);
  } catch (error) {
    console.error(`check-pr-size: cannot resolve base ref "${baseRef}": ${error.message.split("\n")[0]}`);
    process.exit(2);
  }
  const { mergeBase, lines, files, violations } = result;
  console.log(`check-pr-size: ${lines} lines, ${files} files changed since ${mergeBase.slice(0, 12)} (ceilings: ${HARD_MAX_LINES}/${HARD_MAX_FILES})`);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`FAIL ${violation}`);
    process.exit(1);
  }
}
