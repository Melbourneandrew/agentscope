#!/usr/bin/env python3
"""Validate the durable structure and non-negotiable rules of review-agentscope."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import sys


DEFAULT_SKILL_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPOSITORY_ROOT = DEFAULT_SKILL_ROOT.parents[2]

REQUIRED_REFERENCES = (
    "review-map.md",
    "architecture-blueprints.md",
    "trust-data-privacy.md",
    "lifecycle-recovery-concurrency.md",
    "api-package-artifacts.md",
    "testing-evidence-acceptance.md",
    "release-practice.md",
    "review-language.md",
)

REQUIRED_SKILL_PHRASES = (
    "Blueprint decisions are binding",
    "standalone Blueprint-only PR",
    "earlier, standalone Blueprint-only PR",
    "authorized defensive review",
    "exact, quiescent change",
    "Evolve this skill",
    "During a read-only review",
    "Only after explicit write and task-tracking authorization",
    "quick_validate.py",
)

REQUIRED_ARCHITECTURE_PHRASES = (
    "standalone Blueprint-only PR",
    "merges first",
    "requirements conflict",
)

EXPECTED_FRONTMATTER = {
    "name": "review-agentscope",
    "description": (
        "Use for independent reviews of Agentscope code, pull requests, architecture, "
        "trust boundaries, tests, evidence, release readiness, or implementation plans. "
        "Applies the repository's requirements and Blueprints as binding decisions, runs "
        "adversarial and built-artifact checks, and records reusable review lessons back "
        "into this skill."
    ),
}

EXPECTED_OPENAI_YAML = """interface:
  display_name: \"Review Agentscope\"
  short_description: \"Review Agentscope architecture, safety, and releases\"
  default_prompt: \"Use $review-agentscope to review this change against its requirements, Blueprints, trust boundaries, lifecycle invariants, package surfaces, evidence, and release gates.\"
"""

EXPECTED_BLUEPRINT_GATE = """Blueprint decisions are binding on implementation reviews.

- Read every Blueprint and requirement governing the changed capability before judging the implementation.
- Treat implementation divergence from an approved Blueprint as a merge-blocking P1 even when the implementation seems preferable.
- Do not rewrite a Blueprint inside an implementation PR to make the implementation appear conformant.
- Permit an architectural exception only when a compelling reason was approved and merged in an earlier, standalone Blueprint-only PR. Record that PR and review the implementation against the newly merged decision.
- If the architecture should change and no prior standalone Blueprint-only PR exists, stop that implementation path. Require the Blueprint-only decision PR first, then rebase or revise the implementation in a later PR.
- Do not waive a requirements conflict through a Blueprint. Requirements remain the external source of truth and must be reconciled separately through the Software Factory process."""

EXPECTED_ARCHITECTURE_EXCEPTION = """An implementation may depart from an older Blueprint only when all of the following are true:

1. A compelling architectural reason is documented against the requirements.
2. A standalone Blueprint-only PR contains no implementation behavior change.
3. That PR receives the required architecture review and merges first.
4. The implementation PR is rebased onto the merged decision.
5. The implementation is reviewed against the new Blueprint, not against discussion drafts.

If any step is absent, report the divergence as P1 and require the decision sequence to be corrected.

A requirements conflict cannot be waived by an architectural exception; reconcile it through a separate Software Factory requirements change.

Use the project `software-factory` skill when proposing or reviewing changes to requirements or Blueprints."""

EXPECTED_REVIEW_LANGUAGE_SHA256 = (
    "5e1d899928979ce1ed4336a1583c277dba58936284dc7bd49ee2ce45968f60fc"
)


def extract_section(markdown: str, heading: str) -> str:
    marker = f"## {heading}\n\n"
    require(markdown.count(marker) == 1, f"missing or duplicate section: {heading}")
    remainder = markdown.split(marker, 1)[1]
    return remainder.split("\n\n## ", 1)[0].strip()


def parse_frontmatter(skill: str) -> dict[str, str]:
    match = re.match(r"^---\n(?P<body>.*?)\n---\n", skill, re.DOTALL)
    require(match is not None, "SKILL.md has invalid YAML frontmatter framing")
    result: dict[str, str] = {}
    for line in match.group("body").splitlines():
        key, separator, value = line.partition(":")
        require(separator == ":" and key and value.strip(), "invalid frontmatter field")
        require(key in EXPECTED_FRONTMATTER, f"unexpected frontmatter field: {key}")
        require(key not in result, f"duplicate frontmatter field: {key}")
        result[key] = value.strip()
    require(result == EXPECTED_FRONTMATTER, "frontmatter identity or description changed")
    return result


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill-root", type=Path, default=DEFAULT_SKILL_ROOT)
    parser.add_argument("--repository-root", type=Path, default=DEFAULT_REPOSITORY_ROOT)
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    skill_root = arguments.skill_root.resolve()
    repository_root = arguments.repository_root.resolve()
    skill_path = skill_root / "SKILL.md"
    require(skill_path.is_file(), "review skill must contain SKILL.md")
    require(
        (skill_root / "agents" / "openai.yaml").is_file(),
        "missing agents/openai.yaml",
    )
    require(
        (repository_root / "AGENTS.md").is_file(),
        "repository AGENTS.md is missing",
    )

    skill = skill_path.read_text(encoding="utf-8")
    parse_frontmatter(skill)
    for phrase in REQUIRED_SKILL_PHRASES:
        require(phrase in skill, f"SKILL.md is missing required phrase: {phrase}")
    require(
        extract_section(skill, "Non-negotiable Blueprint gate")
        == EXPECTED_BLUEPRINT_GATE,
        "normative Blueprint gate changed or was weakened",
    )

    openai_yaml = (skill_root / "agents" / "openai.yaml").read_text(
        encoding="utf-8"
    )
    require(openai_yaml == EXPECTED_OPENAI_YAML, "agents/openai.yaml is not canonical")

    references = skill_root / "references"
    actual_references = tuple(sorted(path.name for path in references.glob("*.md")))
    require(
        actual_references == tuple(sorted(REQUIRED_REFERENCES)),
        f"unexpected reference inventory: {actual_references}",
    )
    for name in REQUIRED_REFERENCES:
        require(f"references/{name}" in skill, f"SKILL.md does not route to {name}")
        require(
            (references / name).stat().st_size > 200,
            f"reference is unexpectedly empty: {name}",
        )

    architecture = (references / "architecture-blueprints.md").read_text(
        encoding="utf-8"
    )
    for phrase in REQUIRED_ARCHITECTURE_PHRASES:
        require(phrase in architecture, f"architecture checklist is missing: {phrase}")
    require(
        extract_section(architecture, "Standalone exception protocol")
        == EXPECTED_ARCHITECTURE_EXCEPTION,
        "standalone Blueprint exception protocol changed or was weakened",
    )

    review_language = (references / "review-language.md").read_bytes()
    require(
        hashlib.sha256(review_language).hexdigest()
        == EXPECTED_REVIEW_LANGUAGE_SHA256,
        "defensive review-language boundary changed without validator update",
    )

    agents = (repository_root / "AGENTS.md").read_text(encoding="utf-8")
    require(
        "review-agentscope" in agents,
        "AGENTS.md must make review-agentscope discoverable",
    )
    require(
        "standalone Blueprint-only PR" in agents,
        "AGENTS.md must preserve the Blueprint exception gate",
    )

    print(
        "Validated review-agentscope: "
        f"{len(REQUIRED_REFERENCES)} references, Blueprint gate, evolution rule, "
        "and repository discovery."
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print(f"review-agentscope validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
