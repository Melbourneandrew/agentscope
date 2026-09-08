import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "vitest";

import {
  createEngineClient,
  createProductionOperations,
  executeController,
} from "../pty-runtime-proof-controller.mjs";

const roots = [];
const servers = [];
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
    const fixture = operations({ failAt: stage });
    const result = await executeController({ operations: fixture });
    assert.equal(result.receipt.stage, stage);
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.receipt.originalOutcome, "failure");
    assert.equal(
      result.receipt.runtimeReceiptAuthenticated,
      ["terminal-join", "final-assertion"].includes(stage),
    );
    assert.deepEqual(fixture.events.slice(-2), ["cleanup", "uninstall"]);
  }
});

test("passes only after receipt, terminal join, and cleanup", async () => {
  const result = await executeController({ operations: operations() });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.receipt, {
    version: 1,
    stage: "final-assertion",
    status: "passed",
    runtimeReceiptAuthenticated: true,
    cleanupProved: true,
    originalOutcome: "success",
    signal: null,
  });
});

test("latches first signal and executes cleanup once", async () => {
  for (const signalAt of ["setup", "create", "cleanup"]) {
    const fixture = operations({ signalAt });
    const result = await executeController({ operations: fixture });
    assert.equal(result.exitCode, 143);
    assert.equal(result.receipt.signal, "SIGTERM");
    assert.equal(
      fixture.events.filter((value) => value === "cleanup").length,
      1,
    );
  }
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
  }
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
  const client = createEngineClient({
    absoluteDeadline: performance.now() + 10_000,
    socketPath,
    socketOwner: BigInt(process.getuid()),
  });
  await assert.rejects(
    client.request({
      expected: [200],
      method: "GET",
      path: "/v1.45/version",
    }),
    /engine-request-invalid/u,
  );
  await assert.rejects(
    client.request({
      expected: [201],
      method: "GET",
      path: `/v1.45/images/${encodeURIComponent(
        "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6",
      )}/json`,
    }),
    /engine-request-invalid/u,
  );
  await assert.rejects(
    client.request({
      expected: [201],
      method: "POST",
      mutation: true,
      path: `/v1.45/containers/create?name=agentscope-pty-runtime-proof-${"a".repeat(
        32,
      )}&platform=linux%2Famd64`,
    }),
    /engine-request-invalid/u,
  );
  await client.request({
    expected: [200],
    method: "GET",
    path: `/v1.45/images/${encodeURIComponent(
      "sha256:395425e54d98ebbd748d388685a0c2de151a30fa92fffc10ba30fa63f3db64d6",
    )}/json`,
  });
  chmodSync(socketPath, 0o600);
  await assert.rejects(
    client.request({
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
  assert.equal(result.receipt.cleanupProved, false);
  assert.equal(
    observed.some((path) => path.includes("/containers/create?")),
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
