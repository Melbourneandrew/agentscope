import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "vitest";

import {
  canonicalTerminalReceipts,
  createEngineClient,
  createLifecycleState,
  createProductionOperations,
  executeController,
  parseImagePullReceipt,
  parseTerminalReceipt,
  publishTerminalResult,
  reduceLifecycleState,
  serializeLifecycleState,
  validateTerminalReceipt,
} from "../pty-runtime-proof-controller.mjs";

const roots = [];
const servers = [];
const passingReceipt = Object.freeze({
  version: 1,
  stage: "final-assertion",
  status: "passed",
  errorCode: null,
  runtimeReceiptAuthenticated: true,
  cleanupProved: true,
  originalOutcome: "success",
  signal: null,
});
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise((resolveClose) => server.close(resolveClose));
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const operations = ({ failAt, cleanup = true, signalAt } = {}) => {
  let latch = () => false;
  const events = [];
  const operation = (name) => async () => {
    events.push(name);
    if (signalAt === name) {
      latch("SIGTERM");
      latch("SIGINT");
    }
    if (failAt === name) throw new Error("raw fixture diagnostic");
  };
  return {
    events,
    installSignalHandlers(value) {
      latch = value;
      return () => events.push("uninstall");
    },
    setup: operation("setup"),
    inputIdentity: operation("input-identity"),
    imageIdentity: operation("image-identity"),
    create: operation("create"),
    runtimeReceipt: operation("runtime-receipt"),
    terminalJoin: operation("terminal-join"),
    finalAssertion: operation("final-assertion"),
    async cleanup() {
      events.push("cleanup");
      if (signalAt === "cleanup") {
        latch("SIGTERM");
        latch("SIGINT");
      }
      if (failAt === "cleanup") throw new Error("raw cleanup diagnostic");
      return cleanup;
    },
  };
};

test("emits one closed receipt for every lifecycle failure prefix", async () => {
  for (const stage of [
    "setup",
    "input-identity",
    "image-identity",
    "create",
    "runtime-receipt",
    "terminal-join",
    "final-assertion",
  ]) {
    for (const cleanup of [true, false]) {
      const fixture = operations({ failAt: stage, cleanup });
      const result = await executeController({ operations: fixture });
      assert.equal(result.receipt.stage, stage);
      assert.equal(result.receipt.status, "failed");
      assert.equal(result.receipt.originalOutcome, "failure");
      assert.equal(result.receipt.errorCode, "unexpected-failure");
      assert.equal(result.receipt.cleanupProved, cleanup);
      assert.equal(
        result.receipt.runtimeReceiptAuthenticated,
        ["terminal-join", "final-assertion"].includes(stage),
      );
      assert.deepEqual(fixture.events.slice(-2), ["cleanup", "uninstall"]);
    }
  }
});

test("passes only after receipt, terminal join, and cleanup", async () => {
  const result = await executeController({ operations: operations() });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.receipt, {
    version: 1,
    stage: "final-assertion",
    status: "passed",
    errorCode: null,
    runtimeReceiptAuthenticated: true,
    cleanupProved: true,
    originalOutcome: "success",
    signal: null,
  });
});

test("latches first signal and executes cleanup once", async () => {
  for (const signalAt of ["setup", "create", "runtime-receipt", "cleanup"]) {
    const fixture = operations({ signalAt });
    const result = await executeController({ operations: fixture });
    assert.equal(result.exitCode, 143);
    assert.equal(result.receipt.signal, "SIGTERM");
    assert.equal(
      result.receipt.stage,
      signalAt === "cleanup" ? "cleanup" : signalAt,
    );
    assert.equal(
      fixture.events.filter((value) => value === "cleanup").length,
      1,
    );
  }
});

test("every reachable failure, signal, and cleanup event sequence serializes canonically", async () => {
  const stages = [
    "setup",
    "input-identity",
    "image-identity",
    "create",
    "runtime-receipt",
    "terminal-join",
    "final-assertion",
    "cleanup",
  ];
  for (const [failAt, signalAt, cleanup] of [undefined, ...stages].flatMap(
    (failAt) =>
      [undefined, ...stages].flatMap((signalAt) =>
        [false, true].map((cleanup) => [failAt, signalAt, cleanup]),
      ),
  )) {
    const result = await executeController({
      operations: operations({ cleanup, failAt, signalAt }),
    });
    assert.equal(validateTerminalReceipt(result.receipt), result.receipt);
    assert.deepEqual(
      parseTerminalReceipt(Buffer.from(`${JSON.stringify(result.receipt)}\n`)),
      result.receipt,
    );
  }
});

test("cleanup-time primary signal cannot masquerade as final-assertion signal", async () => {
  const result = await executeController({
    operations: operations({ signalAt: "cleanup" }),
  });
  assert.equal(result.receipt.stage, "cleanup");
  assert.equal(validateTerminalReceipt(result.receipt), result.receipt);
  const finalAssertionSignal = {
    ...result.receipt,
    stage: "final-assertion",
  };
  assert.equal(
    validateTerminalReceipt(finalAssertionSignal),
    finalAssertionSignal,
  );
  assert.notDeepEqual(result.receipt, finalAssertionSignal);
  assertRejectedReceipts([{ ...result.receipt, cleanupProved: true }]);
});

