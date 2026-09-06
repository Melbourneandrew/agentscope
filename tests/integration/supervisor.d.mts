export type SupervisedProcessResult = Readonly<{
  code: number | null;
  contained: boolean;
  signal: NodeJS.Signals | null;
}>;

export function runSupervisedProcess(input: {
  arguments_?: readonly string[];
  environment: NodeJS.ProcessEnv;
  executable: string;
  maximumMilliseconds: number;
  stdio?: "ignore" | "inherit";
}): Promise<SupervisedProcessResult>;
