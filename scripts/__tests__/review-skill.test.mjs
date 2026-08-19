import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const validator = join(
  repositoryRoot,
  ".agents/skills/review-agentscope/scripts/validate_review_skill.py",
);
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentscope-review-skill-"));
  fixtures.push(root);
  const skillRoot = join(root, ".agents/skills/review-agentscope");
  cpSync(join(repositoryRoot, ".agents/skills/review-agentscope"), skillRoot, {
    recursive: true,
  });
  writeFileSync(
    join(root, "AGENTS.md"),
    readFileSync(join(repositoryRoot, "AGENTS.md")),
  );
  return { root, skillRoot };
}

function validate(fixture) {
  return spawnSync(
    "python3",
    [
      validator,
      "--skill-root",
      fixture.skillRoot,
      "--repository-root",
      fixture.root,
    ],
    { encoding: "utf8" },
  );
}

test("validates the committed review skill contract", () => {
  const result = validate(createFixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Validated review-agentscope/);
});

test("rejects removal of the standalone Blueprint exception gate", () => {
  const fixture = createFixture();
  const skillPath = join(fixture.skillRoot, "SKILL.md");
  writeFileSync(
    skillPath,
    readFileSync(skillPath, "utf8").replace(
      "earlier, standalone Blueprint-only PR",
      "earlier architecture change",
    ),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /earlier, standalone Blueprint-only PR/);
});

test("rejects a missing focused review module", () => {
  const fixture = createFixture();
  rmSync(join(fixture.skillRoot, "references/review-language.md"));

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected reference inventory/);
});
