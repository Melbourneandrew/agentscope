import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { types } from "node:util";
import { runInNewContext } from "node:vm";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { createBuildStderrObservation } from "../image-preparation/process-output.mjs";

const marker = (stage: string, family = "none") =>
  `[agentscope-material:v1 stage=${stage} family=${family}]\n`;
const observe = (chunks: readonly string[]) => {
  const observation = createBuildStderrObservation();
  for (const chunk of chunks) observation.consume(Buffer.from(chunk));
  return observation.snapshot();
};
const absent = {
  stderrClass: "unknown",
};
const sourceAt = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("bounded untrusted bootstrap text observations", () => {
  it("retains only enums across every byte split and BuildKit prefix", () => {
    const text =
      `#7 0.193 ${marker("import-key")}` +
      `#7 0.194 ${marker("import-key", "gpg-execution")}`;
    for (let split = 0; split <= text.length; split += 1) {
      expect(observe([text.slice(0, split), text.slice(split)])).toEqual({
        ...absent,
        untrustedBootstrapStage: "import-key",
        untrustedBootstrapFailureFamily: "gpg-execution",
      });
    }
  });

  it("scans past the retained 16KiB prefix without retaining raw late content", () => {
    const observation = createBuildStderrObservation();
    expect(observation.consume(Buffer.from("X".repeat(20_000) + "\n"))).toBe(
      true,
    );
    observation.consume(Buffer.from(marker("verify-signature")));
    observation.consume(
      Buffer.from(marker("verify-signature", "gpg-execution")),
    );
    expect(observation.snapshot()).toEqual({
      ...absent,
      untrustedBootstrapStage: "verify-signature",
      untrustedBootstrapFailureFamily: "gpg-execution",
    });
    expect(JSON.stringify(observation.snapshot())).not.toContain("XXXX");
  });

  it("preserves the original stderr classifier and truncation boundary", () => {
    const observation = createBuildStderrObservation();
    expect(observation.consume(Buffer.from("permission denied\n"))).toBe(false);
    expect(observation.snapshot()).toEqual({
      ...absent,
      stderrClass: "permission-denied",
    });
    expect(observation.consume(Buffer.alloc(16_384))).toBe(true);
    expect(observation.snapshot().stderrClass).toBe("permission-denied");
  });

  it("neutral markers cannot introduce or displace the original classifier", () => {
    const text = "X".repeat(16_340) + "\npermission denied\n";
    const expected = observe([text]).stderrClass;
    for (const chunks of [
      [marker("import-key"), text],
      [marker("import-key").slice(0, 20), marker("import-key").slice(20), text],
      [text.slice(0, 100), text.slice(100), marker("import-key")],
    ])
      expect(observe(chunks).stderrClass).toBe(expected);
    expect(expected).toBe("permission-denied");
  });

  it.each([
    marker("import-key") + marker("authenticate-inputs"),
    marker("import-key") + marker("import-key"),
    marker("import-key", "gpg-execution") + marker("list-key"),
    marker("import-key", "filesystem"),
    marker("completed", "signature-policy"),
    marker("unknown"),
    marker("import-key", "secret-canary"),
    marker("import-key").replace("family=none", "family=none extra=canary"),
    "arbitrary-prefix " + marker("import-key"),
    "X".repeat(300) + marker("import-key"),
    marker("import-key").trimEnd(),
    marker("import-key") + "[agentscope-material:v1 malformed]\n",
    marker("import-key").replace(":v1", ":v2"),
    marker("import-key").replace(":v1", ""),
    marker("import-key") + "[agentscope-material",
    marker("import-key").trimEnd() + "X".repeat(300) + "\n",
  ])("rejects ambiguity or malformed marker shape", (text) => {
    expect(observe([text])).toEqual(absent);
  });

  it("never promotes ordinary output or a complete observation to authority", () => {
    expect(observe(["canary vendor body\n"])).toEqual(absent);
    expect(observe([marker("completed")])).toEqual({
      ...absent,
      untrustedBootstrapStage: "completed",
      untrustedBootstrapFailureFamily: "none",
    });
  });
});

