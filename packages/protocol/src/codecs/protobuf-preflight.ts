import {
  ScalarType,
  type DescField,
  type DescMessage,
} from "@bufbuild/protobuf";

export type ProtobufPreflightLimits = Readonly<{
  maximumBytes: number;
  maximumDepth: number;
  maximumFields: number;
  maximumLengthDelimitedBytes: number;
}>;

export class ProtobufPreflightError extends Error {
  public constructor() {
    super("protocol.codec.invalid");
    this.name = "ProtobufPreflightError";
  }
}

const invalid = (): never => {
  throw new ProtobufPreflightError();
};

export const snapshotProtobufInput = (input: unknown, maximumBytes: number) => {
  try {
    if (!(input instanceof Uint8Array) || input.byteLength > maximumBytes)
      invalid();
    return new Uint8Array(input as Uint8Array);
  } catch {
    throw new ProtobufPreflightError();
  }
};

const expectedWireType = (field: DescField): readonly number[] => {
  if (field.fieldKind === "message" || field.fieldKind === "map") return [2];
  if (field.fieldKind === "enum") return [0];
  if (field.fieldKind === "list" && field.listKind === "message") return [2];
  /* v8 ignore next -- the pinned OTLP v1.11 closure has no repeated enum field. */
  if (field.fieldKind === "list" && field.listKind === "enum")
    return field.packed ? [0, 2] : [0];
  const scalarWire =
    field.scalar === ScalarType.DOUBLE || field.scalar === ScalarType.FIXED64
      ? 1
      : field.scalar === ScalarType.FIXED32
        ? 5
        : field.scalar === ScalarType.STRING ||
            field.scalar === ScalarType.BYTES
          ? 2
          : 0;
  /* v8 ignore next -- the pinned OTLP closure has no repeated scalar field. */
  return field.fieldKind === "list" && field.packed
    ? [scalarWire, 2]
    : [scalarWire];
};

const nestedMessage = (field: DescField) => {
  if (field.fieldKind === "message") return field.message;
  if (field.fieldKind === "list" && field.listKind === "message")
    return field.message;
  return undefined;
};

type Frame = {
  schema?: DescMessage;
  position: number;
  end: number;
  depth: number;
  groupFieldNumber?: number;
};

const validateKnownField = (field: DescField, wireType: number) => {
  if (!expectedWireType(field).includes(wireType)) invalid();
};

type WireContext = {
  limits: ProtobufPreflightLimits;
  readVarint: (frame: Frame) => bigint;
};

const advanceWire = (
  frame: Frame,
  field: DescField | undefined,
  fieldNumber: number,
  wireType: number,
  context: WireContext,
): Frame | undefined => {
  if (wireType === 0) {
    context.readVarint(frame);
    return undefined;
  }
  if (wireType === 1) {
    frame.position += 8;
    return undefined;
  }
  if (wireType === 5) {
    frame.position += 4;
    return undefined;
  }
  if (wireType === 3) {
    if (field !== undefined || frame.depth + 1 > context.limits.maximumDepth)
      invalid();
    return {
      position: frame.position,
      end: frame.end,
      depth: frame.depth + 1,
      groupFieldNumber: fieldNumber,
    };
  }
  if (wireType !== 2) invalid();
  const length = context.readVarint(frame);
  if (
    length > BigInt(context.limits.maximumLengthDelimitedBytes) ||
    length > BigInt(Number.MAX_SAFE_INTEGER)
  )
    invalid();
  const end = frame.position + Number(length);
  if (end > frame.end) invalid();
  const nested = field === undefined ? undefined : nestedMessage(field);
  if (nested === undefined) {
    frame.position = end;
    return undefined;
  }
  if (frame.depth + 1 > context.limits.maximumDepth) invalid();
  return {
    schema: nested,
    position: frame.position,
    end,
    depth: frame.depth + 1,
  };
};

export const preflightProtobufMessage = (
  input: unknown,
  schema: DescMessage,
  limits: ProtobufPreflightLimits,
) => {
  try {
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength > limits.maximumBytes
    )
      invalid();
    const bytes = input as Uint8Array;
    let fields = 0;
    const readVarint = (frame: Frame) => {
      let value = 0n;
      for (let index = 0; index < 10; index += 1) {
        if (frame.position >= frame.end) invalid();
        const byte = bytes[frame.position++]!;
        value |= BigInt(byte & 0x7f) << BigInt(index * 7);
        if ((byte & 0x80) === 0) {
          if (index === 9 && byte > 1) invalid();
          return value;
        }
      }
      return invalid();
    };

    const stack: Frame[] = [
      {
        schema,
        position: 0,
        end: bytes.byteLength,
        depth: 0,
      },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.position === frame.end) {
        if (frame.groupFieldNumber !== undefined) invalid();
        stack.pop();
        if (stack.length > 0) stack[stack.length - 1]!.position = frame.end;
        continue;
      }
      if (frame.position > frame.end || ++fields > limits.maximumFields)
        invalid();
      const tag = readVarint(frame);
      const fieldNumber = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNumber <= 0 || fieldNumber > 536_870_911) invalid();
      if (wireType === 4) {
        if (frame.groupFieldNumber !== fieldNumber) invalid();
        stack.pop();
        /* v8 ignore next -- a matching end-group frame is created only beneath its parent frame. */
        if (stack.length === 0) invalid();
        stack[stack.length - 1]!.position = frame.position;
        continue;
      }
      const field = frame.schema?.fields.find(
        (candidate) => candidate.number === fieldNumber,
      );
      if (field !== undefined) validateKnownField(field, wireType);
      const nestedFrame = advanceWire(frame, field, fieldNumber, wireType, {
        limits,
        readVarint,
      });
      if (nestedFrame !== undefined) {
        stack.push(nestedFrame);
        continue;
      }
      if (frame.position > frame.end) invalid();
    }
  } catch {
    /* v8 ignore next -- fixed diagnostic rethrow is exercised, but V8 attributes it to the throw site. */
    throw new ProtobufPreflightError();
  }
};
