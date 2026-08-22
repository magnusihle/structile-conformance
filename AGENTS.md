# Structile conformance authority

## Protected repository

This repository evaluates implementation candidates. Read `requirements/requirements.json`, `verification/test-catalog.json`, and `verification/evidence.schema.json` before any work.

Ordinary implementation builders have read-only authority here. They must not change requirements, test logic, fixtures, goldens, seeds, thresholds, waiver state, evidence policy, repository rules, CODEOWNERS, signing workflows, or release artifacts.

The initial G0 bootstrap branch proposes runner infrastructure for human/verifier review. After the human establishes the baseline, changes require a separate protected conformance/specification task and independent review; core/product feature PRs cannot include them.

No agent may sign evidence, apply repository protections, merge, release the runner, or claim a gate passed. Local evidence is unsigned and non-authoritative.