test("cleanup uncertainty cannot become success", async () => {
  for (const fixture of [
    operations({ cleanup: false }),
    operations({ failAt: "cleanup" }),
  ]) {
    const result = await executeController({ operations: fixture });
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.cleanupProved, false);
    assert.equal(result.receipt.originalOutcome, "uncertain");
    assert.equal(result.receipt.stage, "cleanup");
    assert.equal(result.receipt.errorCode, "cleanup-unproved");
  }
});

test("cleanup uncertainty preserves an earlier causal failure", async () => {
  const result = await executeController({
    operations: operations({ failAt: "image-identity", cleanup: false }),
  });
  assert.equal(result.receipt.stage, "image-identity");
  assert.equal(result.receipt.errorCode, "unexpected-failure");
  assert.equal(result.receipt.cleanupProved, false);
  assert.equal(result.receipt.originalOutcome, "failure");
});

test("a cleanup-time signal cannot overwrite an earlier causal failure", async () => {
  const result = await executeController({
    operations: operations({
      failAt: "image-identity",
      signalAt: "cleanup",
    }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.receipt.stage, "image-identity");
  assert.equal(result.receipt.errorCode, "unexpected-failure");
  assert.equal(result.receipt.originalOutcome, "failure");
  assert.equal(result.receipt.signal, "SIGTERM");
  assert.equal(result.receipt.cleanupProved, false);
  assert.equal(validateTerminalReceipt(result.receipt), result.receipt);
  assert.deepEqual(
    parseTerminalReceipt(Buffer.from(`${JSON.stringify(result.receipt)}\n`)),
    result.receipt,
  );
  const priorExitCode = process.exitCode;
  const receipts = [];
  const published = await publishTerminalResult(result, {
    getSignal: () => result.receipt.signal,
    writeReceipt: (receipt) => receipts.push(receipt),
  });
  assert.equal(published.exitCode, 1);
  assert.deepEqual(receipts, [result.receipt]);
  process.exitCode = priorExitCode;
});

test("the lifecycle reducer is monotonic and terminalizes exactly once", () => {
  let state = createLifecycleState();
  state = reduceLifecycleState(state, {
    stage: "input-identity",
    type: "enter",
  });
  assert.throws(
    () => reduceLifecycleState(state, { stage: "setup", type: "enter" }),
    /unexpected-failure/u,
  );
  state = reduceLifecycleState(state, {
    errorCode: "repository-identity-invalid",
    originalOutcome: "failure",
    type: "failure",
  });
  state = reduceLifecycleState(state, {
    signal: "SIGTERM",
    type: "signal",
  });
  state = reduceLifecycleState(state, { type: "begin-cleanup" });
  state = reduceLifecycleState(state, {
    proved: true,
    type: "finish-cleanup",
  });
  const receipt = serializeLifecycleState(state);
  assert.deepEqual(receipt, {
    version: 1,
    stage: "input-identity",
    status: "failed",
    errorCode: "repository-identity-invalid",
    runtimeReceiptAuthenticated: false,
    cleanupProved: false,
    originalOutcome: "failure",
    signal: "SIGTERM",
  });
  assert.throws(
    () => reduceLifecycleState(state, { signal: "SIGINT", type: "signal" }),
    /unexpected-failure/u,
  );
  assert.deepEqual(
    parseTerminalReceipt(Buffer.from(`${JSON.stringify(receipt)}\n`)),
    receipt,
  );
});

test("the closed terminal table exhaustively decides every receipt cross-product", () => {
  const stages = [
    "setup",
    "input-identity",
    "image-identity",
    "create",
    "runtime-receipt",
    "terminal-join",
    "final-assertion",
    "cleanup",
  ];
  const outcomes = ["success", "failure", "uncertain", "timeout", "signal"];
  const signals = [null, "SIGINT", "SIGTERM"];
  const errorCodes = [
    null,
    ...new Set(canonicalTerminalReceipts.map((receipt) => receipt.errorCode)),
  ];
  const canonical = new Set(
    canonicalTerminalReceipts.map((receipt) => JSON.stringify(receipt)),
  );
  const crossProduct = (dimensions) =>
    dimensions.reduce(
      (rows, dimension) =>
        rows.flatMap((row) => dimension.map((value) => [...row, value])),
      [[]],
    );
  for (const [
    stage,
    originalOutcome,
    cleanupProved,
    signal,
    errorCode,
  ] of crossProduct([stages, outcomes, [false, true], signals, errorCodes])) {
    const receipt = {
      version: 1,
      stage,
      status: errorCode === null ? "passed" : "failed",
      errorCode,
      runtimeReceiptAuthenticated: [
        "terminal-join",
        "final-assertion",
        "cleanup",
      ].includes(stage),
      cleanupProved,
      originalOutcome,
      signal,
    };
    const expected = canonical.has(JSON.stringify(receipt));
    let accepted = true;
    try {
      validateTerminalReceipt(receipt);
    } catch {
      accepted = false;
    }
    assert.equal(accepted, expected);
  }
  for (const receipt of canonicalTerminalReceipts)
    assert.deepEqual(
      parseTerminalReceipt(Buffer.from(`${JSON.stringify(receipt)}\n`)),
      receipt,
    );
});

const assertRejectedReceipts = (receipts) => {
  for (const receipt of receipts) {
    assert.throws(
      () => validateTerminalReceipt(receipt),
      /unexpected-failure/u,
    );
    assert.throws(
      () => parseTerminalReceipt(Buffer.from(`${JSON.stringify(receipt)}\n`)),
      /unexpected-failure/u,
    );
  }
};

test("terminal receipts reject unknown, missing, duplicate, malformed, and extra state", () => {
  const valid = { ...passingReceipt };
  assert.equal(validateTerminalReceipt(valid), valid);
  assertRejectedReceipts([
    { ...valid, errorCode: "future-code", status: "failed" },
    Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "stage"),
    ),
    { ...valid, stage: ["final-assertion"] },
    {
      ...valid,
      status: "failed",
      errorCode: "cleanup-unproved",
      originalOutcome: "failure",
    },
    { ...valid, extra: false },
    null,
  ]);
  for (const receipt of [
    `${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`,
    '{"version":1,"version":1,"stage":"final-assertion","status":"passed","errorCode":null,"runtimeReceiptAuthenticated":true,"cleanupProved":true,"originalOutcome":"success","signal":null}\n',
    '{"version":2,"\\u0076ersion":1,"stage":"final-assertion","status":"passed","errorCode":null,"runtimeReceiptAuthenticated":true,"cleanupProved":true,"originalOutcome":"success","signal":null}\n',
    `${JSON.stringify({ ...valid, extra: false })}\n`,
    "not-json\n",
  ])
    assert.throws(
      () => parseTerminalReceipt(Buffer.from(receipt)),
      /unexpected-failure/u,
    );
  assert.deepEqual(
    parseTerminalReceipt(Buffer.from(`${JSON.stringify(valid)}\n`)),
    valid,
  );
});

