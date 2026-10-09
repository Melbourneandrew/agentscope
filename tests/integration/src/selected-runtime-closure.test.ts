import { readFileSync } from "node:fs";
import {
  createServer as createTlsServer,
  request as tlsRequest,
} from "node:https";
import { posix, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// @ts-expect-error private integration module publishes no declaration
import * as privateAuthority from "../immutable-candidate-authority.mjs";

const { selectedRuntimeFiles } = privateAuthority as {
  selectedRuntimeFiles: readonly string[];
};
const integrationRoot = resolve(import.meta.dirname, "..");
// @ts-expect-error fixed public test CA module has no TypeScript declaration
import { collectorCa } from "../collector-ca.mjs";

it("uses ordinary Node CA and hostname verification on the real TLS receiver", async () => {
  const runner = readFileSync(
    resolve(integrationRoot, "run-scenarios.mjs"),
    "utf8",
  );
  const literal = (name: string): string => {
    const encoded = new RegExp(`const ${name} =\\s*("[^\\n]*");`, "u").exec(
      runner,
    )?.[1];
    if (encoded === undefined) throw new Error("missing-fixed-tls-fixture");
    return JSON.parse(encoded) as string;
  };
  const source = readFileSync(
    resolve(integrationRoot, "destination-server.mjs"),
    "utf8",
  )
    .replace('import { createServer } from "node:http";\n', "")
    .replace(
      'import { createServer as createSecureServer } from "node:https";\n',
      "",
    );
  let server: ReturnType<typeof createTlsServer> | undefined;
  runInNewContext(source, {
    Buffer,
    URL,
    console: { log: () => undefined },
    process: {
      once: () => undefined,
      argv: ["node", "destination-server.mjs", "ingestion"],
      env: {
        AGENTSCOPE_SCENARIO_ID: "codex-tui-trace-smoke",
        AGENTSCOPE_MAXIMUM_REQUEST_BYTES: "1048576",
        AGENTSCOPE_COLLECTOR_TLS_CERT: literal("collectorTlsCertificate"),
        AGENTSCOPE_COLLECTOR_TLS_KEY: literal("collectorTlsKey"),
      },
    },
    createServer: () => {
      throw new Error("insecure-receiver");
    },
    createSecureServer: (...args: Parameters<typeof createTlsServer>) => {
      server = createTlsServer(...args);
      const listen = server.listen.bind(server);
      server.listen = (() => listen(0, "127.0.0.1")) as typeof server.listen;
      return server;
    },
  });
  if (server === undefined) throw new Error("missing-tls-receiver");
  const receiver = server;
  try {
    if (!receiver.listening)
      await new Promise<void>((resolve) => receiver.once("listening", resolve));
    const address = receiver.address();
    if (address === null || typeof address === "string")
      throw new Error("missing-tls-port");
    const call = (path: string, servername = "collector", body?: string) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const request = tlsRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            servername,
            ca: collectorCa as string,
            path,
            method: body === undefined ? "GET" : "POST",
            agent: false,
            headers: {
              authorization: `Basic ${Buffer.from("DUMMY_PUBLIC_KEY:DUMMY_SECRET_KEY").toString("base64")}`,
              "content-type": "application/json",
              "x-langfuse-ingestion-version": "4",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
              resolve({
                status: response.statusCode ?? 0,
                text: Buffer.concat(chunks).toString("utf8"),
              });
            });
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end(body);
      });
    await expect(
      call("/api/public/otel/v1/traces", "not-collector"),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect((await call("/api/public/otel/v1/traces")).status).toBe(405);
    const body = '{"resourceSpans":[]}';
    expect(
      (await call("/api/public/otel/v1/traces", "collector", body)).status,
    ).toBe(200);
    const snapshot = await call("/observations");
    expect(snapshot.status).toBe(200);
    expect(JSON.parse(snapshot.text) as unknown).toMatchObject({
      observationVersion: 2,
      batches: [Buffer.from(body).toString("base64")],
      aggregateBytes: Buffer.byteLength(body),
    });
  } finally {
    if (receiver.listening)
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
  }
});
type CollectorRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  resume(): void;
  [Symbol.asyncIterator](): AsyncGenerator<Buffer>;
};
const collectorFixture = () => {
  const source = readFileSync(
    resolve(integrationRoot, "destination-server.mjs"),
    "utf8",
  )
    .replace('import { createServer } from "node:http";\n', "")
    .replace(
      'import { createServer as createSecureServer } from "node:https";\n',
      "",
    );
  let closes = 0;
  let terminate!: () => void;
  const process = {
    exitCode: 0,
    once: (signal: string, listener: () => void) => {
      expect(signal).toBe("SIGTERM");
      terminate = listener;
    },
    argv: ["node", "destination-server.mjs", "ingestion"],
    env: {
      AGENTSCOPE_SCENARIO_ID: "codex-tui-trace-smoke",
      AGENTSCOPE_MAXIMUM_REQUEST_BYTES: "1048576",
      AGENTSCOPE_COLLECTOR_TLS_CERT: "synthetic-cert",
      AGENTSCOPE_COLLECTOR_TLS_KEY: "synthetic-key",
    },
  };
  const server = {
    listen: () => undefined,
    close: () => {
      closes += 1;
    },
  };
  const receiver = runInNewContext(`${source}; ({handleRequest})`, {
    Buffer,
    URL,
    console: { log: () => undefined },
    process,
    createServer: () => {
      throw new Error("unexpected-insecure-server");
    },
    createSecureServer: (options: { cert: string; key: string }) => {
      expect(options).toEqual({ cert: "synthetic-cert", key: "synthetic-key" });
      return server;
    },
  }) as {
    handleRequest(request: CollectorRequest, response: unknown): Promise<void>;
  };
  const request = (
    method: string,
    url: string,
    remoteAddress = "172.20.0.2",
    chunks: Buffer[] = [],
  ) => ({
    method,
    url,
    socket: { remoteAddress },
    headers: {
      authorization: `Basic ${Buffer.from("DUMMY_PUBLIC_KEY:DUMMY_SECRET_KEY").toString("base64")}`,
      "content-type": "application/json",
      "x-langfuse-ingestion-version": "4",
      "x-forwarded-for": "127.0.0.1",
    },
    resume: () => undefined,
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* chunks;
    },
  });
  const receive = (input: CollectorRequest, sendFails = false) => {
    const result = { status: 0, text: "" };
    const settled = receiver.handleRequest(input, {
      writeHead: (status: number) => {
        result.status = status;
      },
      end: (text: string) => {
        if (sendFails) throw new Error("PRIVATE SEND FAILURE");
        result.text = text;
      },
    });
    return { result, settled };
  };
  return {
    request,
    receive,
    closes: () => closes,
    terminate: () => {
      terminate();
    },
    exitCode: () => process.exitCode,
  };
};
const emittedRoot = resolve(integrationRoot, "../../packages/testkit/dist");
describe("collector guarded ordinary termination", () => {
  it("makes unsealed termination nonzero", () => {
    const fixture = collectorFixture();
    fixture.terminate();
    expect(fixture.closes()).toBe(1);
    expect(fixture.exitCode()).toBe(1);
  });
  it("makes partial snapshot send termination nonzero", async () => {
    const fixture = collectorFixture();
    const snapshot = fixture.receive(
      fixture.request("GET", "/observations", "127.0.0.1"),
      true,
    );
    await expect(snapshot.settled).rejects.toThrow("PRIVATE SEND FAILURE");
    fixture.terminate();
    expect(fixture.closes()).toBe(1);
    expect(fixture.exitCode()).toBe(1);
  });
  it("makes failed collector termination nonzero after its refused snapshot", async () => {
    const fixture = collectorFixture();
    const request = fixture.request(
      "POST",
      "/api/public/otel/v1/traces",
      "172.20.0.2",
      [Buffer.from("{}")],
    );
    request.headers.authorization = "Basic invalid";
    await fixture.receive(request).settled;
    const snapshot = fixture.receive(
      fixture.request("GET", "/observations", "127.0.0.1"),
    );
    await snapshot.settled;
    expect(snapshot.result.status).toBe(409);
    fixture.terminate();
    expect(fixture.exitCode()).toBe(1);
  });
});
it("keeps the sealed producer alive while its snapshot reader has not terminated", async () => {
  const fixture = collectorFixture();
  const body = Buffer.from('{"synthetic":true}');
  await fixture.receive(
    fixture.request("POST", "/api/public/otel/v1/traces", "172.20.0.2", [body]),
  ).settled;
  const snapshot = fixture.receive(
    fixture.request("GET", "/observations", "127.0.0.1"),
  );
  await snapshot.settled;
  expect(snapshot.result.status).toBe(200);
  expect(JSON.parse(snapshot.result.text) as unknown).toMatchObject({
    observationVersion: 2,
    batches: [body.toString("base64")],
    aggregateBytes: body.byteLength,
  });
  // Snapshot publication is not proof that the same-container reader exited.
  expect(fixture.closes()).toBe(0);
  const late = fixture.receive(
    fixture.request("POST", "/api/public/otel/v1/traces", "172.20.0.2", [body]),
  );
  await late.settled;
  expect(late.result.status).toBe(409);
  fixture.terminate();
  expect(fixture.closes()).toBe(1);
  expect(fixture.exitCode()).toBe(0);
});
const parse = (text: string) =>
  ts.createSourceFile("fixture.js", text, ts.ScriptTarget.ESNext, true);

