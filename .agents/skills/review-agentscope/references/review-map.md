# Review map

Select every checklist whose trigger matches the delta. Review adjacent seams when one component hands authority, data, time, or durable state to another.

| Changed area                                  | Required references                                                                   | Typical adjacent seam                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Requirements, Blueprints, acceptance evidence | `architecture-blueprints.md`, `testing-evidence-acceptance.md`                        | implementation and release claims                    |
| Protocol, canonical DTOs, codecs, brands      | `trust-data-privacy.md`, `api-package-artifacts.md`, `testing-evidence-acceptance.md` | Core finalization and external readers               |
| Core capture, redaction, routing, retrieval   | `trust-data-privacy.md`, `lifecycle-recovery-concurrency.md`                          | Protocol brands, destinations, Operational State     |
| Destination or harness descriptors            | `trust-data-privacy.md`, `api-package-artifacts.md`                                   | Core-only orchestration and test-only contracts      |
| Configuration, credentials, Operational State | `trust-data-privacy.md`, `lifecycle-recovery-concurrency.md`                          | Doctor, recovery, cross-process writers              |
| Hook installation or filesystem mutation      | `lifecycle-recovery-concurrency.md`, `api-package-artifacts.md`                       | path identity, ownership records, recovery manifests |
| CLI commands and presentation                 | `testing-evidence-acceptance.md`, `api-package-artifacts.md`                          | Core typed outcomes and output escaping              |
| Package exports, builds, workflows            | `api-package-artifacts.md`, `release-practice.md`                                     | clean checkout, packed CLI, restricted imports       |
| Test adapters and reusable suites             | `testing-evidence-acceptance.md`, `trust-data-privacy.md`                             | oracle ownership and production export isolation     |

Always apply `architecture-blueprints.md`, `release-practice.md`, and `review-language.md`.
