import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";
import { classifyCheckpointTopologyForTest } from "../internal/headless-supervisor-backend.js";

type Snapshot = {
  pid: number;
  parentPid: number;
  startIdentity: string;
  state: string;
};
const backend = readFileSync(
  new URL("../internal/headless-supervisor-backend.ts", import.meta.url),
  "utf8",
);
const start = backend.indexOf("const sameProcessSnapshotSet = (");
const end = backend.indexOf("const delay = (", start);
if (start < 0 || end <= start) throw new Error("checkpoint-source-anchor");
const code = transpileModule(backend.slice(start, end), {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
const root = (): Snapshot => ({
  pid: 2,
  parentPid: 1,
  startIdentity: "root-birth",
  state: "S",
});
const zombie = (): Snapshot => ({
  pid: 3,
  parentPid: 2,
  startIdentity: "zombie-birth",
  state: "Z",
});
const harness = (initial: Snapshot[]) => {
  let processes = initial.map((entry) => ({ ...entry }));
  const signals: { pid: number; signal: string }[] = [];
  let reads = 0;
  let now = 1;
  let transform = (entries: Snapshot[]): Snapshot[] | undefined => entries;
  const context = {
    assertNamespaceIdentity: (value: string) => {
      expect(value).toBe("namespace");
    },
    strictContainerProcessSnapshot: () => {
      reads++;
      return transform(processes.map((entry) => ({ ...entry })));
    },
    readProcessSnapshot: (pid: number) =>
      processes.find((entry) => entry.pid === pid),
    process: {
      kill: (pid: number, signal: string) => {
        signals.push({ pid, signal });
        const entry = processes.find((candidate) => candidate.pid === pid);
        if (entry && signal === "SIGSTOP" && entry.state !== "Z")
          entry.state = "T";
      },
    },
    safeReflectApply: Reflect.apply,
    performanceNow: () => now,
    performance: {},
    fail: (value: string): never => {
      throw new Error(value);
    },
  };
  const execute = (expression: string): Snapshot[] | undefined =>
    runInNewContext(`(() => { ${code}\nreturn ${expression}; })()`, context, {
      timeout: 1000,
    }) as Snapshot[] | undefined;
  return {
    signals,
    reads: () => reads,
    freeze: () => execute('freezeContainerProcessSet("namespace", 100)'),
    release: (frozen: Snapshot[], notify = false) => {
      Object.assign(context, { frozen, notify });
      execute(
        'releaseFrozenContainerProcessSet("namespace", frozen, 2, notify, 100)',
      );
    },
    replace: (entries: Snapshot[]) => {
      processes = entries;
    },
    clock: (value: number) => {
      now = value;
    },
    observations: (value: typeof transform) => {
      transform = value;
    },
  };
};

describe("exact production checkpoint freeze and release", () => {
  it("never counts a retained zombie as the live root or descendant", () => {
    const live = { ...root(), state: "T" };
    const descendant = {
      pid: 4,
      parentPid: 2,
      startIdentity: "descendant-birth",
      state: "T",
    };
    expect(
      classifyCheckpointTopologyForTest(
        harness([live, zombie(), descendant]).freeze()!,
        live,
      ),
    ).toBe("matched");
    expect(
      classifyCheckpointTopologyForTest(
        harness([live, zombie()]).freeze()!,
        live,
      ),
    ).toBe("nonroot-missing");
    expect(
      classifyCheckpointTopologyForTest(
        harness([{ ...live, state: "Z" }, zombie(), descendant]).freeze()!,
        live,
      ),
    ).toBe("root-missing");
  });

  it.each(["T", "t"])(
    "retains stable zombie identity beside %s live tasks",
    (state) => {
      const live = { ...root(), state };
      const value = harness([live, zombie()]);
      const frozen = value.freeze()!;
      expect(frozen).toEqual([live, zombie()]);
      expect(value.reads()).toBe(2);
      expect(value.signals).toEqual([]);
      value.release(frozen, true);
      expect(value.signals).toEqual([
        { pid: 2, signal: "SIGUSR2" },
        { pid: 2, signal: "SIGCONT" },
      ]);
      expect(frozen[1]).toEqual(zombie());
    },
  );

  it("stops live processes but neither stops nor reaps a retained zombie", () => {
    const value = harness([root(), zombie()]);
    const frozen = value.freeze()!;
    expect(frozen).toEqual([{ ...root(), state: "T" }, zombie()]);
    expect(value.signals).toEqual([{ pid: 2, signal: "SIGSTOP" }]);
    value.release(frozen);
    expect(value.signals).toEqual([
      { pid: 2, signal: "SIGSTOP" },
      { pid: 2, signal: "SIGCONT" },
    ]);
  });

  it.each(["startIdentity", "parentPid", "state"] as const)(
    "rejects an unsettled zombie %s without extending 64 attempts",
    (field) => {
      const value = harness([{ ...root(), state: "T" }, zombie()]);
      let read = 0;
      value.observations((entries) => {
        if (++read % 2 === 0) {
          const last = entries[1]!;
          if (field === "startIdentity") last.startIdentity = "substituted";
          else if (field === "parentPid") last.parentPid = 1;
          else last.state = "S";
        }
        return entries;
      });
      expect(value.freeze).toThrow("testkit.headless.observer.process-set");
      expect(value.reads()).toBe(128);
      expect(value.signals).toEqual([]);
    },
  );

  it.each(["missing", "birth", "parent", "revived"])(
    "rejects %s zombie identity before any release signal",
    (variant) => {
      const value = harness([{ ...root(), state: "T" }, zombie()]);
      const frozen = value.freeze()!;
      const changed = zombie();
      if (variant === "birth") changed.startIdentity = "new-birth";
      if (variant === "parent") changed.parentPid = 1;
      if (variant === "revived") changed.state = "T";
      value.replace([
        { ...root(), state: "T" },
        ...(variant === "missing" ? [] : [changed]),
      ]);
      expect(() => {
        value.release(frozen);
      }).toThrow("testkit.headless.observer.identity");
      expect(value.signals).toEqual([]);
    },
  );

  it("keeps an unavailable snapshot failing and admits no release", () => {
    const value = harness([root(), zombie()]);
    value.observations(() => undefined);
    expect(value.freeze).toThrow("testkit.headless.observer.process-set");
    expect(value.reads()).toBe(64);
    expect(value.signals).toEqual([]);
  });

  it("consumes only the original cutoff, including between attempts", () => {
    const value = harness([root(), zombie()]);
    value.observations(() => {
      value.clock(100);
      return undefined;
    });
    expect(value.freeze).toThrow("testkit.headless.execution.deadline");
    expect(value.reads()).toBe(1);
    expect(value.signals).toEqual([]);
  });
});
