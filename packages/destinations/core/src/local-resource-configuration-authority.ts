export type LocalResourceConfigurationCommitEvidence = Readonly<{
  priorGeneration: number;
  committedGeneration: number;
  candidateDigest: string;
}>;

export type LocalResourceConfigurationAuthority = Readonly<{
  readonly localResourceConfigurationAuthority: "agentscope-destinations-core";
}>;

export type LocalResourceConfigurationInvocationAuthority = Readonly<{
  authority: LocalResourceConfigurationAuthority;
  awaitCommitSettlement(): Promise<void>;
}>;

export type BindLocalResourceConfigurationAuthorityInput = Readonly<{
  destinationType: string;
  connectionId: string;
  operationId: string;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  priorGeneration: number;
  candidateGeneration: number;
  candidateDigest: string;
  commit: () => Promise<LocalResourceConfigurationCommitEvidence>;
}>;

type StoredAuthority = Readonly<{
  destinationType: string;
  connectionId: string;
  operationId: string;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  priorGeneration: number;
  candidateGeneration: number;
  candidateDigest: string;
  commit: () => Promise<LocalResourceConfigurationCommitEvidence>;
}>;

const authorities = new WeakMap<object, StoredAuthority>();
const consumed = new WeakSet<object>();
const commitFailures = new WeakSet<object>();

export class LocalResourceConfigurationCommitError extends Error {
  public readonly code =
    "destination.local-resource-configuration.outcome-unknown";
  public readonly configurationMayHaveAdvanced = true;

  public constructor() {
    super("destination.local-resource-configuration.outcome-unknown");
    this.name = "LocalResourceConfigurationCommitError";
    commitFailures.add(this);
  }
}

export const isLocalResourceConfigurationCommitError = (
  value: unknown,
): value is LocalResourceConfigurationCommitError =>
  typeof value === "object" && value !== null && commitFailures.has(value);

export class LocalResourceConfigurationAuthorityError extends Error {
  public readonly code = "destination.local-resource-configuration.invalid";

  public constructor() {
    super("destination.local-resource-configuration.invalid");
    this.name = "LocalResourceConfigurationAuthorityError";
  }
}

const invalid = (): never => {
  throw new LocalResourceConfigurationAuthorityError();
};

const bounded = (value: unknown, pattern: RegExp, maximum: number): string => {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maximum ||
    !pattern.test(value)
  )
    return invalid();
  return value;
};

const generation = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalid();
  return value;
};

export const bindLocalResourceConfigurationAuthorityForCore = (
  input: BindLocalResourceConfigurationAuthorityInput,
): LocalResourceConfigurationAuthority => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const expectedKeys = [
    "commit",
    "connectionId",
    "candidateDigest",
    "candidateGeneration",
    "destinationType",
    "lifecycleFingerprint",
    "operationId",
    "priorGeneration",
    "recoveryHandlerId",
  ];
  if (
    Reflect.ownKeys(descriptors).length !== expectedKeys.length ||
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  )
    return invalid();
  const read = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return invalid();
    return descriptor.value;
  };
  const commitValue = read("commit");
  if (typeof commitValue !== "function") return invalid();
  const commit =
    commitValue as () => Promise<LocalResourceConfigurationCommitEvidence>;
  const stored = Object.freeze({
    destinationType: bounded(
      read("destinationType"),
      /^@agentscope\/destination-[a-z0-9-]{1,64}$/u,
      96,
    ),
    connectionId: bounded(
      read("connectionId"),
      /^destination-connection-v1-[0-9a-f]{64}$/u,
      96,
    ),
    operationId: bounded(read("operationId"), /^[0-9a-f]{32}$/u, 32),
    lifecycleFingerprint: bounded(
      read("lifecycleFingerprint"),
      /^sha256-[0-9a-f]{64}$/u,
      71,
    ),
    recoveryHandlerId: bounded(
      read("recoveryHandlerId"),
      /^@agentscope\/destination-[a-z0-9-]+\/lifecycle-v[1-9][0-9]{0,4}$/u,
      192,
    ),
    priorGeneration: generation(read("priorGeneration")),
    candidateGeneration: generation(read("candidateGeneration")),
    candidateDigest: bounded(
      read("candidateDigest"),
      /^sha256-[0-9a-f]{64}$/u,
      71,
    ),
    commit,
  });
  if (
    /^0{32}$/u.test(stored.operationId) ||
    stored.candidateGeneration <= stored.priorGeneration ||
    stored.candidateGeneration > stored.priorGeneration + 2
  )
    return invalid();
  const authority = Object.freeze({
    localResourceConfigurationAuthority:
      "agentscope-destinations-core" as const,
  });
  authorities.set(authority, stored);
  return authority;
};

