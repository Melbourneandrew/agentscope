import {
  MAXIMUM_TRANSPORT_RESPONSE_BYTES,
  reporterDeadlineRemainingMilliseconds,
  type DestinationTransportResponse,
} from "@agentscope/destinations-core";
import type { PrepareCoreRetrievalRuntimeInput } from "@agentscope/core/retrieval-orchestration";

type DestinationTransportExecutor =
  PrepareCoreRetrievalRuntimeInput["transportExecutor"];

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
]);
const textEncoder = new TextEncoder();

const readBoundedBody = async (response: Response): Promise<Uint8Array> => {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAXIMUM_TRANSPORT_RESPONSE_BYTES)
        throw new Error("destination.transport.response-too-large");
      chunks.push(next.value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The original bounded-read failure remains authoritative.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const readBoundedHeaders = (
  response: Response,
): Readonly<Record<string, string>> => {
  const headers: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let count = 0;
  let totalBytes = 0;
  for (const [name, value] of response.headers) {
    if (FORBIDDEN_RESPONSE_HEADERS.has(name)) continue;
    count += 1;
    totalBytes +=
      textEncoder.encode(name).byteLength +
      textEncoder.encode(value).byteLength;
    if (count > 64 || totalBytes > 32_768)
      throw new Error("destination.transport.response-headers-too-large");
    headers[name] = value;
  }
  return Object.freeze(headers);
};

export const productionDestinationTransportExecutor: DestinationTransportExecutor =
  async (request): Promise<DestinationTransportResponse> => {
    const remaining = reporterDeadlineRemainingMilliseconds(request.deadline);
    if (request.signal.aborted || remaining <= 0)
      throw new Error("destination.transport.deadline-exceeded");
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    const signal = AbortSignal.any([request.signal, timeout]);
    const response = await fetch(request.url, {
      ...(request.body === undefined
        ? {}
        : { body: Buffer.from(request.body) }),
      credentials: "omit",
      headers: request.headers,
      method: request.method,
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal,
    });
    try {
      const headers = readBoundedHeaders(response);
      const body = await readBoundedBody(response);
      return Object.freeze({
        body,
        headers,
        status: response.status,
      });
    } catch (error) {
      try {
        await response.body?.cancel();
      } catch {
        // The original bounded-response failure remains authoritative.
      }
      throw error;
    }
  };
