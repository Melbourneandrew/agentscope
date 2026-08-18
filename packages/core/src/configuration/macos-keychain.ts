import {
  defineStoredCredentialBackendAdapter,
  deriveStoredCredentialReference,
  type CredentialBackendAdapter,
  type CredentialResolutionFailure,
  type StoredCredentialBackendImplementation,
} from "./credential-adapter.js";
import type { ConfigurationCredentialReference } from "./schema.js";
import {
  MACOS_SECURITY_EXECUTABLE,
  type MacosKeychainCommand,
  type MacosKeychainCommandExecutor,
  type MacosKeychainCommandResult,
} from "./macos-keychain-command.js";
import { createMacosSecurityCommandExecutor } from "./macos-keychain-executor.js";

const SERVICE = "dev.agentscope.credentials.v1";
const MAXIMUM_OUTPUT_BYTES = 16_384;
const referencePrefix = "credential-reference-v1-";

export type {
  MacosKeychainCommand,
  MacosKeychainCommandExecutor,
  MacosKeychainCommandResult,
} from "./macos-keychain-command.js";

export class MacosKeychainAdapterError extends Error {
  public readonly code = "core.credential.macos-keychain-invalid";

  public constructor() {
    super("core.credential.macos-keychain-invalid");
    this.name = "MacosKeychainAdapterError";
  }
}

const invalid = (): never => {
  throw new MacosKeychainAdapterError();
};

const accountFor = (referenceId: string): string =>
  `agentscope:v1:${referenceId.slice(referencePrefix.length)}`;

const fixedFailure = (exitCode: number): CredentialResolutionFailure => {
  if (exitCode === 44) return "missing";
  if (exitCode === 51) return "locked";
  if (exitCode === 36) return "denied";
  return "unavailable";
};

const parseResult = (value: unknown): MacosKeychainCommandResult => {
  if (typeof value !== "object" || value === null) return invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !== "exitCode,stderr,stdout" ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const exitCode: unknown = descriptors.exitCode?.value;
  const stdout: unknown = descriptors.stdout?.value;
  const stderr: unknown = descriptors.stderr?.value;
  if (
    !Number.isInteger(exitCode) ||
    (exitCode as number) < 0 ||
    (exitCode as number) > 255 ||
    !(stdout instanceof Uint8Array) ||
    !(stderr instanceof Uint8Array) ||
    stdout.byteLength > MAXIMUM_OUTPUT_BYTES ||
    stderr.byteLength > MAXIMUM_OUTPUT_BYTES
  )
    return invalid();
  return Object.freeze({
    exitCode: exitCode as number,
    stdout: Uint8Array.from(stdout),
    stderr: Uint8Array.from(stderr),
  });
};

const run = async (
  execute: MacosKeychainCommandExecutor,
  command: MacosKeychainCommand,
): Promise<MacosKeychainCommandResult | undefined> => {
  if (command.signal.aborted) return undefined;
  try {
    return parseResult(await execute(command));
  } catch {
    return undefined;
  }
};

const keychainCommand = (
  arguments_: readonly string[],
  signal: AbortSignal,
  stdin?: string,
): MacosKeychainCommand =>
  Object.freeze({
    executable: MACOS_SECURITY_EXECUTABLE,
    arguments: Object.freeze([...arguments_]),
    ...(stdin === undefined ? {} : { stdin }),
    signal,
  });

const exactStoredReference = (
  reference: ConfigurationCredentialReference,
): reference is ConfigurationCredentialReference & {
  backend: "macos-keychain";
  referenceId: string;
} =>
  reference.backend === "macos-keychain" &&
  reference.referenceId.startsWith(referencePrefix);

const deleteReference = async (
  execute: MacosKeychainCommandExecutor,
  reference: ConfigurationCredentialReference,
  signal: AbortSignal,
): Promise<boolean> => {
  if (!exactStoredReference(reference)) return false;
  const result = await run(
    execute,
    keychainCommand(
      [
        "delete-generic-password",
        "-a",
        accountFor(reference.referenceId),
        "-s",
        SERVICE,
      ],
      signal,
    ),
  );
  return result?.exitCode === 0 || result?.exitCode === 44;
};

const createImplementation = (
  execute: MacosKeychainCommandExecutor,
): StoredCredentialBackendImplementation => ({
  createPending: async ({ ownership, generationId, secret, signal }) => {
    if (secret.includes("\n") || secret.includes("\r"))
      return Object.freeze({ ok: false as const, code: "malformed" as const });
    const referenceId = deriveStoredCredentialReference(
      "macos-keychain",
      ownership,
      generationId,
    ).referenceId;
    const result = await run(
      execute,
      keychainCommand(
        [
          "add-generic-password",
          "-a",
          accountFor(referenceId),
          "-s",
          SERVICE,
          "-D",
          "Agentscope credential",
          "-l",
          `Agentscope ${referenceId.slice(-12)}`,
          "-w",
        ],
        signal,
        `${secret}\n`,
      ),
    );
    return result?.exitCode === 0
      ? Object.freeze({ ok: true as const, referenceId })
      : Object.freeze({
          ok: false as const,
          code: result ? fixedFailure(result.exitCode) : "unavailable",
        });
  },
  resolve: async ({ reference, context }) => {
    if (!exactStoredReference(reference))
      return Object.freeze({ ok: false as const, code: "malformed" as const });
    const result = await run(
      execute,
      keychainCommand(
        [
          "find-generic-password",
          "-a",
          accountFor(reference.referenceId),
          "-s",
          SERVICE,
          "-w",
        ],
        context.signal,
      ),
    );
    if (!result)
      return Object.freeze({
        ok: false as const,
        code: "unavailable" as const,
      });
    if (result.exitCode !== 0)
      return Object.freeze({
        ok: false as const,
        code: fixedFailure(result.exitCode),
      });
    let secret: string;
    try {
      secret = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    } catch {
      return Object.freeze({ ok: false as const, code: "malformed" as const });
    }
    if (secret.endsWith("\n")) secret = secret.slice(0, -1);
    return Object.freeze({ ok: true as const, secret });
  },
  activate: async ({ reference, signal }) => {
    if (!exactStoredReference(reference)) return false;
    const result = await run(
      execute,
      keychainCommand(
        [
          "find-generic-password",
          "-a",
          accountFor(reference.referenceId),
          "-s",
          SERVICE,
        ],
        signal,
      ),
    );
    return result?.exitCode === 0;
  },
  removePending: async ({ reference, signal }) => {
    return deleteReference(execute, reference, signal);
  },
  removeOwned: async ({ ownership, reference, signal }) => {
    if (
      !exactStoredReference(reference) ||
      deriveStoredCredentialReference(
        "macos-keychain",
        ownership,
        reference.generationId,
      ).referenceId !== reference.referenceId
    )
      return false;
    return deleteReference(execute, reference, signal);
  },
});

export const createMacosKeychainCredentialAdapterForTesting = (input: {
  platform?: NodeJS.Platform;
  execute: MacosKeychainCommandExecutor;
}): CredentialBackendAdapter => {
  if (
    typeof input !== "object" ||
    input === null ||
    (input.platform ?? process.platform) !== "darwin" ||
    typeof input.execute !== "function"
  )
    return invalid();
  return defineStoredCredentialBackendAdapter(
    "macos-keychain",
    createImplementation(input.execute),
  );
};

export const createMacosKeychainCredentialAdapter =
  (): CredentialBackendAdapter =>
    createMacosKeychainCredentialAdapterForTesting({
      platform: process.platform,
      execute: createMacosSecurityCommandExecutor(),
    });
