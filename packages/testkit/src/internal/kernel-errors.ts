import { HeadlessSupervisorError } from "../headless-supervisor.js";

export type PtyReconciliationStage =
  | "authority"
  | "observer"
  | "signal"
  | "reap"
  | "residual"
  | "child-join"
  | "output-join"
  | "transport-close"
  | "outer-shutdown";

type KernelFailure = Readonly<{
  code: string;
  stage: PtyReconciliationStage | undefined;
}>;

// The existing private error registry is shared by both transports. Neither
// an Error property nor a caller-provided object is diagnostic authority.
const failures = new WeakMap<object, KernelFailure>();
const apply = Reflect.apply;
const freeze = Object.freeze;
// eslint-disable-next-line @typescript-eslint/unbound-method
const get = WeakMap.prototype.get;
// eslint-disable-next-line @typescript-eslint/unbound-method
const set = WeakMap.prototype.set;
const stages = new Set<PtyReconciliationStage>([
  "authority",
  "observer",
  "signal",
  "reap",
  "residual",
  "child-join",
  "output-join",
  "transport-close",
  "outer-shutdown",
]);
// eslint-disable-next-line @typescript-eslint/unbound-method
const has = Set.prototype.has;

const failure = (error: unknown): KernelFailure | undefined =>
  typeof error === "object" && error !== null
    ? (apply(get, failures, [error]) as KernelFailure | undefined)
    : undefined;

export const kernelError = (
  code: string,
  stage?: PtyReconciliationStage,
): HeadlessSupervisorError => {
  const error = new HeadlessSupervisorError(code);
  const admittedStage =
    code === "testkit.headless.reconciliation.deadline" &&
    stage !== undefined &&
    apply(has, stages, [stage])
      ? stage
      : undefined;
  apply(set, failures, [error, freeze({ code, stage: admittedStage })]);
  return error;
};

export const fail = (code: string, stage?: PtyReconciliationStage): never => {
  throw kernelError(code, stage);
};

export const trustedErrorCode = (error: unknown): string | undefined =>
  failure(error)?.code;

export const readPtyReconciliationStage = (
  error: unknown,
): PtyReconciliationStage | undefined => failure(error)?.stage;

export const ptyAuthorityFailureStage = (
  code: string | undefined,
): PtyReconciliationStage => {
  if (code === "testkit.headless.observer.signal") return "signal";
  if (code === "testkit.headless.observer.reap") return "reap";
  if (
    code === "testkit.headless.observer.identity" ||
    code === "testkit.headless.observer.read" ||
    code === "testkit.headless.observer.root"
  )
    return "observer";
  return "authority";
};