test("terminal receipts reject substituted causal dimensions", () => {
  const valid = { ...passingReceipt };
  for (const receipt of [
    {
      ...valid,
      stage: "input-identity",
      status: "failed",
      errorCode: "repository-identity-invalid",
      runtimeReceiptAuthenticated: false,
      originalOutcome: "failure",
    },
    {
      ...valid,
      stage: "image-identity",
      status: "failed",
      errorCode: "image-identity-invalid",
      runtimeReceiptAuthenticated: false,
      cleanupProved: false,
      originalOutcome: "uncertain",
    },
    {
      ...valid,
      status: "failed",
      errorCode: "signal",
      originalOutcome: "signal",
      signal: "SIGTERM",
    },
  ]) {
    assert.equal(validateTerminalReceipt(receipt), receipt);
    assert.deepEqual(
      parseTerminalReceipt(Buffer.from(`${JSON.stringify(receipt)}\n`)),
      receipt,
    );
  }
  assertRejectedReceipts([
    {
      ...valid,
      stage: "setup",
      status: "failed",
      errorCode: "terminal-join-invalid",
      runtimeReceiptAuthenticated: false,
      originalOutcome: "failure",
    },
    {
      ...valid,
      stage: "input-identity",
      status: "failed",
      errorCode: "runtime-receipt-invalid",
      runtimeReceiptAuthenticated: false,
      originalOutcome: "uncertain",
    },
    {
      ...valid,
      stage: "cleanup",
      status: "failed",
      errorCode: "unexpected-failure",
      originalOutcome: "failure",
    },
    {
      ...valid,
      stage: "input-identity",
      status: "failed",
      errorCode: "engine-status-invalid",
      runtimeReceiptAuthenticated: false,
      originalOutcome: "uncertain",
    },
    {
      ...valid,
      stage: "terminal-join",
      status: "failed",
      errorCode: "engine-status-invalid",
      originalOutcome: "uncertain",
    },
    {
      ...valid,
      stage: "create",
      status: "failed",
      errorCode: "container-identity-invalid",
      runtimeReceiptAuthenticated: false,
      originalOutcome: "failure",
    },
  ]);
});

test("terminal receipts bind cleanup and signal dimensions", () => {
  const valid = { ...passingReceipt };
  assertRejectedReceipts([
    {
      ...valid,
      stage: "input-identity",
      status: "failed",
      errorCode: "repository-identity-invalid",
      runtimeReceiptAuthenticated: false,
      cleanupProved: false,
      originalOutcome: "failure",
    },
    {
      ...valid,
      stage: "input-identity",
      status: "failed",
      errorCode: "preexisting-container",
      runtimeReceiptAuthenticated: false,
      cleanupProved: false,
      originalOutcome: "failure",
    },
    {
      ...valid,
      stage: "image-identity",
      status: "failed",
      errorCode: "image-identity-invalid",
      runtimeReceiptAuthenticated: false,
      cleanupProved: false,
      originalOutcome: "failure",
    },
    {
      ...valid,
      stage: "cleanup",
      status: "failed",
      errorCode: "cleanup-unproved",
      cleanupProved: false,
      originalOutcome: "uncertain",
      signal: "SIGTERM",
    },
    {
      ...valid,
      stage: "create",
      status: "failed",
      errorCode: "container-authority-invalid",
      runtimeReceiptAuthenticated: false,
      originalOutcome: "uncertain",
    },
    {
      ...valid,
      stage: "setup",
      status: "failed",
      errorCode: "signal",
      runtimeReceiptAuthenticated: false,
      originalOutcome: "signal",
      signal: "SIGTERM",
    },
    {
      ...valid,
      stage: "terminal-join",
      status: "failed",
      errorCode: "signal",
      originalOutcome: "signal",
      signal: "SIGTERM",
    },
  ]);
});

