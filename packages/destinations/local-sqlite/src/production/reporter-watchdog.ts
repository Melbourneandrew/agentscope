/* v8 ignore file -- this parent-death process entry is executed and teardown-verified by the built-artifact verifier. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const fail = (): never => process.exit(70);

if (typeof process.send !== "function" || process.connected !== true) fail();

let workerPid: number | undefined;
let workerStartIdentity: string | undefined;
let complete = false;

const currentStartIdentity = (pid: number): string | undefined => {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    const ticks = value.slice(close + 2).split(" ")[19];
    return ticks === undefined
      ? undefined
      : createHash("sha256")
          .update(`${pid}:${ticks}`)
          .digest("hex")
          .slice(0, 32);
  } catch {
    return undefined;
  }
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== "string" || !keys.includes(key),
      )
    )
      return undefined;
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor))
        return undefined;
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return undefined;
  }
};

const killWorker = (): void => {
  if (workerPid === undefined || workerStartIdentity === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-workerPid, "SIGKILL");
    else if (currentStartIdentity(workerPid) === workerStartIdentity)
      process.kill(workerPid, "SIGKILL");
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ESRCH"
    )
      fail();
  }
};

process.on("message", (value: unknown) => {
  const watch = exactRecord(value, [
    "type",
    "workerPid",
    "workerStartIdentity",
  ]);
  if (
    watch?.type === "watch" &&
    typeof watch.workerPid === "number" &&
    Number.isSafeInteger(watch.workerPid) &&
    watch.workerPid > 0 &&
    typeof watch.workerStartIdentity === "string" &&
    /^[a-f0-9]{32}$/u.test(watch.workerStartIdentity) &&
    currentStartIdentity(watch.workerPid) === watch.workerStartIdentity &&
    workerPid === undefined
  ) {
    workerPid = watch.workerPid;
    workerStartIdentity = watch.workerStartIdentity;
    process.send?.({ type: "watching" });
    return;
  }
  const completion = exactRecord(value, ["type"]);
  if (completion?.type === "complete" && workerPid !== undefined) {
    complete = true;
    process.disconnect();
    return;
  }
  fail();
});

process.on("disconnect", () => {
  if (!complete) killWorker();
  process.exit(complete ? 0 : 70);
});
