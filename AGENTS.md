# Structile conformance authority

## Protected repository

This repository evaluates implementation candidates. Read `requirements/requirements.json`, `verification/test-catalog.json`, and `verification/evidence.schema.json` before any work.

Ordinary implementation builders have read-only authority here. They must not change requirements, test logic, fixtures, goldens, seeds, thresholds, waiver state, evidence policy, repository rules, CODEOWNERS, signing workflows, or release artifacts.

The initial G0 bootstrap branch proposes runner infrastructure for human/verifier review. After the human establishes the baseline, changes require a separate protected conformance/specification task and independent review; core/product feature PRs cannot include them.

No agent may sign evidence, apply repository protections, merge, release the runner, or claim a gate passed. Local evidence is unsigned and non-authoritative.

## Presentation gate

No pull request is opened, updated or presented to the human until every check below has run and passed (`docs/delivery-operating-model.md` section 6 in the canonical planning repository, <https://github.com/magnusihle/structile-planning>, is normative):

1. This repository's own candidate checks pass locally, using the same commands its CI runs (`npm ci --ignore-scripts && npm run check`). A red first CI run on a pre-existing check is a loop failure.
2. The committed diff from the merge-base is reviewed file by file and its manifest matches the declared scope exactly. Bulk staging (`git add -A`) is forbidden; every path is staged explicitly.
3. Size ceilings hold: gross churn at most 500 lines and 10 files (targets 200/5).
4. The full diff contains no undeclared files, secrets, NUL bytes or undeclared TODO/FIXME markers, and every new user-facing entry point has been executed at least once for real.
5. An independent verifier context that did not author the change re-runs checks 1–4 adversarially, with a mandate to refute readiness, and issues a verdict. Verifier agents run on an economical model (Sonnet-class or cheaper), never a frontier model. One verifier pass per PR; a trivial delta provable by diff-stat plus green CI needs no fresh round.
6. The report presenting the PR quotes tool and verifier output verbatim. A prose claim of verification with no attached output is void.
