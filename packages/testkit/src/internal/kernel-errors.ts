import { HeadlessSupervisorError } from "../headless-supervisor.js";

export type PtyReconciliationStage =
  | "authority"
  | "observer"
  | "observer-read"
  | "observer-stat"
  | "observer-esrch"
  | "observer-permission"
  | "observer-io"
  | "observer-namespace"
  | "observer-identity"
  | "observer-graph"
  | "observer-root-reuse"
  | "observer-target-reuse"
  | "observer-zombie-before"
  | "observer-zombie-after"
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
  "observer-read",
  "observer-stat",
  "observer-esrch",
  "observer-permission",
  "observer-io",
  "observer-namespace",
  "observer-identity",
  "observer-graph",
  "observer-root-reuse",
  "observer-target-reuse",
  "observer-zombie-before",
  "observer-zombie-after",
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
const readStages = new Set<PtyReconciliationStage>([
  "observer-read",
  "observer-stat",
  "observer-esrch",
  "observer-permission",
  "observer-io",
]);
const identityStages = new Set<PtyReconciliationStage>([
  "observer-namespace",
  "observer-identity",
  "observer-graph",
  "observer-root-reuse",
  "observer-target-reuse",
  "observer-zombie-before",
  "observer-zombie-after",
]);

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
    stage !== undefined &&
    ((code === "testkit.headless.reconciliation.deadline" &&
      apply(has, stages, [stage])) ||
      (code === "testkit.headless.observer.read" &&
        apply(has, readStages, [stage])) ||
      (code === "testkit.headless.observer.identity" &&
        apply(has, identityStages, [stage])))
      ? stage
      : undefined;
  apply(set, failures, [error, freeze({ code, stage: admittedStage })]);
  return error;
};

export const fail = (code: string, stage?: PtyReconciliationStage): never => {
  throw kernelError(code, stage);
};

export const failObserverRead = (stage?: PtyReconciliationStage): never =>
  fail("testkit.headless.observer.read", stage);
export const failObserverIdentity = (stage: PtyReconciliationStage): never =>
  fail("testkit.headless.observer.identity", stage);

export const trustedErrorCode = (error: unknown): string | undefined =>
  failure(error)?.code;

export const readPtyReconciliationStage = (
  error: unknown,
): PtyReconciliationStage | undefined => failure(error)?.stage;

// Fixed syscall research only. Even disappearance remains an observer failure;
// this classification never changes the existing ENOENT-only absence rule.
export const observerReadFailureStage = (
  errno: unknown,
): PtyReconciliationStage => {
  if (errno === "ESRCH") return "observer-esrch";
  if (errno === "EACCES" || errno === "EPERM") return "observer-permission";
  if (errno === "EIO") return "observer-io";
  return "observer-read";
};

export const ptyAuthorityFailureStage = (
  code: string | undefined,
): PtyReconciliationStage => {
  if (code === "testkit.headless.observer.signal") return "signal";
  if (code === "testkit.headless.observer.reap") return "reap";
  if (code === "testkit.headless.observer.read") return "observer-read";
  if (code === "testkit.headless.observer.identity") return "observer-identity";
  if (code === "testkit.headless.observer.root") return "observer";
  return "authority";
};
