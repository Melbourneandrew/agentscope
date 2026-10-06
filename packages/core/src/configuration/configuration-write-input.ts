import {
  serializeAgentscopeConfiguration,
  type AgentscopeConfigurationSnapshot,
} from "./schema.js";

type Failure = "invalid" | "downgrade" | "conflict";
type Authority<
  Owner extends object,
  Credential extends object,
  Resource extends object,
> = Readonly<{
  owner: (value: object) => value is Owner;
  credential: (value: object) => value is Credential;
  resource: (value: object) => value is Resource;
  invalid: (failure: Failure) => never;
  maximumBytes: number;
}>;

const writeDescriptors = (
  input: unknown,
  invalid: (failure: Failure) => never,
) => {
  const descriptors =
    typeof input === "object" && input !== null
      ? Object.getOwnPropertyDescriptors(input)
      : undefined;
  if (
    !descriptors ||
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    ![
      "candidate,credentialMutationIntent,expectedGeneration,owner",
      "candidate,expectedGeneration,localResourceMutationIntent,owner",
      "candidate,expectedGeneration,owner",
    ].includes(Object.keys(descriptors).sort().join(",")) ||
    Reflect.ownKeys(descriptors).some((key) => {
      const descriptor = descriptors[key as keyof typeof descriptors];
      return !descriptor || !("value" in descriptor);
    })
  )
    return invalid("invalid");
  return descriptors;
};

// Reconstruction is private; canonical brand registries remain with the transaction owner.
export const configurationWriteInput = <
  Owner extends object,
  Credential extends object,
  Resource extends object,
>(
  input: unknown,
  authority: Authority<Owner, Credential, Resource>,
) => {
  const descriptors = writeDescriptors(input, authority.invalid);
  const expectedGeneration: unknown = descriptors.expectedGeneration?.value;
  const candidate: unknown = descriptors.candidate?.value;
  const owner: unknown = descriptors.owner?.value;
  const credentialMutationIntent: unknown =
    descriptors.credentialMutationIntent?.value;
  const localResourceMutationIntent: unknown =
    descriptors.localResourceMutationIntent?.value;
  if (
    (!Number.isSafeInteger(expectedGeneration) &&
      expectedGeneration !== null) ||
    (typeof expectedGeneration === "number" && expectedGeneration < 0) ||
    typeof candidate !== "object" ||
    candidate === null ||
    typeof owner !== "object" ||
    owner === null ||
    !authority.owner(owner) ||
    (credentialMutationIntent !== undefined &&
      (typeof credentialMutationIntent !== "object" ||
        credentialMutationIntent === null ||
        !authority.credential(credentialMutationIntent))) ||
    (localResourceMutationIntent !== undefined &&
      (typeof localResourceMutationIntent !== "object" ||
        localResourceMutationIntent === null ||
        !authority.resource(localResourceMutationIntent))) ||
    (credentialMutationIntent !== undefined &&
      localResourceMutationIntent !== undefined)
  )
    return authority.invalid("invalid");
  const typedCandidate = candidate as AgentscopeConfigurationSnapshot;
  const candidateText = serializeAgentscopeConfiguration(typedCandidate);
  /* v8 ignore next 2 -- the branded schema's tighter aggregate bound makes
     the outer file cap unreachable for a genuine snapshot. */
  if (Buffer.byteLength(candidateText, "utf8") > authority.maximumBytes)
    return authority.invalid("invalid");
  if (!typedCandidate.mutationSafe) return authority.invalid("downgrade");
  const typedExpected = expectedGeneration as number | null;
  if (typedCandidate.generation !== (typedExpected ?? -1) + 1)
    return authority.invalid("conflict");
  return Object.freeze({
    expectedGeneration: typedExpected,
    candidate: typedCandidate,
    candidateText,
    owner,
    credentialMutationIntent,
    localResourceMutationIntent,
  });
};