function relativeEdges(text: string, includeDynamic: boolean) {
  const edges: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      if (!ts.isStringLiteral(node.moduleSpecifier))
        throw new Error("nonliteral-runtime-edge");
      edges.push(node.moduleSpecifier.text);
    }
    if (
      includeDynamic &&
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (
        node.arguments.length !== 1 ||
        argument === undefined ||
        !ts.isStringLiteral(argument)
      )
        throw new Error("nonliteral-runtime-edge");
      edges.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(text));
  return edges.filter((edge) => !edge.startsWith("node:"));
}

function requireClosure(
  files: readonly string[],
  root: string,
  prefix = "",
  entries: readonly string[] = files,
  staticOnly = false,
) {
  const inventory = new Set(files);
  const pending = [...entries];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || !inventory.has(file))
      throw new Error("missing-runtime-entry");
    if (visited.has(file) || !/\.m?js$/u.test(file)) continue;
    visited.add(file);
    const source = readFileSync(
      resolve(root, file.slice(prefix.length)),
      "utf8",
    );
    for (const edge of relativeEdges(source, !staticOnly)) {
      const target = posix.normalize(posix.join(posix.dirname(file), edge));
      if (!edge.startsWith(".") || !inventory.has(target))
        throw new Error(`unresolved-runtime-edge:${target}`);
      pending.push(target);
    }
  }
}

