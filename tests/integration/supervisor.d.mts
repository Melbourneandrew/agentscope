export type SupervisedProcessResult = Readonly<{
  code: number | null;
  contained: boolean;
  residualWorkObserved: boolean;
  signal: NodeJS.Signals | null;
}>;

export function parseSystemdTerminalExit(
  facts: Readonly<Record<string, string>>,
): number | undefined;
export function parseSystemdMainExitStatus(
  facts: Readonly<Record<string, string>>,
): number | undefined;
export function systemdMainProcessIsTerminal(
  facts: Readonly<Record<string, string>>,
): boolean;
type CgroupObjectIdentity = Readonly<{
  dev: number;
  gid: number;
  ino: number;
  mode: number;
  uid: number;
}>;
export type CgroupIdentity = Readonly<{
  descriptors: readonly [number, number, number, number];
  identities: readonly [
    CgroupObjectIdentity,
    CgroupObjectIdentity,
    CgroupObjectIdentity,
    CgroupObjectIdentity,
  ];
}>;
export function authenticateCgroup(cgroupPath: string): CgroupIdentity;
export function exactPathIsAbsent(path: string): boolean;
export function closeDescriptorSet(
  descriptors: readonly number[],
  close?: (descriptor: number) => void,
): boolean;
export function cgroupObservationSettled(
  cgroupPath: string,
  identity: CgroupIdentity,
): boolean;
export function classifySystemdUnitAuthority(
  facts: Readonly<Record<string, string>>,
  authority: Readonly<{
    cgroup: string;
    gid: number;
    groups: readonly number[];
    uid: number;
    unit: string;
  }>,
): "load" | "identity" | "cgroup" | "hardening" | "principal" | undefined;
export function classifyTerminalSystemdUnitAuthority(
  facts: Readonly<Record<string, string>>,
  authority: Readonly<{
    cgroup: string;
    gid: number;
    groups: readonly number[];
    uid: number;
    unit: string;
  }>,
  beforeAbsent: boolean,
  afterAbsent: boolean,
): "load" | "identity" | "cgroup" | "hardening" | "principal" | undefined;
export function classifyTerminalCgroupTransitionFailure(
  facts: Readonly<Record<string, string>>,
  authority: Readonly<{
    cgroup: string;
    gid: number;
    groups: readonly number[];
    uid: number;
    unit: string;
  }>,
  beforeAbsent: boolean,
  afterAbsent: boolean,
): "cgroup-transition-retained" | "cgroup-transition-other";
export function classifyRetirementSystemdUnitAuthority(
  facts: Readonly<Record<string, string>>,
  authority: Readonly<{
    cgroup: string;
    gid: number;
    groups: readonly number[];
    uid: number;
    unit: string;
  }>,
  before: Readonly<{ absent: boolean; empty: boolean }>,
  after: Readonly<{ absent: boolean; empty: boolean }>,
): "load" | "identity" | "cgroup" | "hardening" | "principal" | undefined;

export function validateRootPid1Probe(
  input: Readonly<{
    after: Readonly<{ bootId: string; startTime: string }>;
    before: Readonly<{ bootId: string; startTime: string }>;
    digestOutput: string;
    firstTarget: string;
    manager: Readonly<{
      dev: number;
      digest: string;
      gid: number;
      ino: number;
      mode: number;
      size: number;
      uid: number;
    }>;
    secondTarget: string;
    statOutput: string;
  }>,
): boolean;

export function rootPid1ProbeRequired(error: unknown): boolean;

export type SystemdToolFailureStage =
  | "startup"
  | "cutoff"
  | "sentinel"
  | "tool-spawn"
  | "client-terminal"
  | "unit-admission"
  | "retirement"
  | "join";

export type SystemdToolSentinelReason =
  | "child-exit"
  | "start-identity"
  | "inherited-group"
  | "transition-timeout"
  | "kill"
  | "reap-join"
  | "residual"
  | "internal-unknown";

export type SystemdToolJoinReason =
  | "leader-identity"
  | "preclose-residual"
  | "control-close"
  | "reap-timeout"
  | "identity-drift"
  | "postreap-residual"
  | "internal-unknown";

export type SystemdToolClientTerminalReason =
  | "cutoff"
  | "deadline"
  | "leader-identity"
  | "child-admission"
  | "member-identity"
  | "output-read"
  | "output-bound"
  | "nonzero-terminal"
  | "internal-unknown";

export type SystemdLifecyclePhase =
  | "mapped-executable-pre-submit"
  | "unit-admission"
  | "terminal-wait"
  | "unit-authoritative"
  | "cgroup-observation"
  | "termination"
  | "retirement"
  | "collection";

export type SystemdLifecycleReason =
  "deadline" | "interrupted" | "authority" | "malformed" | "internal";

export type SystemdRetirementAuthorityReason =
  | "authority-load"
  | "authority-identity"
  | "authority-cgroup"
  | "authority-hardening"
  | "authority-principal";

export type SystemdRetirementDiagnosticReason =
  | "cgroup-retained"
  | "cgroup-path"
  | "unit-show"
  | "unit-command"
  | "descriptor-close";

export type SystemdCollectionDiagnosticReason =
  "unit-show" | "unit-facts" | "load-state" | "cgroup-absence";

export type SystemdTerminalWaitAuthorityReason =
  "unit-show" | "unit-parse" | SystemdRetirementAuthorityReason;

