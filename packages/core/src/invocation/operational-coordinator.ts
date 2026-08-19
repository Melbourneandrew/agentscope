import { spawn, type StdioOptions } from "node:child_process";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { AgentscopeHome } from "../configuration/home.js";
import type {} from "./operational-coordinator-child.js";
import {
  inspectOperationalStateForHookForCore,
  operationalStateStoreUsesNativeFileSystemForCore,
  parseHookOperationalEvidenceWriteResultForCore,
  parseOperationalStateSnapshotForCore,
  recordHookOperationalEvidence,
  type HookOperationalEvidenceInput,
  type HookOperationalEvidenceWriteResult,
  type OperationalStateSnapshot,
  type OperationalStateStore,
} from "../configuration/operational-state.js";

const MAXIMUM_REQUEST_BYTES = 524_288;
const MAXIMUM_RESPONSE_BYTES = 524_288;
const COORDINATOR_REQUEST_FD_ENVIRONMENT =
  "AGENTSCOPE_OPERATIONAL_COORDINATOR_REQUEST_FD";
declare const __AGENTSCOPE_OPERATIONAL_COORDINATOR_PROGRAM__: string;
let bundledCoordinatorProgram: string | undefined;
/* v8 ignore next -- the release build defines and executes this branch in the
 * strict bundled-artifact verifier; source tests retain the sibling fallback. */
if (typeof __AGENTSCOPE_OPERATIONAL_COORDINATOR_PROGRAM__ === "string")
  bundledCoordinatorProgram = __AGENTSCOPE_OPERATIONAL_COORDINATOR_PROGRAM__;

type CoordinatorRequest =
  | Readonly<{
      kind: "preload";
      homeRoot: string;
      platform: NodeJS.Platform;
    }>
  | Readonly<{
      kind: "commit";
      homeRoot: string;
      platform: NodeJS.Platform;
      evidence: HookOperationalEvidenceInput;
    }>;

export type OperationalCoordinatorPreloadResult =
  | Readonly<{ ok: true; snapshot: OperationalStateSnapshot }>
  | Readonly<{ ok: false }>;

export type OperationalCoordinatorCommitResult =
  | Readonly<{ ok: true; result: HookOperationalEvidenceWriteResult }>
  | Readonly<{ ok: false }>;

type ChildOptions = Readonly<{
  executable?: string;
  program?: string;
  onSpawn?: (processId: number | undefined) => void;
}>;

const signalIsAborted = (signal: AbortSignal | undefined): boolean => {
  try {
    return signal?.aborted === true;
  } catch {
    return true;
  }
};

const parseResponse = (
  output: string,
  kind: CoordinatorRequest["kind"],
): OperationalStateSnapshot | HookOperationalEvidenceWriteResult => {
  const parsed: unknown = JSON.parse(output);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("core.operational-coordinator.unavailable");
  const descriptors = Object.getOwnPropertyDescriptors(parsed);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join("\0") !== "kind\0value" ||
    Object.values(descriptors).some((entry) => !("value" in entry)) ||
    descriptors.kind!.value !== kind
  )
    throw new Error("core.operational-coordinator.unavailable");
  return kind === "preload"
    ? parseOperationalStateSnapshotForCore(descriptors.value!.value)
    : parseHookOperationalEvidenceWriteResultForCore(descriptors.value!.value);
};