function scenarioProjection(
  omitFrom?: "sources" | "copy",
  omitted:
    | "selected-runtime-files.mjs"
    | "codex-trace-child-diagnostics.mjs" = "selected-runtime-files.mjs",
) {
  const names: string[] = [];
  const copied: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "sources" &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      const first = node.initializer.elements[0];
      if (
        first === undefined ||
        !ts.isSpreadElement(first) ||
        !ts.isCallExpression(first.expression)
      )
        throw new Error("unrecognized-runtime-sources");
      const mapping = first.expression.expression;
      const callback = first.expression.arguments[0];
      if (
        !ts.isPropertyAccessExpression(mapping) ||
        mapping.name.text !== "map" ||
        !ts.isArrayLiteralExpression(mapping.expression) ||
        callback === undefined ||
        !ts.isArrowFunction(callback) ||
        callback.body.getText().replace(/\s/gu, "") !==
          "[name,resolve(integrationRoot,name)]"
      )
        throw new Error("unrecognized-runtime-sources");
      for (const name of mapping.expression.elements) {
        if (!ts.isStringLiteral(name))
          throw new Error("nonliteral-runtime-source");
        names.push(name.text);
      }
    }
    if (ts.isStringLiteral(node) && node.text.startsWith("COPY runner.mjs "))
      copied.push(...node.text.split(" ").slice(1, -1));
    ts.forEachChild(node, visit);
  };
  visit(
    parse(readFileSync(resolve(integrationRoot, "run-scenarios.mjs"), "utf8")),
  );
  return names.filter(
    (name) =>
      !(omitFrom === "sources" && name === omitted) &&
      copied.some(
        (copy) => copy === name && !(omitFrom === "copy" && copy === omitted),
      ),
  );
}

