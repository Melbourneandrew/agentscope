export type SupervisedProcessResult = Readonly<{
  code: number | null;
  contained: boolean;
  residualWorkObserved: boolean;
  signal: NodeJS.Signals | null;
}>;

export function parseSystemdTerminalExit(
  facts: Readonly<Record<string, string>>,
): number | undefined;

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

export function systemdToolFailureStage(
  error: unknown,
): SystemdToolFailureStage | undefined;

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
