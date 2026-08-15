import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeAgentTraceSchema, type NativeAgentTrace } from "./types.js";

const STALE_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_JOURNAL_TEXT_LENGTH = 20_000;

/**
 * Directory where per-turn hook events are journaled, one file per event.
 * Cloud Cursor writes no transcript files and every hook invocation is a
 * separate process, so this journal is the only cross-event record a turn
 * trace can be derived from (blueprint ADR-011/ADR-012).
 */
function turnJournalDir(): string {
  return join(tmpdir(), "sf-langfuse-cursor-turn-journal");
}

export type TurnJournalEvent = {
  type: "prompt" | "thinking" | "shell_command" | "shell_output";
  text: string;
};

export type JournalEntry = TurnJournalEvent & {
  generationId?: string;
  ts?: string;
};

let eventCounter = 0;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function conversationPrefix(conversationId: string): string {
  return `${shortHash(conversationId)}--`;
}

/** Best-effort: journal failures must never block the hook (ADR-003). */
export function recordTurnJournalEvent(input: {
  conversationId: string;
  generationId?: string;
  event: TurnJournalEvent;
}): void {
  try {
    const dir = turnJournalDir();
    mkdirSync(dir, { recursive: true });
    const entry: JournalEntry = {
      ...input.event,
      text: input.event.text.slice(0, MAX_JOURNAL_TEXT_LENGTH),
      generationId: input.generationId,
      ts: new Date().toISOString(),
    };
    const prefix = conversationPrefix(input.conversationId);
    const name = `${prefix}${Date.now()}-${process.pid}-${eventCounter++}.json`;
    writeFileSync(join(dir, name), JSON.stringify(entry), { flag: "wx" });
    cleanupStaleEntries(dir);
  } catch {
    // Fail open.
  }
}

export type PeekedJournalEntry = { file: string; entry: JournalEntry };

/** Read every journaled event for a conversation, oldest first, deleting nothing. */
export function peekTurnJournal(conversationId: string): PeekedJournalEntry[] {
  const peeked: PeekedJournalEntry[] = [];
  try {
    const dir = turnJournalDir();
    if (!existsSync(dir)) {
      return [];
    }
    const prefix = conversationPrefix(conversationId);
    const files = readdirSync(dir)
      .filter((file) => file.startsWith(prefix))
      .sort();
    for (const file of files) {
      const path = join(dir, file);
      try {
        peeked.push({
          file: path,
          entry: JSON.parse(readFileSync(path, "utf8")) as JournalEntry,
        });
      } catch {
        // Unreadable entry: sweep it now.
        try {
          unlinkSync(path);
        } catch {
          // Already reclaimed.
        }
      }
    }
  } catch {
    return [];
  }
  return peeked;
}

export type TurnJournalSelection = {
  /** Entries the turn trace is built from: its prompt + its events. */
  events: PeekedJournalEntry[];
  /** Entries to delete after the turn: `events` plus swept orphan prompts. */
  consumed: PeekedJournalEntry[];
};

/**
 * Select the journal entries that belong to one turn.
 *
 * Non-prompt entries join the turn when they have no generation id or one
 * belonging to this turn's generation (prefix matching tolerates per-step
 * suffixes; distinct turns' ids never prefix each other). Without a turn id
 * nothing but a prompt may be consumed — other turns' events must not be
 * swept by a turnless response.
 *
 * The turn's prompt is the NEWEST prompt recorded before the turn's first
 * generation event — a newer prompt is the already-queued next turn's and
 * must survive. Prompts older than the selected one are orphans of turns
 * that never reached afterAgentResponse; they are swept (consumed, never
 * exported) so they cannot shift attribution of later turns. When no
 * generation event anchors the turn, the oldest prompt is used: at worst
 * one thin turn is mislabeled by an orphan, and the sweep-free selection
 * leaves the genuine prompt for the next turn to re-synchronize.
 */
