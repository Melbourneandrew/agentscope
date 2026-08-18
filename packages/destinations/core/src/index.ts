export const destinationsCorePackageId =
  "@agentscope/destinations-core" as const;

export {
  compileDestinationRegistry,
  defineDestinationDescriptor,
  DestinationDescriptorError,
  getDestinationDescriptor,
  isDestinationDescriptor,
  parseDestinationSettings,
  type DeliveryIdentitySupport,
  type DestinationDescriptor,
  type DestinationDescriptorInput,
  type DestinationRegistry,
  type DestinationSettings,
  type DestinationTransportDeclaration,
  type RemoteEndpointCandidate,
  type ReporterFactoryContext,
} from "./descriptor.js";
export {
  isReporterDeadline,
  MAXIMUM_REPORTER_TIMEOUT_MILLISECONDS,
  ReporterDeadlineError,
  reporterDeadlineRemainingMilliseconds,
  type ReporterDeadline,
} from "./deadline.js";
export {
  DestinationEndpointError,
  isValidatedDestinationEndpoint,
  type DestinationEndpointPolicy,
  type ValidatedDestinationEndpoint,
} from "./endpoint.js";
export {
  createCredentialSlotId,
  createDestinationCommandName,
  createDestinationConnectionId,
  createDestinationTypeId,
  DestinationIdentityError,
  type CredentialSlotId,
  type DestinationCommandName,
  type DestinationConnectionId,
  type DestinationTypeId,
} from "./identity.js";
export {
  createDestinationReporter,
  createReporterReceipt,
  isDestinationReporter,
  MAXIMUM_REPORTER_BATCH_ITEMS,
  REPORTER_OUTCOMES,
  ReporterContractError,
  type RedactedTraceBatch,
  type Reporter,
  type ReporterAttempt,
  type ReporterImplementation,
  type ReporterOutcome,
  type ReporterReceipt,
} from "./reporter.js";
export {
  DestinationTransportError,
  executeBoundDestinationRequest,
  isBoundDestinationTransport,
  MAXIMUM_TRANSPORT_REQUEST_BYTES,
  MAXIMUM_TRANSPORT_RESPONSE_BYTES,
  type BoundDestinationTransport,
  type DestinationTransportRequest,
  type DestinationTransportResponse,
} from "./transport.js";
export {
  DestinationCredentialError,
  readReporterCredential,
  type CredentialSlot,
  type ReporterCredentialAccessor,
} from "./credentials.js";
export {
  DESTINATION_SETTINGS_LIMITS,
  DestinationDataError,
  type JsonObject,
  type JsonValue,
} from "./plain-data.js";
