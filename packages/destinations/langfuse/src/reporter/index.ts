import { Buffer } from "node:buffer";

import {
  createCredentialSlotId,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
  executeBoundDestinationRequest,
  readReporterCredential,
  type DestinationDescriptor,
  type ReporterFactoryContext,
} from "@agentscope/destinations-core";
import { readOtlpExportJsonResponse } from "@agentscope/protocol";
import { z } from "zod";

import {
  LANGFUSE_COMPATIBILITY_MANIFEST,
  LANGFUSE_PROFILE_IDS,
  type LangfuseDestinationSettings,
} from "../compatibility.js";
import { encodeLangfuseOtlpJsonBatch } from "./projection.js";
import { createLangfuseRetriever } from "../retriever/index.js";

export const langfuseReporterPackageId =
  "@agentscope/destination-langfuse/reporter" as const;

const settingsSchema = z.strictObject({
  endpoint: z.string(),
  allowInsecureLoopback: z.boolean(),
  profileId: z.enum(LANGFUSE_PROFILE_IDS),
  compatibilityManifestId: z.literal(
    LANGFUSE_COMPATIBILITY_MANIFEST.manifestId,
  ),
  encoding: z.literal("application/json"),
});
void settingsSchema.shape;

const publicKeySlot = createCredentialSlotId("public-key");
const secretKeySlot = createCredentialSlotId("secret-key");

const createAuthorization = (
  context: ReporterFactoryContext<LangfuseDestinationSettings>,
): string => {
  const publicKey = readReporterCredential(context.credentials, publicKeySlot);
  const secretKey = readReporterCredential(context.credentials, secretKeySlot);
  /* v8 ignore next 2 -- both slots are required and the family constructs the factory context only after exact credential validation. */
  if (publicKey === undefined || secretKey === undefined)
    throw new Error("destination.langfuse.credentials.unavailable");
  const value = `Basic ${Buffer.from(`${publicKey}:${secretKey}`, "utf8").toString("base64")}`;
  if (value.length > 8_192)
    throw new Error("destination.langfuse.credentials.unavailable");
  return value;
};

const profileFor = (profileId: LangfuseDestinationSettings["profileId"]) => {
  const profile = LANGFUSE_COMPATIBILITY_MANIFEST.profiles.find(
    (candidate) => candidate.profileId === profileId,
  );
  /* v8 ignore next 2 -- the closed settings enum is declared from this exact manifest profile inventory. */
  if (profile === undefined)
    throw new Error("destination.langfuse.profile.unavailable");
  return profile;
};

const isJsonResponseContentType = (value: string | undefined): boolean => {
  if (value === undefined || value.length > 256) return false;
  const segments = value.split(";");
  if (segments.shift()?.trim().toLowerCase() !== "application/json")
    return false;
  if (segments.length === 0) return true;
  if (segments.length !== 1) return false;
  return /^charset\s*=\s*(?:utf-8|"utf-8")$/iu.test(segments[0]!.trim());
};

const createLangfuseReporter = (
  context: ReporterFactoryContext<LangfuseDestinationSettings>,
) => {
  /* v8 ignore next 2 -- this remote descriptor can be constructed only with an exact prepared endpoint and its bound transport. */
  if (context.transport === null || context.endpoint === null)
    throw new Error("destination.langfuse.transport.unavailable");
  const transport = context.transport;
  const profile = profileFor(context.settings.profileId);
  const authorization = createAuthorization(context);
  const headers = Object.freeze({
    authorization,
    "content-type": context.settings.encoding,
    ...profile.reporter.headers,
  });
  return createDestinationReporter({
    report: async ({ traces, signal, deadline }) => {
      let body: Uint8Array;
      try {
        body = encodeLangfuseOtlpJsonBatch(traces);
      } catch {
        return createReporterReceipt("rejected");
      }
      const response = await executeBoundDestinationRequest(transport, {
        method: "POST",
        pathAndQuery: profile.reporter.path,
        headers,
        body,
        signal,
        deadline,
      });
      if (response.status === 429) return createReporterReceipt("unavailable");
      if (response.status >= 300 && response.status < 500)
        return createReporterReceipt("rejected");
      if (response.status !== 200)
        return createReporterReceipt("outcome-unknown");
      if (!isJsonResponseContentType(response.headers["content-type"]))
        return createReporterReceipt("outcome-unknown");
      const acknowledgement = readOtlpExportJsonResponse(response.body);
      if (
        !acknowledgement.ok ||
        acknowledgement.response.partialSuccessPresent ||
        acknowledgement.response.rejectedSpans !== "0"
      )
        return createReporterReceipt("outcome-unknown");
      return createReporterReceipt("accepted");
    },
  });
};

export const langfuseDestinationDescriptor: DestinationDescriptor<LangfuseDestinationSettings> =
  defineDestinationDescriptor({
    descriptorVersion: 1,
    destinationType: "@agentscope/destination-langfuse",
    commandName: "langfuse",
    settingsVersion: 1,
    settingsSchema,
    defaultSettings: {
      endpoint: "https://cloud.langfuse.com",
      allowInsecureLoopback: false,
      profileId: "langfuse-cloud-v4",
      compatibilityManifestId: LANGFUSE_COMPATIBILITY_MANIFEST.manifestId,
      encoding: "application/json",
    },
    credentialSlots: [
      { id: publicKeySlot, required: true },
      { id: secretKeySlot, required: true },
    ],
    documentationPath: "/docs/cli/destination/configure",
    deliveryIdentitySupport: "duplicates-possible",
    transport: {
      kind: "remote",
      resolveEndpoint: (settings) => ({
        url: settings.endpoint,
        allowInsecureLoopback: settings.allowInsecureLoopback,
      }),
    },
    createReporter: createLangfuseReporter,
    createRetriever: createLangfuseRetriever,
    retrievalOrdering: "start-time-desc-provider",
  });
