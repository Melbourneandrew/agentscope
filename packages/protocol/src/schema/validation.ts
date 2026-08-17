export const CANONICAL_INPUT_BUDGET = Object.freeze({
  maximumDepth: 24,
  maximumNodes: 100_000,
  maximumObjectKeys: 512,
  maximumStringCodeUnits: 2_000_000,
} as const);

export type ProtocolValidationCode =
  | "protocol.input.cyclic"
  | "protocol.input.depth"
  | "protocol.input.nodes"
  | "protocol.input.object-keys"
  | "protocol.input.object-shape"
  | "protocol.input.strings"
  | "protocol.schema.invalid";

export class ProtocolValidationError extends Error {
  public readonly code: ProtocolValidationCode;
  public readonly issues: readonly string[];

  public constructor(
    code: ProtocolValidationCode,
    issues: readonly string[] = [code],
  ) {
    super(code);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.issues = Object.freeze([...issues]);
  }
}

type PendingNode = { value: unknown; depth: number };

export const assertCanonicalInputBudget = (input: unknown) => {
  const pending: PendingNode[] = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stringCodeUnits = 0;

  while (pending.length > 0) {
    const item = pending.pop();
    const current = item!;
    nodes += 1;
    if (nodes > CANONICAL_INPUT_BUDGET.maximumNodes) {
      throw new ProtocolValidationError("protocol.input.nodes");
    }
    if (current.depth > CANONICAL_INPUT_BUDGET.maximumDepth) {
      throw new ProtocolValidationError("protocol.input.depth");
    }
    if (typeof current.value === "string") {
      stringCodeUnits += current.value.length;
      if (stringCodeUnits > CANONICAL_INPUT_BUDGET.maximumStringCodeUnits) {
        throw new ProtocolValidationError("protocol.input.strings");
      }
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) {
      continue;
    }
    if (seen.has(current.value)) {
      throw new ProtocolValidationError("protocol.input.cyclic");
    }
    seen.add(current.value);
    const prototype = Object.getPrototypeOf(current.value) as unknown;
    if (
      !Array.isArray(current.value) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new ProtocolValidationError("protocol.input.object-shape");
    }
    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    const entries = Object.entries(descriptors).filter(
      ([key]) => !(Array.isArray(current.value) && key === "length"),
    );
    if (entries.length > CANONICAL_INPUT_BUDGET.maximumObjectKeys) {
      throw new ProtocolValidationError("protocol.input.object-keys");
    }
    for (const [key, descriptor] of entries) {
      stringCodeUnits += key.length;
      if (stringCodeUnits > CANONICAL_INPUT_BUDGET.maximumStringCodeUnits) {
        throw new ProtocolValidationError("protocol.input.strings");
      }
      if (!("value" in descriptor)) {
        throw new ProtocolValidationError("protocol.input.object-shape");
      }
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
};
