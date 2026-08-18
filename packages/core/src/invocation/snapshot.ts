import { createHash } from "node:crypto";

import {
  reporterDeadlineRemainingMilliseconds,
  type ReporterDeadline,
} from "@agentscope/destinations-core";
import { createReporterDeadline } from "@agentscope/destinations-core/core-orchestration";

import type {
  CaptureInvocationContext,
  HarnessRegistryId,
} from "../capture/types.js";
import {
  readConfigurationForHook,
  type ConfigurationStore,
} from "../configuration/transaction.js";
import {
  serializeAgentscopeConfiguration,
  MAXIMUM_HOOK_DEADLINE_MILLISECONDS,
  MINIMUM_HOOK_DEADLINE_MILLISECONDS,
  type AgentscopeConfigurationSnapshot,
} from "../configuration/schema.js";
import {
  resolveRedactionPolicy,
  type RedactionPolicyRegistry,
} from "../redaction/policy.js";
import {
  resolveGitContextForCore,
  type GitContextSnapshot,
  type WorkspaceCandidate,
} from "./git-context.js";

export const INVOCATION_PREPARATION_CODES = Object.freeze([
  "configuration-unavailable",
  "policy-unavailable",
  "context-unavailable",
  "deadline-exceeded",
] as const);
export type InvocationPreparationCode =
  (typeof INVOCATION_PREPARATION_CODES)[number];

export type InvocationPreparationFailure = Readonly<{
  ok: false;
  outcome: "failed-open";
  stage: "configuration" | "policy" | "context";
  code: InvocationPreparationCode;
  diagnostic: Readonly<{
    code: "configuration-invalid" | "policy-unavailable" | "capture-failed";
    severity: "warning";
    configurationGeneration: number | null;
  }>;
}>;

export type CaptureInvocationSnapshot = Readonly<{
  configuration: AgentscopeConfigurationSnapshot;
  invocation: CaptureInvocationContext;
  deadline: ReporterDeadline;
  deadlineProvenance: Readonly<{
    bootstrapDeadlineMilliseconds: number;
    configuredDeadlineMilliseconds: number;
    effectiveDeadlineMilliseconds: number;
  }>;
}>;

export type InvocationPreparationResult =
  | Readonly<{ ok: true; snapshot: CaptureInvocationSnapshot }>
  | InvocationPreparationFailure;

const failure = (
  stage: InvocationPreparationFailure["stage"],
  code: InvocationPreparationCode,
  diagnosticCode: InvocationPreparationFailure["diagnostic"]["code"],
  configurationGeneration: number | null,
): InvocationPreparationFailure =>
  Object.freeze({
    ok: false,
    outcome: "failed-open",
    stage,
    code,
    diagnostic: Object.freeze({
      code: diagnosticCode,
      severity: "warning",
      configurationGeneration,
    }),
  });

const configurationIdentity = (snapshot: AgentscopeConfigurationSnapshot) =>
  `configuration-v1-sha256-${createHash("sha256")
    .update(serializeAgentscopeConfiguration(snapshot))
    .digest("hex")}`;

const signalIsAborted = (signal: AbortSignal | undefined) => {
  try {
    return signal?.aborted === true;
  } catch {
    return true;
  }
};

const monotonicNow = performance.now.bind(performance);

export type CaptureInvocationPreparationInput = Readonly<{
  configurationStore: ConfigurationStore;
  policyRegistry: RedactionPolicyRegistry;
  harnessRegistryId: HarnessRegistryId;
  harnessVersion: CaptureInvocationContext["harnessVersion"];
  hookObservedUnixNano: string;
  operationIdScope: CaptureInvocationContext["operationIdScope"];
  workspaceCandidates: readonly WorkspaceCandidate[];
  gitExecutable: string;
  bootstrapDeadlineMilliseconds: number;
  signal?: AbortSignal;
}>;

type ContextResolver = (
  input: Readonly<{
    candidates: readonly WorkspaceCandidate[];
    gitExecutable: string;
    remainingMilliseconds: number;
    signal?: AbortSignal;
  }>,
) => Promise<GitContextSnapshot>;

