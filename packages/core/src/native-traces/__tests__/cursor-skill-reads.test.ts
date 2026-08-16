import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ackSkillReads,
  peekSkillReads,
  recordSkillRead,
} from "../cursor-skill-reads.js";

function withSpoolDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(
    join(tmpdir(), "sf-langfuse-cursor-skill-reads-test-"),
  );
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Mirrors cursor-skill-reads.ts's convHash/genHash naming, for test assertions only. */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function generationPrefix(
  conversationId: string,
  generationId: string,
): string {
  return `${shortHash(conversationId)}--${shortHash(generationId)}--`;
}

/** Finds the single spool file matching a conversation+generation prefix. */
function spooledFile(
  dir: string,
  conversationId: string,
  generationId: string,
): string {
  const prefix = generationPrefix(conversationId, generationId);
  const name = readdirSync(dir).find((entry) => entry.startsWith(prefix));
  if (!name) {
    throw new Error(`no spool file found for prefix ${prefix}`);
  }
  return join(dir, name);
}

/** peek + ack, for tests that only care about the combined "consume" behavior. */
function consume(
  conversationId: string,
  generationId: string,
  dir: string,
): string[] {
  const { skills, files } = peekSkillReads(conversationId, generationId, dir);
  ackSkillReads(files);
  return skills;
}

test("record + consume (peek then ack) round-trip returns the read skill", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    const skills = consume("conv-1", "gen-1", dir);
    assert.deepEqual(skills, ["qa"]);
  });
});

test("peekSkillReads does not delete the spool files", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    const first = peekSkillReads("conv-1", "gen-1", dir);
    assert.deepEqual(first.skills, ["qa"]);
    assert.equal(first.files.length, 1);
    const firstFile = first.files.at(0);
    assert.ok(firstFile);
    assert.ok(existsSync(firstFile));

    // Peeking again returns the same result — nothing was consumed.
    const second = peekSkillReads("conv-1", "gen-1", dir);
    assert.deepEqual(second.skills, ["qa"]);
    assert.deepEqual(second.files, first.files);
    assert.ok(existsSync(firstFile));
  });
});

test("ackSkillReads deletes exactly the given files", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    const { files } = peekSkillReads("conv-1", "gen-1", dir);
    assert.equal(files.length, 1);
    const file = files.at(0);
    assert.ok(file);
    assert.ok(existsSync(file));

    ackSkillReads(files);
    assert.equal(existsSync(file), false);
  });
});

test("peeking after ack returns an empty result", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    const { files } = peekSkillReads("conv-1", "gen-1", dir);
    ackSkillReads(files);

    const afterAck = peekSkillReads("conv-1", "gen-1", dir);
    assert.deepEqual(afterAck.skills, []);
    assert.deepEqual(afterAck.files, []);
  });
});

test("a failed export can retry against the same spooled reads (no ack = no loss)", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    // Simulate a failed export: peek, but never ack.
    const attempt1 = peekSkillReads("conv-1", "gen-1", dir);
    assert.deepEqual(attempt1.skills, ["qa"]);

    // Retry sees the same spooled reads.
    const attempt2 = peekSkillReads("conv-1", "gen-1", dir);
    assert.deepEqual(attempt2.skills, ["qa"]);

    // This retry succeeds and acks.
    ackSkillReads(attempt2.files);
    assert.deepEqual(peekSkillReads("conv-1", "gen-1", dir).skills, []);
  });
});

test("a read event recorded between peek and ack survives the ack and is seen on the next peek", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    const { files: peekedFiles } = peekSkillReads("conv-1", "gen-1", dir);
    assert.equal(peekedFiles.length, 1);

    // A new read event for the SAME generation lands after the peek but
    // before the ack (e.g. a concurrent beforeReadFile hook invocation).
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/testing/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    // Acking only the originally peeked files must not touch the new event's file.
    ackSkillReads(peekedFiles);

    const second = peekSkillReads("conv-1", "gen-1", dir);
    assert.deepEqual(second.skills, ["testing"]);
    assert.equal(second.files.length, 1);
    assert.notDeepEqual(second.files, peekedFiles);
  });
});

test("entries from other generations survive an ack for a different generation (by construction)", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/testing/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-2",
      },
      dir,
    );

    const genOne = consume("conv-1", "gen-1", dir);
    assert.deepEqual(genOne, ["qa"]);

    // gen-2's spool file is untouched by consuming gen-1 (separate key prefixes).
    const genTwoPeek = peekSkillReads("conv-1", "gen-2", dir);
    assert.deepEqual(genTwoPeek.skills, ["testing"]);

    const genTwo = consume("conv-1", "gen-2", dir);
    assert.deepEqual(genTwo, ["testing"]);
  });
});

test("non-skill paths are a no-op", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/src/index.ts",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    const skills = consume("conv-1", "gen-1", dir);
    assert.deepEqual(skills, []);
  });
});

test("peeking a missing conversation/generation returns an empty result", () => {
  withSpoolDir((dir) => {
    const result = peekSkillReads("no-such-conversation", "gen-1", dir);
    assert.deepEqual(result, { skills: [], files: [] });
  });
});

test("acking a nonexistent file does not throw", () => {
  withSpoolDir((dir) => {
    assert.doesNotThrow(() => {
      ackSkillReads([join(dir, "does-not-exist.json")]);
    });
  });
});

