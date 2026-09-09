export type SupervisedProcessResult = Readonly<{
  code: number | null;
  contained: boolean;
  residualWorkObserved: boolean;
  signal: NodeJS.Signals | null;
}>;

export function parseSystemdTerminalExit(
  facts: Readonly<Record<string, string>>,
): number | undefined;

export function runSupervisedProcess(input: {
  arguments_?: readonly string[];
  containment?: "github-systemd";
  environment: NodeJS.ProcessEnv;
  executable: string;
  maximumMilliseconds: number;
  stdio?: "ignore" | "inherit";
}): Promise<SupervisedProcessResult>;