const fixtureServer = async (handler) => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-engine-client."));
  roots.push(root);
  const socketPath = resolve(root, "engine.sock");
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolveListen) =>
    server.listen(socketPath, resolveListen),
  );
  chmodSync(socketPath, 0o660);
  return socketPath;
};

test("direct Engine client accepts split bounded responses", async () => {
  const socketPath = await fixtureServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":');
    response.end("true}");
  });
  const client = createEngineClient({
    absoluteDeadline: performance.now() + 10_000,
    socketPath,
    socketOwner: BigInt(process.getuid()),
  });
  const result = await client.request({
    expected: [200],
    method: "GET",
    path: `/v1.45/images/${encodeURIComponent(
      "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6",
    )}/json`,
  });
  assert.equal(result.body.toString(), '{"ok":true}');
  assert.equal(client.uncertain(), false);
});

test("truncation, oversize, status, and timeout stop later mutation", async () => {
  for (const mode of ["truncated", "oversize", "status", "timeout"]) {
    const socketPath = await fixtureServer((_request, response) => {
      if (mode === "truncated") {
        response.writeHead(200, { "content-length": "8" });
        response.write("x");
        response.destroy();
      } else if (mode === "oversize") response.end("xxxx");
      else if (mode === "status") response.writeHead(500).end("{}");
      else setTimeout(() => response.end("{}"), 40);
    });
    const client = createEngineClient({
      absoluteDeadline:
        performance.now() + (mode === "timeout" ? 7_010 : 10_000),
      socketPath,
      socketOwner: BigInt(process.getuid()),
    });
    await assert.rejects(
      client.request({
        expected: [200],
        maximumBytes: mode === "oversize" ? 3 : 32,
        method: "POST",
        mutation: true,
        path: `/v1.45/images/create?fromImage=node&tag=${encodeURIComponent(
          "sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c",
        )}&platform=linux%2Famd64`,
      }),
    );
    assert.equal(client.uncertain(), true);
    await assert.rejects(
      client.request({
        expected: [200],
        method: "POST",
        mutation: true,
        path: `/v1.45/containers/create?name=agentscope-pty-runtime-proof-${"a".repeat(
          32,
        )}&platform=linux%2Famd64`,
      }),
      /engine-request-invalid/u,
    );
  }
});

test("rejects socket and route substitution before request admission", async () => {
  let requests = 0;
  const socketPath = await fixtureServer((_request, response) => {
    requests += 1;
    response.end("{}");
  });
  for (const invalidRequest of [
    {
      expected: [200],
      method: "GET",
      path: "/v1.45/version",
    },
    {
      expected: [201],
      method: "GET",
      path: `/v1.45/images/${encodeURIComponent(
        "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6",
      )}/json`,
    },
    {
      expected: [201],
      method: "POST",
      mutation: true,
      path: `/v1.45/containers/create?name=agentscope-pty-runtime-proof-${"a".repeat(
        32,
      )}&platform=linux%2Famd64`,
    },
  ]) {
    const invalidClient = createEngineClient({
      absoluteDeadline: performance.now() + 10_000,
      socketPath,
      socketOwner: BigInt(process.getuid()),
    });
    await assert.rejects(
      invalidClient.request(invalidRequest),
      /engine-request-invalid/u,
    );
    assert.equal(invalidClient.uncertain(), true);
  }
  const socketClient = createEngineClient({
    absoluteDeadline: performance.now() + 10_000,
    socketPath,
    socketOwner: BigInt(process.getuid()),
  });
  await socketClient.request({
    expected: [200],
    method: "GET",
    path: `/v1.45/images/${encodeURIComponent(
      "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6",
    )}/json`,
  });
  chmodSync(socketPath, 0o600);
  await assert.rejects(
    socketClient.request({
      expected: [200],
      method: "GET",
      path: `/v1.45/images/${encodeURIComponent(
        "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6",
      )}/json`,
    }),
    /socket-identity-substituted/u,
  );
  assert.equal(requests, 1);
});