describe("actual owned kernel output consumer (VM dependencies, no processes)", () => {
  it("keeps the original combined output cap and retains late marker enums", () => {
    const source = sourceAt("../image-preparation/boundary.mjs");
    const start = source.indexOf("  const consume = (chunk, retain) => {");
    const body = source.slice(
      start,
      source.indexOf("  child.stdout.on", start),
    );
    const outputChunks: Buffer[] = [];
    const failures: string[] = [];
    const observation = createBuildStderrObservation();
    const consume = runInNewContext(
      "let bytes = 0; let outputTruncated = false;\n" + body + "\nconsume;",
      {
        outputChunks,
        maximumBuildOutputBytes: 16 * 1024 * 1024,
        stderrObservation: observation,
        timeoutAfterOutputForTesting: undefined,
        applyOutputTimeoutForTesting: () => undefined,
        fail: (code: string) => {
          failures.push(code);
        },
      },
      { timeout: 1_000 },
    ) as (bytes: Buffer, retain: boolean) => void;
    consume(Buffer.from("X".repeat(20_000) + "\n"), false);
    consume(Buffer.from(marker("verify-signature")), false);
    consume(Buffer.from(marker("verify-signature", "gpg-execution")), false);
    consume(Buffer.from("stdout-canary"), true);
    expect(outputChunks.map((chunk) => chunk.toString())).toEqual([
      "stdout-canary",
    ]);
    expect(observation.snapshot().untrustedBootstrapStage).toBe(
      "verify-signature",
    );
    expect(failures).toEqual([]);
    consume(Buffer.alloc(16 * 1024 * 1024), true);
    expect(failures).toEqual(["integration.images.output"]);
    expect(outputChunks).toHaveLength(1);
  });
});

type Projection = (value: unknown, environment: Record<string, string>) => void;
const fileCommandProjection = (write: (bytes: Buffer) => void) => {
  const source = sourceAt("../controller-file-command.mjs");
  return runInNewContext(
    source.replace(/^import .*;$/gmu, "").replaceAll("export const", "const") +
      "\npublishBootstrapGpgObservation;",
    {
      Buffer,
      types,
      isAbsolute: (value: string) => value.startsWith("/"),
      constants: { O_WRONLY: 1, O_APPEND: 2, O_NOFOLLOW: 4, O_NONBLOCK: 8 },
      openSync: () => 1,
      fstatSync: () => ({ isFile: () => true }),
      writeSync: (_fd: number, bytes: Buffer) => {
        write(bytes);
      },
      closeSync: () => undefined,
    },
    { timeout: 1_000 },
  ) as Projection;
};

interface BuildReplay {
  mapped: Error;
  build: () => Promise<unknown>;
  diagnostic: () => unknown;
  usable: () => boolean;
  retirementRequired: () => boolean;
  block: (kind: "uncertain" | "pending") => void;
}
const builderReplay = (settings: {
  failure?: Error;
  settlementFailure?: Error;
  archiveFailure?: Error;
  diagnosticFailure?: boolean;
}): BuildReplay => {
  const source = sourceAt("../image-preparation/docker.mjs");
  const stateSource = sourceAt("../image-preparation/state.mjs");
  const capture = source.slice(
    source.indexOf("  const captureFirstBuildFailure ="),
    source.indexOf("  const finalizeBuildResult ="),
  );
  const start = source.indexOf("  const executePreparedBuild = async (");
  const build = source.slice(
    start,
    source.indexOf("\n  return Object.freeze({", start),
  );
  const mapped = new Error("integration.images.build.image-build.unknown");
  const process = observe([
    marker("import-key"),
    marker("import-key", "gpg-execution"),
  ]);
  return runInNewContext(
    stateSource.replace("export const", "const") +
      `
      const lifecycle = createImagePreparationState();
      const state = lifecycle.docker;
      const client = { evidence: { images: [{ image: "fixture" }] } };
      state.admitClient(client);
      ${capture}\n${build}
      ({
        mapped,
        build: () => buildPreparedDockerImage(client, {
          buildArguments: {}, buildNetwork: "none", buildOutput: "image",
          context: "/fixture", dockerfile: "Verifier.Dockerfile", labels: {},
          maximumMilliseconds: 1000, tag: "fixture:tag"
        }),
        diagnostic: () => state.readDiagnostic(client),
        usable: () => state.clientIsUsable(client),
        retirementRequired: () => lifecycle.retirement.clientIsUncertain(client),
        block: (kind) => kind === "uncertain" ? state.markUncertain(client) : state.recordPendingImage(client, "fixture:tag", "fixture")
      });`,
    {
      mapped,
      selectBuildNetwork: (value: unknown) => value,
      selectBuildOutput: (value: unknown) => value,
      validBuildInput: () => true,
      imageBuildPolicy: () => ({ workDeadline: 100, deadline: 200 }),
      defaultMaximumBuildContextBytes: 1024,
      createBuildArchive: () => {
        if (settings.archiveFailure) throw settings.archiveFailure;
        return Buffer.alloc(0);
      },
      createBuildAuthority: () => ({
        requestCapable: true,
        currentOperationKind: "image-build",
        builder: "fixture",
        buildkit: {},
        client: {},
        reconciliationReasons: {},
      }),
      executeBuilderBuild: () => {
        if (settings.failure) throw settings.failure;
        return {};
      },
      readImageProcessDiagnostic: (error: unknown) =>
        error === settings.settlementFailure
          ? observe([
              marker("authenticate-inputs"),
              marker("authenticate-inputs", "input"),
            ])
          : process,
      builderResources: () => ({
        container: "fixture-container",
        volume: "fixture-volume",
      }),
      diagnosticDigest: () => {
        if (settings.diagnosticFailure) throw new Error("fixture-diagnostic");
        return "sha256-fixture";
      },
      settleBuilderBuild: () => {
        if (settings.settlementFailure) throw settings.settlementFailure;
      },
      settledBuildFailure: () => mapped,
      fixedError: (code: string) => new Error(code),
      finalizeBuildResult: () => "fixture-result",
    },
    { timeout: 1000 },
  ) as BuildReplay;
};

