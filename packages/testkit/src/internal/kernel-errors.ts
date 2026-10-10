import { HeadlessSupervisorError } from "../headless-supervisor.js";
import { types } from "node:util";

export type PtySemanticFailure = Readonly<{
  finalSemanticState: "active" | "ready";
  inputJoined: boolean;
  readinessObserved: boolean;
  allInputBytesWritten: boolean;
}>;

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
  | "reap-call"
  | "reap-receipt"
  | "reap-not-ready"
  | "reap-persisted"
  | "residual"
  | "child-join"
  | "output-join"
  | "transport-close"
  | "outer-shutdown";

type KernelFailure = Readonly<{
  code: string;
  stage: PtyReconciliationStage | undefined;
  semanticFailure?: PtySemanticFailure;
  exitSignal?: number;
}>;

// The existing private error registry is shared by both transports. Neither
// an Error property nor a caller-provided object is diagnostic authority.
const failures = new WeakMap<object, KernelFailure>();
const apply = Reflect.apply;
const freeze = Object.freeze;
const isSafeInteger = Number.isSafeInteger;
// eslint-disable-next-line @typescript-eslint/unbound-method
const get = WeakMap.prototype.get;
// eslint-disable-next-line @typescript-eslint/unbound-method
const set = WeakMap.prototype.set;
const isProxy = types.isProxy;
const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const map = Array.prototype.map;
const some = Array.prototype.some;
const semanticSnapshot = (value: unknown): PtySemanticFailure | undefined => {
  if (value === null || typeof value !== "object" || isProxy(value))
    return undefined;
  const keys = [
    "finalSemanticState",
    "inputJoined",
    "readinessObserved",
    "allInputBytesWritten",
  ];
  if (ownKeys(value).length !== keys.length) return undefined;
  const fields = apply(map, keys, [
    (key: string) => descriptor(value, key),
  ]) as (PropertyDescriptor | undefined)[];
  if (
    apply(some, fields, [
      (field: PropertyDescriptor | undefined) =>
        field === undefined || !("value" in field),
    ])
  )
    return undefined;
  const [state, joined, ready, written] = apply(map, fields, [
    (field: PropertyDescriptor) => field.value as unknown,
  ]) as unknown[];
  if (
    (state !== "active" && state !== "ready") ||
    typeof joined !== "boolean" ||
    typeof ready !== "boolean" ||
    typeof written !== "boolean"
  )
    return undefined;
  return freeze({
    finalSemanticState: state,
    inputJoined: joined,
    readinessObserved: ready,
    allInputBytesWritten: written,
  });
};
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
  "reap-call",
  "reap-receipt",
  "reap-not-ready",
  "reap-persisted",
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
  semanticFailure?: PtySemanticFailure,
  exitSignal?: number,
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
  const semantic =
    code === "testkit.pty.transport.semantic-incomplete"
      ? semanticSnapshot(semanticFailure)
      : undefined;
  apply(set, failures, [
    error,
    freeze({
      code,
      stage: admittedStage,
      ...(semantic === undefined ? {} : { semanticFailure: semantic }),
      ...(code === "testkit.pty.transport.exit" &&
      typeof exitSignal === "number" &&
      isSafeInteger(exitSignal) &&
      exitSignal >= 1 &&
      exitSignal <= 64 &&
      exitSignal !== 2 &&
      exitSignal !== 9 &&
      exitSignal !== 15
        ? { exitSignal }
        : {}),
    }),
  ]);
  return error;
};

export const fail = (
  code: string,
  stage?: PtyReconciliationStage,
  semanticFailure?: PtySemanticFailure,
  exitSignal?: number,
): never => {
  throw kernelError(code, stage, semanticFailure, exitSignal);
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
export const readPtySemanticFailure = (
  error: unknown,
): PtySemanticFailure | undefined => failure(error)?.semanticFailure;
export const readPtyExitSignal = (error: unknown): number | undefined =>
  failure(error)?.exitSignal;

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
