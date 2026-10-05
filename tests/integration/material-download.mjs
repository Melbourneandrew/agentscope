/** One bounded request/response kernel; redirects are acquisition-only data. */
import { request } from "node:https";
import { performance } from "node:perf_hooks";
import { rootCertificates } from "node:tls";
const remaining = (deadline) => {
  const value = Math.floor(deadline - performance.now());
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("integration.harness-material.failed");
  return value;
};
export const classifyMaterialResponseForTesting = (response, expectedBytes) => {
  if (response.statusCode === 429) return "rate-limit";
  if (response.statusCode >= 500 && response.statusCode <= 599)
    return "upstream";
  if (response.statusCode !== 200) return "status";
  if (response.headers.location !== undefined) return "redirect";
  if (response.headers["content-encoding"] !== undefined) return "encoding";
  if (
    response.headers["content-length"] !== undefined &&
    response.headers["content-length"] !== String(expectedBytes)
  ) {
    const observed = response.headers["content-length"];
    if (typeof observed !== "string" || !/^[0-9]+$/u.test(observed))
      return "hdr-invalid";
    const length = BigInt(observed);
    if (length === BigInt(expectedBytes)) return "hdr-noncanon";
    return length < BigInt(expectedBytes) ? "hdr-short" : "hdr-long";
  }
};

const responsePolicy = (response, descriptor, mode) => {
  if (mode === "release-asset" && response.statusCode === 302) {
    let redirect;
    const raw = response.headers.location;
    try {
      if (
        typeof raw !== "string" ||
        raw.length < 1 ||
        raw.length > 16_384 ||
        Array.from(raw).some(
          (character) =>
            character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error();
      const url = new URL(raw);
      if (
        !authorizedMaterialUrl(url) ||
        url.hostname !== "release-assets.githubusercontent.com" ||
        url.href !== raw
      )
        throw new Error();
      redirect = url.href;
    } catch {
      return { rejection: "redirect", maximumBytes: 16_384 };
    }
    const length = response.headers["content-length"];
    const validLength =
      typeof length === "string" && /^(?:0|[1-9][0-9]{0,4})$/u.test(length);
    const rejection =
      response.headers["content-encoding"] !== undefined
        ? "encoding"
        : length !== undefined && (!validLength || Number(length) > 16_384)
          ? "size"
          : undefined;
    return {
      redirect,
      rejection,
      expectedBytes: validLength ? Number(length) : undefined,
      maximumBytes: 16_384,
    };
  }
  const metadata = mode === true;
  const advertised = response.headers["content-length"];
  const expectedBytes = metadata
    ? typeof advertised === "string" && /^[1-9][0-9]{0,5}$/u.test(advertised)
      ? Number(advertised)
      : undefined
    : descriptor.bytes;
  const rejection =
    metadata && advertised !== undefined && expectedBytes === undefined
      ? "hdr-invalid"
      : metadata && expectedBytes > descriptor.maximumBytes
        ? "size"
        : classifyMaterialResponseForTesting(response, expectedBytes);
  return {
    expectedBytes,
    rejection,
    maximumBytes: metadata ? descriptor.maximumBytes : descriptor.bytes,
  };
};
const materialRequestOptions = (url) => ({
  agent: false,
  ca: rootCertificates,
  hostname: url.hostname,
  maxHeaderSize: 16 * 1024,
  method: "GET",
  path: `${url.pathname}${url.search}`,
  protocol: "https:",
  rejectUnauthorized: true,
  servername: url.hostname,
});
const authorizedMaterialUrl = (url) =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  url.hash === "" &&
  url.port === "";

export const downloadMaterialObject = (
  descriptor,
  signal,
  deadline,
  transport = request,
  metadata = false,
) =>
  new Promise((resolveDownload, rejectDownload) => {
    if (signal.aborted) {
      rejectDownload(new Error("interrupted"));
      return;
    }
    const url = new URL(descriptor.tarballUrl ?? descriptor.url);
    if (!authorizedMaterialUrl(url)) {
      rejectDownload(new Error("registry identity"));
      return;
    }
    let settled = false;
    let requestHandle;
    let responseHandle;
    let terminalError;
    let terminalValue;
    let requestClosed = false;
    let responseClosed = false;
    const chunks = [];
    let bytes = 0;
    const settle = () => {
      if (settled) return;
      if (terminalError === undefined) {
        if (signal.aborted) terminalError = new Error("interrupted");
        else if (performance.now() >= deadline)
          terminalError = new Error("deadline");
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (terminalError === undefined && terminalValue !== undefined)
        resolveDownload(terminalValue);
      else rejectDownload(terminalError ?? new Error("incomplete"));
    };
    const maybeSettle = () => {
      if (requestClosed && (responseHandle === undefined || responseClosed))
        settle();
    };
    const stop = (error) => {
      terminalError ??= error;
      responseHandle?.destroy();
      requestHandle?.destroy();
    };
    const onAbort = () => stop(new Error("interrupted"));
    const timer = setTimeout(
      () => stop(new Error("deadline")),
      remaining(deadline),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    requestHandle = transport(materialRequestOptions(url), (response) => {
      responseHandle = response;
      const policy = responsePolicy(response, descriptor, metadata);
      const { expectedBytes, rejection, redirect, maximumBytes } = policy;
      response.once("aborted", () => stop(new Error("incomplete")));
      response.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > maximumBytes) stop(new Error("size"));
        else if (redirect === undefined) chunks.push(chunk);
      });
      response.once("error", stop);
      response.once("end", () => {
        if (
          (redirect === undefined && bytes < 1) ||
          (expectedBytes !== undefined && bytes !== expectedBytes) ||
          ((metadata || redirect !== undefined) && !response.complete)
        )
          stop(new Error("size"));
        else terminalValue = redirect ?? Buffer.concat(chunks);
      });
      response.once("close", () => {
        responseClosed = true;
        if (metadata && terminalValue === undefined)
          terminalError ??= new Error("incomplete");
        maybeSettle();
      });
      if (rejection !== undefined) stop(new Error(rejection));
    });
    requestHandle.once("error", stop);
    requestHandle.once("close", () => {
      requestClosed = true;
      maybeSettle();
    });
    requestHandle.end();
  });
