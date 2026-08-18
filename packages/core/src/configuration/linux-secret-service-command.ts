export const LINUX_SECRET_TOOL_EXECUTABLE = "/usr/bin/secret-tool" as const;

export type LinuxSecretServiceOperation = "store" | "lookup" | "clear";
export type LinuxSecretServiceCommand = Readonly<{
  executable: typeof LINUX_SECRET_TOOL_EXECUTABLE;
  operation: LinuxSecretServiceOperation;
  arguments: readonly string[];
  stdin?: string;
  signal: AbortSignal;
}>;
export type LinuxSecretServiceCommandResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
}>;
export type LinuxSecretServiceCommandExecutor = (
  command: LinuxSecretServiceCommand,
) => Promise<LinuxSecretServiceCommandResult>;
