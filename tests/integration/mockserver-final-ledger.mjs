/** Same upstream final ledger projection; no service or secondary authority. */
import { createHash } from "node:crypto";
import { types } from "node:util";

const maximumBytes = 1024 * 1024;
const failure = () => {
  throw new Error("integration.mockserver.control");
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const trafficFields = Object.freeze([
  "method",
  "path",
  "role",
  "status",
  "bodyBytes",
  "bodySha256",
]);
/** Untrusted client observations only; the final server comparison remains mandatory. */
export const snapshotMockServerTraffic = (value, runId) => {
  const own = (record, fields) => {
    if (record === null || typeof record !== "object" || types.isProxy(record))
      failure();
    const descriptors = Object.getOwnPropertyDescriptors(record);
    if (
      Reflect.ownKeys(descriptors).length !== fields.length ||
      fields.some(
        (key) =>
          descriptors[key]?.enumerable !== true ||
          !Object.hasOwn(descriptors[key], "value"),
      )
    )
      failure();
    return Object.fromEntries(
      fields.map((key) => [key, descriptors[key].value]),
    );
  };
  const envelope = own(value, ["runId", "entries"]);
  if (
    !/^[a-f0-9]{16}$/u.test(runId ?? "") ||
    envelope.runId !== runId ||
    types.isProxy(envelope.entries) ||
    !Array.isArray(envelope.entries) ||
    envelope.entries.length > 16
  )
    failure();
  const entries = [];
  for (let index = 0; index < envelope.entries.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(
      envelope.entries,
      String(index),
    );
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
      failure();
    const row = own(descriptor.value, trafficFields);
    if (
      typeof row.method !== "string" ||
      typeof row.path !== "string" ||
      !/^(?:GET|PUT|POST)$/u.test(row.method) ||
      !/^\/[a-zA-Z0-9._/-]{1,255}$/u.test(row.path) ||
      ![
        "allowed",
        "forbidden",
        "unauthenticated",
        "readiness",
        "data-plane",
      ].includes(row.role) ||
      !Number.isInteger(row.status) ||
      row.status < 100 ||
      row.status > 599 ||
      !Number.isSafeInteger(row.bodyBytes) ||
      row.bodyBytes < 0 ||
      row.bodyBytes > maximumBytes ||
      typeof row.bodySha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.bodySha256)
    )
      failure();
    entries.push(Object.freeze(Object.assign(Object.create(null), row)));
  }
  if (Reflect.ownKeys(envelope.entries).length !== entries.length + 1)
    failure();
  return Object.freeze({ runId, entries: Object.freeze(entries) });
};
const finalMetadata = (headers, body) => {
  const keys = Object.keys(headers).filter((key) =>
    key.startsWith("x-agentscope-final-"),
  );
  if (keys.length === 0) return undefined;
  const value = (name) => {
    const values = headers[`x-agentscope-final-${name}`];
    if (
      !Array.isArray(values) ||
      values.length !== 1 ||
      typeof values[0] !== "string"
    )
      failure();
    return values[0];
  };
  const role = value("role"),
    statusText = value("status");
  if (
    !/^[1-5][0-9]{2}$/u.test(statusText) ||
    ![
      "allowed",
      "forbidden",
      "unauthenticated",
      "readiness",
      "data-plane",
    ].includes(role)
  )
    failure();
  let bodyBytes = body.length,
    bodySha256 = digest(body);
  if (role !== "data-plane") {
    const size = value("bytes"),
      sha = value("sha256");
    if (
      body.length !== 0 ||
      Object.keys(headers).length !== 4 ||
      !/^(?:0|[1-9][0-9]{0,6})$/u.test(size) ||
      Number(size) > maximumBytes ||
      !/^[a-f0-9]{64}$/u.test(sha)
    )
      failure();
    bodyBytes = Number(size);
    bodySha256 = sha;
  }
  if (keys.length !== (role === "data-plane" ? 2 : 4)) failure();
  return { role, status: Number(statusText), bodyBytes, bodySha256 };
};
const bodyBytes = (body) => {
  if (typeof body === "string") return Buffer.from(body);
  if (body === undefined) return Buffer.alloc(0);
  if (body === null || typeof body !== "object") failure();
  if (typeof body.rawBytes === "string") {
    const decoded = Buffer.from(body.rawBytes, "base64");
    if (decoded.toString("base64") !== body.rawBytes) failure();
    return decoded;
  }
  if (body.type === "STRING" && typeof body.string === "string")
    return Buffer.from(body.string);
  if (body.type === "JSON" && typeof body.json === "string")
    return Buffer.from(body.json);
  if (body.type === "BINARY" && typeof body.base64Bytes === "string") {
    const decoded = Buffer.from(body.base64Bytes, "base64");
    if (decoded.toString("base64") !== body.base64Bytes) failure();
    return decoded;
  }
  failure();
};
const promptOccurrences = (value, hash) => {
  const pending = [value];
  let visited = 0;
  let count = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (++visited > 8192) failure();
    if (typeof item === "string") count += digest(item) === hash ? 1 : 0;
    else if (item !== null && typeof item === "object") {
      const children = Object.values(item);
      if (pending.length + children.length > 8192) failure();
      pending.push(...children);
    }
  }
  return count;
};
/** Provisional retrieval and final ledger use the SAME upstream serializer. */
export const projectMockServerRequests = (bytes, promptSha256) => {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximumBytes) failure();
  const requests = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!Array.isArray(requests) || requests.length > 16) failure();
  return Object.freeze(
    requests.map((entry) => {
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.method !== "string" ||
        typeof entry.path !== "string"
      )
        failure();
      const body = bodyBytes(entry.body);
      if (body.length > maximumBytes) failure();
      const headers = entry.headers ?? {};
      const metadata = finalMetadata(headers, body);
      let occurrences = 0;
      let modelSha256 = null;
      if (
        promptSha256 !== undefined &&
        (metadata === undefined || metadata.role === "data-plane")
      ) {
        const decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body),
        );
        occurrences = promptOccurrences(decoded, promptSha256);
        if (typeof decoded?.model === "string")
          modelSha256 = digest(decoded.model);
      }
      const credentialCount = Object.keys(headers)
        .filter((key) => /^(?:authorization|x-api-key|api-key)$/iu.test(key))
        .reduce(
          (sum, key) =>
            sum + (Array.isArray(headers[key]) ? headers[key].length : 1),
          0,
        );
      return Object.freeze({
        method: entry.method,
        path: entry.path,
        bodyBytes: body.length,
        bodySha256: digest(body),
        modelSha256,
        promptOccurrenceCount: occurrences,
        credentialHeaderCount: credentialCount,
        ...(metadata ?? {}),
      });
    }),
  );
};
/** Independent terminal service observation, never the candidate's pass claim. */
const assertClaudeFinalModelLedger = (
  ledger,
  fixture,
  routeFixture,
  scenario,
) => {
  const native = fixture?.harnessObservation;
  const hashes = native?.modelRequestBodySha256;
  const routes = routeFixture.routes.filter(
    (route) => route.routeId === "anthropic-messages",
  );
  if (
    scenario.modelRoutes.length !== 1 ||
    scenario.modelRoutes[0] !== "anthropic-messages" ||
    routes.length !== 1 ||
    routes[0].method !== "POST" ||
    routes[0].path !== "/v1/messages" ||
    native?.kind !== "claude-code-native" ||
    !Array.isArray(hashes) ||
    hashes.length !== 2 ||
    [0, 1].some(
      (index) =>
        typeof hashes[index] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(hashes[index]),
    ) ||
    ledger.length !== 2 ||
    ledger.some(
      (entry, index) =>
        entry.method !== routes[0].method ||
        entry.path !== routes[0].path ||
        entry.bodySha256 !== hashes[index],
    )
  )
    failure();
};

