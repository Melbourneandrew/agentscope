import type { W3CTraceId } from "@agentscope/protocol";

import {
  createDestinationConnectionId,
  createDestinationTypeId,
  type DestinationConnectionId,
  type DestinationTypeId,
} from "./identity.js";

declare const traceLocatorBrand: unique symbol;

export type TraceLocator = Readonly<{
  connectionId: DestinationConnectionId;
  destinationType: DestinationTypeId;
  traceId: W3CTraceId;
  destinationTraceId?: string;
  destinationRevision?: string;
  readonly [traceLocatorBrand]: true;
}>;

export type TraceLocatorInput = Readonly<{
  connectionId: DestinationConnectionId;
  destinationType: DestinationTypeId;
  traceId: string;
  destinationTraceId?: string;
  destinationRevision?: string;
}>;

const locatorRegistry = new WeakSet<object>();
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const textEncoder = new TextEncoder();

export class RetrievalIdentityError extends Error {
  public readonly code = "destination.retrieval-identity.invalid";

  public constructor() {
    super("destination.retrieval-identity.invalid");
    this.name = "RetrievalIdentityError";
  }
}

const invalid = (): never => {
  throw new RetrievalIdentityError();
};

const valueOf = (descriptors: PropertyDescriptorMap, key: string): unknown => {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor)) return invalid();
  return descriptor.value;
};

const canonicalTraceId = (value: unknown): W3CTraceId => {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{32}$/u.test(value) ||
    value === "0".repeat(32)
  )
    return invalid();
  return value as W3CTraceId;
};

const destinationNativeId = (value: unknown, maximumBytes = 1_024): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    textEncoder.encode(value).byteLength > maximumBytes ||
    /\p{Cc}/u.test(value)
  )
    return invalid();
  return value;
};

export const createTraceLocator = (input: TraceLocatorInput): TraceLocator => {
  try {
    if (typeof input !== "object" || input === null) return invalid();
    const descriptors = objectGetOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      (keys as string[]).sort().join(",") !==
        [
          "connectionId",
          ...((keys as string[]).includes("destinationRevision")
            ? ["destinationRevision"]
            : []),
          ...((keys as string[]).includes("destinationTraceId")
            ? ["destinationTraceId"]
            : []),
          "destinationType",
          "traceId",
        ].join(",")
    )
      return invalid();
    const destinationTraceId = descriptors.destinationTraceId
      ? destinationNativeId(valueOf(descriptors, "destinationTraceId"))
      : undefined;
    const destinationRevision = descriptors.destinationRevision
      ? destinationNativeId(valueOf(descriptors, "destinationRevision"), 256)
      : undefined;
    const locator = Object.freeze({
      connectionId: createDestinationConnectionId(
        valueOf(descriptors, "connectionId"),
      ),
      destinationType: createDestinationTypeId(
        valueOf(descriptors, "destinationType"),
      ),
      traceId: canonicalTraceId(valueOf(descriptors, "traceId")),
      ...(destinationRevision === undefined ? {} : { destinationRevision }),
      ...(destinationTraceId === undefined ? {} : { destinationTraceId }),
    }) as TraceLocator;
    locatorRegistry.add(locator);
    return locator;
  } catch {
    return invalid();
  }
};

export const isTraceLocator = (value: unknown): value is TraceLocator =>
  typeof value === "object" && value !== null && locatorRegistry.has(value);
