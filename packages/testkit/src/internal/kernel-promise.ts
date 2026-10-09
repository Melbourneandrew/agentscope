import { performance } from "node:perf_hooks";

import {
  fail,
  kernelError,
  readPtyReconciliationStage,
  readPtySemanticFailure,
  trustedErrorCode,
  type PtyReconciliationStage,
} from "./kernel-errors.js";

const SafePromise = Promise;
const apply = Reflect.apply;
const maximum = Math.max;
const safeSetTimeout = setTimeout;
const safeClearTimeout = clearTimeout;
// eslint-disable-next-line @typescript-eslint/unbound-method
const performanceNow = performance.now;
// eslint-disable-next-line @typescript-eslint/unbound-method
const promiseThen = Promise.prototype.then;

export type Terminal<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ error: unknown; ok: false }>;

export const terminalOf = <T>(promise: Promise<T>): Promise<Terminal<T>> =>
  apply(promiseThen, promise, [
    (value: T) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  ]) as Promise<Terminal<T>>;

export const observeAtCreation = <T>(promise: Promise<T>): Promise<T> => {
  void terminalOf(promise);
  return promise;
};

export const terminalSnapshot = <T>(
  promise: Promise<T>,
): (() => Terminal<T> | undefined) => {
  let terminal: Terminal<T> | undefined;
  const observed = terminalOf(promise);
  void apply(promiseThen, observed, [
    (value: Terminal<T>) => {
      terminal = value;
    },
  ]);
  return () => terminal;
};

export const remaining = (deadline: number): number =>
  maximum(0, deadline - apply(performanceNow, performance, []));

// This is the existing kernel promise race, not a process or backend owner.
// Diagnostic provenance follows an authentic rejection; only this race's
// deadline winner receives the supplied stage. No later result wins anew.
export const boundedInvoke = <T>(
  operation: () => Promise<T>,
  deadline: number,
  code: string,
  stage?: PtyReconciliationStage,
): Promise<T> => {
  const initialWait = remaining(deadline);
  if (initialWait <= 0) return fail(code, stage);
  let operationPromise: Promise<T>;
  try {
    operationPromise = operation();
  } catch (error: unknown) {
    return fail(
      trustedErrorCode(error) ?? "testkit.headless.kernel.failure",
      readPtyReconciliationStage(error),
      readPtySemanticFailure(error),
    );
  }
  const observed = terminalOf(operationPromise);
  const wait = remaining(deadline);
  if (wait <= 0) return fail(code, stage);
  return observeAtCreation(
    new SafePromise<T>((resolve, reject) => {
      const timer = safeSetTimeout(() => {
        reject(kernelError(code, stage));
      }, wait);
      void apply(promiseThen, observed, [
        (settled: Terminal<T>) => {
          safeClearTimeout(timer);
          if (settled.ok) resolve(settled.value);
          else
            reject(
              kernelError(
                trustedErrorCode(settled.error) ??
                  "testkit.headless.kernel.failure",
                readPtyReconciliationStage(settled.error),
                readPtySemanticFailure(settled.error),
              ),
            );
        },
      ]);
    }),
  );
};
