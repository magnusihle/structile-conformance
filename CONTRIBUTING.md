# Contributing

Conformance changes are specification changes, not implementation fixes. Each change requires a human-owned task, requirement/test mapping, security impact, protected fixture/threshold review, independent reviewer, and a new signed runner digest.

Implementation builders may report reproducible failures but must not submit a test weakening alongside the candidate it evaluates. No pull request may lower a threshold in response to an implementation failure without an explicit scope decision.
