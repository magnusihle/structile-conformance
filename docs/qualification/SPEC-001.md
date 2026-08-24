# SPEC-001 qualification — spec-fuzz

Suite ID: SPEC-001 (`spec-fuzz` slug), gate G1, requirements DS-003, SPEC-001, SPEC-007,
SPEC-008, SPEC-009, SPEC-010. Candidate SHA: `653471d73f2352a77f2cf2ef2856f6f9e17873d1`
(core `main`, "Adopt delivery operating model: gates, task-ready and planning pin (#10)"),
run from a throwaway worktree pinned to that exact commit. All runs below are
`localUnsigned`/informative per `--allow-unsigned`; none is protected release evidence.

## Pollution-hardening rework

Main's `resolveParent` (`src/g1-support.ts`) now refuses any path traversing or targeting a
`POLLUTION_KEYS` segment (`f837cb8`, landed after the salvage `specFuzz` was written).
`specFuzz`'s deterministic property-fuzzing loop calls `resolveParent(document, path)` once
per iteration, for every mutation kind including `"pollute"`.

Analysis before porting: each iteration rebuilds `document` fresh from a clean protected seed
(`JSON.parse(JSON.stringify(pick(seeds)))`), and `collectPaths`/`resolveParent` both run on
that clean document *before* the iteration's single mutation is applied — iterations do not
compound. `collectPaths` only returns own-enumerable paths, so it can only surface a
`__proto__`/`constructor`/`prototype` segment if a seed carried one as a real own property;
the three protected seeds and the fixture catalog contain none (checked by `grep`). The
`"pollute"` mutation never asks `resolveParent` to walk *through* a pollution key — it reaches
an ordinary, already-resolved target like every other mutation and only afterwards assigns a
JSON-parsed `{"__proto__": {...}}` literal (a real own property, not a live-prototype write)
as that target's new value.

Conclusion: the hardening is inert for this suite's call pattern. No payload-synthesis
workaround was needed or added — `specFuzz` was ported byte-for-byte from salvage, with a
comment above the fuzz loop recording this analysis. Confirmed empirically:
`assertPrototypeIntact()` passes on all 100,000 iterations below, including every `"pollute"`
draw, and `measurements.prototypePolluted` is `false`. Assertion strength is unchanged from
salvage — every `assertDiscriminates` call and its `errorName`/`label` pair is identical,
character for character, to `git show origin/g1/protected-suites:src/suites-g1.ts` L360–596.

## Positive control

```
$ node src/cli.ts run spec-fuzz --unsigned --candidate <candidate-worktree> --evidence-dir <dir> --seeds protected --iterations 100000
{"testId":"SPEC-001","status":"passed","exitCode":0,"evidence":".../evidence.json","authoritative":false}
```

Wall time: ~2.9s. `measurements`: `iterations:100000, seed:20260823, deterministicRejections:25,
fuzzAccepted:13790, fuzzRefused:86210, prototypePolluted:false, localUnsigned:true`. All 25
deterministic negative-corpus probes (3 top-level pollution keys + 1 nested pollution +
11 injection classes + 2 catalog-escape + 5 limits + 3 non-data-type probes) discriminated
correctly (control accepted, poison rejected). All three catalog-named `evidenceArtifacts`
were emitted: `spec-fuzz.json`, `rejected-corpus.json`, `coverage.json`.

```
$ node src/cli.ts verify-evidence <evidence.json> --allow-unsigned --candidate-sha 653471d73f2352a77f2cf2ef2856f6f9e17873d1
{"testId":"SPEC-001","status":"passed","requirements":6,"errors":0}
```

## Negative mutants

Built in a throwaway worktree of core (`git worktree add ... 653471d7... --detach`), full
`npm run build --workspaces --if-present` once to materialise every workspace's `dist/`
(required — the suite's own `buildAndImport` only rebuilds `@structile/spec`, and a fresh
worktree has no prebuilt `@structile/catalog` type declarations for it to resolve against),
then one mutation at a time in `packages/spec/src/validation.ts`, rebuilt with
`npm run build --workspace @structile/spec`, rerun, then reverted (`git checkout --`) before
the next mutant. Worktree removed with `git worktree remove --force` after all four.