export function selectTurnJournalEntries(
  peeked: PeekedJournalEntry[],
  turnId: string | undefined,
): TurnJournalSelection {
  const generationEvents = peeked.filter(
    ({ entry }) =>
      entry.type !== "prompt" &&
      turnId !== undefined &&
      (!entry.generationId || entry.generationId.startsWith(turnId)),
  );
  const prompts = peeked.filter(({ entry }) => entry.type === "prompt");
  const anchorTs = generationEvents
    .map(({ entry }) => entry.ts)
    .filter((ts): ts is string => typeof ts === "string")
    .sort()[0];
  let selectedPrompt: PeekedJournalEntry | undefined;
  if (anchorTs !== undefined) {
    selectedPrompt = [...prompts]
      .reverse()
      .find(({ entry }) => (entry.ts ?? "") <= anchorTs);
  }
  selectedPrompt ??= prompts[0];

  const events = [
    ...(selectedPrompt ? [selectedPrompt] : []),
    ...generationEvents,
  ];
  const orphanPrompts =
    anchorTs !== undefined && selectedPrompt !== undefined
      ? prompts.slice(0, prompts.indexOf(selectedPrompt))
      : [];
  return { events, consumed: [...events, ...orphanPrompts] };
}

/** Delete consumed journal files; failures never propagate (ADR-003). */
export function ackTurnJournalEntries(peeked: PeekedJournalEntry[]): void {
  for (const { file } of peeked) {
    try {
      unlinkSync(file);
    } catch {
      // Already reclaimed.
    }
  }
}

function cleanupStaleEntries(dir: string): void {
  try {
    const now = Date.now();
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      try {
        if (now - statSync(path).mtimeMs > STALE_FILE_MAX_AGE_MS) {
          unlinkSync(path);
        }
      } catch {
        // Already reclaimed.
      }
    }
  } catch {
    // Fail open.
  }
}

/**
 * Build a turn trace from journaled events plus the response text carried by
 * the afterAgentResponse payload. With only a prompt journaled this yields the
 * thin trace (ADR-011); with thoughts and shell events it yields the full
 * hook-event-derived turn (ADR-012).
 */
export function buildJournalTurnTrace(input: {
  sessionId: string;
  turnId: string;
  responseText: string;
  modelName?: string;
  events: JournalEntry[];
}): NativeAgentTrace {
  const traceId = `cursor:${input.sessionId}:${input.turnId}`;
  const model = input.modelName ? { name: input.modelName } : undefined;
  const messages: unknown[] = [];
  let messageCounter = 0;
  const nextId = () => `journal-${messageCounter++}`;
  // Without timestamps the OTLP planner falls back to epoch zero and the
  // trace lands in 1970; stamp every message so spans get real times.
  const now = new Date().toISOString();

  const prompt = input.events.find((event) => event.type === "prompt");
  if (prompt) {
    messages.push({
      id: nextId(),
      role: "user",
      timestamp: prompt.ts ?? now,
      parts: [{ type: "user_text", text: prompt.text }],
    });
  }
  const assistantParts: unknown[] = [];
  for (const event of input.events) {
    if (event.type === "thinking") {
      assistantParts.push({ type: "thinking", text: event.text });
    } else if (event.type === "shell_command") {
      assistantParts.push({
        type: "shell_command",
        command: { command: event.text },
      });
    } else if (event.type === "shell_output") {
      assistantParts.push({ type: "shell_output", stdout: event.text });
    }
  }
  assistantParts.push({ type: "assistant_text", text: input.responseText });
  messages.push({
    id: nextId(),
    role: "assistant",
    timestamp: now,
    model,
    parts: assistantParts,
  });

  return NativeAgentTraceSchema.parse({
    id: traceId,
    traceId,
    provider: "cursor",
    sessionId: input.sessionId,
    turnId: input.turnId,
    createdAt: prompt?.ts ?? now,
    updatedAt: now,
    model,
    messages,
    sources: [],
    metadata: { capture: "hook-event-journal" },
  });
}
