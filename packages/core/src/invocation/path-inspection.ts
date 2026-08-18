import { spawn } from "node:child_process";

const MAXIMUM_REQUEST_BYTES = 65_536;
const MAXIMUM_RESPONSE_BYTES = 32_768;

const childSource = String.raw`
import { realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

const fail = () => process.exit(1);
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > ${MAXIMUM_REQUEST_BYTES}) fail();
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  let response;
  if (request.kind === "workspace" && Array.isArray(request.paths)) {
    response = null;
    for (let index = 0; index < request.paths.length; index += 1) {
      try {
        const path = realpathSync(request.paths[index]);
        if (statSync(path).isDirectory()) {
          response = { kind: "workspace", index, path };
          break;
        }
      } catch {}
    }
  } else if (
    request.kind === "canonicalize" &&
    typeof request.worktree === "string" &&
    typeof request.commonDirectory === "string"
  ) {
    response = {
      kind: "canonicalize",
      worktree: realpathSync(request.worktree),
      repositoryRoot: realpathSync(dirname(request.commonDirectory)),
    };
  } else {
    fail();
  }
  process.stdout.write(JSON.stringify(response));
} catch {
  fail();
}
`;

export type PathInspectionRequest =
  | Readonly<{ kind: "workspace"; paths: readonly string[] }>
  | Readonly<{
      kind: "canonicalize";
      worktree: string;
      commonDirectory: string;
    }>;

export type PathInspectionResponse =
  | Readonly<{ kind: "workspace"; index: number; path: string }>
  | Readonly<{
      kind: "canonicalize";
      worktree: string;
      repositoryRoot: string;
    }>
  | null;

type ChildRunOptions = Readonly<{
  program?: string;
  executable?: string;
  onSpawn?: (processId: number | undefined) => void;
}>;

const responseIsValid = (
  value: unknown,
  request: PathInspectionRequest,
): value is PathInspectionResponse => {
  if (request.kind === "workspace")
    return (
      value === null ||
      (typeof value === "object" &&
        value !== null &&
        Object.keys(value).sort().join("\0") === "index\0kind\0path" &&
        (value as { kind?: unknown }).kind === "workspace" &&
        Number.isSafeInteger((value as { index?: unknown }).index) &&
        ((value as { index: number }).index ?? -1) >= 0 &&
        ((value as { index: number }).index ?? request.paths.length) <
          request.paths.length &&
        typeof (value as { path?: unknown }).path === "string")
    );
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).sort().join("\0") === "kind\0repositoryRoot\0worktree" &&
    (value as { kind?: unknown }).kind === "canonicalize" &&
    typeof (value as { worktree?: unknown }).worktree === "string" &&
    typeof (value as { repositoryRoot?: unknown }).repositoryRoot === "string"
  );
};

const signalIsAborted = (signal: AbortSignal | undefined): boolean => {
  try {
    return signal?.aborted === true;
  } catch {
    return true;
  }
};

const runChild = (
  request: PathInspectionRequest,
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
  options: ChildRunOptions,
): Promise<PathInspectionResponse> => {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    signalIsAborted(signal)
  )
    return Promise.reject(new Error("core.path-inspection.unavailable"));
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > MAXIMUM_REQUEST_BYTES)
    return Promise.reject(new Error("core.path-inspection.unavailable"));
  return new Promise((resolve, reject) => {
    let output = "";
    let failed = false;
    let settled = false;
    const child = spawn(
      options.executable ?? process.execPath,
      ["--input-type=module", "--eval", options.program ?? childSource],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    options.onSpawn?.(child.pid);
    const stop = (): void => {
      failed = true;
      try {
        child.kill("SIGKILL");
        /* v8 ignore next 3 -- Node child_process owns this native method; the
         * fixed catch only protects an impossible host-runtime regression. */
      } catch {
        // The close/error boundary below owns the fixed failure result.
      }
    };
    const abort = (): void => {
      stop();
    };
    const timer = setTimeout(stop, timeoutMilliseconds);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        signal?.removeEventListener("abort", abort);
      } catch {
        failed = true;
      }
      if (error || failed) {
        reject(new Error("core.path-inspection.unavailable"));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(output);
        if (!responseIsValid(parsed, request))
          throw new Error("core.path-inspection.unavailable");
        resolve(parsed);
      } catch {
        reject(new Error("core.path-inspection.unavailable"));
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAXIMUM_RESPONSE_BYTES) stop();
    });
    child.once("error", () => {
      finish(new Error("spawn failed"));
    });
    child.once("close", (code) => {
      if (code !== 0) failed = true;
      finish();
    });
    try {
      signal?.addEventListener("abort", abort, { once: true });
      if (signalIsAborted(signal)) stop();
      child.stdin.end(payload);
      /* v8 ignore next 2 -- the owned pipe can fail asynchronously through the
       * child error/close boundary; synchronous native throws are defensive. */
    } catch {
      /* v8 ignore next -- see the native-pipe defense comment above. */
      stop();
    }
  });
};

export const inspectPathsInChildForCore = (
  request: PathInspectionRequest,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<PathInspectionResponse> =>
  runChild(request, timeoutMilliseconds, signal, {});

export const inspectPathsInChildForTesting = (
  request: PathInspectionRequest,
  timeoutMilliseconds: number,
  options: ChildRunOptions,
  signal?: AbortSignal,
): Promise<PathInspectionResponse> =>
  runChild(request, timeoutMilliseconds, signal, options);
