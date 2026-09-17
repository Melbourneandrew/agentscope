import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  boundedRequestLedger,
  codexTurnTerminalObserved,
  codexTurnTerminalObservedAfterBaseline,
  localSqliteAcceptanceBaseline,
  localSqliteAcceptanceObservedAfterBaseline,
  localSqliteReporterSettled,
  openLocalSqliteLifecycle,
  openOperationalStateHealth,
  publishTerminalCompletionBeforeDeadline,
  readCodexSessionLedgers,
  readCodexSessionLedgerRecords,
  readBoundedJsonResponse,
  settledCodexLedgerSnapshot,
  settledLocalSqliteLifecycleSnapshot,
  terminalObservationBeforeDeadline,
  traceSummaryBeforeDeadline,
  waitForModelRequestBeforeDeadline,
  waitWithinObservationDeadline,
} from "../codex-runtime-evidence.mjs";

describe("Codex bounded native ledgers", () => {
  it.runIf(process.platform === "linux")(
    "holds the home identity and rejects symlinked session ancestors",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-ledger-"));
      const moved = `${root}-moved`;
      const external = mkdtempSync(
        join(tmpdir(), "agentscope-codex-external-"),
      );
      const day = join(root, ".codex", "sessions", "2026", "09", "14");
      mkdirSync(day, { recursive: true });
      const terminal = `${JSON.stringify({ type: "event_msg" })}\n`;
      writeFileSync(join(day, "rollout-exact.jsonl"), terminal);
      const descriptor = openSync(
        root,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      try {
        expect(readCodexSessionLedgers(descriptor)).toEqual([terminal]);
        const records = readCodexSessionLedgerRecords(descriptor);
        expect(records).toEqual([
          expect.objectContaining({
            relativePath: ".codex/sessions/2026/09/14/rollout-exact.jsonl",
            content: terminal,
          }),
        ]);
        expect(typeof records[0]?.dev).toBe("bigint");
        expect(typeof records[0]?.ino).toBe("bigint");
        renameSync(root, moved);
        mkdirSync(root);
        symlinkSync(external, join(root, ".codex"));
        expect(readCodexSessionLedgers(descriptor)).toEqual([terminal]);
        rmSync(join(moved, ".codex", "sessions", "2026", "09"), {
          recursive: true,
        });
        symlinkSync(external, join(moved, ".codex", "sessions", "2026", "09"));
        expect(() => readCodexSessionLedgers(descriptor)).toThrow(
          "integration.codex.session-ledger",
        );
      } finally {
        closeSync(descriptor);
        rmSync(root, { recursive: true, force: true });
        rmSync(moved, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    },
  );

  it("rejects same-size rewrites and growth across ledger snapshots", () => {
    const identity = {
      dev: 1n,
      ino: 2n,
      mode: 0o100600n,
      uid: 3n,
      gid: 4n,
      size: 2n,
      mtimeNs: 5n,
      ctimeNs: 6n,
    };
    expect(
      settledCodexLedgerSnapshot({
        before: identity,
        first: Buffer.from("a\n"),
        middle: identity,
        second: Buffer.from("a\n"),
        after: identity,
      }),
    ).toBe("a\n");
    expect(
      settledCodexLedgerSnapshot({
        before: identity,
        first: Buffer.from("a\n"),
        middle: identity,
        second: Buffer.from("b\n"),
        after: identity,
      }),
    ).toBeNull();
    expect(
      settledCodexLedgerSnapshot({
        before: identity,
        first: Buffer.from("a\n"),
        middle: identity,
        second: Buffer.from("a\n"),
        after: { ...identity, size: 3n, mtimeNs: 7n, ctimeNs: 7n },
      }),
    ).toBeNull();
  });
});

// Lifecycle fixtures keep descriptor identity, durable acceptance, and
// settlement adversaries adjacent.
// eslint-disable-next-line max-lines-per-function
describe("Codex Local SQLite reporter settlement", () => {
  it.runIf(process.platform === "linux")(
    "requires a new durable Local SQLite acceptance after the exact baseline",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-health-"));
      const health = join(root, ".agentscope", "health");
      mkdirSync(health, { recursive: true });
      const homeDescriptor = openSync(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      const statePath = join(health, "operational-state-v1.json");
      const accepted = {
        version: 1,
        nextSequence: 1,
        losses: { diagnostics: 0, health: 0, checkpoints: 0 },
        diagnostics: [],
        health: [
          {
            scope: "connection",
            stage: "remote-acceptance",
            outcome: "accepted",
            configurationGeneration: 1,
            policyMode: "baseline",
            destinationType: "@agentscope/destination-local-sqlite",
            connectionId: `destination-connection-v1-${"a".repeat(64)}`,
            receipt: "accepted",
            sequence: 0,
            observedAtUnixMilliseconds: 1,
          },
        ],
        checkpoints: [],
      };
      const healthDescriptor = openOperationalStateHealth(homeDescriptor);
      try {
        const baseline = localSqliteAcceptanceBaseline(healthDescriptor);
        expect(baseline).toEqual({
          nextSequence: 0,
          losses: { diagnostics: 0, health: 0, checkpoints: 0 },
          diagnostics: [],
          health: [],
          checkpoints: [],
        });
        writeFileSync(statePath, `${JSON.stringify(accepted)}\n`);
        expect(
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toBe(true);
        const afterAcceptance = localSqliteAcceptanceBaseline(healthDescriptor);
        expect(
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            afterAcceptance,
          ),
        ).toBe(false);
        writeFileSync(
          statePath,
          `${JSON.stringify({
            ...accepted,
            health: [{ ...accepted.health[0], substituted: true }],
          })}\n`,
        );
        expect(() =>
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toThrow("integration.codex.operational-state");
        writeFileSync(statePath, ` ${JSON.stringify(accepted)}\n`);
        expect(() => localSqliteAcceptanceBaseline(healthDescriptor)).toThrow(
          "integration.codex.operational-state",
        );
        writeFileSync(
          statePath,
          `${JSON.stringify({
            ...accepted,
            losses: { diagnostics: 0, health: 0 },
          })}\n`,
        );
        expect(() => localSqliteAcceptanceBaseline(healthDescriptor)).toThrow(
          "integration.codex.operational-state",
        );
        writeFileSync(
          statePath,
          `${JSON.stringify({ ...accepted, diagnostics: [{}] })}\n`,
        );
        expect(() => localSqliteAcceptanceBaseline(healthDescriptor)).toThrow(
          "integration.codex.operational-state",
        );
      } finally {
        closeSync(healthDescriptor);
        closeSync(homeDescriptor);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "holds the health directory and rejects path and logical-history substitution",
    // eslint-disable-next-line max-lines-per-function -- one descriptor-bound replacement matrix
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-health-"));
      const health = join(root, ".agentscope", "health");
      const moved = `${health}-moved`;
      mkdirSync(health, { recursive: true });
      const homeDescriptor = openSync(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      const healthDescriptor = openOperationalStateHealth(homeDescriptor);
      const connection = {
        scope: "connection",
        stage: "remote-acceptance",
        outcome: "accepted",
        configurationGeneration: 1,
        policyMode: "baseline",
        destinationType: "@agentscope/destination-local-sqlite",
        connectionId: `destination-connection-v1-${"b".repeat(64)}`,
        receipt: "accepted",
        sequence: 1,
        observedAtUnixMilliseconds: 2,
      };
      const initialHealth = {
        scope: "hook",
        stage: "hook-started",
        outcome: "completed",
        configurationGeneration: 1,
        policyMode: "baseline",
        receipt: null,
        sequence: 0,
        observedAtUnixMilliseconds: 1,
      };
      const initial = {
        version: 1,
        nextSequence: 1,
        losses: { diagnostics: 0, health: 0, checkpoints: 0 },
        diagnostics: [],
        health: [initialHealth],
        checkpoints: [],
      };
      try {
        writeFileSync(
          join(health, "operational-state-v1.json"),
          `${JSON.stringify(initial)}\n`,
        );
        const baseline = localSqliteAcceptanceBaseline(healthDescriptor);
        renameSync(health, moved);
        mkdirSync(health);
        writeFileSync(
          join(health, "operational-state-v1.json"),
          `${JSON.stringify({
            ...initial,
            nextSequence: 2,
            health: [initialHealth, connection],
          })}\n`,
        );
        expect(
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toBe(false);
        writeFileSync(
          join(moved, "operational-state-v1.json"),
          `${JSON.stringify({
            ...initial,
            nextSequence: 2,
            health: [initialHealth, connection],
          })}\n`,
        );
        expect(
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toBe(true);
        writeFileSync(
          join(moved, "operational-state-v1.json"),
          `${JSON.stringify({
            ...initial,
            nextSequence: 3,
            health: [
              {
                ...initialHealth,
                stage: "delivery",
                sequence: 1,
                observedAtUnixMilliseconds: 2,
              },
              { ...connection, sequence: 2, observedAtUnixMilliseconds: 2 },
            ],
          })}\n`,
        );
        expect(
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toBe(true);
        writeFileSync(
          join(moved, "operational-state-v1.json"),
          `${JSON.stringify({
            ...initial,
            nextSequence: 2,
            health: [
              { ...initialHealth, observedAtUnixMilliseconds: 9 },
              connection,
            ],
          })}\n`,
        );
        expect(() =>
          localSqliteAcceptanceObservedAfterBaseline(
            healthDescriptor,
            baseline,
          ),
        ).toThrow("integration.codex.operational-state");
      } finally {
        closeSync(healthDescriptor);
        closeSync(homeDescriptor);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "binds one exact lifecycle and accepts only stable empty settlement",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-sqlite-"));
      const namespace = join(
        root,
        ".agentscope",
        "destinations",
        "local-sqlite",
        "a".repeat(64),
      );
      const lifecycle = join(namespace, "lifecycle");
      mkdirSync(lifecycle, { recursive: true });
      const homeDescriptor = openSync(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      let lifecycleDescriptor;
      try {
        lifecycleDescriptor = openLocalSqliteLifecycle(homeDescriptor);
        expect(localSqliteReporterSettled(lifecycleDescriptor)).toBe(true);
        writeFileSync(join(lifecycle, `lease-${"b".repeat(32)}.json`), "{}\n");
        expect(localSqliteReporterSettled(lifecycleDescriptor)).toBe(false);
        rmSync(join(lifecycle, `lease-${"b".repeat(32)}.json`));
        writeFileSync(
          join(lifecycle, `lease-cleanup-${"c".repeat(32)}.json`),
          "{}\n",
        );
        expect(localSqliteReporterSettled(lifecycleDescriptor)).toBe(false);
      } finally {
        if (lifecycleDescriptor !== undefined) closeSync(lifecycleDescriptor);
        closeSync(homeDescriptor);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects ambiguous namespaces, symlink ancestors, and unknown entries",
    () => {
      const root = mkdtempSync(join(tmpdir(), "agentscope-codex-sqlite-"));
      const localSqlite = join(
        root,
        ".agentscope",
        "destinations",
        "local-sqlite",
      );
      mkdirSync(join(localSqlite, "a".repeat(64), "lifecycle"), {
        recursive: true,
      });
      const homeDescriptor = openSync(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        mkdirSync(join(localSqlite, "b".repeat(64), "lifecycle"), {
          recursive: true,
        });
        expect(() => openLocalSqliteLifecycle(homeDescriptor)).toThrow(
          "integration.codex.local-sqlite-settlement",
        );
        rmSync(join(localSqlite, "b".repeat(64)), { recursive: true });
        const lifecycleDescriptor = openLocalSqliteLifecycle(homeDescriptor);
        try {
          writeFileSync(
            join(localSqlite, "a".repeat(64), "lifecycle", "unknown"),
            "",
          );
          expect(() => localSqliteReporterSettled(lifecycleDescriptor)).toThrow(
            "integration.codex.local-sqlite-settlement",
          );
        } finally {
          closeSync(lifecycleDescriptor);
        }
        rmSync(join(root, ".agentscope"), { recursive: true });
        symlinkSync(tmpdir(), join(root, ".agentscope"));
        expect(() => openLocalSqliteLifecycle(homeDescriptor)).toThrow(
          "integration.codex.local-sqlite-settlement",
        );
      } finally {
        closeSync(homeDescriptor);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("Codex Local SQLite settlement snapshots", () => {
  it("accepts only an unchanged empty lifecycle snapshot", () => {
    const identity = {
      dev: 1n,
      ino: 2n,
      mode: 0o40700n,
      uid: 3n,
      gid: 4n,
      size: 0n,
      mtimeNs: 5n,
      ctimeNs: 6n,
    };
    expect(
      settledLocalSqliteLifecycleSnapshot({
        before: identity,
        first: [],
        middle: identity,
        second: [],
        after: identity,
      }),
    ).toBe(true);
    const lease = {
      kind: "file",
      name: `lease-${"a".repeat(32)}.json`,
    };
    expect(
      settledLocalSqliteLifecycleSnapshot({
        before: identity,
        first: [lease],
        middle: identity,
        second: [lease],
        after: identity,
      }),
    ).toBe(false);
    expect(
      settledLocalSqliteLifecycleSnapshot({
        before: identity,
        first: [],
        middle: { ...identity, mtimeNs: 7n },
        second: [],
        after: { ...identity, mtimeNs: 7n },
      }),
    ).toBe(false);
    expect(() =>
      settledLocalSqliteLifecycleSnapshot({
        before: identity,
        first: [{ kind: "other", name: "exclusive-fence-v1" }],
        middle: identity,
        second: [{ kind: "other", name: "exclusive-fence-v1" }],
        after: identity,
      }),
    ).toThrow("integration.codex.local-sqlite-settlement");
    expect(() =>
      settledLocalSqliteLifecycleSnapshot({
        before: identity,
        first: [{ kind: "file", name: "unknown" }],
        middle: identity,
        second: [{ kind: "file", name: "unknown" }],
        after: identity,
      }),
    ).toThrow("integration.codex.local-sqlite-settlement");
  });
});

// eslint-disable-next-line max-lines-per-function -- closed native-record adversarial matrix
describe("Codex bounded native records", () => {
  it("rejects a terminal observation at the exact deadline cutoff", () => {
    let observedAt = 99;
    const now = () => observedAt;
    expect(
      terminalObservationBeforeDeadline({
        observed: true,
        deadline: 100,
        now,
      }),
    ).toBe(true);
    observedAt = 100;
    expect(
      terminalObservationBeforeDeadline({
        observed: true,
        deadline: 100,
        now,
      }),
    ).toBe(false);
  });

  it("rechecks the cutoff after recording the terminal diagnostic", async () => {
    let observedAt = 99;
    let published = false;
    await expect(
      publishTerminalCompletionBeforeDeadline({
        deadline: 100,
        now: () => observedAt,
        record: () => {
          observedAt = 100;
        },
        publish: () => {
          published = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("integration.codex.trace-deadline");
    expect(published).toBe(false);
  });

  it("rejects a completed trace search at the exact deadline cutoff", () => {
    let observedAt = 99;
    const now = () => observedAt;
    expect(
      traceSummaryBeforeDeadline({ summary: "trace", deadline: 100, now }),
    ).toBe("trace");
    observedAt = 100;
    expect(() =>
      traceSummaryBeforeDeadline({ summary: "trace", deadline: 100, now }),
    ).toThrow("integration.codex.trace-deadline");
  });

  it("accepts exactly one complete native task-terminal witness", () => {
    const message = "AGENTSCOPE_PTY_COMPLETE";
    const terminal = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: message,
      },
    });
    expect(codexTurnTerminalObserved([], message)).toBe(false);
    expect(codexTurnTerminalObserved([`${terminal}\n`], message)).toBe(true);
    expect(codexTurnTerminalObserved([terminal], message)).toBe(false);
    expect(() =>
      codexTurnTerminalObserved([`${terminal}\n${terminal}\n`], message),
    ).toThrow("integration.codex.session-ledger");
    expect(() =>
      codexTurnTerminalObserved(
        [
          `${JSON.stringify({
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: "turn-1",
              last_agent_message: "substituted",
            },
          })}\n`,
        ],
        message,
      ),
    ).toThrow("integration.codex.session-ledger");
    expect(() => codexTurnTerminalObserved(["{\n"], message)).toThrow(
      "integration.codex.session-ledger",
    );
    const record = (content: string, overrides = {}) => ({
      relativePath:
        ".codex/sessions/2026/09/16/rollout-2026-09-16T00:00:00-test.jsonl",
      dev: 1n,
      ino: 2n,
      mode: 0o100600n,
      uid: 1000n,
      gid: 1000n,
      content,
      ...overrides,
    });
    const baseline = [record(`${JSON.stringify({ type: "session_meta" })}\n`)];
    expect(
      codexTurnTerminalObservedAfterBaseline(baseline, baseline, message),
    ).toBe(false);
    expect(
      codexTurnTerminalObservedAfterBaseline(
        [record(`${baseline[0]!.content}${terminal}\n`)],
        baseline,
        message,
      ),
    ).toBe(true);
    expect(() =>
      codexTurnTerminalObservedAfterBaseline(
        [record(`${baseline[0]!.content}${terminal}\n`, { ino: 3n })],
        baseline,
        message,
      ),
    ).toThrow("integration.codex.session-ledger");
    expect(() =>
      codexTurnTerminalObservedAfterBaseline(
        [record(`${terminal}\n`)],
        [record(`${terminal}\n`)],
        message,
      ),
    ).toThrow("integration.codex.session-ledger");
    expect(() =>
      codexTurnTerminalObservedAfterBaseline(
        [
          record(`${baseline[0]!.content}${terminal}\n`),
          record("unrelated\n", {
            relativePath:
              ".codex/sessions/2026/09/16/rollout-2026-09-16T00:00:01-extra.jsonl",
            ino: 4n,
          }),
        ],
        baseline,
        message,
      ),
    ).toThrow("integration.codex.session-ledger");
  });

  it("reads one bounded JSON response and rejects overflow or malformed data", async () => {
    await expect(
      readBoundedJsonResponse(
        new Response(JSON.stringify([{ method: "POST" }])),
        128,
      ),
    ).resolves.toEqual([{ method: "POST" }]);
    await expect(
      readBoundedJsonResponse(new Response("x".repeat(129)), 128),
    ).rejects.toThrow("integration.codex.sidecar");
    await expect(
      readBoundedJsonResponse(new Response("{"), 128),
    ).rejects.toThrow("integration.codex.sidecar");
  });

  it("retains all request records and rejects extra capacity or non-records", () => {
    const records = [{ path: "/v1/responses" }, { path: "/unexpected" }];
    expect(boundedRequestLedger(records)).toHaveLength(2);
    expect(() =>
      boundedRequestLedger(Array.from({ length: 9 }, () => ({}))),
    ).toThrow("integration.codex.model-request");
    expect(() => boundedRequestLedger([null])).toThrow(
      "integration.codex.model-request",
    );
  });

  it("never lets an observation backoff survive its absolute deadline", async () => {
    const boundedWait = waitWithinObservationDeadline;
    let now = 14_000;
    const waits: number[] = [];
    const wait = (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    };
    await expect(
      boundedWait({
        deadline: 15_000,
        maximumWaitMilliseconds: 500,
        now: () => now,
        wait,
      }),
    ).resolves.toBeUndefined();
    expect(waits).toEqual([500]);
    now = 14_900;
    await expect(
      boundedWait({
        deadline: 15_000,
        maximumWaitMilliseconds: 500,
        now: () => now,
        wait,
      }),
    ).rejects.toThrow("integration.codex.trace-deadline");
    expect(waits).toEqual([500, 100]);
    await expect(
      boundedWait({
        deadline: 15_000,
        maximumWaitMilliseconds: 500,
        now: () => now,
        wait,
      }),
    ).rejects.toThrow("integration.codex.trace-deadline");
    expect(waits).toEqual([500, 100]);
  });

  it("starts no model-ledger request after its diagnostic cutoff", async () => {
    const requests: AbortSignal[] = [];
    await expect(
      waitForModelRequestBeforeDeadline({
        deadline: 100,
        now: () => 100,
        request: (signal) => {
          requests.push(signal);
          return Promise.resolve([]);
        },
        wait: () => Promise.resolve(),
      }),
    ).rejects.toThrow("integration.codex.diagnostic-deadline");
    expect(requests).toEqual([]);
  });

  it("aborts and joins an in-flight model-ledger request at the cutoff", async () => {
    let now = 0;
    let joined = false;
    const request = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            joined = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    const observation = waitForModelRequestBeforeDeadline({
      deadline: 10,
      now: () => now,
      request,
      wait: () => Promise.resolve(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    now = 10;
    await expect(observation).rejects.toThrow(
      "integration.codex.diagnostic-deadline",
    );
    expect(joined).toBe(true);
  });

  it("starts no later request when the diagnostic cutoff ends a backoff", async () => {
    let now = 99;
    let requests = 0;
    let pendingWait = false;
    await expect(
      waitForModelRequestBeforeDeadline({
        deadline: 100,
        now: () => now,
        request: () => {
          requests += 1;
          return Promise.resolve([]);
        },
        wait: (milliseconds) => {
          pendingWait = true;
          now += milliseconds;
          pendingWait = false;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("integration.codex.diagnostic-deadline");
    expect(requests).toBe(1);
    expect(pendingWait).toBe(false);
  });
});
