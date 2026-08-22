import {
  createDestinationTypeId,
  type DestinationConnectionId,
  type DestinationTypeId,
} from "./identity.js";
import { createReporterDeadline } from "./deadline.js";
import {
  executeBoundDestinationRequest,
  type BoundDestinationTransport,
} from "./transport.js";

export type DestinationReachabilityState = "available" | "unavailable";

export type DestinationReachabilityProbe = Readonly<{
  destinationType: DestinationTypeId;
  inspect: (
    input: Readonly<{
      configurationGeneration: number;
      configurationIdentity: string;
      connectionId: DestinationConnectionId;
      signal: AbortSignal;
    }>,
  ) => Promise<DestinationReachabilityState>;
}>;

export type DestinationReachabilityProbeInput = Readonly<{
  destinationType: string;
  inspect: DestinationReachabilityProbe["inspect"];
}>;

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
  const destinationTypeInput: unknown = descriptors.destinationType?.value;
  const inspect: unknown = descriptors.inspect?.value;
  if (typeof inspect !== "function") return invalid();
  let destinationType: DestinationTypeId;
  try {
    destinationType = createDestinationTypeId(destinationTypeInput);
  } catch {
    return invalid();
  }
  const probe = Object.freeze({
    destinationType,
    inspect: inspect as DestinationReachabilityProbe["inspect"],
  });
  probes.add(probe);
  return probe;
};

export const isDestinationReachabilityProbe = (
  value: unknown,
): value is DestinationReachabilityProbe =>
  typeof value === "object" && value !== null && probes.has(value);

export const inspectBoundDestinationReachability = async (
  transport: BoundDestinationTransport,
  pathAndQuery: string,
  signal: AbortSignal,
): Promise<DestinationReachabilityState> => {
  try {
    const response = await executeBoundDestinationRequest(transport, {
      method: "GET",
      pathAndQuery,
      headers: Object.freeze({}),
      signal,
      deadline: createReporterDeadline(900),
    });
    const provesReachableEndpoint =
      (response.status >= 200 && response.status < 300) ||
      [400, 401, 403, 405, 413, 415, 422, 429].includes(response.status);
    return signal.aborted || !provesReachableEndpoint
      ? "unavailable"
      : "available";
  } catch {
    return "unavailable";
  }
};