test("ambiguous create and remove latch uncertainty before later mutation", async () => {
  for (const operation of ["create", "remove"]) {
    let requests = 0;
    const socketPath = await fixtureServer((request, response) => {
      requests += 1;
      request.socket.destroy();
      response.destroy();
    });
    const client = createEngineClient({
      absoluteDeadline: performance.now() + 10_000,
      socketPath,
      socketOwner: BigInt(process.getuid()),
    });
    const identity = "a".repeat(64);
    await assert.rejects(
      operation === "create"
        ? client.request({
            body: Buffer.from("{}"),
            expected: [201],
            method: "POST",
            mutation: true,
            path: `/v1.45/containers/create?name=agentscope-pty-runtime-proof-${"b".repeat(
              32,
            )}&platform=linux%2Famd64`,
          })
        : client.request({
            cleanup: true,
            expected: [204],
            method: "DELETE",
            mutation: true,
            path: `/v1.45/containers/${identity}?force=1&v=0`,
          }),
    );
    assert.equal(client.uncertain(), true);
    await assert.rejects(
      client.request({
        body: Buffer.from("{}"),
        expected: [201],
        method: "POST",
        mutation: true,
        path: `/v1.45/containers/create?name=agentscope-pty-runtime-proof-${"c".repeat(
          32,
        )}&platform=linux%2Famd64`,
      }),
      /engine-request-invalid/u,
    );
    assert.equal(requests, 1);
  }
});

