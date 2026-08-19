export {
  DestinationDescriptorError,
  compileDestinationRegistry,
  defineDestinationDescriptor,
  getDestinationDescriptor,
  isDestinationDescriptor,
  parseDestinationSettings,
  type DeliveryIdentitySupport,
  type DestinationDescriptor,
  type DestinationDescriptorInput,
  type DestinationRegistry,
  type DestinationSettings,
  type DestinationTransportDeclaration,
} from "./descriptor.js";
export {
  DestinationIdentityError,
  createCredentialSlotId,
  createDestinationCommandName,
  createDestinationConnectionId,
  createDestinationTypeId,
  type CredentialSlotId,
  type DestinationCommandName,
  type DestinationConnectionId,
  type DestinationTypeId,
} from "./identity.js";
export type { JsonObject, JsonValue } from "./plain-data.js";
