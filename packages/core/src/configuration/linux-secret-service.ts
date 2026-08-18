import {
  defineStoredCredentialBackendAdapter,
  deriveStoredCredentialReference,
  type CredentialBackendAdapter,
  type CredentialResolutionFailure,
  type StoredCredentialBackendImplementation,
} from "./credential-adapter.js";
import {
  LINUX_SECRET_TOOL_EXECUTABLE,
  type LinuxSecretServiceCommand,
  type LinuxSecretServiceCommandExecutor,
  type LinuxSecretServiceCommandResult,
  type LinuxSecretServiceOperation,
} from "./linux-secret-service-command.js";
import { createLinuxSecretServiceCommandExecutor } from "./linux-secret-service-executor.js";
import type { ConfigurationCredentialReference } from "./schema.js";

const SERVICE = "dev.agentscope.credentials.v1";
const MAXIMUM_OUTPUT_BYTES = 16_384;
const referencePrefix = "credential-reference-v1-";

export type {
  LinuxSecretServiceCommand,
  LinuxSecretServiceCommandExecutor,
  LinuxSecretServiceCommandResult,
} from "./linux-secret-service-command.js";

export class LinuxSecretServiceError extends Error {
  public readonly code = "core.credential.linux-secret-service-invalid";

  public constructor() {
    super("core.credential.linux-secret-service-invalid");
    this.name = "LinuxSecretServiceError";
  }
}

const invalid = (): never => {
  throw new LinuxSecretServiceError();
};

const fixedFailure = (exitCode: number): CredentialResolutionFailure => {
  if (exitCode === 44) return "missing";
  if (exitCode === 51) return "locked";
  if (exitCode === 36) return "denied";
  return "unavailable";
};

const parseResult = (value: unknown): LinuxSecretServiceCommandResult => {
  if (typeof value !== "object" || value === null) return invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !== "exitCode,stdout" ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const exitCode: unknown = descriptors.exitCode?.value;
  const stdout: unknown = descriptors.stdout?.value;
  if (
    !Number.isInteger(exitCode) ||
    (exitCode as number) < 0 ||
    (exitCode as number) > 255 ||
    !(stdout instanceof Uint8Array) ||
    stdout.byteLength > MAXIMUM_OUTPUT_BYTES
  )
    return invalid();
  return Object.freeze({
    exitCode: exitCode as number,
    stdout: Uint8Array.from(stdout),
  });
};

const run = async (
  execute: LinuxSecretServiceCommandExecutor,
  command: LinuxSecretServiceCommand,
): Promise<LinuxSecretServiceCommandResult | undefined> => {
  if (command.signal.aborted) return undefined;
  try {
    return parseResult(await execute(command));
  } catch {
    return undefined;
  }
};

const command = (
  operation: LinuxSecretServiceOperation,
  arguments_: readonly string[],
  signal: AbortSignal,
  stdin?: string,
): LinuxSecretServiceCommand =>
  Object.freeze({
    executable: LINUX_SECRET_TOOL_EXECUTABLE,
    operation,
    arguments: Object.freeze([operation, ...arguments_]),
    ...(stdin === undefined ? {} : { stdin }),
    signal,
  });

const exactStoredReference = (
  reference: ConfigurationCredentialReference,
): reference is ConfigurationCredentialReference & {
  backend: "linux-secret-service";
  referenceId: string;
} =>
  reference.backend === "linux-secret-service" &&
  reference.referenceId.startsWith(referencePrefix);

const attributes = (referenceId: string): readonly string[] =>
  Object.freeze([
    "service",
    SERVICE,
    "reference",
    referenceId.slice(referencePrefix.length),
  ]);

const createImplementation = (
  execute: LinuxSecretServiceCommandExecutor,
  sessionAvailable: boolean,
): StoredCredentialBackendImplementation => {
  const invoke = async (
    operation: LinuxSecretServiceOperation,
    reference: ConfigurationCredentialReference,
    signal: AbortSignal,
  ): Promise<LinuxSecretServiceCommandResult | undefined> => {
    if (!sessionAvailable || !exactStoredReference(reference)) return undefined;
    return run(
      execute,
      command(operation, attributes(reference.referenceId), signal),
    );
  };
  return {
    createPending: async ({ ownership, generationId, secret, signal }) => {
      if (!sessionAvailable)
        return Object.freeze({
          ok: false as const,
          code: "unavailable" as const,
        });
      if (secret.includes("\n") || secret.includes("\r"))
        return Object.freeze({
          ok: false as const,
          code: "malformed" as const,
        });
      const referenceId = deriveStoredCredentialReference(
        "linux-secret-service",
        ownership,
        generationId,
      ).referenceId;
      const result = await run(
        execute,
        command(
          "store",
          [
            `--label=Agentscope ${referenceId.slice(-12)}`,
            ...attributes(referenceId),
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
        return Object.freeze({
          ok: false as const,
          code: "malformed" as const,
        });
      const result = await invoke("lookup", reference, context.signal);
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
      try {
        let secret = new TextDecoder("utf-8", { fatal: true }).decode(
          result.stdout,
        );
        if (secret.endsWith("\n")) secret = secret.slice(0, -1);
        return secret.length > 0
          ? Object.freeze({ ok: true as const, secret })
          : Object.freeze({ ok: false as const, code: "malformed" as const });
      } catch {
        return Object.freeze({
          ok: false as const,
          code: "malformed" as const,
        });
      }
    },
    activate: async ({ reference, signal }) =>
      (await invoke("lookup", reference, signal))?.exitCode === 0,
    removePending: async ({ reference, signal }) => {
      const result = await invoke("clear", reference, signal);
      return result?.exitCode === 0 || result?.exitCode === 44;
    },
    removeOwned: async ({ ownership, reference, signal }) => {
      if (
        !exactStoredReference(reference) ||
        deriveStoredCredentialReference(
          "linux-secret-service",
          ownership,
          reference.generationId,
        ).referenceId !== reference.referenceId
      )
        return false;
      const result = await invoke("clear", reference, signal);
      return result?.exitCode === 0 || result?.exitCode === 44;
    },
  };
};

export const linuxSecretServiceSessionIsAvailableForTesting = (
  environment: object,
): boolean => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      environment,
      "DBUS_SESSION_BUS_ADDRESS",
    );
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string" &&
      descriptor.value.length > 0 &&
      descriptor.value.length <= 4_096
    );
  } catch {
    return false;
  }
};

export const createLinuxSecretServiceAdapterForTesting = (input: {
  platform?: NodeJS.Platform;
  sessionAvailable: boolean;
  execute: LinuxSecretServiceCommandExecutor;
}): CredentialBackendAdapter => {
  if (
    typeof input !== "object" ||
    input === null ||
    (input.platform ?? process.platform) !== "linux" ||
    typeof input.sessionAvailable !== "boolean" ||
    typeof input.execute !== "function"
  )
    return invalid();
  return defineStoredCredentialBackendAdapter(
    "linux-secret-service",
    createImplementation(input.execute, input.sessionAvailable),
  );
};

export const createLinuxSecretServiceAdapter = (): CredentialBackendAdapter =>
  createLinuxSecretServiceAdapterForTesting({
    platform: process.platform,
    sessionAvailable: linuxSecretServiceSessionIsAvailableForTesting(
      process.env,
    ),
    execute: createLinuxSecretServiceCommandExecutor(),
  });
