import { fromBinary } from "@bufbuild/protobuf";

import {
  ExportTraceServiceResponseSchema,
  type ExportTraceServiceResponse,
} from "../generated/otlp/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import { deepFreeze } from "../schema/immutable.js";
import { CODEC_PROFILE } from "./codec-profile.js";
import { parseBoundedJson } from "./json-parser.js";
import { protobufMessageFromParsedJson } from "./json-to-protobuf.js";
import {
  preflightProtobufMessage,
  snapshotProtobufInput,
} from "./protobuf-preflight.js";

export type OtlpExportResponseSummary = Readonly<{
  kind: "otlp-export-response";
  partialSuccessPresent: boolean;
  rejectedSpans: string;
  warningPresent: boolean;
}>;

export type OtlpExportResponseReadResult =
  | Readonly<{ ok: true; response: OtlpExportResponseSummary }>
  | Readonly<{ ok: false; code: "protocol.reader.invalid" }>;

const invalid = deepFreeze({
  ok: false as const,
  code: "protocol.reader.invalid" as const,
});
const budgets = CODEC_PROFILE.externalReceiver.budgets;

const resultFor = (
  response: ExportTraceServiceResponse,
): OtlpExportResponseReadResult => {
  const partial = response.partialSuccess;
  if (partial !== undefined && partial.rejectedSpans < 0n) return invalid;
  const rejectedSpans = partial?.rejectedSpans ?? 0n;
  const warningPresent =
    partial !== undefined &&
    partial.rejectedSpans === 0n &&
    partial.errorMessage.length > 0;
  return deepFreeze({
    ok: true,
    response: {
      kind: "otlp-export-response",
      partialSuccessPresent:
        partial !== undefined &&
        (partial.rejectedSpans !== 0n || partial.errorMessage.length > 0),
      rejectedSpans: rejectedSpans.toString(),
      warningPresent,
    },
  });
};

export const readOtlpExportJsonResponse = (
  input: unknown,
): OtlpExportResponseReadResult => {
  try {
    const parsed = parseBoundedJson(input, {
      maximumBytes: budgets.maximumJsonBytes,
      maximumDepth: budgets.maximumDepth,
      maximumNodes: budgets.maximumNodes,
      maximumObjectKeys: budgets.maximumObjectKeys,
      maximumArrayItems: budgets.maximumArrayItems,
      maximumStringBytes: budgets.maximumStringBytes,
    });
    return resultFor(
      protobufMessageFromParsedJson(ExportTraceServiceResponseSchema, parsed),
    );
  } catch {
    return invalid;
  }
};

export const readOtlpExportProtobufResponse = (
  input: unknown,
): OtlpExportResponseReadResult => {
  try {
    const bytes = snapshotProtobufInput(input, budgets.maximumProtobufBytes);
    preflightProtobufMessage(bytes, ExportTraceServiceResponseSchema, {
      maximumBytes: budgets.maximumProtobufBytes,
      maximumDepth: budgets.maximumDepth,
      maximumFields: budgets.maximumWireFields,
      maximumLengthDelimitedBytes: budgets.maximumLengthDelimitedBytes,
    });
    return resultFor(
      fromBinary(ExportTraceServiceResponseSchema, bytes, {
        readUnknownFields: false,
        recursionLimit: budgets.maximumDepth,
      }),
    );
  } catch {
    return invalid;
  }
};
