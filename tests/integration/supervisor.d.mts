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

export function transferDescriptorAuthority<T>(
  input: Readonly<{
    close(descriptor: number): void;
    construct(descriptor: number): T;
    open(): number;
  }>,
): T;

export function runSupervisedProcess(input: {
  arguments_?: readonly string[];
  containment?: "github-systemd";
  environment: NodeJS.ProcessEnv;
  executable: string;
  maximumMilliseconds: number;
  stdio?: "ignore" | "inherit";
}): Promise<SupervisedProcessResult>;
