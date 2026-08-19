import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  createHookEntryAuthority,
  type HookEntryAuthority,
} from "@agentscope/core/hook-orchestration";

import { parseHookLauncherDuration } from "./hook-verifier-contract.js";

export type { HookVerifierChildProgram } from "./hook-verifier-child.js";

const MAXIMUM_EVIDENCE_BYTES = 65_536;
const MAXIMUM_VERIFIER_RESPONSE_BYTES = 4_096;
declare const __AGENTSCOPE_HOOK_VERIFIER_PROGRAM__: string;
declare const __AGENTSCOPE_CLI_VERSION__: string;
declare const __AGENTSCOPE_HOOK_HARNESS_TYPES__: readonly string[];

type BootstrapAuthority = Readonly<{
  arguments: readonly string[];
  contractVersion: 1;
  deadlineStartedAt: number;
  duration: number;
  physicalPath: string;
}>;

type VerifiedLauncher = Readonly<{
  duration: number;
  harnessType: string;
  homeRoot: string;
}>;

export type HookMachineTestingInput = Readonly<{
  machineEntryPath: string;
  onEvidence: (
    value: Readonly<{
      evidence: Uint8Array;
      hookEntryAuthority: HookEntryAuthority;
      launcher: VerifiedLauncher;
    }>,
  ) => void | Promise<void>;
  releaseIdentity: string;
  stdin: Readable;
  verifierProgram?: string;
}>;

const exactAuthority = (value: unknown): BootstrapAuthority => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("cli.hook.invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = [
    "arguments",
    "contractVersion",
    "deadlineStartedAt",
    "duration",
    "physicalPath",
  ];
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    ) ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    throw new Error("cli.hook.invalid");
  const arguments_ = descriptors.arguments?.value as unknown;
  const deadlineStartedAt = descriptors.deadlineStartedAt?.value as unknown;
  const physicalPath = descriptors.physicalPath?.value as unknown;
  const duration = descriptors.duration?.value as unknown;
  if (
    descriptors.contractVersion?.value !== 1 ||
    !Array.isArray(arguments_) ||
    Object.getPrototypeOf(arguments_) !== Array.prototype ||
    arguments_.length !== 0 ||
    Reflect.ownKeys(arguments_).some((key) => key !== "length") ||
    typeof deadlineStartedAt !== "number" ||
    !Number.isFinite(deadlineStartedAt) ||
    deadlineStartedAt < 0 ||
    deadlineStartedAt > performance.now() ||
    typeof physicalPath !== "string" ||
    physicalPath.length === 0 ||
    physicalPath.length > 4_096 ||
    duration !== parseDuration(physicalPath)
  )
    throw new Error("cli.hook.invalid");
  return Object.freeze({
    arguments: Object.freeze([]),
    contractVersion: 1,
    deadlineStartedAt,
    duration,
    physicalPath,
  });
};

const parseDuration = (path: string): number => {
  const duration = parseHookLauncherDuration(path);
  if (duration === undefined) throw new Error("cli.hook.invalid");
  return duration;
};

