# SPEC-002 qualification — spec-migrations

**This is a rewrite for the released-majors amendment (planning#1), not a port.** The
salvage suite at `origin/g1/protected-suites:src/suites-g1b.ts` L114–212 presupposed a
released spec major 2 that does not exist and asserted an N/N-1 round trip unconditionally.
The amended catalog oracle (`verification/test-catalog.json`, SPEC-002) is authoritative and
reads:

> With one released major: the compatibility matrix truthfully declares current 1, previous
> null and migration/rollback not-applicable; unknown, future, fractional or unavailable
> versions fail closed; no synthetic major or corpus is fabricated. With two or more released
> majors: migrations are deterministic/idempotent; supported specs preserve semantics;
> forward/rollback round-trip meets normalized equality and the compatibility matrix is
> complete.

Suite ID: SPEC-002 (`spec-migrations` slug), gate G1, requirements SPEC-002, SPEC-003.
Candidate SHA: `653471d73f2352a77f2cf2ef2856f6f9e17873d1` (core `main`, "Adopt delivery
operating model: gates, task-ready and planning pin (#10)"), run from a clean worktree
pinned to that exact commit. All runs below are `localUnsigned`/informative per
`--allow-unsigned`; none is protected release evidence.

## What was rewritten vs. reused

Reused from salvage (structurally unchanged): the `buildAndImport`/`requireExports` import
pattern, the corpus-driven validation loop, the deterministic/idempotent/lossless round-trip
assertions and the `assertDiscriminates`-based fail-closed checks for out-of-matrix migration
targets — all of it, but now gated behind `previous !== null` so it only runs once a second
major genuinely exists.

Rewritten: every assertion that presupposed major 2. Salvage's `assert.ok(previous !== null,
...)` treated a single supported major as a suite failure ("a runtime that supports only one
major cannot demonstrate N/N-1 compatibility, and declaring the requirement met would be
false") — under the amendment that is backwards: a single-major runtime that declares
`previous: null` and `rollback: "not-yet-applicable"` is compliant, and a suite that forces a
fabricated migration to pass would itself be the violation. The rewrite branches on
`supported.length`:

- **One released major** (current state): asserts `matrix.migrations` is empty and
  `matrix.rollback === "not-yet-applicable"`; asserts the on-disk migration corpus contains
  exactly one fixture per released major and nothing more (`readdir` on
  `fixtures/spec/migrations` must equal `["v1.json"]`, never a fabricated `v2.json`); and
  probes `negotiateSpecVersion` with `assertDiscriminates` against a future major (current+1),
  a fractional major (current+0.5), a negative/unavailable major (-1), a large unknown major
  (999999), a missing `specVersion`, and an empty `specVersion` object — six controls, each
  paired against the accepted current-major call so a masked pass is structurally impossible.
- **Two or more released majors** (not yet reachable, written so it engages the moment it is):
  `requireExports(spec, ["migrateSpecification", "rollbackSpecification"], ...)` only in this
  branch — core `main` does not export either symbol today, and requiring them
  unconditionally (as salvage did) would fail a runtime the amended requirement says must
  pass. Then the full salvage-style round trip: adjacent forward/rollback migrations declared
  in both directions, forward-then-rollback losslessness, determinism, idempotence, component-
  shape preservation, and fail-closed on an out-of-matrix target major.

Both branches read off the same `supported`/`previous` values, so this is one suite body, not
a suite plus a disabled stub — the two-majors path is inert today because `previous === null`,
not skipped.

## Fixture decision

`fixtures/spec/migrations/v1.json` is carried byte-for-byte from salvage — it is read, in
both branches, to prove a real corpus exists for the one released major and validates under
`fixtures/spec/catalog.json`. Blob identity proof:

```
$ git show origin/g1/protected-suites:fixtures/spec/migrations/v1.json | shasum -a 256
88cc935a5c18496f4abd445a205e65f4ea6bce2c466f3728b7959123884e225f  -
$ shasum -a 256 fixtures/spec/migrations/v1.json
88cc935a5c18496f4abd445a205e65f4ea6bce2c466f3728b7959123884e225f  fixtures/spec/migrations/v1.json
```

`fixtures/spec/migrations/v2.json` is **rejected, not carried**. It declares
`specVersion.major: 2`, which presupposes a spec major that has not released. The rewritten
suite's one-major branch never reads it, and reading it would itself violate the amended
oracle ("no synthetic major or corpus is fabricated"). The suite instead asserts its absence:
it lists `fixtures/spec/migrations/` and requires the file set to equal exactly
`v{major}.json` for each major in `SUPPORTED_SPEC_MAJORS` — currently `["v1.json"]` — so a
future `v2.json` added ahead of a real major-2 release would itself fail the suite. No new
fixture content presupposing an unreleased major was invented.

## Toolchain / build note

`buildAndImport("@structile/spec", "packages/spec")` builds only the `@structile/spec`
workspace; on a worktree with no prior build, its `dependencies` type import of
`@structile/catalog` needs that package's `dist/*.d.ts` already present or `tsc` fails with
`TS2307: Cannot find module '@structile/catalog'`. The protected runner presumably builds all
workspaces in dependency order before any suite executes; for these standalone runs
`@structile/catalog` was built once explicitly (`npm run build --workspace @structile/catalog`)
before invoking the suite. This is a fixture/environment note, not a change to the suite or to
core.

## Positive control

Candidate: clean worktree at `653471d73f2352a77f2cf2ef2856f6f9e17873d1`, `SUPPORTED_SPEC_MAJORS
= [1]` (unmodified, "conforms as-is" per the tranche brief).

```
$ node src/cli.ts run spec-migrations --candidate <candidate-worktree> \
    --matrix released --roundtrip --unsigned --evidence-dir <dir>
{"testId":"SPEC-002","status":"passed","exitCode":0,
 "evidence":".../evidence.json","authoritative":false}
```

`measurements`: `supportedMajors:1, branch:"single-major-not-applicable", roundtrips:0,
rejections:6, localUnsigned:true`.

`migration-matrix.json`:

```json
{
  "supported": [1], "current": 1, "previous": null,
  "matrix": { "current": 1, "previous": null, "supported": [1], "migrations": [], "rollback": "not-yet-applicable" },
  "corpusFiles": ["v1.json"],
  "branch": "single-major-not-applicable"
}
```

`roundtrip-diffs.json` (`rejections`, all `controlAccepted:true`):

```json
[
  {"label":"negotiate:future-major","rejected":true,"error":"unsupported specification major 2; supported: 1","controlAccepted":true},
  {"label":"negotiate:fractional-major","rejected":true,"error":"specVersion must declare an integer major","controlAccepted":true},
  {"label":"negotiate:unavailable-major","rejected":true,"error":"unsupported specification major -1; supported: 1","controlAccepted":true},
  {"label":"negotiate:unknown-major","rejected":true,"error":"unsupported specification major 999999; supported: 1","controlAccepted":true},
  {"label":"negotiate:missing-specVersion","rejected":true,"error":"specVersion must declare an integer major","controlAccepted":true},
  {"label":"negotiate:empty-specVersion","rejected":true,"error":"specVersion must declare an integer major","controlAccepted":true}
]
```

### verify-evidence

```
$ node src/cli.ts verify-evidence <dir>/evidence.json --allow-unsigned \
    --candidate-sha 653471d73f2352a77f2cf2ef2856f6f9e17873d1
{"testId":"SPEC-002","status":"passed","requirements":2,"errors":0}
```

## Mutants (throwaway worktree, removed after use)

Three mutants applied one at a time to a disposable `git worktree add ... 653471d... --detach`
of core, each reverted with `git checkout --` before the next was applied; the worktree was
removed (`git worktree remove --force`) after the last one. Each hits a distinct amended-oracle
behavior and fails for the asserted reason (verbatim from the suite's own assertion, quoted
from `measurements.error` in the resulting evidence):

**Mutant 1 — matrix fabricates a previous major.** `packages/spec/src/version.ts`,
`compatibilityMatrix()`: changed `sorted.length > 1 ? sorted[1] : null` to `... : 0`, so a
single-major runtime reports `previous: 0` instead of `previous: null`.

```
the matrix must declare the previous major honestly

0 !== null
```

**Mutant 2 — a future major is accepted instead of failing closed.**
`packages/spec/src/validation.ts`, `negotiateSpecVersion()`: added
`&& requested.major !== (SUPPORTED_SPEC_MAJORS[0] as number) + 1` to the supported-majors
guard, so `current + 1` (the "next" major) is let through.

```
negotiate:future-major was accepted but must be rejected
```

**Mutant 3 — a fractional major is accepted instead of failing closed.**
`packages/spec/src/validation.ts`, `negotiateSpecVersion()`: replaced
`!Number.isInteger(requested.major)` with `typeof requested.major !== "number"`, and the
supported-majors check with `SUPPORTED_SPEC_MAJORS.includes(Math.trunc(requested.major))`, so
`current + 0.5` truncates to a supported integer and is accepted.

```
negotiate:fractional-major was accepted but must be rejected
```

Each mutant was reverted (`git checkout -- packages/spec/src/<file>`) immediately after its
run; `git status --porcelain` in the mutant worktree was clean before removal.

## Status

Local/informative only. `npm run check` is green in this branch's worktree (planning:check,
language:check, typecheck, `node --test test/*.test.ts` all pass, including the updated
`runner.test.ts` ten-suite registration). The positive control and `verify-evidence` runs above
are `localUnsigned: true` / `workflowIdentity: local-unsigned/not-release-evidence` — informative
only, not protected release evidence. SPEC-002 and SPEC-003 remain unevidenced for G1 until the
protected conformance workflow runs this suite, signed, against the merged candidate.
