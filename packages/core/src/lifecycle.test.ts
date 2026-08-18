import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  isRedactedCanonicalTrace,
  type RedactedCanonicalTrace,
} from "@agentscope/protocol";

import type {
  CapturedTrace,
  CapturedTraceCandidate,
  CaptureInvocationContext,
  OperationCandidate,
} from "./capture/types.js";
import {
  withCaptureInvocation,
  withCaptureInvocationSyncForCore,
} from "./capture/runtime.js";
import {
  runFailOpenTraceLifecycle,
  type RedactedTraceSink,
  type TraceLifecycleInput,
} from "./lifecycle.js";
import {
  BUILTIN_REDACTION_POLICY_REFERENCES,
  DEFAULT_REDACTION_POLICY_REGISTRY,
  resolveRedactionPolicy,
} from "./redaction/policy.js";

// Branded handoff and content-free fail-open component evidence.

const invocation = (): CaptureInvocationContext => {
  const policy = resolveRedactionPolicy(
    DEFAULT_REDACTION_POLICY_REGISTRY,
    BUILTIN_REDACTION_POLICY_REFERENCES.baseline,
  );
  return {
    harnessRegistryId: "codex",
    harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
    snapshot: {
      configurationIdentity: "config.v1",
      policyIdentity: policy.identity,
      redactionPolicy: policy,
    },
    hookObservedUnixNano: "10",
    operationIdScope: "session-global",
    context: {
      fields: [],
      unavailable: [
        {
          field: "agentscope.workspace.directory",
          source: "process",
          state: "unavailable",
          reason: "resolution-failed",
        },
        ...[
          "agentscope.git.worktree",
          "agentscope.git.repository_root",
          "vcs.ref.head.name",
          "vcs.ref.head.revision",
          "vcs.ref.type",
        ].map((field) => ({
          field,
          source: "git" as const,
          state: "unavailable" as const,
          reason: "resolution-failed" as const,
        })),
      ],
    },
  };
};

const operation = (): OperationCandidate => ({
  logicalKey: "root",
  locator: { kind: "source-ordinal", ordinal: 0 },
  kind: "AGENT",
  name: "agent-operation",
  nameProvenance: { field: "span.name", source: "native-artifact" },
  timing: {
    basis: "native-interval",
    nativeState: "observed",
    source: "native-artifact",
    startUnixNano: "1",
    endUnixNano: "20",
  },
  fields: [],
  unavailable: [],
  events: [],
  links: [],
});

const candidate = (): CapturedTraceCandidate => ({
  captureBoundary: {
    session: {
      kind: "native-session",
      nativeIdentityKind: "thread",
      nativeIdentity: "thread-1",
    },
    boundaryKind: "turn",
    boundaryId: "turn-1",
    generation: 0,
    positionKind: "event-index",
    startPosition: 0,
    exclusiveEndPosition: 1,
  },
  rootContext: { fields: [], unavailable: [] },
  operations: [operation()],
});

const redactionOverflowCandidate = (): CapturedTraceCandidate => {
  const value = candidate();
  return {
    ...value,
    operations: [
      {
        ...value.operations[0]!,
        events: Array.from({ length: 60 }, (_, index) => ({
          name: "checkpoint",
          nameProvenance: {
            field: "span.event.name" as const,
            source: "native-artifact" as const,
          },
          timeUnixNano: String(index + 2),
          timeProvenance: {
            field: "span.event.time_unix_nano" as const,
            source: "native-artifact" as const,
          },
          fields: [],
        })),
      },
    ],
  };
};

const validInput = (
  sink: RedactedTraceSink = () => undefined,
): TraceLifecycleInput => ({
  invocation: invocation(),
  capture: (factory) => factory.capture(candidate()),
  sink,
});

