import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuildStderrObservation } from "../image-preparation/process-output.mjs";

type RuntimeFunctions = {
  mockServerNetworkObservation: (
    server: unknown,
    network: unknown,
  ) => Record<string, unknown>;
  startMockServer: (plan: unknown, signal: unknown) => Promise<void>;
};
const runtimeSource = () =>
  readFileSync(resolve(import.meta.dirname, "../run-scenarios.mjs"), "utf8");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const load = (records: unknown, sink: (value: string) => void) => {
  const source = runtimeSource();
  const start = source.indexOf("const mockServerNetworkObservation =");
  const end = source.indexOf(
    "// eslint-disable-next-line complexity -- exact closed container terminal witness",
    start,
  );
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const controls = new Map([["run", {}]]);
  const calls: string[][] = [];
  return {
    controls,
    calls,
    functions: runInNewContext(
      `${source.slice(start, end)}; ({ mockServerNetworkObservation, startMockServer })`,
      {
        types,
        console: { error: sink },
        canonicalImagePlatform: "linux/amd64",
        ISOLATION_EXECUTOR_LIMITS: { containers: { mockServer: {} } },
        assertControlVolumeCurrent: async () => {},
        labelArguments: () => [],
        sidecarResourceArguments: () => [],
        tmpfsArguments: () => [],
        assertContainer: () => Promise.resolve("fixed-container"),
        dockerWithSignal: (args: string[]) => {
          calls.push(args);
          return Promise.resolve({ stdout: JSON.stringify(records) });
        },
        mockServerBuiltImages: new Map([["run", { imageId: "fixed-image" }]]),
        mockServerControls: controls,
        mockServerContainerIdentities: new Map(),
      },
    ) as RuntimeFunctions,
  };
};
describe("content-free MockServer network refusal observation", () => {
  const plan = {
    runId: "run",
    mockServerName: "fixed",
    networkName: "network",
  };
  it.each([true, false])(
    "retains original refusal and fixed state when running=%s",
    async (running) => {
      const output: string[] = [];
      const value = load(
        [
          {
            Image: "fixed-image",
            State: {
              Status: running ? "running" : "exited",
              Running: running,
              OOMKilled: false,
              ExitCode: 1,
              Error: "PRIVATE_CANARY",
            },
            NetworkSettings: { Networks: { network: { IPAddress: "" } } },
          },
        ],
        (text) => output.push(text),
      );
      await expect(value.functions.startMockServer(plan, {})).rejects.toThrow(
        "integration.isolation.mockserver-network",
      );
      expect(value.calls.map((args) => args[0])).toEqual([
        "create",
        "start",
        "container",
      ]);
      expect(output).toHaveLength(1);
      expect(output[0]).not.toContain("PRIVATE_CANARY");
      const projected = JSON.parse(
        output[0]!.split("diagnostic:")[1]!,
      ) as Record<string, unknown>;
      expect(projected).toEqual({
        diagnosticVersion: 1,
        trust: "untrusted-diagnostic",
        stage: "mockserver-network-refusal",
        status: running ? "running" : "exited",
        running,
        oomKilled: false,
        exitCode: 1,
        networkCount: 1,
        ipPresent: false,
      });
      expect(value.controls.get("run")).toEqual({});
    },
  );
  it("refuses accessor/proxy and out-of-range facts without invoking caller code", () => {
    const observe = load([], () => {}).functions.mockServerNetworkObservation;
    const trap = () => {
      throw Error("PRIVATE_CANARY");
    };
    const server = {
      State: {
        get Status() {
          return trap();
        },
        Running: "true",
        OOMKilled: 1,
        ExitCode: 256,
      },
      NetworkSettings: {
        Networks: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [index, {}]),
        ),
      },
    };
    expect(observe(server, new Proxy({}, { get: trap }))).toMatchObject({
      status: "unknown",
      running: null,
      oomKilled: null,
      exitCode: null,
      networkCount: null,
      ipPresent: false,
    });
    expect(
      observe(new Proxy({}, { getOwnPropertyDescriptor: trap }), {}),
    ).toMatchObject({ status: "unknown", exitCode: null });
  });
  it("keeps successful admission silent and failed diagnostic sinks non-authoritative", async () => {
    const record = {
      Image: "fixed-image",
      NetworkSettings: { Networks: { network: { IPAddress: "172.18.0.2" } } },
    };
    const value = load([record], () => {
      throw Error("sink-must-not-run");
    });
    await expect(
      value.functions.startMockServer(plan, {}),
    ).resolves.toBeUndefined();
    expect(value.controls.get("run")).toEqual({ host: "172.18.0.2" });
    record.NetworkSettings.Networks.network.IPAddress = "";
    const failed = load([record], () => {
      throw Error("PRIVATE_CANARY");
    });
    await expect(failed.functions.startMockServer(plan, {})).rejects.toThrow(
      "integration.isolation.mockserver-network",
    );
  });
});

const imageRoles = [
  "copy-java",
  "copy-jar",
  "copy-control",
  "copy-configuration",
  "export",
  "layers",
  "tar",
  "load",
];
const marker =
  "#7 1.0 [agentscope-material:v1 stage=supplier-connected-service-finalization family=none]\n";