const runChild = (
  request: CoordinatorRequest,
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
  options: ChildOptions,
): Promise<OperationalStateSnapshot | HookOperationalEvidenceWriteResult> => {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    signalIsAborted(signal)
  )
    return Promise.reject(
      new Error("core.operational-coordinator.unavailable"),
    );
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > MAXIMUM_REQUEST_BYTES)
    return Promise.reject(
      new Error("core.operational-coordinator.unavailable"),
    );
  return new Promise((resolve, reject) => {
    /* v8 ignore next -- the injected-program fallback is executed by the
     * strict single-file bundle verifier. */
    const program = options.program ?? bundledCoordinatorProgram;
    /* v8 ignore next -- exact injected-program selection is exercised by the
     * strict single-file bundle verifier. */
    const injectedProgram =
      options.program === undefined && bundledCoordinatorProgram !== undefined;
    let arguments_: string[];
    /* v8 ignore next -- the sibling branch is exercised by the strict direct
     * dist verifier while source coverage supplies explicit programs. */
    if (injectedProgram) arguments_ = ["--input-type=module", "-"];
    else if (program) arguments_ = ["--input-type=module", "--eval", program];
    else
      arguments_ = [
        fileURLToPath(
          new URL("./operational-coordinator-child.js", import.meta.url),
        ),
      ];
    /* v8 ignore next -- the injected descriptor is exercised by the strict
     * single-file bundle verifier. */
    const requestFileDescriptor = injectedProgram ? "3" : "";
    /* v8 ignore next -- the injected extra pipe is exercised by that same
     * strict verifier. */
    const childStdio: StdioOptions = injectedProgram
      ? ["pipe", "pipe", "ignore", "pipe"]
      : ["pipe", "pipe", "ignore"];
    const child = spawn(options.executable ?? process.execPath, arguments_, {
      env: {
        ...process.env,
        [COORDINATOR_REQUEST_FD_ENVIRONMENT]: requestFileDescriptor,
      },
      stdio: childStdio,
      windowsHide: true,
    });
    const childInput = child.stdin;
    const childOutput = child.stdout;
    /* v8 ignore next 5 -- the exact pipe stdio descriptor makes both streams
     * non-null on every supported Node runtime; keep a fixed host fallback. */
    if (!childInput || !childOutput) {
      child.kill("SIGKILL");
      reject(new Error("core.operational-coordinator.unavailable"));
      return;
    }
    options.onSpawn?.(child.pid);
    let output = "";
    let failed = false;
    let settled = false;
    const stop = (): void => {
      failed = true;
      try {
        child.kill("SIGKILL");
        /* v8 ignore next 3 -- the close/error boundary owns the fixed result
         * if a supported host runtime ever throws from child.kill. */
      } catch {
        // Fixed failure is returned only after close/error joins the child.
      }
    };
    const abort = (): void => {
      stop();
    };
    const timer = setTimeout(stop, timeoutMilliseconds);
    const finish = (error?: unknown): void => {
      /* v8 ignore next -- Node owns one terminal error/close sequence; this
       * guard contains a defensive duplicate host callback. */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        signal?.removeEventListener("abort", abort);
      } catch {
        failed = true;
      }
      if (failed || error) {
        reject(new Error("core.operational-coordinator.unavailable"));
        return;
      }
      try {
        resolve(parseResponse(output, request.kind));
      } catch {
        reject(new Error("core.operational-coordinator.unavailable"));
      }
    };
    childOutput.setEncoding("utf8");
    childOutput.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAXIMUM_RESPONSE_BYTES) stop();
    });
    child.once("error", finish);
    child.once("close", (code) => {
      if (code !== 0) failed = true;
      finish();
    });
    /* v8 ignore next -- the injected request pipe is exercised by the strict
     * single-file bundle verifier. */
    const requestInput = (
      injectedProgram ? child.stdio[3] : childInput
    ) as Writable | null;
    childInput.once("error", stop);
    requestInput?.once("error", stop);
    try {
      signal?.addEventListener("abort", abort, { once: true });
      /* v8 ignore next -- closes the exact add-listener/abort race. */
      if (signalIsAborted(signal)) stop();
      /* v8 ignore next -- the strict bundle verifier supplies this program. */
      if (injectedProgram) childInput.end(program);
      requestInput?.end(payload);
      /* v8 ignore next 2 -- native pipe failures settle through error/close;
       * synchronous host throws are retained as defense in depth. */
    } catch {
      /* v8 ignore next -- see native pipe defense above. */
      stop();
    }
  });
};

const directPreload = async (
  store: OperationalStateStore,
): Promise<OperationalStateSnapshot> =>
  inspectOperationalStateForHookForCore(store);

const directCommit = async (
  store: OperationalStateStore,
  evidence: HookOperationalEvidenceInput,
): Promise<HookOperationalEvidenceWriteResult> =>
  recordHookOperationalEvidence(store, evidence);

const useSourceFallback = import.meta.url.endsWith(".ts");

export const preloadOperationalStateForCore = async (
  home: AgentscopeHome,
  store: OperationalStateStore,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<OperationalCoordinatorPreloadResult> => {
  try {
    if (
      useSourceFallback &&
      !operationalStateStoreUsesNativeFileSystemForCore(store)
    )
      throw new Error("core.operational-coordinator.unavailable");
    /* v8 ignore else -- the strict built-artifact verifier executes the real
     * child branch while source coverage exercises the direct semantic seam. */
    if (useSourceFallback)
      return Object.freeze({ ok: true, snapshot: await directPreload(store) });
    /* v8 ignore start -- executed by the strict built-artifact verifier. */
    const snapshot = (await runChild(
      Object.freeze({
        kind: "preload",
        homeRoot: home.root,
        platform: home.platform,
      }),
      timeoutMilliseconds,
      signal,
      {},
    )) as OperationalStateSnapshot;
    return Object.freeze({ ok: true, snapshot });
    /* v8 ignore stop */
  } catch {
    return Object.freeze({ ok: false });
  }
};

export const commitOperationalEvidenceForCore = async (
  home: AgentscopeHome,
  store: OperationalStateStore,
  evidence: HookOperationalEvidenceInput,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<OperationalCoordinatorCommitResult> => {
  try {
    if (
      useSourceFallback &&
      !operationalStateStoreUsesNativeFileSystemForCore(store)
    )
      throw new Error("core.operational-coordinator.unavailable");
    /* v8 ignore else -- the strict built-artifact verifier executes the real
     * child branch while source coverage exercises the direct semantic seam. */
    if (useSourceFallback)
      return Object.freeze({
        ok: true,
        result: await directCommit(store, evidence),
      });
    /* v8 ignore start -- executed by the strict built-artifact verifier. */
    const result = (await runChild(
      Object.freeze({
        kind: "commit",
        homeRoot: home.root,
        platform: home.platform,
        evidence,
      }),
      timeoutMilliseconds,
      signal,
      {},
    )) as HookOperationalEvidenceWriteResult;
    return Object.freeze({ ok: true, result });
    /* v8 ignore stop */
  } catch {
    return Object.freeze({ ok: false });
  }
};

export const runOperationalCoordinatorForTesting = (
  request: CoordinatorRequest,
  timeoutMilliseconds: number,
  options: ChildOptions,
  signal?: AbortSignal,
): Promise<OperationalStateSnapshot | HookOperationalEvidenceWriteResult> =>
  runChild(request, timeoutMilliseconds, signal, options);
