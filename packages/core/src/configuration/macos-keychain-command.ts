export const MACOS_SECURITY_EXECUTABLE = "/usr/bin/security" as const;

export type MacosKeychainCommand = Readonly<{
  executable: typeof MACOS_SECURITY_EXECUTABLE;
  arguments: readonly string[];
  stdin?: string;
  signal: AbortSignal;
}>;

export type MacosKeychainCommandResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

export type MacosKeychainCommandExecutor = (
  command: MacosKeychainCommand,
) => Promise<MacosKeychainCommandResult>;
