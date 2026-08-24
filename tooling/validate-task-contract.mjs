// Hand-rolled validator for delivery/task-contract.schema.json, in the same
// dependency-free style as validate-planning.mjs. task-ready reuses this.

const GATES = new Set(["G0", "G1", "G2", "G3", "G4", "G4A", "G5", "G6"]);
const TASK_ID = /^[A-Z][A-Z0-9]*-[0-9]{3}-T[0-9]{2,3}$/;
const CATALOG_ID = /^[A-Z][A-Z0-9]*-[0-9]{3}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const HARD_MAX_LINES = 500;
const HARD_MAX_FILES = 10;

// Paths no contract may open for modification: the enforcement surface.
const FORBIDDEN_ALLOWED_PATH_PREFIXES = [
  "delivery/",
  "requirements/",
  "verification/",
  "docs/delivery-operating-model.md"
];

const isStringArray = (value, min = 0) =>
  Array.isArray(value) && value.length >= min && value.every((item) => typeof item === "string" && item.length > 0);

export function validateTaskContract(contract) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (typeof contract !== "object" || contract === null || Array.isArray(contract)) {
    return ["contract must be a JSON object"];
  }

  if (!TASK_ID.test(contract.id ?? "")) fail("id must match <REQ-ID>-T<nn>, e.g. SPEC-001-T01");
  if (typeof contract.behavior !== "string" || contract.behavior.length < 15) fail("behavior must be one full sentence (min 15 chars)");
  if (!GATES.has(contract.gate)) fail("gate must be one of the catalog gates");
  if (!isStringArray(contract.requirements, 1) || !contract.requirements.every((id) => CATALOG_ID.test(id))) fail("requirements must list at least one requirement ID");
  if (!isStringArray(contract.protectedTests, 1) || !contract.protectedTests.every((id) => CATALOG_ID.test(id))) fail("protectedTests must list at least one protected test ID");
  if (!COMMIT.test(contract.baseCommit ?? "")) fail("baseCommit must be a 40-hex commit SHA");
  if (!DIGEST.test(contract.runnerDigest ?? "")) fail("runnerDigest must be sha256:<64 hex>");
  if (!DIGEST.test(contract.testSourceDigest ?? "")) fail("testSourceDigest must be sha256:<64 hex>");
  if (!isStringArray(contract.allowedPaths, 1)) fail("allowedPaths must list at least one glob");
  if (!isStringArray(contract.commands, 1)) fail("commands must list at least one command");
  if (typeof contract.owner !== "string" || contract.owner.length < 2) fail("owner must name the approving human");
  if (typeof contract.escalation !== "string" || contract.escalation.length < 2) fail("escalation must name a checkpoint route");
  if (!isStringArray(contract.localArtifacts, 1)) fail("localArtifacts must list at least one artifact");

  const budget = contract.budget;
  if (typeof budget !== "object" || budget === null) {
    fail("budget must be an object with maxLines and maxFiles");
  } else {
    if (!Number.isInteger(budget.maxLines) || budget.maxLines < 1 || budget.maxLines > HARD_MAX_LINES) {
      fail(`budget.maxLines must be 1..${HARD_MAX_LINES} (hard ceiling; DEL-002)`);
    }
    if (!Number.isInteger(budget.maxFiles) || budget.maxFiles < 1 || budget.maxFiles > HARD_MAX_FILES) {
      fail(`budget.maxFiles must be 1..${HARD_MAX_FILES} (hard ceiling; DEL-002)`);
    }
  }

  if (isStringArray(contract.allowedPaths)) {
    for (const glob of contract.allowedPaths) {
      const normalized = glob.replace(/^\.\//, "");
      if (FORBIDDEN_ALLOWED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix) || prefix.startsWith(normalized.replace(/\*.*$/, "")))) {
        fail(`allowedPaths may not open the protected enforcement surface: ${glob}`);
      }
    }
  }

  if (contract.placeholders !== undefined) {
    if (!Array.isArray(contract.placeholders)) {
      fail("placeholders must be an array");
    } else {
      for (const item of contract.placeholders) {
        if (typeof item !== "object" || item === null || typeof item.path !== "string" || !TASK_ID.test(item.followUpTask ?? "")) {
          fail("each placeholder needs a path and an approved followUpTask ID");
        }
      }
    }
  }

  return errors;
}

export function assertTaskContract(contract) {
  const errors = validateTaskContract(contract);
  if (errors.length > 0) {
    const error = new Error(`Task contract validation failed:\n- ${errors.join("\n- ")}`);
    error.errors = errors;
    throw error;
  }
}
