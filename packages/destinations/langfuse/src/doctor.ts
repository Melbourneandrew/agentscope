import {
  defineDestinationReachabilityProbe,
  inspectBoundDestinationReachability,
  isBoundDestinationTransport,
  type BoundDestinationTransport,
  type DestinationConnectionId,
  type DestinationReachabilityProbe,
} from "@agentscope/destinations-core";

import {
  LANGFUSE_COMPATIBILITY_MANIFEST,
  LANGFUSE_PROFILE_IDS,
  type LangfuseProfileId,
} from "./compatibility.js";

export type LangfuseDoctorConnection = Readonly<{
  connectionId: DestinationConnectionId;
  profileId: LangfuseProfileId;
  transport: BoundDestinationTransport;
}>;

export type LangfuseDoctorConnectionResolver = (
  connectionId: DestinationConnectionId,
  configurationGeneration: number,
  configurationIdentity: string,
  signal: AbortSignal,
) => Promise<LangfuseDoctorConnection | null>;

const profileIds = new Set<string>(LANGFUSE_PROFILE_IDS);

const snapshotConnection = (
  value: unknown,
): LangfuseDoctorConnection | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join(",") !==
      "connectionId,profileId,transport" ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return undefined;
  const connectionId: unknown = descriptors.connectionId?.value;
  const profileId: unknown = descriptors.profileId?.value;
  const transport: unknown = descriptors.transport?.value;
  if (
    typeof connectionId !== "string" ||
    typeof profileId !== "string" ||
    !profileIds.has(profileId) ||
    !isBoundDestinationTransport(transport)
  )
    return undefined;
  return Object.freeze({
    connectionId: connectionId as DestinationConnectionId,
    profileId: profileId as LangfuseProfileId,
    transport,
  });
};

const reporterPath = (profileId: LangfuseProfileId): string | undefined =>
  LANGFUSE_COMPATIBILITY_MANIFEST.profiles.find(
    (profile) => profile.profileId === profileId,
  )?.reporter.path;

export const createLangfuseReachabilityProbe = (
  resolveConnection: LangfuseDoctorConnectionResolver,
): DestinationReachabilityProbe => {
  if (typeof resolveConnection !== "function")
    throw new Error("destination.langfuse.doctor.invalid");
  return defineDestinationReachabilityProbe({
    destinationType: "@agentscope/destination-langfuse",
    inspect: async ({
      configurationGeneration,
      configurationIdentity,
      connectionId,
      signal,
    }) => {
      try {
        if (
          signal.aborted ||
          !Number.isSafeInteger(configurationGeneration) ||
          configurationGeneration < 0 ||
          !/^sha256-[0-9a-f]{64}$/u.test(configurationIdentity)
        )
          return "unavailable";
        const connection = snapshotConnection(
          await resolveConnection(
            connectionId,
            configurationGeneration,
            configurationIdentity,
            signal,
          ),
        );
        if (
          !connection ||
          connection.connectionId !== connectionId ||
          signal.aborted
        )
          return "unavailable";
        const pathAndQuery = reporterPath(connection.profileId);
        /* v8 ignore next -- the connection snapshot admits only the exact profile inventory from this same manifest. */
        if (pathAndQuery === undefined) return "unavailable";
        return inspectBoundDestinationReachability(
          connection.transport,
          pathAndQuery,
          signal,
        );
      } catch {
        return "unavailable";
      }
    },
  });
};