const runVerifier = (
  authority: BootstrapAuthority,
  input: HookMachineTestingInput,
  timeoutMilliseconds: number,
): Promise<VerifiedLauncher> =>
  new Promise((resolve, reject) => {
    const program =
      input.verifierProgram ??
      (typeof __AGENTSCOPE_HOOK_VERIFIER_PROGRAM__ === "string"
        ? __AGENTSCOPE_HOOK_VERIFIER_PROGRAM__
        : undefined);
    const childModule = import.meta.url.endsWith(".ts")
      ? "./hook-verifier-child.ts"
      : "./hook-verifier-child.js";
    const arguments_ = program
      ? ["--input-type=module", "--eval", program]
      : [fileURLToPath(new URL(childModule, import.meta.url))];
    const child = spawn(process.execPath, arguments_, {
      env: {},
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    let outputSize = 0;
    let failed = false;
    let settled = false;
    const stop = (): void => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, timeoutMilliseconds);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed) {
        reject(new Error("cli.hook.invalid"));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(
          Buffer.concat(output).toString("utf8"),
        );
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          Object.getPrototypeOf(parsed) !== Object.prototype
        )
          throw new Error("cli.hook.invalid");
        const descriptors = Object.getOwnPropertyDescriptors(parsed);
        if (
          Reflect.ownKeys(descriptors).length !== 3 ||
          Object.keys(descriptors).sort().join("\0") !==
            "duration\0harnessType\0homeRoot" ||
          Object.values(descriptors).some(
            (descriptor) => !("value" in descriptor),
          )
        )
          throw new Error("cli.hook.invalid");
        const record = parsed as Record<string, unknown>;
        if (
          record.duration !== parseDuration(authority.physicalPath) ||
          typeof record.harnessType !== "string" ||
          typeof record.homeRoot !== "string"
        )
          throw new Error("cli.hook.invalid");
        resolve(
          Object.freeze({
            duration: record.duration,
            harnessType: record.harnessType,
            homeRoot: record.homeRoot,
          }),
        );
      } catch {
        reject(new Error("cli.hook.invalid"));
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = MAXIMUM_VERIFIER_RESPONSE_BYTES + 1 - outputSize;
      const retainedLength = Math.min(chunk.byteLength, Math.max(0, remaining));
      if (retainedLength > 0) output.push(chunk.subarray(0, retainedLength));
      outputSize += retainedLength;
      if (
        chunk.byteLength > remaining ||
        outputSize > MAXIMUM_VERIFIER_RESPONSE_BYTES
      )
        stop();
    });
    child.once("error", stop);
    child.once("close", (code) => {
      if (code !== 0) failed = true;
      finish();
    });
    child.stdin?.end(
      JSON.stringify({
        machineEntryPath: input.machineEntryPath,
        nodeExecutable: process.execPath,
        physicalPath: authority.physicalPath,
        releaseIdentity: input.releaseIdentity,
      }),
    );
  });

const readEvidence = (
  stream: Readable,
  timeoutMilliseconds: number,
): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value?: Uint8Array): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      if (!value) reject(new Error("cli.hook.invalid"));
      else resolve(value);
    };
    const timer = setTimeout(() => {
      stream.destroy();
      finish();
    }, timeoutMilliseconds);
    stream.on("data", (chunk: Uint8Array) => {
      const remaining = MAXIMUM_EVIDENCE_BYTES + 1 - size;
      const retainedLength = Math.min(chunk.byteLength, Math.max(0, remaining));
      if (retainedLength > 0)
        chunks.push(Buffer.from(chunk.subarray(0, retainedLength)));
      size += retainedLength;
      if (chunk.byteLength > remaining || size > MAXIMUM_EVIDENCE_BYTES) {
        stream.destroy();
        finish();
      }
    });
    stream.once("end", () => {
      finish(new Uint8Array(Buffer.concat(chunks)));
    });
    stream.once("error", () => {
      finish();
    });
  });

const run = async (
  authorityInput: unknown,
  input: HookMachineTestingInput,
): Promise<void> => {
  const authority = exactAuthority(authorityInput);
  const duration = authority.duration;
  const hookEntryAuthority = createHookEntryAuthority({
    durationMilliseconds: duration,
    startedAt: authority.deadlineStartedAt,
  });
  const remaining = (): number =>
    Math.max(
      0,
      Math.floor(duration - (performance.now() - authority.deadlineStartedAt)),
    );
  const verificationBudget = remaining();
  if (verificationBudget <= 0) throw new Error("cli.hook.invalid");
  const launcher = await runVerifier(authority, input, verificationBudget);
  const evidenceBudget = remaining();
  if (evidenceBudget <= 0) throw new Error("cli.hook.invalid");
  const evidence = await readEvidence(input.stdin, evidenceBudget);
  if (remaining() <= 0) throw new Error("cli.hook.invalid");
  await input.onEvidence(
    Object.freeze({ evidence, hookEntryAuthority, launcher }),
  );
};

/* v8 ignore start -- production-only packed entry; verify-artifact executes the
   generated launcher and bundled machine rather than importing source. */
export const runOwnedHookBootstrap = async (
  authority: unknown,
): Promise<void> => {
  try {
    await run(authority, {
      machineEntryPath: fileURLToPath(import.meta.url),
      onEvidence: ({ launcher }) => {
        if (!__AGENTSCOPE_HOOK_HARNESS_TYPES__.includes(launcher.harnessType))
          throw new Error("cli.hook.invalid");
      },
      releaseIdentity: __AGENTSCOPE_CLI_VERSION__,
      stdin: process.stdin,
    });
  } catch {
    // The internal machine hook is deliberately silent and fail-open.
  }
};
/* v8 ignore stop */

export const runOwnedHookBootstrapForTesting = (
  authority: unknown,
  input: HookMachineTestingInput,
): Promise<void> =>
  run(authority, input).catch(() => {
    throw new Error("cli.hook.invalid");
  });