describe("actual builder failure observation and existing state map", () => {
  it("retains joined failed-build enums without changing failure or usability", async () => {
    const replay = builderReplay({ failure: new Error("fixture-command") });
    await expect(replay.build()).rejects.toBe(replay.mapped);
    expect(replay.usable()).toBe(true);
    expect(replay.diagnostic()).toMatchObject({
      outcome: "failed-settled",
      process: {
        untrustedBootstrapStage: "import-key",
        untrustedBootstrapFailureFamily: "gpg-execution",
      },
    });
    let output = "";
    fileCommandProjection((bytes) => {
      output += bytes.toString();
    })(replay.diagnostic(), {
      AGENTSCOPE_MOCKSERVER_RESEARCH: "supplier",
      GITHUB_OUTPUT: "/output",
    });
    expect(output).toContain("untrusted_bootstrap_stage=import-key\n");
    expect(output).toContain(
      "untrusted_bootstrap_failure_family=gpg-execution\n",
    );
  });

  it("preserves the exact controlling error and first failure when settlement fails", async () => {
    const primary = new Error("integration.images.output");
    const ordinary = builderReplay({ failure: primary });
    await expect(ordinary.build()).rejects.toBe(primary);
    const optional = builderReplay({
      failure: new Error("fixture-command"),
      diagnosticFailure: true,
    });
    await expect(optional.build()).rejects.toBe(optional.mapped);
    const cleanup = new Error("fixture-cleanup");
    const unsettled = builderReplay({
      failure: new Error("fixture-command"),
      settlementFailure: cleanup,
    });
    await expect(unsettled.build()).rejects.toBe(cleanup);
    expect(unsettled.usable()).toBe(false);
    expect(unsettled.diagnostic()).toMatchObject({
      outcome: "retired-failure",
      process: { untrustedBootstrapStage: "import-key" },
    });
  });

  it("clears stale settled observations before a valid build's pre-invocation failure", async () => {
    const settings: { failure: Error; archiveFailure?: Error } = {
      failure: new Error("fixture-command"),
    };
    const replay = builderReplay(settings);
    await expect(replay.build()).rejects.toThrow();
    expect(replay.diagnostic()).toMatchObject({ outcome: "failed-settled" });
    settings.archiveFailure = new Error("fixture-context");
    await expect(replay.build()).rejects.toBe(settings.archiveFailure);
    expect(replay.diagnostic()).toBeUndefined();
  });

  it.each(["uncertain", "pending"] as const)(
    "does not erase evidence for a %s client rejected before work",
    async (kind) => {
      const replay = builderReplay({ failure: new Error("fixture-command") });
      await expect(replay.build()).rejects.toThrow();
      const diagnostic = replay.diagnostic();
      replay.block(kind);
      expect(replay.retirementRequired()).toBe(kind === "uncertain");
      await expect(replay.build()).rejects.toThrow(
        "integration.images.build.input",
      );
      expect(replay.diagnostic()).toBe(diagnostic);
    },
  );

  it("keeps successful builds silent and non-certifying", async () => {
    const replay = builderReplay({});
    await expect(replay.build()).resolves.toBe("fixture-result");
    expect(replay.diagnostic()).toBeUndefined();
    expect(replay.usable()).toBe(true);
  });
});