describe("actual emitted immutable scenario runtime closure", () => {
  it.each(["sources", "copy"] as const)(
    "rejects the actual static diagnostic helper omitted from %s",
    (projection) => {
      expect(() => {
        requireClosure(
          scenarioProjection(projection, "codex-trace-child-diagnostics.mjs"),
          integrationRoot,
          "",
          ["immutable-candidate-authority.mjs"],
          true,
        );
      }).toThrow("unresolved-runtime-edge:codex-trace-child-diagnostics.mjs");
    },
  );
  it.each([false, true])(
    "checks Testkit closure with helper omitted %s",
    (omitted) => {
      const probe = () => {
        requireClosure(
          selectedRuntimeFiles.filter(
            (name) => !omitted || !name.endsWith("/proc-process-snapshot.js"),
          ),
          emittedRoot,
          "testkit/",
        );
      };
      if (omitted)
        expect(probe).toThrow(
          "unresolved-runtime-edge:testkit/internal/proc-process-snapshot.js",
        );
      else expect(probe).not.toThrow();
    },
  );
  // Conditional dynamic edges belong to scenario.runtimeArtifacts, not this
  // fixed top-level authority graph. Testkit includes literal dynamic edges.
  it.each([undefined, "sources", "copy"] as const)(
    "checks top-level static closure with inventory omitted from %s",
    (projection) => {
      const probe = () => {
        requireClosure(
          scenarioProjection(projection),
          integrationRoot,
          "",
          ["immutable-candidate-authority.mjs"],
          true,
        );
      };
      if (projection === undefined) expect(probe).not.toThrow();
      else
        expect(probe).toThrow(
          "unresolved-runtime-edge:selected-runtime-files.mjs",
        );
    },
  );
});

describe("independent collector socket custody", () => {
  const body = Buffer.from('{"resourceSpans":[]}');
  const ingestPath = "/api/public/otel/v1/traces";
  it("denies candidate terminal reads before mutation and preserves real ingress", async () => {
    const fixture = collectorFixture();
    const denied = fixture.receive(fixture.request("GET", "/observations"));
    await denied.settled;
    expect(denied.result).toEqual({ status: 403, text: "{}" });
    expect(fixture.closes()).toBe(0);
    const ingested = fixture.receive(
      fixture.request("POST", ingestPath, "172.20.0.2", [body]),
    );
    await ingested.settled;
    expect(ingested.result.status).toBe(200);
    const terminal = fixture.receive(
      fixture.request("GET", "/observations", "127.0.0.1"),
    );
    await terminal.settled;
    expect(JSON.parse(terminal.result.text)).toEqual({
      observationVersion: 2,
      scenarioId: "codex-tui-trace-smoke",
      batches: [body.toString("base64")],
      aggregateBytes: body.length,
    });
    expect(terminal.result.status).toBe(200);
    expect(fixture.closes()).toBe(0);
    fixture.terminate();
    expect(fixture.closes()).toBe(1);
    expect(fixture.exitCode()).toBe(0);
  });
  it("drains all admitted handlers without accepting new work after the cut", async () => {
    const fixture = collectorFixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = fixture.request("POST", ingestPath);
    input[Symbol.asyncIterator] = async function* () {
      await held;
      yield body;
    };
    const pending = fixture.receive(input);
    const terminal = fixture.receive(
      fixture.request("GET", "/observations", "::1"),
    );
    const late = fixture.receive(
      fixture.request("POST", ingestPath, "172.20.0.2", [body]),
    );
    await late.settled;
    expect(late.result.status).toBe(409);
    expect(terminal.result.status).toBe(0);
    expect(fixture.closes()).toBe(0);
    release();
    await Promise.all([pending.settled, terminal.settled]);
    expect(terminal.result.status).toBe(200);
    expect(fixture.closes()).toBe(0);
    fixture.terminate();
    expect(fixture.closes()).toBe(1);
    expect(fixture.exitCode()).toBe(0);
  });
  it("refuses overflow or failed authentication without publishing original bodies", async () => {
    for (const overflow of [false, true]) {
      const fixture = collectorFixture();
      const canary = Buffer.from("PRIVATE_RAW_CANARY");
      const input = fixture.request("POST", ingestPath, "172.20.0.2", [
        overflow ? Buffer.alloc(1048577, canary[0]) : canary,
      ]);
      if (!overflow) input.headers.authorization = "Basic invalid";
      const rejected = fixture.receive(input);
      await rejected.settled;
      expect(rejected.result.status).toBe(overflow ? 413 : 400);
      const terminal = fixture.receive(
        fixture.request("GET", "/observations", "::ffff:127.0.0.1"),
      );
      await terminal.settled;
      expect(terminal.result.status).toBe(409);
      expect(terminal.result.text).not.toContain(canary.toString());
      expect(
        (JSON.parse(terminal.result.text) as { batches: string[] }).batches,
      ).toEqual([]);
    }
  });
});
