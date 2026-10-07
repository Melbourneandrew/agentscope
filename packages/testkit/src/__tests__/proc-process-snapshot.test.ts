import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transpileModule, ScriptTarget } from "typescript";
import { describe, expect, it } from "vitest";
import {
  fail,
  failObserverRead,
  observerReadFailureStage,
  trustedErrorCode,
  readPtyReconciliationStage,
} from "../internal/kernel-errors.js";

const readInternal = (name: string): string =>
  readFileSync(new URL(`../internal/${name}`, import.meta.url), "utf8");
const caughtFailure = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("exact production proc-reader diagnostic leaves", () => {
  it.each([
    ["ENOENT", undefined],
    ["ESRCH", "observer-esrch"],
    ["EACCES", "observer-permission"],
    ["EPERM", "observer-permission"],
    ["EIO", "observer-io"],
    ["unexpected", "observer-read"],
    ["malformed", "observer-stat"],
    ["valid", undefined],
    ["ESRCH:ENOENT", undefined],
    ["ESRCH:valid", undefined],
    ["ESRCH:reused", undefined],
    ["ESRCH:EACCES", "observer-permission"],
    ["ESRCH:EPERM", "observer-permission"],
    ["ESRCH:EIO", "observer-io"],
    ["ESRCH:malformed", "observer-stat"],
    ["expired-before", "observer-esrch"],
    ["expired-after", "observer-esrch"],
    ["expired-absence", "observer-esrch"],
  ] as const)(
    "preserves the existing %s disposition and fixed leaf",
    (kind, leaf) => {
      const source = readInternal("proc-process-snapshot.ts");
      const start = source.indexOf("const readProcessSnapshot = (");
      const end = source.indexOf("export { readProcessSnapshot", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const compiled = transpileModule(source.slice(start, end), {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText;
      let reads = 0;
      let samples = 0;
      const read = runInNewContext(
        `${compiled}\nreadProcessSnapshot;`,
        {
          readFileSync: (path: string, encoding: string) => {
            expect([path, encoding]).toEqual(["/proc/67/stat", "utf8"]);
            reads += 1;
            const selected =
              kind === "expired-after" && reads === 2
                ? "valid"
                : kind === "expired-absence" && reads === 2
                  ? "ENOENT"
                  : kind.startsWith("expired")
                    ? "ESRCH"
                    : (kind.split(":")[reads - 1] ?? kind);
            if (selected === "valid" || selected === "reused")
              return `67 (fixture) S 1 ${"0 ".repeat(17)}${selected === "reused" ? 456 : 123}`;
            if (selected === "malformed")
              return "private malformed process data";
            throw Object.assign(new Error("private syscall detail"), {
              code: selected,
            });
          },
          performanceNow: () => {
            samples += 1;
            return kind === "expired-before" ||
              ((kind === "expired-after" || kind === "expired-absence") &&
                samples === 2)
              ? 100
              : 1;
          },
          performance: {},
          safeReflectApply: Reflect.apply,
          numberIsSafeInteger: Number.isSafeInteger,
          numberIsFinite: Number.isFinite,
          fail,
          failObserverRead,
          observerReadFailureStage,
          trustedErrorCode,
          readPtyReconciliationStage,
        },
        { timeout: 1000 },
      ) as (pid: number, deadline: number) => unknown;
      if (kind.endsWith("ENOENT")) expect(read(67, 100)).toBeUndefined();
      else if (kind.endsWith("valid") || kind.endsWith("reused"))
        expect(read(67, 100)).toEqual({
          pid: 67,
          parentPid: 1,
          startIdentity: kind.endsWith("reused") ? "67:456" : "67:123",
          state: "S",
        });
      else {
        const error = caughtFailure(() => read(67, 100));
        expect(trustedErrorCode(error)).toBe("testkit.headless.observer.read");
        expect(readPtyReconciliationStage(error)).toBe(leaf);
        expect(JSON.stringify(error)).not.toContain("private");
      }
      expect(reads).toBe(
        kind === "ESRCH" ||
          kind.startsWith("ESRCH:") ||
          kind === "expired-after" ||
          kind === "expired-absence"
          ? 2
          : 1,
      );
    },
  );
});
