import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { performance } from "node:perf_hooks";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const validator = join(
  repositoryRoot,
  ".agents/skills/review-agentscope/scripts/validate_review_skill.py",
);
const fixtures = [];
const inputFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const skillDirectory = ".agents/skills/review-agentscope";
const inputFiles = [
  "AGENTS.md",
  `${skillDirectory}/SKILL.md`,
  `${skillDirectory}/agents/openai.yaml`,
  ...[
    "review-map",
    "architecture-blueprints",
    "trust-data-privacy",
    "lifecycle-recovery-concurrency",
    "api-package-artifacts",
    "testing-evidence-acceptance",
    "release-practice",
    "review-language",
  ].map((name) => `${skillDirectory}/references/${name}.md`),
];
const directories = [
  ".agents",
  ".agents/skills",
  skillDirectory,
  `${skillDirectory}/agents`,
  `${skillDirectory}/references`,
];

function inspectFixture(fixture) {
  const root = lstatSync(fixture.root);
  assert.ok(
    root.isDirectory() &&
      root.dev === fixture.identity.dev &&
      root.ino === fixture.identity.ino &&
      root.uid === fixture.identity.uid &&
      root.mode === fixture.identity.mode,
    "review fixture root identity changed",
  );
  let bytes = 0;
  for (const directory of ["", ...directories]) {
    const path = join(fixture.root, directory);
    assert.ok(
      lstatSync(path).isDirectory(),
      "review fixture directory changed",
    );
    for (const name of readdirSync(path)) {
      const relative = directory ? `${directory}/${name}` : name;
      const stat = lstatSync(join(fixture.root, relative));
      if (directories.includes(relative)) assert.ok(stat.isDirectory());
      else {
        assert.ok(
          inputFiles.includes(relative) && stat.isFile(),
          "unexpected review fixture member",
        );
        bytes += stat.size;
      }
    }
  }
  assert.ok(bytes <= 256 * 1024, "review fixture bytes exceeded");
}

function cleanupFixture(fixture, deadline, remove = rmSync) {
  inspectFixture(fixture);
  assert.ok(performance.now() < deadline, "review fixture cleanup deadline");
  remove(fixture.root, { recursive: true });
  fixtures.splice(fixtures.indexOf(fixture), 1);
}
afterEach(() => {
  const deadline = performance.now() + 10_000;
  for (const fixture of [...fixtures]) cleanupFixture(fixture, deadline);
});

function createFixture() {
  const deadline = performance.now() + 5000;
  const root = mkdtempSync(join(tmpdir(), "agentscope-review-skill-"));
  const fixture = {
    root,
    skillRoot: join(root, skillDirectory),
    identity: lstatSync(root),
    deadline,
  };
  fixtures.push(fixture);
  for (const directory of directories)
    assert.ok(
      lstatSync(join(repositoryRoot, directory)).isDirectory(),
      "review source directory changed",
    );
  for (const directory of directories) mkdirSync(join(root, directory));
  let bytes = 0;
  for (const file of inputFiles) {
    const sourcePath = join(repositoryRoot, file);
    const fd = openSync(sourcePath, inputFlags);
    try {
      const stat = fstatSync(fd);
      assert.ok(stat.isFile() && stat.size <= 128 * 1024);
      bytes += stat.size;
      assert.ok(bytes <= 256 * 1024);
      const contents = readBoundedInput(fd);
      assert.equal(contents.length, stat.size);
      for (const current of [fstatSync(fd), lstatSync(sourcePath)]) {
        assert.ok(current.isFile());
        for (const key of [
          "dev",
          "ino",
          "mode",
          "uid",
          "size",
          "mtimeMs",
          "ctimeMs",
        ])
          assert.equal(
            current[key],
            stat[key],
            "review input identity changed",
          );
      }
      writeFileSync(join(root, file), contents, { flag: "wx", mode: 0o600 });
    } finally {
      closeSync(fd);
    }
  }
  inspectFixture(fixture);
  return fixture;
}

function readBoundedInput(fd) {
  const buffer = Buffer.alloc(128 * 1024 + 1);
  let count = 0;
  while (count < buffer.length) {
    const read = readSync(fd, buffer, count, buffer.length - count, null);
    if (read === 0) break;
    count += read;
  }
  assert.ok(count <= 128 * 1024, "review input byte bound");
  return buffer.subarray(0, count);
}

function validate(fixture) {
  inspectFixture(fixture);
  const timeout = Math.floor(fixture.deadline - performance.now());
  assert.ok(timeout > 0, "review fixture validation deadline");
  return spawnSync(
    "python3",
    [
      validator,
      "--skill-root",
      fixture.skillRoot,
      "--repository-root",
      fixture.root,
    ],
    { encoding: "utf8", timeout, maxBuffer: 64 * 1024, killSignal: "SIGKILL" },
  );
}

test("validates the committed review skill contract", () => {
  const result = validate(createFixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Validated review-agentscope/);
});

test("bounded input reads reject growth without reading beyond the fixed ceiling", () => {
  assert.equal(inputFlags & constants.O_NONBLOCK, constants.O_NONBLOCK);
  assert.equal(inputFlags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
  let consumed = 0;
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const body = source.slice(
    source.indexOf("function readBoundedInput("),
    source.indexOf("\nfunction validate("),
  );
  const read = Function(
    "readSync",
    "Buffer",
    "assert",
    `${body}; return readBoundedInput;`,
  )(
    (_fd, buffer, offset, length) => {
      assert.ok(consumed + length <= 128 * 1024 + 1);
      const count = Math.min(length, 97);
      buffer.fill(65, offset, offset + count);
      consumed += count;
      return count;
    },
    Buffer,
    assert,
  );
  assert.throws(() => read(1), /review input byte bound/);
  assert.equal(consumed, 128 * 1024 + 1);
});

test("retains cleanup ownership on removal failure or root substitution", () => {
  const fixture = createFixture();
  const moved = `${fixture.root}-moved`;
  const failure = new Error("seeded removal failure");
  assert.throws(
    () =>
      cleanupFixture(fixture, fixture.deadline, () => {
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.ok(fixtures.includes(fixture));
  renameSync(fixture.root, moved);
  symlinkSync(moved, fixture.root, "dir");
  try {
    assert.throws(
      () => cleanupFixture(fixture, fixture.deadline),
      /root identity/,
    );
    assert.ok(fixtures.includes(fixture));
    assert.ok(lstatSync(moved).isDirectory());
  } finally {
    rmSync(fixture.root);
    renameSync(moved, fixture.root);
  }
});

test("rejects unowned fixture members and expired child authority", () => {
  const fixture = createFixture();
  const foreign = join(fixture.root, "unexpected");
  writeFileSync(foreign, "not admitted");
  try {
    assert.throws(() => validate(fixture), /unexpected review fixture member/);
  } finally {
    rmSync(foreign);
  }
  fixture.deadline = performance.now() - 1;
  assert.throws(() => validate(fixture), /validation deadline/);
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
