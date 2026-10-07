import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  failObserverRead,
  observerReadFailureStage,
  readPtyReconciliationStage,
  trustedErrorCode,
} from "./kernel-errors.js";

const safeReflectApply = Reflect.apply;
const performanceNow = performance.now.bind(performance);
const numberIsSafeInteger = Number.isSafeInteger;
const numberIsFinite = Number.isFinite;

type ProcessSnapshot = Readonly<{
  parentPid: number;
  pid: number;
  startIdentity: string;
  state: string;
}>;

const readProcessSnapshot = (
  pid: number,
  monotonicDeadlineMs: number,
): ProcessSnapshot | undefined => {
  try {
    let value = "";
    try {
      value = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
      // ESRCH describes the inode-bound task, not current path absence. Make
      // one fresh observation, never a new window or errno-to-absence rule.
      if (
        !numberIsFinite(monotonicDeadlineMs) ||
        safeReflectApply(performanceNow, performance, []) >= monotonicDeadlineMs
      )
        return failObserverRead("observer-esrch");
      let freshFailed = false;
      let freshError: unknown;
      try {
        value = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch (error: unknown) {
        freshFailed = true;
        freshError = error;
      }
      if (
        safeReflectApply(performanceNow, performance, []) >= monotonicDeadlineMs
      )
        return failObserverRead("observer-esrch");
      if (freshFailed) throw freshError;
    }
    const close = value.lastIndexOf(")");
    if (close < 1) return failObserverRead("observer-stat");
    const fields = value
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
    const state = fields[0];
    const encodedParent = fields[1];
    const start = fields[19];
    if (
      state === undefined ||
      !/^[DIKPRSTWXYZtx]$/u.test(state) ||
      encodedParent === undefined ||
      !/^\d+$/u.test(encodedParent) ||
      start === undefined ||
      !/^\d+$/u.test(start)
    )
      return failObserverRead("observer-stat");
    const parentPid = Number(encodedParent);
    if (!numberIsSafeInteger(parentPid) || parentPid < 0)
      return failObserverRead("observer-stat");
    return { parentPid, pid, startIdentity: `${pid}:${start}`, state };
  } catch (error: unknown) {
    if (trustedErrorCode(error) === "testkit.headless.observer.read")
      return failObserverRead(readPtyReconciliationStage(error));
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    )
      return undefined;
    return failObserverRead(
      observerReadFailureStage(
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined,
      ),
    );
  }
};

export { readProcessSnapshot };
export type { ProcessSnapshot };