test("duplicate reads of the same skill collapse to a single name", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    const { skills, files } = peekSkillReads("conv-1", "gen-1", dir);
    assert.deepEqual(skills, ["qa"]);
    // Two distinct event files even though the skill name collapses.
    assert.equal(files.length, 2);
    ackSkillReads(files);
  });
});

test("plugin-cache skill paths normalize to <plugin>:<name>", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath:
          "/Users/x/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/brainstorming/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    const skills = consume("conv-1", "gen-1", dir);
    assert.deepEqual(skills, ["superpowers:brainstorming"]);
  });
});

test("spool filenames are opaque convHash--genHash--suffix, never the raw ids", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "../evil",
        generationId: "../../also-evil",
      },
      dir,
    );

    const entries = readdirSync(dir);
    assert.equal(entries.length, 1);
    const entry = entries.at(0);
    assert.ok(entry);
    assert.match(entry, /^[0-9a-f]{16}--[0-9a-f]{16}--\d+-\d+-\d+\.json$/);
    assert.ok(entry.startsWith(generationPrefix("../evil", "../../also-evil")));

    const skills = consume("../evil", "../../also-evil", dir);
    assert.deepEqual(skills, ["qa"]);
  });
});

test("ids that would collide under naive sanitization spool under distinct prefixes", () => {
  withSpoolDir((dir) => {
    // "a/b" and "a_b" both normalize to "a_b" under a char-replacement
    // sanitizer; hashing keeps them distinct.
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "a/b",
        generationId: "gen-1",
      },
      dir,
    );
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/testing/SKILL.md",
        conversationId: "a_b",
        generationId: "gen-1",
      },
      dir,
    );

    assert.equal(readdirSync(dir).length, 2);

    const first = consume("a/b", "gen-1", dir);
    assert.deepEqual(first, ["qa"]);

    // The other id's spool file survived the first consume untouched.
    const second = consume("a_b", "gen-1", dir);
    assert.deepEqual(second, ["testing"]);
  });
});

test("a corrupt spool file is skipped rather than breaking the peek", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );

    const corruptFile = join(
      dir,
      `${generationPrefix("conv-1", "gen-1")}9999999999999-1-1.json`,
    );
    writeFileSync(corruptFile, "{not valid json");

    const { skills, files } = peekSkillReads("conv-1", "gen-1", dir);
    assert.deepEqual(skills, ["qa"]);
    // The corrupt file wasn't included among the files to ack.
    assert.equal(files.length, 1);
    assert.ok(!files.includes(corruptFile));
  });
});

test("recordSkillRead no-ops when conversationId is falsy", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "",
        generationId: "gen-1",
      },
      dir,
    );

    assert.equal(existsSync(dir) && readdirSync(dir).length, 0);
  });
});

test("recordSkillRead no-ops when generationId is falsy", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "",
      },
      dir,
    );

    assert.equal(existsSync(dir) && readdirSync(dir).length, 0);
  });
});

test("a stale current-generation file is returned for reporting, not swept, by its own peek", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-1",
      },
      dir,
    );
    const currentFile = spooledFile(dir, "conv-1", "gen-1");

    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(currentFile, oldTime, oldTime);

    const result = peekSkillReads("conv-1", "gen-1", dir);
    assert.deepEqual(result.skills, ["qa"]);
    assert.deepEqual(result.files, [currentFile]);
    assert.ok(
      existsSync(currentFile),
      "current-generation stale file must survive its own peek",
    );

    ackSkillReads(result.files);
  });
});

test("a stale file from a DIFFERENT generation of the SAME conversation IS swept by a peek", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-stale",
      },
      dir,
    );
    const staleFile = spooledFile(dir, "conv-1", "gen-stale");
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(staleFile, oldTime, oldTime);

    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/testing/SKILL.md",
        conversationId: "conv-1",
        generationId: "gen-fresh",
      },
      dir,
    );

    // Peeking a different generation of the SAME conversation sweeps the
    // stale sibling-generation file.
    const skills = consume("conv-1", "gen-fresh", dir);
    assert.deepEqual(skills, ["testing"]);
    assert.equal(
      existsSync(staleFile),
      false,
      "stale file from a different generation of the same conversation must be swept",
    );
  });
});

test("a stale file from a DIFFERENT conversation survives another conversation's peek (cross-conversation isolation)", () => {
  withSpoolDir((dir) => {
    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/qa/SKILL.md",
        conversationId: "conv-A",
        generationId: "gen-1",
      },
      dir,
    );
    const convAFile = spooledFile(dir, "conv-A", "gen-1");
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(convAFile, oldTime, oldTime);

    recordSkillRead(
      {
        filePath: "/repo/.cursor/skills/testing/SKILL.md",
        conversationId: "conv-B",
        generationId: "gen-1",
      },
      dir,
    );

    // Conversation B's peek must never touch conversation A's files, even
    // though A's file is stale — B has no way to know whether A is
    // abandoned or mid-retry on a failed export.
    const bResult = consume("conv-B", "gen-1", dir);
    assert.deepEqual(bResult, ["testing"]);
    assert.ok(
      existsSync(convAFile),
      "a different conversation's stale file must survive this peek",
    );

    // Conversation A's own reads are still intact and reportable.
    const aResult = consume("conv-A", "gen-1", dir);
    assert.deepEqual(aResult, ["qa"]);
  });
});