describe("synchronous fail-open trace lifecycle", () => {
  it("hands one branded frozen item to the sink and retains no Core result copy", () => {
    let clone: unknown;
    const sink = vi.fn<RedactedTraceSink>((trace) => {
      expect(isRedactedCanonicalTrace(trace)).toBe(true);
      expect(Object.isFrozen(trace)).toBe(true);
      clone = structuredClone(trace);
      return undefined;
    });
    const result = runFailOpenTraceLifecycle(validInput(sink));
    expect(result).toEqual({ outcome: "sink-returned", stage: "sink" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/trace|span|thread|CANARY/iu);
    expect(isRedactedCanonicalTrace(clone as RedactedCanonicalTrace)).toBe(
      false,
    );
  });

  it("returns fixed capture failures for invalid policy and arbitrary errors", () => {
    const capture = vi.fn(validInput().capture);
    const sink = vi.fn<RedactedTraceSink>(() => undefined);
    const invalidPolicy = invocation();
    const result = runFailOpenTraceLifecycle({
      ...validInput(sink),
      invocation: {
        ...invalidPolicy,
        snapshot: { ...invalidPolicy.snapshot, policyIdentity: "invalid" },
      },
      capture,
    });
    expect(result).toEqual({
      outcome: "failed-open",
      stage: "capture",
      reason: "failed",
    });
    expect(capture).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(
      runFailOpenTraceLifecycle({
        ...validInput(sink),
        capture() {
          throw new Error("CANARY_SECRET");
        },
      }),
    ).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
  });

  it("requires the exact trace minted by this invocation", async () => {
    const old = await withCaptureInvocation(invocation(), (factory) =>
      factory.capture(candidate()),
    );
    const sink = vi.fn<RedactedTraceSink>(() => undefined);
    for (const capture of [
      () => old,
      (factory: Parameters<TraceLifecycleInput["capture"]>[0]) => {
        factory.capture(candidate());
        return old;
      },
      (factory: Parameters<TraceLifecycleInput["capture"]>[0]) => {
        const current = factory.capture(candidate());
        return structuredClone(current);
      },
    ])
      expect(
        runFailOpenTraceLifecycle({ ...validInput(sink), capture }),
      ).toEqual({
        outcome: "failed-open",
        stage: "capture",
        reason: "failed",
      });
    expect(sink).not.toHaveBeenCalled();

    const duringSink = new AbortController();
    expect(
      runFailOpenTraceLifecycle({
        ...validInput(() => {
          duringSink.abort();
        }),
        signal: duringSink.signal,
      }),
    ).toEqual({
      outcome: "failed-open",
      stage: "sink",
      reason: "cancelled",
    });
  });
});

describe("runtime misuse observation", () => {
  it("observes runtime-cast async and hostile thenable capture returns", async () => {
    const sink = vi.fn<RedactedTraceSink>(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      for (const capture of [
        (async () => {
          await Promise.resolve();
          throw new Error("CANARY_SECRET");
        }) as unknown as TraceLifecycleInput["capture"],
        (() => ({
          get then() {
            throw new Error("CANARY_SECRET");
          },
        })) as unknown as TraceLifecycleInput["capture"],
        (() => "CANARY_SECRET") as unknown as TraceLifecycleInput["capture"],
        (() =>
          new Proxy(
            {},
            {
              getOwnPropertyDescriptor() {
                throw new Error("CANARY_SECRET");
              },
              get() {
                throw new Error("CANARY_SECRET");
              },
            },
          )) as unknown as TraceLifecycleInput["capture"],
      ])
        expect(
          runFailOpenTraceLifecycle({ ...validInput(sink), capture }),
        ).toEqual({
          outcome: "failed-open",
          stage: "capture",
          reason: "failed",
        });
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      expect(sink).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("lifecycle cancellation and sink failure closure", () => {
  it("treats an unavailable deadline clock as cancellation", () => {
    expect(
      runFailOpenTraceLifecycle({
        ...validInput(),
        remainingMilliseconds() {
          throw new Error("CANARY_SECRET");
        },
      }),
    ).toEqual({
      outcome: "failed-open",
      stage: "capture",
      reason: "cancelled",
    });
  });

  it("checks cancellation before capture, redaction, and sink handoff", () => {
    const pre = new AbortController();
    pre.abort("CANARY_SECRET");
    const capture = vi.fn(validInput().capture);
    expect(
      runFailOpenTraceLifecycle({
        ...validInput(),
        capture,
        signal: pre.signal,
      }),
    ).toEqual({
      outcome: "failed-open",
      stage: "capture",
      reason: "cancelled",
    });
    expect(capture).not.toHaveBeenCalled();

    const afterCapture = new AbortController();
    let retainedFactory:
      Parameters<TraceLifecycleInput["capture"]>[0] | undefined;
    const result = runFailOpenTraceLifecycle({
      ...validInput(),
      signal: afterCapture.signal,
      capture(factory) {
        retainedFactory = factory;
        const trace = factory.capture(candidate());
        afterCapture.abort();
        return trace;
      },
    });
    expect(result).toEqual({
      outcome: "failed-open",
      stage: "redaction",
      reason: "cancelled",
    });
    expect(() => retainedFactory!.capture(candidate())).toThrow();

    let reads = 0;
    const stagedSignal = {
      get aborted() {
        reads += 1;
        return reads === 3;
      },
    } as AbortSignal;
    const sink = vi.fn<RedactedTraceSink>(() => undefined);
    expect(
      runFailOpenTraceLifecycle({ ...validInput(sink), signal: stagedSignal }),
    ).toEqual({
      outcome: "failed-open",
      stage: "sink",
      reason: "cancelled",
    });
    expect(sink).not.toHaveBeenCalled();
  });

  it("maps redaction overflow and every sink failure to fixed results", async () => {
    const sink = vi.fn<RedactedTraceSink>(() => undefined);
    expect(
      runFailOpenTraceLifecycle({
        ...validInput(sink),
        capture: (factory) => factory.capture(redactionOverflowCandidate()),
      }),
    ).toEqual({
      outcome: "failed-open",
      stage: "redaction",
      reason: "failed",
    });
    expect(sink).not.toHaveBeenCalled();

    const rejectingPromise = Promise.reject(new Error("CANARY_SECRET"));
    void rejectingPromise;
    void Object.defineProperty(rejectingPromise, "catch", {
      value() {
        throw new Error("CANARY_SECRET");
      },
    });
    const hostileThenable = {
      get then() {
        throw new Error("CANARY_SECRET");
      },
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      for (const failingSink of [
        (() => {
          throw new Error("CANARY_SECRET");
        }) as RedactedTraceSink,
        (() => "CANARY_SECRET") as unknown as RedactedTraceSink,
        (() => rejectingPromise) as unknown as RedactedTraceSink,
        (() => hostileThenable) as unknown as RedactedTraceSink,
      ])
        expect(runFailOpenTraceLifecycle(validInput(failingSink))).toEqual({
          outcome: "failed-open",
          stage: "sink",
          reason: "failed",
        });
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("hostile lifecycle boundaries", () => {
  it("keeps the lifecycle source and dist free of direct IO dependencies", () => {
    for (const url of [
      new URL("./lifecycle.ts", import.meta.url),
      new URL("../dist/lifecycle.js", import.meta.url),
    ]) {
      const source = fs.readFileSync(url, "utf8");
      expect(source).not.toMatch(
        /node:(?:fs|http|https|net|tls)|\bfetch\s*\(|\bconsole\.|process\.(?:stdout|stderr)/u,
      );
    }
  });

  it("maps hostile lifecycle, signal, and sink boundaries to fixed results", () => {
    expect(runFailOpenTraceLifecycle(null as never)).toEqual({
      outcome: "failed-open",
      stage: "capture",
      reason: "failed",
    });
    expect(
      runFailOpenTraceLifecycle(
        new Proxy({} as TraceLifecycleInput, {
          get() {
            throw new Error("CANARY_SECRET");
          },
        }),
      ),
    ).toEqual({ outcome: "failed-open", stage: "capture", reason: "failed" });
    const throwingSignal = {
      get aborted() {
        throw new Error("CANARY_SECRET");
      },
    } as unknown as AbortSignal;
    expect(
      runFailOpenTraceLifecycle({ ...validInput(), signal: throwingSignal }),
    ).toEqual({
      outcome: "failed-open",
      stage: "capture",
      reason: "cancelled",
    });
    const hostileSink = new Proxy<RedactedTraceSink>(() => undefined, {
      apply() {
        throw new Error("CANARY_SECRET");
      },
    });
    expect(runFailOpenTraceLifecycle(validInput(hostileSink))).toEqual({
      outcome: "failed-open",
      stage: "sink",
      reason: "failed",
    });
    expect(() =>
      withCaptureInvocationSyncForCore(invocation(), null as never),
    ).toThrow();
    expect(
      runFailOpenTraceLifecycle({
        ...validInput(),
        capture: (() => undefined) as unknown as TraceLifecycleInput["capture"],
      }),
    ).toEqual({ outcome: "failed-open", stage: "capture", reason: "failed" });
    expect(
      runFailOpenTraceLifecycle({
        ...validInput(),
        onCaptured: () => Promise.resolve("unexpected"),
      }),
    ).toEqual({ outcome: "failed-open", stage: "capture", reason: "failed" });
    const abortOnFailure = new AbortController();
    expect(
      runFailOpenTraceLifecycle({
        ...validInput(),
        signal: abortOnFailure.signal,
        capture() {
          abortOnFailure.abort();
          throw new Error("CANARY_SECRET");
        },
      }),
    ).toEqual({
      outcome: "failed-open",
      stage: "capture",
      reason: "cancelled",
    });
  });
});

describe("lifecycle IO and compile boundary", () => {
  it("performs no Core IO across success and every failure stage", async () => {
    const spies = [
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "appendFileSync"),
      vi.spyOn(fs, "writeFile"),
      vi.spyOn(fs, "appendFile"),
      vi.spyOn(fs, "createWriteStream"),
      vi.spyOn(http, "request"),
      vi.spyOn(http, "get"),
      vi.spyOn(https, "request"),
      vi.spyOn(https, "get"),
      vi.spyOn(net, "connect"),
      vi.spyOn(net, "createConnection"),
      vi.spyOn(tls, "connect"),
      vi.spyOn(globalThis.console, "log").mockImplementation(() => undefined),
      vi.spyOn(globalThis.console, "warn").mockImplementation(() => undefined),
      vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined),
      vi.spyOn(globalThis, "fetch"),
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    ];
    try {
      expect(runFailOpenTraceLifecycle(validInput())).toEqual({
        outcome: "sink-returned",
        stage: "sink",
      });
      const invalid = invocation();
      const aborted = new AbortController();
      aborted.abort();
      for (const input of [
        {
          ...validInput(),
          invocation: {
            ...invalid,
            snapshot: { ...invalid.snapshot, policyIdentity: "invalid" },
          },
        },
        {
          ...validInput(),
          capture: () => {
            throw new Error("CANARY_SECRET");
          },
        },
        {
          ...validInput(),
          capture: (factory: Parameters<TraceLifecycleInput["capture"]>[0]) =>
            factory.capture(redactionOverflowCandidate()),
        },
        { ...validInput(), signal: aborted.signal },
        {
          ...validInput(),
          sink: (() => {
            throw new Error("CANARY_SECRET");
          }) as RedactedTraceSink,
        },
        {
          ...validInput(),
          sink: (() =>
            Promise.reject(
              new Error("CANARY_SECRET"),
            )) as unknown as RedactedTraceSink,
        },
      ])
        expect(runFailOpenTraceLifecycle(input)).toMatchObject({
          outcome: "failed-open",
        });
      await Promise.resolve();
      await Promise.resolve();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("exposes no raw or async sink/capture route", () => {
    expectTypeOf<
      TraceLifecycleInput["capture"]
    >().returns.toEqualTypeOf<CapturedTrace>();
    const value = validInput();
    // @ts-expect-error The lifecycle sink is synchronous and branded-only.
    value.sink({});
    // @ts-expect-error Capture adapters cannot return arbitrary DTOs.
    const invalid: TraceLifecycleInput = { ...value, capture: () => ({}) };
    void invalid;
  });
});