const copy = [
  [
    "copy-java",
    "COPY --from=supplier /supplier/tools/jdk-17.0.20.1+1 /opt/java",
  ],
  [
    "copy-jar",
    "COPY --from=supplier --chmod=0444 /supplier/source/mockserver/mockserver-netty/target/mockserver-netty-7.6.0-jar-with-dependencies.jar /opt/mockserver.jar",
  ],
  [
    "copy-control",
    "COPY --chmod=0600 control-private.pem control-jwks.json /opt/control/",
  ],
  [
    "copy-configuration",
    "COPY --chmod=0444 expectations.json /config/expectations.json",
  ],
];
describe("closed untrusted post-worker BuildKit observations", () => {
  it.each(copy)(
    "correlates only fixed %s vertex entry and completion",
    (role, command) => {
      const text = marker + `#7 DONE 2.0s\n#8 [stage-1 1/4] ${command}\n`;
      for (let split = 0; split < text.length; split++) {
        const observe = createBuildStderrObservation();
        observe.consume(Buffer.from(text.slice(0, split)));
        observe.consume(Buffer.from(text.slice(split)));
        expect(observe.snapshot()).toMatchObject({
          untrustedBootstrapStage: `supplier-image-${role}`,
          untrustedBootstrapFailureFamily: "none",
        });
        observe.consume(Buffer.from("#9 DONE 0.1s\n"));
        expect(observe.snapshot().untrustedBootstrapStage).toBe(
          `supplier-image-${role}`,
        );
        observe.consume(Buffer.from("#8 DONE 0.1s\n"));
        expect(observe.snapshot().untrustedBootstrapStage).toBe(
          `supplier-image-${role}-complete`,
        );
      }
    },
  );
  it.each([
    ["export", "exporting to docker image format"],
    ["layers", "exporting layers"],
    ["tar", "sending tarball"],
    ["load", "importing to docker"],
  ])(
    "observes only fixed %s rendering without claiming outcome",
    (role, text) => {
      const observe = createBuildStderrObservation();
      observe.consume(Buffer.from(marker + `#8 ${text}\n`));
      expect(observe.snapshot().untrustedBootstrapStage).toBe(
        `supplier-image-${role}`,
      );
      observe.consume(Buffer.from(`#8 ${text} 1.0s done\n`));
      expect(observe.snapshot().untrustedBootstrapStage).toBe(
        `supplier-image-${role}-complete`,
      );
      expect(observe.snapshot()).not.toHaveProperty("passed");
    },
  );
  it("requires supplier context and preserves independent Maven failure semantics", () => {
    const observe = createBuildStderrObservation();
    observe.consume(Buffer.from("#8 exporting layers\n"));
    expect(observe.snapshot().untrustedBootstrapStage).toBeUndefined();
    observe.consume(Buffer.from(marker + "#7 DONE 0.1s\n"));
    expect(observe.snapshot().untrustedBootstrapStage).toBe(
      "supplier-image-worker-complete",
    );
    for (const text of [
      "#8 sending tarball PRIVATE_CANARY",
      "#8 exporting layers 9999999.0s done",
      "#8 [stage-1 1/4] COPY PRIVATE_CANARY /opt/java",
      "#123456789 importing to docker",
      "X".repeat(257) + "#8 importing to docker",
    ])
      observe.consume(Buffer.from(text + "\n"));
    expect(observe.snapshot().untrustedBootstrapStage).toBe(
      "supplier-image-worker-complete",
    );
    expect(JSON.stringify(observe.snapshot())).not.toContain("PRIVATE_CANARY");
    observe.consume(
      Buffer.from(
        "#7 3.0 [agentscope-material:v1 stage=supplier-connected-package-other family=none maven=identified,2,0,5,0,0,0,0]\n",
      ),
    );
    expect(observe.snapshot().untrustedBootstrapStage).toBeUndefined();
  });
});

describe("closed content-free controller projection", () => {
  it("projects only closed image roles and existing pending goals through the actual sink", async () => {
    const actual = await vi.importActual<{
      publishBootstrapGpgObservation: (
        diagnostic: unknown,
        environment: NodeJS.ProcessEnv,
      ) => void;
    }>("../controller-file-command.mjs");
    const root = mkdtempSync(resolve(tmpdir(), "agentscope-build-role-"));
    roots.push(root);
    const output = resolve(root, "output");
    const environment = {
      AGENTSCOPE_MOCKSERVER_RESEARCH: "supplier",
      GITHUB_OUTPUT: output,
    };
    const stages = [
      "supplier-image-worker-complete",
      ...imageRoles.flatMap((role) => [
        `supplier-image-${role}`,
        `supplier-image-${role}-complete`,
      ]),
      ...["", "connected-"].flatMap((prefix) =>
        Array.from(
          { length: 12 },
          (_, index) =>
            `supplier-${prefix}package-goal-${String.fromCharCode(97 + index)}`,
        ),
      ),
    ];
    for (const stage of stages) {
      writeFileSync(output, "", { mode: 0o600 });
      actual.publishBootstrapGpgObservation(
        {
          process: {
            untrustedBootstrapStage: stage,
            untrustedBootstrapFailureFamily: "none",
          },
        },
        environment,
      );
      expect(readFileSync(output, "utf8")).toContain(
        `untrusted_bootstrap_stage=${stage}\n`,
      );
      writeFileSync(output, "", { mode: 0o600 });
      actual.publishBootstrapGpgObservation(
        {
          process: {
            untrustedBootstrapStage: stage + "\nPRIVATE_CANARY",
            untrustedBootstrapFailureFamily: "none",
          },
        },
        environment,
      );
      expect(readFileSync(output, "utf8")).toContain(
        "untrusted_bootstrap_stage=unknown\n",
      );
      expect(readFileSync(output, "utf8")).not.toContain("PRIVATE_CANARY");
    }
  });
});
