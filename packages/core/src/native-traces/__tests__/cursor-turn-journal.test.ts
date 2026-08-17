import assert from "node:assert/strict";
import { test } from "vitest";
import {
  selectTurnJournalEntries,
  type PeekedJournalEntry,
} from "../cursor-turn-journal.js";

function entry(
  file: string,
  type: "prompt" | "thinking" | "shell_command" | "shell_output",
  generationId?: string,
  ts?: string,
): PeekedJournalEntry {
  return {
    file,
    entry: {
      type,
      text: file,
      ...(generationId !== undefined ? { generationId } : {}),
      ...(ts !== undefined ? { ts } : {}),
    },
  };
}

const files = (entries: PeekedJournalEntry[]) => entries.map((e) => e.file);

test("selects the anchored prompt and leaves a queued newer prompt", () => {
  const peeked = [
    entry("1-prompt", "prompt", undefined, "2026-01-01T00:00:01Z"),
    entry("2-shell", "shell_command", "gen-1", "2026-01-01T00:00:02Z"),
    entry("3-prompt", "prompt", undefined, "2026-01-01T00:00:03Z"),
  ];

  const selection = selectTurnJournalEntries(peeked, "gen-1");

  assert.deepEqual(files(selection.events), ["1-prompt", "2-shell"]);
  assert.deepEqual(files(selection.consumed), ["1-prompt", "2-shell"]);
});

test("without a turn id only the prompt is selected, never other events", () => {
  const peeked = [
    entry("1-prompt", "prompt"),
    entry("2-shell", "shell_command", "gen-1"),
    entry("3-thinking", "thinking"),
  ];

  const selection = selectTurnJournalEntries(peeked, undefined);

  assert.deepEqual(files(selection.events), ["1-prompt"]);
  assert.deepEqual(files(selection.consumed), ["1-prompt"]);
});

test("excludes other generations but tolerates per-step suffixes", () => {
  const peeked = [
    entry("1-shell", "shell_command", "gen-1"),
    entry("2-thinking", "thinking", "gen-1:step-2"),
    entry("3-shell", "shell_command", "gen-2"),
    entry("4-thinking", "thinking"),
  ];

  const selection = selectTurnJournalEntries(peeked, "gen-1");

  assert.deepEqual(files(selection.events), [
    "1-shell",
    "2-thinking",
    "4-thinking",
  ]);
});

test("sweeps an orphaned prompt from an interrupted turn without exporting it", () => {
  const peeked = [
    entry("1-orphan-prompt", "prompt", undefined, "2026-01-01T00:00:00Z"),
    entry("2-prompt", "prompt", undefined, "2026-01-01T00:00:02Z"),
    entry("3-shell", "shell_command", "gen-1", "2026-01-01T00:00:03Z"),
  ];

  const selection = selectTurnJournalEntries(peeked, "gen-1");

  assert.deepEqual(files(selection.events), ["2-prompt", "3-shell"]);
  assert.deepEqual(files(selection.consumed), [
    "2-prompt",
    "3-shell",
    "1-orphan-prompt",
  ]);
});

test("unanchored thin turn falls back to the oldest prompt and sweeps nothing extra", () => {
  const peeked = [
    entry("1-orphan-prompt", "prompt", undefined, "2026-01-01T00:00:00Z"),
    entry("2-prompt", "prompt", undefined, "2026-01-01T00:00:02Z"),
  ];

  const selection = selectTurnJournalEntries(peeked, "gen-1");

  assert.deepEqual(files(selection.events), ["1-orphan-prompt"]);
  assert.deepEqual(files(selection.consumed), ["1-orphan-prompt"]);
});
