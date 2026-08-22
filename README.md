# Structile Conformance

Protected public conformance contracts and runner for [Structile](https://github.com/magnusihle/structile).

This repository is a separate verification authority. Implementation builders may read and run pinned releases but cannot modify protected test logic, fixtures, thresholds, evidence policy, signing configuration, or repository rules through ordinary feature pull requests.

## G0 status

The G0 bootstrap imports the approved requirement/test/evidence catalogs byte-for-byte and provides the `platform-conformance` command boundary. The local runner can reproduce deterministic checks, but local output is explicitly unsigned and is not release evidence. Protected CI identity, repository rules, and signing must be applied by the human authority before G0 can pass.

```sh
npm ci
npm run check
node src/cli.ts list
```

Authored source, tests, and executable repository scripts are TypeScript. Generated JavaScript is allowed; the two protected planning `.mjs` inputs are the only named exceptions enforced by `npm run language:check`.

Runner contract:

```sh
platform-conformance run <suite> [versioned arguments]
```

Exit `0` means the oracle passed and an evidence envelope was emitted; exit `1` means the oracle failed; exit `2` means invocation, environment, prerequisite, timeout, internal, or evidence failure. A gate accepts only evidence attested by the protected workflow for the exact candidate commit and runner digest.
