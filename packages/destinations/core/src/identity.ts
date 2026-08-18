declare const destinationIdentityBrand: unique symbol;

export type DestinationTypeId = string & {
  readonly [destinationIdentityBrand]: "DestinationTypeId";
};
export type DestinationCommandName = string & {
  readonly [destinationIdentityBrand]: "DestinationCommandName";
};
export type DestinationConnectionId = string & {
  readonly [destinationIdentityBrand]: "DestinationConnectionId";
};
export type CredentialSlotId = string & {
  readonly [destinationIdentityBrand]: "CredentialSlotId";
};

export class DestinationIdentityError extends Error {
  public readonly code = "destination.identity.invalid";

  public constructor() {
    super("destination.identity.invalid");
    this.name = "DestinationIdentityError";
  }
}

const requireString = (
  value: unknown,
  maximumLength: number,
  pattern: RegExp,
): string => {
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    !pattern.test(value)
  )
    throw new DestinationIdentityError();
  return value;
};

export const createDestinationTypeId = (value: unknown): DestinationTypeId =>
  requireString(
    value,
    128,
    /^@agentscope\/destination-[a-z0-9]+(?:-[a-z0-9]+)*$/,
  ) as DestinationTypeId;

export const createDestinationCommandName = (
  value: unknown,
): DestinationCommandName =>
  requireString(
    value,
    64,
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  ) as DestinationCommandName;

export const createDestinationConnectionId = (
  value: unknown,
): DestinationConnectionId =>
  requireString(
    value,
    90,
    /^destination-connection-v1-[0-9a-f]{64}$/,
  ) as DestinationConnectionId;

export const createCredentialSlotId = (value: unknown): CredentialSlotId =>
  requireString(
    value,
    64,
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  ) as CredentialSlotId;
