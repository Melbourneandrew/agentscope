export const WINDOWS_POWERSHELL_EXECUTABLE =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" as const;

export type WindowsCredentialCommand = Readonly<{
  executable: typeof WINDOWS_POWERSHELL_EXECUTABLE;
  arguments: readonly string[];
  stdin: string;
  signal: AbortSignal;
}>;

export type WindowsCredentialCommandResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

export type WindowsCredentialCommandExecutor = (
  command: WindowsCredentialCommand,
) => Promise<WindowsCredentialCommandResult>;
