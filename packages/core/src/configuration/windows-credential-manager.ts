import { Buffer } from "node:buffer";

import {
  defineStoredCredentialBackendAdapter,
  deriveStoredCredentialReference,
  type CredentialBackendAdapter,
  type CredentialResolutionFailure,
  type StoredCredentialBackendImplementation,
} from "./credential-adapter.js";
import type { ConfigurationCredentialReference } from "./schema.js";
import {
  WINDOWS_POWERSHELL_EXECUTABLE,
  type WindowsCredentialCommand,
  type WindowsCredentialCommandExecutor,
  type WindowsCredentialCommandResult,
} from "./windows-credential-command.js";
import { createWindowsCredentialCommandExecutor } from "./windows-credential-executor.js";
import { WINDOWS_CREDENTIAL_MANAGER_ARGUMENTS } from "./windows-credential-script.js";

const MAXIMUM_OUTPUT_BYTES = 16_384;
const MAXIMUM_CREDENTIAL_BYTES = 2_560;
const referencePrefix = "credential-reference-v1-";
const targetPrefix = "dev.agentscope.credentials.v1:";
const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type {
  WindowsCredentialCommand,
  WindowsCredentialCommandExecutor,
  WindowsCredentialCommandResult,
} from "./windows-credential-command.js";

export class WindowsCredentialManagerError extends Error {
  public readonly code = "core.credential.windows-manager-invalid";

  public constructor() {
    super("core.credential.windows-manager-invalid");
    this.name = "WindowsCredentialManagerError";
  }
}

const invalid = (): never => {
  throw new WindowsCredentialManagerError();
};

const targetFor = (referenceId: string): string =>
  `${targetPrefix}${referenceId.slice(referencePrefix.length)}`;

const parseCommandResult = (value: unknown): WindowsCredentialCommandResult => {
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
  execute: WindowsCredentialCommandExecutor,
  command: WindowsCredentialCommand,
): Promise<WindowsCredentialCommandResult | undefined> => {
  if (command.signal.aborted) return undefined;
  try {
    return parseCommandResult(await execute(command));
  } catch {
    return undefined;
  }
};

const command = (
  request: Readonly<Record<string, string>>,
  signal: AbortSignal,
): WindowsCredentialCommand =>
  Object.freeze({
    executable: WINDOWS_POWERSHELL_EXECUTABLE,
    arguments: WINDOWS_CREDENTIAL_MANAGER_ARGUMENTS,
    stdin: JSON.stringify(request),
    signal,
  });

type ManagerResponse =
  | Readonly<{ ok: true; secret?: string }>
  | Readonly<{ ok: false; code: CredentialResolutionFailure }>;

const parseResponse = (
  result: WindowsCredentialCommandResult | undefined,
): ManagerResponse => {
  if (!result || result.exitCode !== 0)
    return Object.freeze({ ok: false, code: "unavailable" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
    );
  } catch {
    return Object.freeze({ ok: false, code: "malformed" });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return Object.freeze({ ok: false, code: "malformed" });
  const data = parsed as Record<string, unknown>;
  const keys = Object.keys(data).sort().join(",");
  if (keys === "ok" && data.ok === true) return Object.freeze({ ok: true });
  if (
    keys === "code,ok" &&
    data.ok === false &&
    ["unavailable", "locked", "denied", "missing", "malformed"].includes(
      data.code as string,
    )
  )
    return Object.freeze({
      ok: false,
      code: data.code as CredentialResolutionFailure,
    });
  if (
    keys === "ok,secretBase64" &&
    data.ok === true &&
    typeof data.secretBase64 === "string" &&
    data.secretBase64.length <= 3_416 &&
    base64Pattern.test(data.secretBase64)
  ) {
    const bytes = Buffer.from(data.secretBase64, "base64");
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAXIMUM_CREDENTIAL_BYTES ||
      bytes.toString("base64") !== data.secretBase64
    )
      return Object.freeze({ ok: false, code: "malformed" });
    try {
      return Object.freeze({
        ok: true,
        secret: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      });
    } catch {
      return Object.freeze({ ok: false, code: "malformed" });
    }
  }
  return Object.freeze({ ok: false, code: "malformed" });
};

const exactStoredReference = (
  reference: ConfigurationCredentialReference,
): reference is ConfigurationCredentialReference & {
  backend: "windows-credential-manager";
  referenceId: string;
} =>
  reference.backend === "windows-credential-manager" &&
  reference.referenceId.startsWith(referencePrefix);

const request = async (
  execute: WindowsCredentialCommandExecutor,
  operation: "read" | "exists" | "delete",
  reference: ConfigurationCredentialReference,
  signal: AbortSignal,
): Promise<ManagerResponse> => {
  if (!exactStoredReference(reference))
    return Object.freeze({ ok: false, code: "malformed" });
  return parseResponse(
    await run(
      execute,
      command({ operation, target: targetFor(reference.referenceId) }, signal),
    ),
  );
};

const createImplementation = (
  execute: WindowsCredentialCommandExecutor,
): StoredCredentialBackendImplementation => ({
  createPending: async ({ ownership, generationId, secret, signal }) => {
    const secretBytes = new TextEncoder().encode(secret);
    if (secretBytes.byteLength > MAXIMUM_CREDENTIAL_BYTES)
      return Object.freeze({ ok: false as const, code: "malformed" as const });
    const referenceId = deriveStoredCredentialReference(
      "windows-credential-manager",
      ownership,
      generationId,
    ).referenceId;
    const response = parseResponse(
      await run(
        execute,
        command(
          {
            operation: "write",
            target: targetFor(referenceId),
            secretBase64: Buffer.from(secretBytes).toString("base64"),
          },
          signal,
        ),
      ),
    );
    return response.ok
      ? Object.freeze({ ok: true as const, referenceId })
      : response;
  },
  resolve: async ({ reference, context }) => {
    const response = await request(execute, "read", reference, context.signal);
    return response.ok && response.secret !== undefined
      ? Object.freeze({ ok: true as const, secret: response.secret })
      : response.ok
        ? Object.freeze({ ok: false as const, code: "malformed" as const })
        : response;
  },
  activate: async ({ reference, signal }) =>
    (await request(execute, "exists", reference, signal)).ok,
  removePending: async ({ reference, signal }) => {
    const response = await request(execute, "delete", reference, signal);
    return response.ok || response.code === "missing";
  },
  removeOwned: async ({ ownership, reference, signal }) => {
    if (
      !exactStoredReference(reference) ||
      deriveStoredCredentialReference(
        "windows-credential-manager",
        ownership,
        reference.generationId,
      ).referenceId !== reference.referenceId
    )
      return false;
    const response = await request(execute, "delete", reference, signal);
    return response.ok || response.code === "missing";
  },
});

export const createWindowsCredentialManagerAdapterForTesting = (input: {
  platform?: NodeJS.Platform;
  execute: WindowsCredentialCommandExecutor;
}): CredentialBackendAdapter => {
  if (
    typeof input !== "object" ||
    input === null ||
    (input.platform ?? process.platform) !== "win32" ||
    typeof input.execute !== "function"
  )
    return invalid();
  return defineStoredCredentialBackendAdapter(
    "windows-credential-manager",
    createImplementation(input.execute),
  );
};

export const createWindowsCredentialManagerAdapter =
  (): CredentialBackendAdapter =>
    createWindowsCredentialManagerAdapterForTesting({
      platform: process.platform,
      execute: createWindowsCredentialCommandExecutor(),
    });
