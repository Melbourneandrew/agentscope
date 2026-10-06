import type { DestinationDescriptor } from "@agentscope/destinations-core";

import {
  createCredentialResolutionContext,
  readResolvedCredentialForCore,
  resolveCredentialReference,
  type CredentialBackendRegistry,
} from "../configuration/credential-adapter.js";
import { credentialResolutionExpired } from "../configuration/credential-resolution-context.js";
import type { ConfiguredDestinationConnection } from "../configuration/schema.js";

type CredentialSettlement =
  | Readonly<{
      kind: "resolved";
      credentials: Readonly<Record<string, string>>;
    }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "expired" }>;

export const resolveCredentialsWithinDeadline = async (
  descriptor: DestinationDescriptor,
  connection: ConfiguredDestinationConnection,
  credentialBackendRegistry: CredentialBackendRegistry,
  controller: AbortController,
  expiresAtMonotonicMilliseconds: number,
): Promise<CredentialSettlement> => {
  const credentialContext = createCredentialResolutionContext(
    "interactive",
    controller.signal,
    expiresAtMonotonicMilliseconds,
  );
  if (credentialResolutionExpired(credentialContext))
    return Object.freeze({ kind: "expired" });
  const resolution = Promise.all(
    descriptor.credentialSlots.map(async (slot) => {
      const reference = connection.credentialReferences[slot.id];
      if (!reference) return [slot.id, undefined] as const;
      const resolved = await resolveCredentialReference(
        credentialBackendRegistry,
        reference,
        credentialContext,
      );
      if (!resolved.ok) throw new Error("core.retrieval.unavailable");
      return [
        slot.id,
        readResolvedCredentialForCore(resolved.credential),
      ] as const;
    }),
  ).then(
    (entries): CredentialSettlement =>
      Object.freeze({
        kind: "resolved",
        credentials: Object.freeze(
          Object.fromEntries(entries.filter((entry) => entry[1] !== undefined)),
        ),
      }),
    (): CredentialSettlement => Object.freeze({ kind: "failed" }),
  );
  let resolveExpiration: (() => void) | undefined;
  const expiration = new Promise<CredentialSettlement>((resolve) => {
    resolveExpiration = () => {
      resolve(Object.freeze({ kind: "expired" }));
    };
  });
  /* v8 ignore else -- the Promise executor initializes this synchronously. */
  if (resolveExpiration !== undefined)
    controller.signal.addEventListener("abort", resolveExpiration, {
      once: true,
    });
  if (controller.signal.aborted) resolveExpiration?.();
  const settlement = await Promise.race([resolution, expiration]);
  /* v8 ignore else -- the Promise executor initializes this synchronously. */
  if (resolveExpiration !== undefined)
    controller.signal.removeEventListener("abort", resolveExpiration);
  return credentialResolutionExpired(credentialContext)
    ? Object.freeze({ kind: "expired" })
    : settlement;
};
