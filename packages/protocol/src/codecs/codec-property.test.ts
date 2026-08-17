import { toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { ExportTraceServiceRequestSchema } from "../generated/otlp/opentelemetry/proto/collector/trace/v1/trace_service_pb.js";
import { isRedactedCanonicalTrace } from "../schema/redacted-envelope.js";
import canonicalFixture from "../testing/fixtures/sanitized-canonical-trace.json" with { type: "json" };
import { CODEC_PROFILE } from "./codec-profile.js";
import { parseBoundedJson } from "./json-parser.js";
import { protobufMessageFromParsedJson } from "./json-to-protobuf.js";
import {
  readExternalOtlpJson,
  readExternalOtlpProtobuf,
} from "./otlp-reader.js";
import { snapshotProtobufInput } from "./protobuf-preflight.js";

const requestJson = JSON.stringify({
  resourceSpans: canonicalFixture.resourceSpans,
});

const requestMessage = () =>
  protobufMessageFromParsedJson(
    ExportTraceServiceRequestSchema,
    parseBoundedJson(requestJson, {
      maximumBytes: CODEC_PROFILE.externalReceiver.budgets.maximumJsonBytes,
      maximumDepth: CODEC_PROFILE.externalReceiver.budgets.maximumDepth,
      maximumNodes: CODEC_PROFILE.externalReceiver.budgets.maximumNodes,
      maximumObjectKeys:
        CODEC_PROFILE.externalReceiver.budgets.maximumObjectKeys,
      maximumArrayItems:
        CODEC_PROFILE.externalReceiver.budgets.maximumArrayItems,
      maximumStringBytes:
        CODEC_PROFILE.externalReceiver.budgets.maximumStringBytes,
    }),
  );

const assertFixedUnbrandedResult = (result: unknown) => {
  expect(Object.isFrozen(result)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /Error|stack|cause|CANARY_SECRET/u,
  );
  expect(isRedactedCanonicalTrace(result)).toBe(false);
};

describe("seeded codec property and metamorphic evidence", () => {
  it("is total with fixed unbranded results over deterministic hostile byte mutations", () => {
    const valid = toBinary(ExportTraceServiceRequestSchema, requestMessage());
    let seed = 0x6d2b_79f5;
    const next = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    for (let iteration = 0; iteration < 512; iteration += 1) {
      const length = next() % 257;
      const bytes = Uint8Array.from({ length }, () => next() & 255);
      if (iteration % 4 === 0 && valid.length > 0) {
        const position = next() % valid.length;
        bytes.set(valid.subarray(0, Math.min(bytes.length, valid.length)));
        if (position < bytes.length)
          bytes[position] = bytes[position]! ^ (1 << (next() % 8));
      }
      assertFixedUnbrandedResult(readExternalOtlpProtobuf(bytes));
      assertFixedUnbrandedResult(readExternalOtlpJson(bytes));
    }
  });

  it("keeps JSON and protobuf normalization equivalent for the same request", () => {
    const binary = toBinary(ExportTraceServiceRequestSchema, requestMessage());
    const jsonResult = readExternalOtlpJson(requestJson);
    const binaryResult = readExternalOtlpProtobuf(binary);
    expect(binaryResult).toEqual(jsonResult);
    assertFixedUnbrandedResult(jsonResult);
    if (jsonResult.ok)
      for (const unit of jsonResult.batch.units)
        expect(isRedactedCanonicalTrace(unit)).toBe(false);
  });

  it("uses one deterministic owned snapshot despite later caller mutation", () => {
    const source = toBinary(ExportTraceServiceRequestSchema, requestMessage());
    const snapshot = snapshotProtobufInput(
      source,
      CODEC_PROFILE.externalReceiver.budgets.maximumProtobufBytes,
    );
    const expected = readExternalOtlpProtobuf(snapshot);
    source.fill(0xff);
    expect(readExternalOtlpProtobuf(snapshot)).toEqual(expected);
    expect(readExternalOtlpProtobuf(source)).not.toEqual(expected);
    assertFixedUnbrandedResult(expected);
  });
});
