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
    const source = readFileSync(
      new URL("../image-preparation/boundary.mjs", import.meta.url),
      "utf8",
    );
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
  const source = readFileSync(
    new URL("../controller-file-command.mjs", import.meta.url),
    "utf8",
  );
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
      const source = readFileSync(
        new URL(
          "../mockserver-material/prepare-bootstrap.mjs",
          import.meta.url,
        ),
        "utf8",
      );
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
  readFileSync(
    new URL("../../../.github/workflows/integration.yml", import.meta.url),
    "utf8",
  ),
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