type ConfigurationSettlement =
  | Readonly<{
      kind: "settled";
      value: Awaited<ReturnType<typeof readConfigurationForHook>>;
    }>
  | Readonly<{ kind: "expired" }>;

const readConfigurationWithinDeadline = async (
  store: ConfigurationStore,
  deadline: ReporterDeadline,
  signal: AbortSignal | undefined,
): Promise<ConfigurationSettlement> => {
  const remaining = reporterDeadlineRemainingMilliseconds(deadline);
  /* v8 ignore next -- the caller validates a minimum 50 ms deadline and checks
     cancellation immediately before this synchronous helper invocation. */
  if (remaining <= 0 || signalIsAborted(signal))
    return Object.freeze({ kind: "expired" });
  const controller = new AbortController();
  const abortRead = (): void => {
    controller.abort();
  };
  const read = readConfigurationForHook(store, controller.signal);
  return new Promise((resolve) => {
    let completed = false;
    const finish = (settlement: ConfigurationSettlement): void => {
      if (completed) return;
      completed = true;
      if (settlement.kind === "expired") controller.abort();
      clearTimeout(timer);
      try {
        signal?.removeEventListener("abort", abortRead);
        controller.signal.removeEventListener("abort", onAbort);
      } catch {
        // Hostile optional signals collapse to the fixed expiry result.
      }
      resolve(settlement);
    };
    const onAbort = (): void => {
      finish(Object.freeze({ kind: "expired" }));
    };
    const timer = setTimeout(() => {
      finish(Object.freeze({ kind: "expired" }));
    }, remaining);
    try {
      signal?.addEventListener("abort", abortRead, { once: true });
    } catch {
      finish(Object.freeze({ kind: "expired" }));
      return;
    }
    if (signalIsAborted(signal)) {
      onAbort();
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    void read.then(
      (value) => {
        finish(Object.freeze({ kind: "settled", value }));
      },
      /* v8 ignore next 10 -- readConfigurationForHook is an async total boundary
         that converts every filesystem/parser rejection into a fixed result. */
      () => {
        finish(
          Object.freeze({
            kind: "settled",
            value: Object.freeze({
              ok: false,
              code: "core.configuration.unavailable",
            }),
          }),
        );
      },
    );
  });
};

type PreparedConfiguration = Readonly<{
  ok: true;
  configuration: AgentscopeConfigurationSnapshot;
  deadline: ReporterDeadline;
  deadlineProvenance: CaptureInvocationSnapshot["deadlineProvenance"];
}>;

const prepareConfiguration = async (
  input: CaptureInvocationPreparationInput,
  startedAt: number,
): Promise<PreparedConfiguration | InvocationPreparationFailure> => {
  const bootstrapDeadlineMilliseconds = input.bootstrapDeadlineMilliseconds;
  if (
    !Number.isSafeInteger(bootstrapDeadlineMilliseconds) ||
    bootstrapDeadlineMilliseconds < MINIMUM_HOOK_DEADLINE_MILLISECONDS ||
    bootstrapDeadlineMilliseconds > MAXIMUM_HOOK_DEADLINE_MILLISECONDS
  )
    return failure(
      "configuration",
      "deadline-exceeded",
      "capture-failed",
      null,
    );
  const bootstrapDeadline = createReporterDeadline(
    bootstrapDeadlineMilliseconds,
  );
  if (signalIsAborted(input.signal))
    return failure(
      "configuration",
      "deadline-exceeded",
      "capture-failed",
      null,
    );
  const settlement = await readConfigurationWithinDeadline(
    input.configurationStore,
    bootstrapDeadline,
    input.signal,
  );
  if (settlement.kind === "expired")
    return failure(
      "configuration",
      "deadline-exceeded",
      "capture-failed",
      null,
    );
  if (!settlement.value.ok)
    return failure(
      "configuration",
      "configuration-unavailable",
      "configuration-invalid",
      null,
    );
  const configuration = settlement.value.snapshot;
  const configuredDeadlineMilliseconds = configuration.hookDeadlineMilliseconds;
  const effectiveDeadlineMilliseconds = Math.min(
    bootstrapDeadlineMilliseconds,
    configuredDeadlineMilliseconds,
  );
  const deadline = createReporterDeadline(
    Math.max(
      0,
      Math.floor(effectiveDeadlineMilliseconds - (monotonicNow() - startedAt)),
    ),
  );
  if (
    signalIsAborted(input.signal) ||
    reporterDeadlineRemainingMilliseconds(deadline) <= 0
  )
    return failure(
      "configuration",
      "deadline-exceeded",
      "capture-failed",
      configuration.generation,
    );
  return Object.freeze({
    ok: true,
    configuration,
    deadline,
    deadlineProvenance: Object.freeze({
      bootstrapDeadlineMilliseconds,
      configuredDeadlineMilliseconds,
      effectiveDeadlineMilliseconds,
    }),
  });
};

const resolveSnapshot = async (
  input: CaptureInvocationPreparationInput,
  contextResolver: ContextResolver,
): Promise<InvocationPreparationResult> => {
  const startedAt = monotonicNow();
  const prepared = await prepareConfiguration(input, startedAt);
  if (!prepared.ok) return prepared;
  const { configuration, deadline, deadlineProvenance } = prepared;
  const effectiveRemainingMilliseconds = (): number =>
    reporterDeadlineRemainingMilliseconds(deadline);
  const deadlineExpired = (): boolean => {
    return effectiveRemainingMilliseconds() <= 0;
  };
  let policy;
  try {
    policy = resolveRedactionPolicy(
      input.policyRegistry,
      configuration.policyReference,
    );
  } catch {
    return failure(
      "policy",
      "policy-unavailable",
      "policy-unavailable",
      configuration.generation,
    );
  }
  /* v8 ignore next -- policy resolution is synchronous and bounded; this
     defensive gate protects an expiry exactly across its final instruction. */
  if (signalIsAborted(input.signal) || deadlineExpired())
    return failure(
      "context",
      "deadline-exceeded",
      "capture-failed",
      configuration.generation,
    );
  let context;
  try {
    context = await contextResolver({
      candidates: input.workspaceCandidates,
      gitExecutable: input.gitExecutable,
      remainingMilliseconds: effectiveRemainingMilliseconds(),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    return failure(
      "context",
      "context-unavailable",
      "capture-failed",
      configuration.generation,
    );
  }
  if (signalIsAborted(input.signal) || deadlineExpired())
    return failure(
      "context",
      "deadline-exceeded",
      "capture-failed",
      configuration.generation,
    );
  const invocation = Object.freeze({
    harnessRegistryId: input.harnessRegistryId,
    harnessVersion: Object.freeze({ ...input.harnessVersion }),
    snapshot: Object.freeze({
      configurationIdentity: configurationIdentity(configuration),
      policyIdentity: policy.identity,
      redactionPolicy: policy,
    }),
    hookObservedUnixNano: input.hookObservedUnixNano,
    operationIdScope: input.operationIdScope,
    context,
  });
  return Object.freeze({
    ok: true,
    snapshot: Object.freeze({
      configuration,
      invocation,
      deadline,
      deadlineProvenance,
    }),
  });
};

export const resolveCaptureInvocationSnapshot = async (
  input: CaptureInvocationPreparationInput,
): Promise<InvocationPreparationResult> => {
  try {
    return await resolveSnapshot(input, resolveGitContextForCore);
  } catch {
    return failure(
      "configuration",
      "configuration-unavailable",
      "configuration-invalid",
      null,
    );
  }
};

export const resolveCaptureInvocationSnapshotForTesting = async (
  input: CaptureInvocationPreparationInput &
    Readonly<{ contextResolver: ContextResolver }>,
): Promise<InvocationPreparationResult> => {
  try {
    return await resolveSnapshot(input, input.contextResolver);
  } catch {
    return failure(
      "configuration",
      "configuration-unavailable",
      "configuration-invalid",
      null,
    );
  }
};
