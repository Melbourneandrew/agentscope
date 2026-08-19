#!/usr/bin/env python3
"""Validate the durable structure and non-negotiable rules of review-agentscope."""

from __future__ import annotations

import argparse
from pathlib import Path
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
    "quick_validate.py",
)

REQUIRED_ARCHITECTURE_PHRASES = (
    "standalone Blueprint-only PR",
    "merges first",
    "requirements conflict",
)


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
    for phrase in REQUIRED_SKILL_PHRASES:
        require(phrase in skill, f"SKILL.md is missing required phrase: {phrase}")

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