export type SystemdLifecycleFailurePredicate =
  | `lifecycle:${SystemdLifecyclePhase}:${SystemdLifecycleReason}`
  | `lifecycle:retirement:${
      SystemdRetirementAuthorityReason | SystemdRetirementDiagnosticReason}`
  | `lifecycle:terminal-wait:${SystemdTerminalWaitAuthorityReason}`
  | `lifecycle:collection:${SystemdCollectionDiagnosticReason}`;

export type SystemdToolFailurePredicate =
  | Exclude<SystemdToolFailureStage, "sentinel" | "join" | "client-terminal">
  | `sentinel:${SystemdToolSentinelReason}`
  | `join:${SystemdToolJoinReason}`
  | `client-terminal:${SystemdToolClientTerminalReason}`
  | SystemdLifecycleFailurePredicate;

export function validSystemdLifecyclePredicate(
  predicate: unknown,
): predicate is SystemdLifecycleFailurePredicate;

export function systemdToolFailureStage(
  error: unknown,
): SystemdToolFailurePredicate | undefined;

export function exerciseSystemdToolFailurePreservationForTesting(): Readonly<{
  authenticatedIdentityPreserved: true;
  cleanupAttempts: 1;
  forgedRejected: true;
}>;

export function validateRootToolReceipt(
  input: Readonly<{
    identity: Readonly<{
      cutoff: string;
      deadline: string;
      operation: string;
      unit: string;
    }>;
    key: string;
    receipt: string;
  }>,
):
  | Readonly<{
      output: string;
      reason:
        | ""
        | SystemdToolSentinelReason
        | SystemdToolJoinReason
        | SystemdToolClientTerminalReason;
      stage: SystemdToolFailureStage;
      status: "error" | "ok" | "uncertain";
    }>
  | undefined;

export function validateLiveMappedExecutable(
  input: Readonly<{
    after: Readonly<{
      bootId: string;
      executable: Readonly<{
        dev: number;
        digest: string;
        gid: number;
        ino: number;
        mode: number;
        size: number;
        uid: number;
      }>;
      pid: number;
      startTime: string;
    }>;
    before: Readonly<{
      bootId: string;
      executable: Readonly<{
        dev: number;
        digest: string;
        gid: number;
        ino: number;
        mode: number;
        size: number;
        uid: number;
      }>;
      pid: number;
      startTime: string;
    }>;
  }>,
): boolean;

type PythonAuthority = Readonly<{
  canonical: string;
  dev: number;
  digest: string;
  gid: number;
  ino: number;
  mode: number;
  size: number;
  uid: number;
}>;

export function validatePythonAuthority(
  input: Readonly<{
    after: PythonAuthority;
    before: PythonAuthority;
    probe: string;
  }>,
): boolean;

type ToolLeaderSnapshot = Readonly<{
  bootId: string;
  pid: number;
  processGroup: number;
  startTime: string;
}>;

export function validateToolLeaderSnapshot(
  expected: ToolLeaderSnapshot,
  observed: ToolLeaderSnapshot,
): boolean;

export function classifyToolSettlement(
  input: Readonly<{
    deadline: number;
    forceAttempted: boolean;
    groupAbsent: boolean;
    now: number;
    terminalObserved: boolean;
  }>,
): "failure" | "terminal" | "wait";

export function advanceToolForceState(
  input: Readonly<{
    absenceProved: boolean;
    forceAttempted: boolean;
    forceDeadline: number;
    groupAbsent: boolean;
    now: number;
  }>,
): Readonly<{
  absenceProved: boolean;
  forceAttempted: boolean;
  reappeared: boolean;
  shouldForce: boolean;
}>;

export function rootToolHasPreparationBudget(
  deadline: number,
  now: number,
): boolean;

export function transferDescriptorAuthority<T>(
  input: Readonly<{
    close(descriptor: number): void;
    construct(descriptor: number): T;
    open(): number;
  }>,
): T;

declare const preparedGithubSystemdSupervision: unique symbol;
export type PreparedGithubSystemdSupervision = Readonly<{
  [preparedGithubSystemdSupervision]: never;
}>;

export function snapshotSystemdEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<NodeJS.ProcessEnv>;

export function sameSystemdEnvironment(
  expected: Readonly<NodeJS.ProcessEnv>,
  observed: NodeJS.ProcessEnv,
): boolean;

export function snapshotSystemdArguments(
  arguments_: readonly string[],
): readonly string[];

export function sameSystemdArguments(
  expected: readonly string[],
  observed: readonly string[],
): boolean;

export function systemdConsumptionDeadlines(
  maximumMilliseconds: number,
  now: number,
): Readonly<{ deadline: number; executionDeadline: number }>;

export function prepareGithubSystemdSupervision(input: {
  arguments_?: readonly string[];
  environment: NodeJS.ProcessEnv;
  executable: string;
  maximumMilliseconds: number;
  stdio?: "ignore" | "inherit";
}): Promise<PreparedGithubSystemdSupervision>;

export function closePreparedGithubSystemdSupervision(
  preparation: PreparedGithubSystemdSupervision,
): Promise<boolean>;

type CommonSupervisedProcessInput = Readonly<{
  arguments_?: readonly string[];
  environment: NodeJS.ProcessEnv;
  executable: string;
  maximumMilliseconds: number;
  stdio?: "ignore" | "inherit";
}>;

export function runSupervisedProcess(
  input: CommonSupervisedProcessInput &
    (
      | Readonly<{
          containment: "github-systemd";
          preparation: PreparedGithubSystemdSupervision;
        }>
      | Readonly<{ containment?: undefined; preparation?: never }>
    ),
): Promise<SupervisedProcessResult>;