export const assertMockServerFinalLedger = (
  ledger,
  fixture,
  routeFixture,
  scenario,
  comparison,
) => {
  if (
    comparison === null ||
    typeof comparison !== "object" ||
    types.isProxy(comparison)
  )
    failure();
  const fields = Object.getOwnPropertyDescriptors(comparison);
  if (
    Reflect.ownKeys(fields).length !== 2 ||
    ["traffic", "runId"].some(
      (key) =>
        fields[key]?.enumerable !== true ||
        !Object.hasOwn(fields[key], "value"),
    )
  )
    failure();
  const traffic = fields.traffic.value,
    runId = fields.runId.value;
  if (!Array.isArray(ledger) || ledger.length > 16 || traffic === undefined)
    failure();
  const observed = snapshotMockServerTraffic(traffic, runId).entries;
  if (
    ledger.length !== observed.length ||
    ledger.some((row, index) =>
      trafficFields.some((field) => row[field] !== observed[index][field]),
    )
  )
    failure();
  // Derive the legacy model-only view ONLY after all received traffic was bound.
  ledger = ledger.filter((row) => row.role === "data-plane");
  const entries = fixture?.modelLedger?.entries;
  if (
    !Array.isArray(entries) ||
    !Array.isArray(ledger) ||
    entries.length !== ledger.length ||
    ledger.some(
      (entry, index) =>
        entry.method !== entries[index].method ||
        entry.path !== entries[index].path ||
        entry.bodyBytes !== entries[index].bodyBytes,
    )
  )
    failure();
  if (scenario.scenarioId === "codex-tui-trace-smoke") {
    if (
      ledger.length !== 1 ||
      ledger[0].bodySha256 !==
        fixture?.harnessObservation?.modelRequestBodySha256
    )
      failure();
    return;
  }
  if (scenario.scenarioId === "claude-interactive-trace-smoke") {
    assertClaudeFinalModelLedger(ledger, fixture, routeFixture, scenario);
    return;
  }
  const expected = scenario.modelRoutes.map((routeId) => {
    const routes = routeFixture.routes.filter(
      (route) => route.routeId === routeId,
    );
    if (routes.length !== 1) failure();
    const route = routes[0];
    return {
      method: route.method,
      path: route.path,
      bodySha256: digest(JSON.stringify(route.requestBody)),
    };
  });
  expected.push({
    method: "GET",
    path: "/agentscope-unmatched",
    bodySha256: digest(Buffer.alloc(0)),
  });
  if (
    ledger.length !== expected.length ||
    ledger.some(
      (entry, index) =>
        entry.method !== expected[index].method ||
        entry.path !== expected[index].path ||
        entry.bodySha256 !== expected[index].bodySha256,
    )
  )
    failure();
};
