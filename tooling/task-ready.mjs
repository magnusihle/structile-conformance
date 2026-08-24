#!/usr/bin/env node
// Canonical task-ready implementation (DEL-003). Repository-neutral entry
// point: ./tooling/task-ready <task-id> [--repo <dir>].
//
// Advisory convergence tooling only. It runs with builder credentials, so a
// green result is never evidence and never supports a gate claim; only the
// independent protected verifier produces evidence (DEL-004, GOV-004).

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { validateTaskContract } from "./validate-task-contract.mjs";

const HARD_MAX_LINES = 500;
const HARD_MAX_FILES = 10;
const PLACEHOLDER_PATTERN = /\b(TODO|FIXME|XXX)\b/;

const globToRegExp = (glob) => {
  const source = glob
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
};

export function runTaskReady(taskId, repo = process.cwd()) {
  const violations = [];
  const warnings = [];
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

  const contractPath = join("delivery", "tasks", `${taskId}.json`);
  let contract = null;
  try {
    contract = JSON.parse(readFileSync(resolve(repo, contractPath), "utf8"));
  } catch (error) {
    return { violations: [`cannot read ${contractPath}: ${error.message}`], warnings };
  }
  violations.push(...validateTaskContract(contract).map((item) => `contract: ${item}`));
  if (violations.length > 0) return { violations, warnings };

  const base = contract.baseCommit;
  try {
    git("cat-file", "-e", `${base}^{commit}`);
  } catch {
    return { violations: [`baseCommit ${base} is not present in this repository`], warnings };
  }
  try {
    git("merge-base", "--is-ancestor", base, "HEAD");
  } catch {
    violations.push(`HEAD does not descend from baseCommit ${base}`);
  }
  // The contract either already exists on baseCommit, or is introduced by
  // exactly one approved commit after it — and is never modified afterwards.
  const worktreeContract = readFileSync(resolve(repo, contractPath), "utf8");
  let baseline = null;
  try {
    baseline = git("show", `${base}:${contractPath}`);
  } catch {
    baseline = null;
  }
  if (baseline !== null) {
    if (baseline !== worktreeContract) {
      violations.push("task contract differs from the version on baseCommit (a PR may not modify its own contract)");
    }
  } else {
    const touches = git("log", "--format=%H", `${base}..HEAD`, "--", contractPath).split("\n").filter(Boolean);
    if (touches.length !== 1) {
      violations.push(`task contract must be introduced by exactly one approved commit after baseCommit and never modified (found ${touches.length} commits touching it)`);
    }
    let headContract = null;
    try {
      headContract = git("show", `HEAD:${contractPath}`);
    } catch {
      headContract = null;
    }
    if (headContract !== worktreeContract) {
      violations.push("task contract has uncommitted modifications (a PR may not modify its own contract)");
    }
  }

  const allowed = contract.allowedPaths.map(globToRegExp);
  const generated = (contract.generatedPaths ?? []).map(globToRegExp);
  const declaredPlaceholders = new Set((contract.placeholders ?? []).map((item) => item.path));
  const protectedGlobs = ["delivery/**", "requirements/**", "verification/**"];
  const protectedFile = resolve(repo, "delivery", "protected-paths.txt");
  if (existsSync(protectedFile)) {
    for (const line of readFileSync(protectedFile, "utf8").split("\n")) {
      if (line.trim()) protectedGlobs.push(line.trim());
    }
  }
  const isProtected = (path) => protectedGlobs.map(globToRegExp).some((regex) => regex.test(path));

  const changes = new Map();
  for (const row of git("diff", "--numstat", base).split("\n")) {
    if (!row.trim()) continue;
    const [added, deleted, path] = row.split("\t");
    changes.set(path, added === "-" ? 0 : Number(added) + Number(deleted));
  }
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter((path) => path.trim());
  for (const path of untracked) {
    changes.set(path, readFileSync(resolve(repo, path), "utf8").split("\n").length);
  }

  const artifactPaths = new Set(contract.localArtifacts);
  let lines = 0;
  for (const [path, churn] of changes) {
    if (path === contractPath || artifactPaths.has(path)) continue;
    if (!allowed.some((regex) => regex.test(path))) violations.push(`out of scope: ${path} matches no allowedPaths glob`);
    if (isProtected(path)) violations.push(`protected path changed: ${path}`);
    if (!generated.some((regex) => regex.test(path))) lines += churn;
  }
  const files = [...changes.keys()].filter((path) => path !== contractPath && !artifactPaths.has(path)).length;
  const maxLines = Math.min(contract.budget.maxLines, HARD_MAX_LINES);
  const maxFiles = Math.min(contract.budget.maxFiles, HARD_MAX_FILES);
  if (lines > maxLines) violations.push(`gross churn ${lines} lines exceeds budget ${maxLines}`);
  if (files > maxFiles) violations.push(`${files} changed files exceeds budget ${maxFiles}`);

  const placeholderViolation = (path) =>
    violations.push(`undeclared placeholder marker added in ${path} (declare it in placeholders with a followUpTask)`);
  let currentPath = "";
  for (const row of git("diff", "-U0", base).split("\n")) {
    if (row.startsWith("+++ b/")) {
      currentPath = row.slice(6);
    } else if (row.startsWith("+") && !row.startsWith("+++") && PLACEHOLDER_PATTERN.test(row)) {
      if (!declaredPlaceholders.has(currentPath)) placeholderViolation(currentPath);
    }
  }
  for (const path of untracked) {
    if (path === contractPath || artifactPaths.has(path) || declaredPlaceholders.has(path)) continue;
    if (PLACEHOLDER_PATTERN.test(readFileSync(resolve(repo, path), "utf8"))) placeholderViolation(path);
  }

  const timeoutMs = (contract.budget.maxMinutes ?? 30) * 60_000;
  for (const command of contract.commands) {
    try {
      execSync(command, { cwd: repo, stdio: "pipe", timeout: timeoutMs });
    } catch (error) {
      violations.push(`command failed: ${command} (${error.status === undefined ? "timeout or spawn error" : `exit ${error.status}`})`);
    }
  }

  for (const artifact of contract.localArtifacts) {
    const artifactPath = resolve(repo, artifact);
    if (!existsSync(artifactPath)) {
      violations.push(`declared local artifact missing: ${artifact}`);
      continue;
    }
    if (artifact.endsWith(".json")) {
      try {
        const parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
        if ("localUnsigned" in parsed && parsed.localUnsigned !== true) {
          violations.push(`local envelope ${artifact} must be explicitly localUnsigned: true`);
        }
      } catch {
        violations.push(`local artifact ${artifact} is not valid JSON`);
      }
    }
  }

  warnings.push("runnerDigest/testSourceDigest verification requires the pinned protected runner and is not performed by task-ready v1");
  return { violations, warnings };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let repo = process.cwd();
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--repo") {
      repo = resolve(args[++index] ?? ".");
    } else if (!args[index].startsWith("--")) {
      positional.push(args[index]);
    }
  }
  const taskId = positional[0];
  if (!taskId) {
    console.error("usage: task-ready <task-id> [--repo <dir>]");
    process.exit(2);
  }
  const { violations, warnings } = runTaskReady(taskId, repo);
  for (const warning of warnings) console.error(`WARN ${warning}`);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`FAIL ${violation}`);
    console.error(`task-ready: ${taskId} NOT ready (${violations.length} violation${violations.length === 1 ? "" : "s"})`);
    process.exit(1);
  }
  console.log(`task-ready: ${taskId} ready. Advisory only — not evidence; only the protected verifier produces evidence.`);
}