test("malformed pull receipt stops before container creation", async () => {
  const observed = [];
  const socketPath = await fixtureServer((request, response) => {
    observed.push(request.url);
    if (request.url.startsWith("/v1.45/containers/json?")) response.end("[]");
    else if (request.url.startsWith("/v1.45/images/create?"))
      response.end("{}\n");
    else response.writeHead(500).end("{}");
  });
  const absoluteDeadline = performance.now() + 10_000;
  const result = await executeController({
    absoluteDeadline,
    operations: createProductionOperations({
      absoluteDeadline,
      repositoryRoot: process.cwd(),
      socketOwner: BigInt(process.getuid()),
      socketPath,
    }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.receipt.originalOutcome, "uncertain");
  assert.equal(result.receipt.errorCode, "image-pull-record-shape-invalid");
  assert.equal(result.receipt.cleanupProved, false);
  assert.equal(validateTerminalReceipt(result.receipt), result.receipt);
  const priorExitCode = process.exitCode;
  const receipts = [];
  const published = await publishTerminalResult(result, {
    getSignal: () => null,
    writeReceipt: (receipt) => receipts.push(receipt),
  });
  assert.equal(published.exitCode, 1);
  assert.deepEqual(receipts, [result.receipt]);
  process.exitCode = priorExitCode;
  assert.equal(
    observed.some((path) => path.includes("/containers/create?")),
    false,
  );
});

test("pull receipt predicates emit only fixed causal codes and stop later mutation", async () => {
  const manifest =
    "sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c";
  const image = `node@${manifest}`;
  const digest = JSON.stringify({ status: `Digest: ${manifest}` });
  const terminal = JSON.stringify({
    status: `Status: Image is up to date for ${image}`,
  });
  const cases = [
    ["image-pull-encoding-invalid", Buffer.from([0xff, 0x0a])],
    ["image-pull-framing-invalid", Buffer.from("")],
    [
      "image-pull-count-invalid",
      Buffer.from(
        `${Array.from({ length: 4097 }, () => '{"status":"x"}').join("\n")}\n`,
      ),
    ],
    ["image-pull-json-invalid", Buffer.from("not-json\n")],
    [
      "image-pull-json-duplicate-key",
      Buffer.from('{"status":"one","status":"two"}\n'),
    ],
    [
      "image-pull-record-shape-invalid",
      Buffer.from('{"status":"working","future":true}\n'),
    ],
    ["image-pull-daemon-error", Buffer.from('{"error":"suppressed"}\n')],
    [
      "image-pull-digest-duplicate",
      Buffer.from(`${digest}\n${digest}\n${terminal}\n`),
    ],
    [
      "image-pull-digest-mismatch",
      Buffer.from(
        `${JSON.stringify({ status: `Digest: sha256:${"0".repeat(64)}` })}\n${terminal}\n`,
      ),
    ],
    ["image-pull-digest-missing", Buffer.from('{"status":"working"}\n')],
    ["image-pull-order-invalid", Buffer.from(`${terminal}\n${digest}\n`)],
    [
      "image-pull-terminal-duplicate",
      Buffer.from(`${digest}\n${terminal}\n${terminal}\n`),
    ],
    [
      "image-pull-terminal-mismatch",
      Buffer.from(
        `${digest}\n${JSON.stringify({ status: "Status: Image is up to date for node@sha256:wrong" })}\n`,
      ),
    ],
    ["image-pull-terminal-missing", Buffer.from(`${digest}\n`)],
    [
      "image-pull-trailing-record",
      Buffer.from(`${digest}\n${terminal}\n{"status":"late"}\n`),
    ],
  ];
  for (const [errorCode, body] of cases) {
    assert.throws(
      () => parseImagePullReceipt(body),
      new RegExp(errorCode, "u"),
    );
    const observed = [];
    const socketPath = await fixtureServer((request, response) => {
      observed.push(`${request.method} ${request.url}`);
      if (request.url.startsWith("/v1.45/containers/json?")) response.end("[]");
      else if (request.url.startsWith("/v1.45/images/create?")) {
        const midpoint = Math.floor(body.length / 2);
        response.write(body.subarray(0, midpoint));
        response.end(body.subarray(midpoint));
      } else response.writeHead(500).end("{}");
    });
    const absoluteDeadline = performance.now() + 10_000;
    const result = await executeController({
      absoluteDeadline,
      operations: createProductionOperations({
        absoluteDeadline,
        repositoryRoot: process.cwd(),
        socketOwner: BigInt(process.getuid()),
        socketPath,
      }),
    });
    assert.equal(result.receipt.stage, "image-identity");
    assert.equal(result.receipt.errorCode, errorCode);
    assert.equal(result.receipt.originalOutcome, "uncertain");
    assert.equal(result.receipt.cleanupProved, false);
    assert.equal(validateTerminalReceipt(result.receipt), result.receipt);
    assert.equal(
      observed.some((entry) => entry.includes("/containers/create?")),
      false,
    );
  }
});

test("pull receipt admits only one uniform LF or CRLF delimiter mode", () => {
  const manifest =
    "sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c";
  const image = `node@${manifest}`;
  const digest = JSON.stringify({ status: `Digest: ${manifest}` });
  const terminal = JSON.stringify({
    status: `Status: Image is up to date for ${image}`,
  });
  for (const delimiter of ["\n", "\r\n"])
    for (const ending of ["", delimiter]) {
      assert.deepEqual(
        parseImagePullReceipt(
          Buffer.from(`${digest}${delimiter}${terminal}${ending}`),
        ),
        { digestAuthenticated: true, terminalAuthenticated: true },
      );
    }
  for (const body of [
    "",
    `\n${digest}\n${terminal}`,
    `\r\n${digest}\r\n${terminal}`,
    `${digest}\n\n${terminal}`,
    `${digest}\r\n\r\n${terminal}`,
    `${digest}\n \n${terminal}`,
    `${digest}\r\n \r\n${terminal}`,
    `${digest}\n${terminal}\n\n`,
    `${digest}\r\n${terminal}\r\n\r\n`,
    `${digest}\n${terminal}\r\n`,
    `${digest}\r\n${terminal}\n`,
    `${digest}\r${terminal}`,
    `${digest}\r\r\n${terminal}`,
    `${digest}\r\n{"status":"bad\rvalue"}\r\n${terminal}`,
  ]) {
    assert.throws(
      () => parseImagePullReceipt(Buffer.from(body)),
      /image-pull-framing-invalid/u,
    );
  }
  assert.throws(
    () => parseImagePullReceipt(Buffer.from(`${digest}\n${terminal}{}`)),
    /image-pull-json-invalid/u,
  );
});

test("malformed create receipt preserves uncertainty and publishes once", async () => {
  const identity =
    "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6";
  const manifest =
    "sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c";
  const socketPath = await fixtureServer((request, response) => {
    if (request.url.startsWith("/v1.45/containers/json?")) response.end("[]");
    else if (request.url.startsWith("/v1.45/images/create?"))
      response.end(
        `${JSON.stringify({ status: `Digest: ${manifest}` })}\n${JSON.stringify(
          { status: `Status: Image is up to date for node@${manifest}` },
        )}\n`,
      );
    else if (request.url.startsWith("/v1.45/images/"))
      response.end(
        JSON.stringify({ Architecture: "amd64", Id: identity, Os: "linux" }),
      );
    else if (request.url.startsWith("/v1.45/containers/create?"))
      response.writeHead(201).end("not-json");
    else response.writeHead(500).end("{}");
  });
  const absoluteDeadline = performance.now() + 10_000;
  const result = await executeController({
    absoluteDeadline,
    operations: createProductionOperations({
      absoluteDeadline,
      repositoryRoot: process.cwd(),
      socketOwner: BigInt(process.getuid()),
      socketPath,
    }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.receipt.stage, "create");
  assert.equal(result.receipt.errorCode, "container-create-invalid");
  assert.equal(result.receipt.originalOutcome, "uncertain");
  assert.equal(result.receipt.cleanupProved, false);
  assert.equal(validateTerminalReceipt(result.receipt), result.receipt);
  const priorExitCode = process.exitCode;
  const receipts = [];
  const published = await publishTerminalResult(result, {
    getSignal: () => null,
    writeReceipt: (receipt) => receipts.push(receipt),
  });
  assert.equal(published.exitCode, 1);
  assert.deepEqual(receipts, [result.receipt]);
  process.exitCode = priorExitCode;
});

test("duplicate-key post-create inspection latches uncertainty and permits no delete", async () => {
  const containerId = "a".repeat(64);
  const identity =
    "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6";
  const manifest =
    "sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c";
  const observed = [];
  const socketPath = await fixtureServer((request, response) => {
    observed.push(`${request.method} ${request.url}`);
    if (request.url.startsWith("/v1.45/containers/json?")) response.end("[]");
    else if (request.url.startsWith("/v1.45/images/create?"))
      response.end(
        `${JSON.stringify({ status: `Digest: ${manifest}` })}\n${JSON.stringify(
          { status: `Status: Image is up to date for node@${manifest}` },
        )}\n`,
      );
    else if (request.url.startsWith("/v1.45/images/"))
      response.end(
        JSON.stringify({ Architecture: "amd64", Id: identity, Os: "linux" }),
      );
    else if (request.url.startsWith("/v1.45/containers/create?"))
      response
        .writeHead(201)
        .end(JSON.stringify({ Id: containerId, Warnings: [] }));
    else if (
      request.method === "GET" &&
      request.url === `/v1.45/containers/${containerId}/json`
    )
      response.end(`{"Id":"${containerId}","Id":"${"b".repeat(64)}"}`);
    else response.writeHead(500).end("{}");
  });
  const absoluteDeadline = performance.now() + 10_000;
  const result = await executeController({
    absoluteDeadline,
    operations: createProductionOperations({
      absoluteDeadline,
      repositoryRoot: process.cwd(),
      socketOwner: BigInt(process.getuid()),
      socketPath,
    }),
  });
  assert.equal(result.receipt.stage, "create");
  assert.equal(result.receipt.errorCode, "container-inspect-invalid");
  assert.equal(result.receipt.originalOutcome, "uncertain");
  assert.equal(result.receipt.cleanupProved, false);
  assert.equal(validateTerminalReceipt(result.receipt), result.receipt);
  assert.equal(
    observed.some((entry) => entry.startsWith("DELETE ")),
    false,
  );
});

test("contradictory created-container authority permits no cleanup mutation", async () => {
  const containerId = "a".repeat(64);
  const imageId =
    "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6";
  const manifest =
    "sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c";
  const observed = [];
  const socketPath = await fixtureServer((request, response) => {
    observed.push(`${request.method} ${request.url}`);
    if (request.url.startsWith("/v1.45/containers/json?")) response.end("[]");
    else if (request.url.startsWith("/v1.45/images/create?"))
      response.end(
        `${JSON.stringify({ status: `Digest: ${manifest}` })}\n${JSON.stringify(
          { status: `Status: Image is up to date for node@${manifest}` },
        )}\n`,
      );
    else if (request.url.startsWith("/v1.45/images/"))
      response.end(
        JSON.stringify({ Architecture: "amd64", Id: imageId, Os: "linux" }),
      );
    else if (request.url.startsWith("/v1.45/containers/create?"))
      response
        .writeHead(201)
        .end(JSON.stringify({ Id: containerId, Warnings: [] }));
    else if (request.url.endsWith("/json"))
      response.end(
        JSON.stringify({
          HostConfig: { NetworkMode: "bridge", ReadonlyRootfs: true },
          Id: containerId,
          Image: imageId,
          Name: "/substituted",
        }),
      );
    else response.writeHead(500).end("{}");
  });
  const absoluteDeadline = performance.now() + 10_000;
  const result = await executeController({
    absoluteDeadline,
    operations: createProductionOperations({
      absoluteDeadline,
      repositoryRoot: process.cwd(),
      socketOwner: BigInt(process.getuid()),
      socketPath,
    }),
  });
  assert.equal(result.receipt.stage, "create");
  assert.equal(result.receipt.errorCode, "container-authority-invalid");
  assert.equal(result.receipt.cleanupProved, false);
  assert.equal(validateTerminalReceipt(result.receipt), result.receipt);
  assert.equal(observed.length, 5);
  assert.equal(
    observed.some((entry) => entry.startsWith("DELETE ")),
    false,
  );
});

test("executes the exact Engine lifecycle and removes its one container", async () => {
  const identity = "a".repeat(64);
  const imageId =
    "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6";
  const manifest =
    "sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c";
  let name;
  let removed = false;
  let terminal = false;
  const observed = [];
  const socketPath = await fixtureServer((request, response) => {
    observed.push(`${request.method} ${request.url}`);
    if (request.url.startsWith("/v1.45/containers/json?")) {
      response.end("[]");
      return;
    }
    if (request.url.startsWith("/v1.45/images/create?")) {
      response.end(
        `${JSON.stringify({ status: `Digest: ${manifest}` })}\n${JSON.stringify(
          {
            status: `Status: Image is up to date for node@${manifest}`,
          },
        )}\n`,
      );
      return;
    }
    if (request.url.startsWith("/v1.45/images/")) {
      response.end(
        JSON.stringify({ Architecture: "amd64", Id: imageId, Os: "linux" }),
      );
      return;
    }
    if (request.url.startsWith("/v1.45/containers/create?")) {
      name = new URL(request.url, "http://fixture").searchParams.get("name");
      response
        .writeHead(201)
        .end(JSON.stringify({ Id: identity, Warnings: [] }));
      return;
    }
    if (request.url.endsWith("/start")) {
      response.writeHead(204).end();
      return;
    }
    if (request.url.includes("/wait?")) {
      terminal = true;
      response.end(JSON.stringify({ Error: null, StatusCode: 0 }));
      return;
    }
    if (request.url.includes("/logs?")) {
      const receipt = Buffer.from('{"version":1,"status":"passed"}\n');
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(receipt.length, 4);
      response.end(Buffer.concat([header, receipt]));
      return;
    }
    if (request.method === "DELETE") {
      removed = true;
      response.writeHead(204).end();
      return;
    }
    if (request.url.endsWith("/json") && removed) {
      response
        .writeHead(404)
        .end(JSON.stringify({ message: `No such container: ${identity}` }));
      return;
    }
    if (request.url.endsWith("/json")) {
      response.end(
        JSON.stringify({
          HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
          Id: identity,
          Image: imageId,
          Name: `/${name}`,
          State: terminal
            ? { ExitCode: 0, Pid: 0, Running: false, Status: "exited" }
            : { ExitCode: 0, Pid: 0, Running: false, Status: "created" },
        }),
      );
      return;
    }
    response.writeHead(500).end("{}");
  });
  const absoluteDeadline = performance.now() + 10_000;
  const result = await executeController({
    absoluteDeadline,
    operations: createProductionOperations({
      absoluteDeadline,
      repositoryRoot: process.cwd(),
      socketOwner: BigInt(process.getuid()),
      socketPath,
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.status, "passed");
  assert.equal(removed, true);
  assert.equal(observed.length, 12);
});

test("controller source contains no subprocess or ambient Docker authority", async () => {
  const source = await import("node:fs").then(({ readFileSync }) =>
    readFileSync(
      resolve(import.meta.dirname, "../pty-runtime-proof-controller.mjs"),
      "utf8",
    ),
  );
  assert.doesNotMatch(
    source,
    /child_process|spawn|execFile|DOCKER_HOST|http:\/\//u,
  );
  assert.match(source, /socketPath/u);
  assert.match(source, /writeSync\(1/u);
  assert.equal(source.match(/process\.stderr\.write/gmu), null);
});

test("a signal delivered during receipt write cannot leave terminal success", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-publication."));
  roots.push(root);
  const fixture = resolve(root, "fixture.mjs");
  writeFileSync(
    fixture,
    `import {publishTerminalResult} from ${JSON.stringify(
      new URL("../pty-runtime-proof-controller.mjs", import.meta.url).href,
    )};
let signal=null;
process.on('SIGTERM',()=>{signal??='SIGTERM'});
const result=await publishTerminalResult({exitCode:0,receipt:${JSON.stringify(passingReceipt)}},{
  getSignal:()=>signal,
  writeReceipt:(receipt)=>{
    process.kill(process.pid,'SIGTERM');
    const until=performance.now()+50;
    while(performance.now()<until){}
    process.stdout.write(JSON.stringify(receipt)+'\\n');
  }
});
process.exitCode=result.exitCode;`,
  );
  const result = await new Promise((resolveChild) => {
    const child = spawn(process.execPath, [fixture], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("close", (status, signal) =>
      resolveChild({
        signal,
        status,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      }),
    );
  });
  assert.equal(result.status, 143);
  assert.equal(result.signal, null);
  assert.equal(result.stderr.length, 0);
  assert.deepEqual(JSON.parse(result.stdout.toString()), passingReceipt);
});

test("pre-publication signal rewrites the sole receipt to failure", async () => {
  const priorExitCode = process.exitCode;
  let signal = "SIGINT";
  const receipts = [];
  const result = await publishTerminalResult(
    { exitCode: 0, receipt: passingReceipt },
    {
      getSignal: () => signal,
      writeReceipt: (receipt) => receipts.push(receipt),
    },
  );
  signal = null;
  assert.equal(result.exitCode, 130);
  assert.deepEqual(receipts, [
    {
      ...passingReceipt,
      errorCode: "signal",
      status: "failed",
      originalOutcome: "signal",
      signal: "SIGINT",
    },
  ]);
  process.exitCode = priorExitCode;
});

test("a signal at the final observation remains owned through process exit", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "agentscope-final-signal."));
  roots.push(root);
  const fixture = resolve(root, "fixture.mjs");
  writeFileSync(
    fixture,
    `import {publishTerminalResult} from ${JSON.stringify(
      new URL("../pty-runtime-proof-controller.mjs", import.meta.url).href,
    )};
let signal=null;
let calls=0;
process.on('SIGTERM',()=>{signal??='SIGTERM';process.exitCode=143});
await publishTerminalResult({exitCode:0,receipt:${JSON.stringify(passingReceipt)}},{
  getSignal:()=>{
    calls+=1;
    if(calls===2){
      process.kill(process.pid,'SIGTERM');
      const until=performance.now()+50;
      while(performance.now()<until){}
    }
    return signal;
  },
  writeReceipt:(receipt)=>process.stdout.write(JSON.stringify(receipt)+'\\n')
});`,
  );
  const result = await new Promise((resolveChild) => {
    const child = spawn(process.execPath, [fixture], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("close", (status, signal) =>
      resolveChild({
        signal,
        status,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      }),
    );
  });
  assert.equal(result.status, 143);
  assert.equal(result.signal, null);
  assert.equal(result.stderr.length, 0);
  assert.deepEqual(JSON.parse(result.stdout.toString()), passingReceipt);
});
