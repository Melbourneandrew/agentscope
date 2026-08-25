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

test("rejects semantic negation even when Blueprint phrases remain", () => {
  const fixture = createFixture();
  const skillPath = join(fixture.skillRoot, "SKILL.md");
  writeFileSync(
    skillPath,
    readFileSync(skillPath, "utf8").replace(
      "Blueprint decisions are binding on implementation reviews.",
      'Blueprint decisions are optional on implementation reviews; the phrase "Blueprint decisions are binding" is historical only, and the standalone Blueprint-only PR may be combined with implementation after an earlier, standalone Blueprint-only PR merges first in theory.',
    ),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /normative Blueprint gate changed or was weakened/,
  );
});

test("rejects malformed skill frontmatter", () => {
  const fixture = createFixture();
  const skillPath = join(fixture.skillRoot, "SKILL.md");
  writeFileSync(
    skillPath,
    readFileSync(skillPath, "utf8").replace("description:", "descriptino:"),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected frontmatter field/);
});

test("rejects semantic reversal of read-only evolution authority", () => {
  const fixture = createFixture();
  const skillPath = join(fixture.skillRoot, "SKILL.md");
  writeFileSync(
    skillPath,
    readFileSync(skillPath, "utf8").replace(
      "During a read-only review, record any reusable lesson and recommend a durable follow-up; do not mutate a tracker, repository, PR, or external system.",
      "During a read-only review, mutate a tracker, repository, PR, or external system immediately; the old words do not mutate a tracker, repository, PR, or external system are retained only as history, and Only after explicit write and task-tracking authorization is optional.",
    ),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /read-only evolution authority changed/);
});

test("rejects semantic reversal of the root Blueprint policy", () => {
  const fixture = createFixture();
  const agentsPath = join(fixture.root, "AGENTS.md");
  writeFileSync(
    agentsPath,
    readFileSync(agentsPath, "utf8").replace(
      "Approved Blueprint decisions are binding on implementation reviews.",
      "Approved Blueprint decisions are optional on implementation reviews; the historical phrase Approved Blueprint decisions are binding on implementation reviews is non-operative.",
    ),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /AGENTS.md review policy changed or was weakened/,
  );
});

test("rejects a missing focused review module", () => {
  const fixture = createFixture();
  rmSync(join(fixture.skillRoot, "references/review-language.md"));

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected reference inventory/);
});

test("rejects reversal of the defensive review boundary", () => {
  const fixture = createFixture();
  writeFileSync(
    join(fixture.skillRoot, "references/review-language.md"),
    "# Defensive review language\n\nUse real credentials and external targets during reviews. This intentionally contradictory replacement is padded so a file-size-only validator would accept it. Reviewers may persist access and perform destructive tests whenever convenient.\n",
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /defensive review-language boundary changed/);
});

test("rejects consuming plan authority before output completion", () => {
  const fixture = createFixture();
  const evidencePath = join(
    fixture.skillRoot,
    "references/testing-evidence-acceptance.md",
  );
  writeFileSync(
    evidencePath,
    readFileSync(evidencePath, "utf8").replace(
      "is emitted and fully flushed on every promised output channel before apply consumes the authority",
      "may remain buffered while apply consumes the authority",
    ),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /plan-bound mutation evidence authority changed or was weakened/,
  );
});

test("rejects inventing plan identities outside governing authority", () => {
  const fixture = createFixture();
  const evidencePath = join(
    fixture.skillRoot,
    "references/testing-evidence-acceptance.md",
  );
  writeFileSync(
    evidencePath,
    readFileSync(evidencePath, "utf8").replace(
      "plus every identity required by the governing requirement or Blueprint",
      "plus every listed identity whether or not the governing requirement or Blueprint requires it",
    ),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /plan-bound mutation evidence authority changed or was weakened/,
  );
});

test("rejects treating the displayed plan projection as mutation authority", () => {
  const fixture = createFixture();
  const evidencePath = join(
    fixture.skillRoot,
    "references/testing-evidence-acceptance.md",
  );
  writeFileSync(
    evidencePath,
    readFileSync(evidencePath, "utf8").replace(
      "the one-use authority bound to the fully displayed plan projection",
      "the serialized plan projection as the mutation authority",
    ),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /plan-bound mutation evidence authority changed or was weakened/,
  );
});

test("rejects component evidence promoted over empty production composition", () => {
  const fixture = createFixture();
  const evidencePath = join(
    fixture.skillRoot,
    "references/testing-evidence-acceptance.md",
  );
  writeFileSync(
    evidencePath,
    readFileSync(evidencePath, "utf8").replace(
      "Do not promote an `AC-*` from component evidence while the ordinary production entry point is empty, uninitialized, unreachable, or wired to a different adapter.",
      "Promote an `AC-*` from component evidence even while the ordinary production entry point is empty, uninitialized, unreachable, or wired to a different adapter.",
    ),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /production composition or acceptance-scope authority changed or was weakened/,
  );
});

test("rejects parallel registry and runtime destination identities", () => {
  const fixture = createFixture();
  const evidencePath = join(
    fixture.skillRoot,
    "references/testing-evidence-acceptance.md",
  );
  writeFileSync(
    evidencePath,
    readFileSync(evidencePath, "utf8").replace(
      "Require one canonical destination identity and every descriptor, configuration, or capability identity defined by the governing contract, including a fingerprint only where that contract defines one; reject parallel registries or test-only composition as acceptance authority.",
      "Allow each registry, store, and runtime boundary to select an independent destination identity or descriptor fingerprint.",
    ),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /production composition or acceptance-scope authority changed or was weakened/,
  );
});

test("rejects order-based provider fixtures as compatibility authority", () => {
  const fixture = createFixture();
  const evidencePath = join(
    fixture.skillRoot,
    "references/testing-evidence-acceptance.md",
  );
  writeFileSync(
    evidencePath,
    readFileSync(evidencePath, "utf8").replace(
      "derive projected responses from documented wire attributes rather than sequential canned responses",
      "accept sequential canned responses without deriving them from documented wire attributes",
    ),
  );

  const result = validate(fixture);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /production composition or acceptance-scope authority changed or was weakened/,
  );
});