**Mutant 1 — unknown componentId silently skipped (catalog escape).** `walkNodes`: changed
`if (!registration) { violations.push(...); continue; }` to `if (!registration) { continue; }`,
so a node referencing an unregistered `componentId` is skipped rather than rejected.

```
{"testId":"SPEC-001","status":"failed","exitCode":1, ...}
measurements.error: "catalog:unknown-component was accepted but must be rejected"
```

Fails for the asserted reason: the suite's dedicated `catalog:unknown-component` probe sets
`componentId` to `"not.registered"` and expects rejection; with the check reduced to a silent
skip, the document validates cleanly instead.

**Mutant 2 — nested prototype pollution accepted.** One defect, two coordinated edits (the
candidate's closed-key schema is otherwise redundant with the pollution scan and masks a
narrower single-line change — see note): `scanData`'s pollution check
(`if (POLLUTION_KEYS.includes(key)) { violations.push(...); continue; }`) was removed from
its object-walk branch, and `PAGE_KEYS` was widened to include `"__proto__"` so the
page-level `additionalProperties:false` check no longer flags it as unknown either.

```
{"testId":"SPEC-001","status":"failed","exitCode":1, ...}
measurements.error: "pollution:nested was accepted but must be rejected"
```

Fails for the asserted reason: the suite's `pollution:nested` probe injects `__proto__` into
`pages[0]` (not the top level) and expects rejection *on its own merits*, per the salvage
comment on avoiding a masking violation; with both defences disabled the poisoned document
validates. Note: removing only the `scanData` check does **not** fail this probe —
`rejectUnknownKeys(page, PAGE_KEYS, ...)` independently flags `__proto__` as an unknown page
property, which is the candidate's schema closure providing genuine defence in depth, not a
suite gap. Both had to be disabled together to isolate the pollution-specific assertion.

**Mutant 3 — SQL-metacharacter injection accepted.** `FORBIDDEN_VALUE_PATTERNS`: removed the
`["sql-metacharacter", /(?:--|;|\/\*|\*\/|\bunion\b|\bselect\b|\bdrop\b|\bdelete\b|\binsert\b)/i]`
entry, so `title = "1; DROP TABLE t --"` is no longer refused by the candidate's own value
scan (verified no other pattern in the list matches this payload).

```
{"testId":"SPEC-001","status":"failed","exitCode":1, ...}
measurements.error: "injection:sql-metacharacter was accepted but must be rejected"
```

Fails for the asserted reason: the suite's `injection:sql-metacharacter` probe expected
`validateSpecification` to reject the poisoned title and it did not.

**Mutant 4 — node-count ceiling silently unenforced (complexity overflow).** `walkNodes`:
removed `if (state.nodes > LIMITS.maxNodes) { violations.push(...); return; }`, so a
specification with more than `LIMITS.maxNodes` (250) nodes is no longer refused. (`limit:bytes`
was not usable here without also touching `APPLICATION_KEYS` — its `description` field is not
a recognised top-level key in this candidate's schema, so that probe is independently caught
regardless of `maxBytes` enforcement; `limit:nodes` gives a clean single-mechanism target,
sized so the added nodes stay under `maxCost` at `staticWeight:1` each.)

```
{"testId":"SPEC-001","status":"failed","exitCode":1, ...}
measurements.error: "limit:nodes was accepted but must be rejected"
```

Fails for the asserted reason: the suite's `limit:nodes` probe builds `LIMITS.maxNodes + 1`
copies of a valid node and expects rejection; with the ceiling check removed, the oversized
document validates.

Each mutant targets a distinct SPEC-001 assertion class (catalog identity, prototype
pollution, injection payload, complexity ceiling) and was confirmed to fail specifically on
the probe exercising that class, not incidentally elsewhere.

## Scope note

This qualification only exercises SPEC-001 (`specFuzz`). ACT-001, SPEC-002, CAP-001 and
PKG-001/HAR-004 are ported and qualified in their own PRs, per `src/suites-g1.ts`'s header
comment.