describe("existing outer observation projection", () => {
  it("projects fixed private-process observations without inspecting thrown contents", () => {
    let output = "";
    const publish = fileCommandProjection((bytes) => {
      output += bytes.toString();
    });
    publish(
      {
        process: {
          untrustedBootstrapStage: "import-key",
          untrustedBootstrapFailureFamily: "gpg-execution",
          stderr: "SECRET_CANARY",
        },
      },
      { AGENTSCOPE_MOCKSERVER_RESEARCH: "supplier", GITHUB_OUTPUT: "/output" },
    );
    expect(output).toContain("untrusted_bootstrap_stage=import-key\n");
    expect(output).toContain(
      "untrusted_bootstrap_failure_family=gpg-execution\n",
    );
    expect(output).not.toContain("SECRET_CANARY");
  });

  it("rejects substituted enums/getters and treats write failure as optional", () => {
    let reads = 0;
    let output = "";
    const publish = fileCommandProjection((bytes) => {
      output += bytes.toString();
    });
    publish(
      {
        process: {
          get untrustedBootstrapStage() {
            reads += 1;
            return "import-key";
          },
          untrustedBootstrapFailureFamily: "none\nFORGED=true",
        },
      },
      { AGENTSCOPE_MOCKSERVER_RESEARCH: "supplier", GITHUB_OUTPUT: "/output" },
    );
    expect(reads).toBe(0);
    expect(output).toContain("untrusted_bootstrap_stage=unknown\n");
    expect(output).toContain("untrusted_bootstrap_failure_family=unknown\n");
    expect(() => {
      fileCommandProjection(() => {
        throw new Error("CANARY");
      })(
        {},
        {
          AGENTSCOPE_MOCKSERVER_RESEARCH: "supplier",
          GITHUB_OUTPUT: "/output",
        },
      );
    }).not.toThrow();
  });
});

describe("actual bootstrap host failure boundary", () => {
  it.each([false, true])(
    "projects the existing client observation without replacing primary (sink failure=%s)",
    async (sinkFails) => {
      const source = sourceAt("../mockserver-material/prepare-bootstrap.mjs");
      const start = source.indexOf("const verifyKind =");
      const body = source.slice(
        start,
        source.indexOf("/** Mutable returned archives", start),
      );
      const primary = new Error("PRIMARY_CANARY");
      const diagnostic = {
        process: {
          untrustedBootstrapStage: "import-key",
          untrustedBootstrapFailureFamily: "gpg-execution",
        },
      };
      const client = {};
      const seen: unknown[] = [];
      const verify = runInNewContext(
        body + "\nverifyKind;",
        {
          reserveMilliseconds: 6_000,
          maximumContextBytes: 384 * 1024 * 1024,
          base: "fixed-base",
          performance: { now: () => 1 },
          check: () => undefined,
          stageContext: () => "fixed-context",
          publishMaterialResearchPhase: () => undefined,
          buildPreparedDockerImage: () => Promise.reject(primary),
          preparedDockerClientDiagnostic: (value: unknown) => {
            expect(value).toBe(client);
            return diagnostic;
          },
          publishBootstrapGpgObservation: (value: unknown) => {
            seen.push(value);
            if (sinkFails) throw new Error("OPTIONAL_CANARY");
          },
          retirePreparedDockerImage: () => {
            throw new Error("must-not-retire-without-image");
          },
        },
        { timeout: 1_000 },
      ) as (...args: unknown[]) => Promise<unknown>;
      await expect(
        verify(
          { deadline: 10_000, dockerClient: client, runId: "run", signal: {} },
          {},
          "maven",
          {},
          {},
        ),
      ).rejects.toBe(primary);
      expect(seen).toEqual([diagnostic]);
    },
  );
});

type Step = { name?: string; run?: string; env?: Record<string, string> };
const workflow = parseYaml(
  sourceAt("../../../.github/workflows/integration.yml"),
) as {
  jobs: Record<string, { steps: Step[] }>;
};
const projection = workflow.jobs["mockserver-supplier-research"]!.steps.find(
  ({ name }) => name === "Project closed research shell observations",
)!;

describe("closed existing workflow observation (synthetic shell only)", () => {
  it.each([
    ["import-key", "gpg-execution", "import-key", "gpg-execution"],
    ["secret\nFORGED=true", "$(false)", "unknown", "unknown"],
    ["", "", "unknown", "unknown"],
  ])(
    "sanitizes fixed fields without changing the optional step outcome",
    (stage, family, expectedStage, expectedFamily) => {
      expect(projection.env?.OBSERVED_UNTRUSTED_BOOTSTRAP_STAGE).toBe(
        "${{ steps.research_packet.outputs.untrusted_bootstrap_stage }}",
      );
      const result = spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-e", "-c", projection.run!],
        {
          env: {
            OBSERVED_MATERIAL_PHASE: "verify-maven",
            OBSERVED_UNTRUSTED_BOOTSTRAP_STAGE: stage,
            OBSERVED_UNTRUSTED_BOOTSTRAP_FAILURE_FAMILY: family,
            GITHUB_STEP_SUMMARY: "/dev/null",
          },
          timeout: 1_000,
          maxBuffer: 4_096,
          encoding: "utf8",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `untrusted_bootstrap_stage=${expectedStage}`,
      );
      expect(result.stdout).toContain(
        `untrusted_bootstrap_failure_family=${expectedFamily}`,
      );
      expect(result.stdout).not.toContain("FORGED=true");
    },
  );
});