export const commitLocalResourceConfiguration = async (
  authority: LocalResourceConfigurationAuthority,
  expected: Readonly<{
    destinationType: string;
    connectionId: string;
    operationId: string;
    lifecycleFingerprint: string;
    recoveryHandlerId: string;
  }>,
): Promise<LocalResourceConfigurationCommitEvidence> => {
  const stored = authorities.get(authority);
  if (!stored || consumed.has(authority)) return invalid();
  if (
    stored.destinationType !== expected.destinationType ||
    stored.connectionId !== expected.connectionId ||
    stored.operationId !== expected.operationId ||
    stored.lifecycleFingerprint !== expected.lifecycleFingerprint ||
    stored.recoveryHandlerId !== expected.recoveryHandlerId
  )
    return invalid();
  consumed.add(authority);
  let evidence: LocalResourceConfigurationCommitEvidence;
  try {
    evidence = await stored.commit();
  } catch (error) {
    if (isLocalResourceConfigurationCommitError(error)) throw error;
    return invalid();
  }
  const descriptors: PropertyDescriptorMap =
    typeof evidence === "object" && evidence !== null
      ? Object.getOwnPropertyDescriptors(evidence)
      : {};
  const keys = ["candidateDigest", "committedGeneration", "priorGeneration"];
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    ) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !("value" in descriptor);
    })
  )
    return invalid();
  const priorGeneration = descriptors.priorGeneration?.value as unknown;
  const committedGeneration = descriptors.committedGeneration?.value as unknown;
  const candidateDigest = descriptors.candidateDigest?.value as unknown;
  if (
    typeof priorGeneration !== "number" ||
    !Number.isSafeInteger(priorGeneration) ||
    priorGeneration < 0 ||
    priorGeneration !== stored.priorGeneration ||
    committedGeneration !== stored.candidateGeneration ||
    typeof candidateDigest !== "string" ||
    candidateDigest !== stored.candidateDigest
  )
    return invalid();
  return Object.freeze({
    priorGeneration,
    committedGeneration,
    candidateDigest,
  });
};

export const bindLocalResourceConfigurationAuthorityForInvocation = (
  authority: LocalResourceConfigurationAuthority,
  signal: AbortSignal,
): LocalResourceConfigurationInvocationAuthority => {
  const stored = authorities.get(authority);
  if (!stored || consumed.has(authority) || !(signal instanceof AbortSignal))
    return invalid();
  let commitSettlement: Promise<void> | undefined;
  const invocationAuthority = bindLocalResourceConfigurationAuthorityForCore({
    destinationType: stored.destinationType,
    connectionId: stored.connectionId,
    operationId: stored.operationId,
    lifecycleFingerprint: stored.lifecycleFingerprint,
    recoveryHandlerId: stored.recoveryHandlerId,
    priorGeneration: stored.priorGeneration,
    candidateGeneration: stored.candidateGeneration,
    candidateDigest: stored.candidateDigest,
    commit: () => {
      const operation = (async () => {
        if (signal.aborted) return invalid();
        const evidence = await commitLocalResourceConfiguration(authority, {
          destinationType: stored.destinationType,
          connectionId: stored.connectionId,
          operationId: stored.operationId,
          lifecycleFingerprint: stored.lifecycleFingerprint,
          recoveryHandlerId: stored.recoveryHandlerId,
        });
        if (signal.aborted) throw new LocalResourceConfigurationCommitError();
        return evidence;
      })();
      commitSettlement = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  });
  return Object.freeze({
    authority: invocationAuthority,
    awaitCommitSettlement: () => commitSettlement ?? Promise.resolve(),
  });
};
