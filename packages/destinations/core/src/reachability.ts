import type { DestinationConnectionId, DestinationTypeId } from "./identity.js";

export type DestinationReachabilityState = "available" | "unavailable";

export type DestinationReachabilityProbe = Readonly<{
  destinationType: DestinationTypeId;
  inspect: (
    input: Readonly<{
      connectionId: DestinationConnectionId;
      signal: AbortSignal;
    }>,
  ) => Promise<DestinationReachabilityState>;
}>;

export type DestinationReachabilityProbeInput = Readonly<{
  destinationType: string;
  inspect: DestinationReachabilityProbe["inspect"];
}>;

const destinationTypePattern = /^@agentscope\/destination-[a-z0-9-]{1,64}$/u;
const probes = new WeakSet<object>();

export class DestinationReachabilityError extends Error {
  public readonly code = "destination.reachability.invalid";

  public constructor() {
    super("destination.reachability.invalid");
    this.name = "DestinationReachabilityError";
  }
}

const invalid = (): never => {
  throw new DestinationReachabilityError();
};

export const defineDestinationReachabilityProbe = (
  input: DestinationReachabilityProbeInput,
): DestinationReachabilityProbe => {
  if (typeof input !== "object" || input === null) return invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return invalid();
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !== "destinationType,inspect" ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return invalid();
  const destinationType: unknown = descriptors.destinationType?.value;
  const inspect: unknown = descriptors.inspect?.value;
  if (
    typeof destinationType !== "string" ||
    !destinationTypePattern.test(destinationType) ||
    typeof inspect !== "function"
  )
    return invalid();
  const probe = Object.freeze({
    destinationType: destinationType as DestinationTypeId,
    inspect: inspect as DestinationReachabilityProbe["inspect"],
  });
  probes.add(probe);
  return probe;
};

export const isDestinationReachabilityProbe = (
  value: unknown,
): value is DestinationReachabilityProbe =>
  typeof value === "object" && value !== null && probes.has(value);
