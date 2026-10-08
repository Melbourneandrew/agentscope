import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import {
  parseMavenFailureObservation,
  createBuildStderrObservation,
} from "../image-preparation/process-output.mjs";
import { classifyPackageFailure } from "./__tests__/fixtures/mockserver-supplier-command.js";

describe("actual bounded Maven rejection projection", () => {
  it.each(
    [
      "org.apache.maven.plugins:maven-compiler-plugin:3.15.0:compile",
      "org.apache.maven.plugins:maven-compiler-plugin:3.15.0:testCompile",
      "org.codehaus.mojo:templating-maven-plugin:3.1.0:filter-sources",
      "org.apache.maven.plugins:maven-enforcer-plugin:3.6.3:enforce",
      "org.apache.maven.plugins:maven-checkstyle-plugin:3.6.0:check",
      "org.codehaus.mojo:flatten-maven-plugin:1.8.0:flatten",
      "io.github.git-commit-id:git-commit-id-maven-plugin:9.0.1:revision",
      "com.github.eirslett:frontend-maven-plugin:2.0.0:install-node-and-npm",
      "com.github.eirslett:frontend-maven-plugin:2.0.0:npm",
      "org.apache.maven.plugins:maven-resources-plugin:3.5.0:copy-resources",
      "org.codehaus.mojo:exec-maven-plugin:3.6.3:exec",
      "org.apache.maven.plugins:maven-assembly-plugin:3.8.0:single",
    ].map((goal, index) => [goal, index + 1] as const),
  )("pins %s to ordinal %s", (goal, ordinal) => {
    const error = Object.assign(new Error(), {
      stdout: "",
      stderr: `[ERROR] Failed to execute goal ${goal} (PRIVATE_CANARY) on project private: PRIVATE_CANARY`,
      code: 255,
      signal: "SIGTERM",
    });
    expect(classifyPackageFailure(error).join(",")).toBe(
      `identified,256,1,${ordinal},0,0,0,0`,
    );
  });
  it.each(
    [
      "JsonBodySerializer",
      "MockServerEventLog",
      "HttpState",
      "RecordedRequestsFileSystemPersistence",
      "LifeCycle",
      "HttpRequestHandler",
    ].map((file, index) => [file, index + 1] as const),
  )("retains only fixed compiler unit %s", (file, unit) => {
    const reason = [
      "cannot find symbol",
      "incompatible types",
      "method does not override or implement a method from a supertype",
      "illegal start of expression",
      "';' expected",
      "reached end of file while parsing",
    ][unit - 1]!;
    const error = Object.assign(new Error(), {
      stdout: "",
      stderr: `[ERROR] /PRIVATE_CANARY/${file}.java:[999999,1] ${reason}: PRIVATE_CANARY`,
    });
    expect(classifyPackageFailure(error).join(",")).toBe(
      `identified,0,0,0,${unit},999999,1,${unit}`,
    );
    error.stderr +=
      "\n[ERROR] /PRIVATE_CANARY/Unknown.java:[1,1] cannot find symbol";
    expect(classifyPackageFailure(error)[0]).toBe("ambiguous");
  });
});
describe("bounded native Maven failure classification", () => {
  it.each([
    [
      "[ERROR] Failed to execute goal org.codehaus.mojo:templating-maven-plugin:3.1.0:filter-sources (x) on project mockserver-core: PRIVATE_CANARY",
      "identified",
      3,
    ],
    [
      "[ERROR] Failed to execute goal private.secret:unknown:1.0:run (x) on project x: PRIVATE_CANARY",
      "unlisted",
      0,
    ],
    ["PRIVATE_CANARY", "absent", 0],
  ])("emits only pinned ordinals from %s", (stderr, disposition, goal) => {
    const error = Object.assign(new Error("PRIVATE_CANARY"), {
      stdout: "",
      stderr,
      code: 1,
      signal: null,
    });
    const tuple = classifyPackageFailure(error).join(",");
    expect(tuple).toBe(`${disposition},2,0,${goal},0,0,0,0`);
    const result = observe([
      `[agentscope-material:v1 stage=supplier-connected-package-other family=none maven=${tuple}]\n`,
    ]);
    expect(result.untrustedMavenFailure).toMatchObject({
      disposition,
      exitCode: 1,
      goal,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
  });
  it("refuses hostile accessors, proxies, overflow and ambiguous goals", () => {
    let calls = 0;
    const error = Object.assign(new Error(), {
      stdout: "",
      stderr: "",
      code: 1,
    });
    Object.defineProperty(error, "stderr", {
      get() {
        calls++;
        throw Error();
      },
    });
    expect(classifyPackageFailure(error)[0]).toBe("absent");
    expect(
      classifyPackageFailure(
        new Proxy(error, {
          getOwnPropertyDescriptor() {
            calls++;
            throw Error();
          },
        }),
      )[0],
    ).toBe("absent");
    expect(calls).toBe(0);
    expect(
      classifyPackageFailure(
        Object.assign(new Error(), {
          stdout: "",
          stderr: "X".repeat(8 * 1024 * 1024 + 1),
        }),
      )[0],
    ).toBe("overflow");
    const goal =
      "[ERROR] Failed to execute goal org.codehaus.mojo:templating-maven-plugin:3.1.0:filter-sources ";
    expect(
      classifyPackageFailure(
        Object.assign(new Error(), { stdout: "", stderr: `${goal}\n${goal}` }),
      )[0],
    ).toBe("ambiguous");
  });
  it("binds one known compiler file and rejects malformed/replayed replacement tuples", () => {
    const error = Object.assign(new Error(), {
      stdout: "",
      stderr:
        "[ERROR] /supplier/source/mockserver/mockserver-core/src/main/java/org/mockserver/serialization/serializers/body/JsonBodySerializer.java:[42,7] cannot find symbol",
    });
    expect(classifyPackageFailure(error).join(",")).toBe(
      "identified,0,0,0,1,42,7,1",
    );
    for (const tuple of [
      "identified,0,0,0,0,0,0,0",
      "absent,0,0,1,0,0,0,0",
      "identified,257,0,1,0,0,0,0",
      "identified,0,0,1,0,0,0,0,extra",
    ])
      expect(
        observe([
          `[agentscope-material:v1 stage=supplier-package-other family=none maven=${tuple}]\n`,
        ]),
      ).toEqual(absent);
    const line =
      "[agentscope-material:v1 stage=supplier-package-other family=none maven=identified,2,0,3,0,0,0,0]\n";
    const text = `#7 0.193 ${line}0.193 ${line}`;
    for (let split = 0; split <= text.length; split++)
      expect(observe([text.slice(0, split), text.slice(split)])).toMatchObject({
        untrustedMavenFailure: { goal: 3 },
      });
    expect(
      observe([`#7 0.193 ${line}0.193 ${line.replace(",3,", ",4,")}`]),
    ).toEqual(absent);
  });
});

describe("actual optional Maven publisher block", () => {
  it.each([
    ["identified,2,0,3,0,0,0,0", true],
    ["ambiguous,2,0,3,0,0,0,0", true],
    ["overflow,0,0,0,0,0,0,0", true],
    ["identified,257,0,3,0,0,0,0", false],
    ["absent,2,0,3,0,0,0,0", false],
    ["identified,2,0,3,0,0,0,0,extra", false],
    ["identified,2,0,3,0,0,0,0\nCANARY", false],
    ["$(exit 8)", false],
  ])(
    "actual workflow retains only canonical Maven tuple %s",
    (tuple, valid) => {
      const workflow = parseYaml(
        readFileSync(
          new URL(
            "../../../.github/workflows/integration.yml",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as {
        jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
      };
      const script = workflow.jobs["mockserver-supplier-research"]!.steps.find(
        (step) => step.name === "Project closed research shell observations",
      )!.run!;
      const result = spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-e", "-c", script],
        {
          encoding: "utf8",
          timeout: 2000,
          maxBuffer: 4096,
          env: {
            OBSERVED_UNTRUSTED_BOOTSTRAP_STAGE:
              "supplier-connected-package-other",
            OBSERVED_UNTRUSTED_BOOTSTRAP_FAILURE_FAMILY: "none",
            OBSERVED_UNTRUSTED_MAVEN_FAILURE: String(tuple),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `untrusted_maven_failure=${valid ? tuple : "unknown"}`,
      );
      expect(result.stdout).not.toContain("CANARY");
    },
  );
});
describe("actual optional Maven publisher record", () => {
  it("curates the exact record without accessing hostile fields", () => {
    const source = readFileSync(
      new URL("../controller-file-command.mjs", import.meta.url),
      "utf8",
    );
    const fields: string[][] = [];
    const publish = runInNewContext(
      `${source.slice(source.indexOf("const own ="), source.indexOf("const append ="))}\n${source.slice(source.indexOf("export const publishBootstrapGpgObservation")).replace("export const", "const")}\npublishBootstrapGpgObservation`,
      {
        types,
        process: { env: {} },
        parseMavenFailureObservation,
        bootstrapStages: ["supplier-connected-package-other"],
        bootstrapFamilies: ["none"],
        append: (values: string[][]) => fields.push(...values),
      },
    ) as (diagnostic: unknown) => void;
    const record = parseMavenFailureObservation("identified,2,0,3,0,0,0,0")!;
    publish({
      process: {
        untrustedBootstrapStage: "supplier-connected-package-other",
        untrustedBootstrapFailureFamily: "none",
        untrustedMavenFailure: record,
      },
    });
    expect(fields[0]).toEqual([
      "untrusted_maven_failure",
      "identified,2,0,3,0,0,0,0",
    ]);
    let calls = 0;
    const hostile = Object.defineProperty({}, "disposition", {
      get() {
        calls++;
        throw Error("PRIVATE_CANARY");
      },
    });
    for (const candidate of [
      hostile,
      new Proxy(
        {},
        {
          ownKeys() {
            calls++;
            throw Error();
          },
        },
      ),
      { ...record, extra: "PRIVATE_CANARY" },
      {
        ...record,
        goal: {
          toString() {
            calls++;
            throw Error();
          },
        },
      },
    ]) {
      fields.length = 0;
      publish({
        process: {
          untrustedBootstrapStage: "supplier-connected-package-other",
          untrustedBootstrapFailureFamily: "none",
          untrustedMavenFailure: candidate,
        },
      });
      expect(fields[0]).toEqual(["untrusted_maven_failure", "unknown"]);
    }
    expect(calls).toBe(0);
    expect(JSON.stringify(fields)).not.toContain("PRIVATE_CANARY");
  });
});

const marker = (stage: string, family = "none") =>
  `[agentscope-material:v1 stage=${stage} family=${family}]\n`;
const observe = (chunks: readonly string[]) => {
  const observation = createBuildStderrObservation();
  for (const chunk of chunks) observation.consume(Buffer.from(chunk));
  return observation.snapshot();
};
const absent = { stderrClass: "unknown" };
const supplierStages = [
  "supplier-connected-entry",
  "supplier-connected-extract",
  "supplier-connected-package",
  "supplier-connected-package-compilation",
  "supplier-connected-package-resolution",
  "supplier-connected-package-frontend",
  "supplier-connected-package-other",
  "supplier-connected-service-finalization",
  "supplier-connected-inventory",
  "supplier-connected-inventory-read",
  "supplier-connected-inventory-guard",
  "supplier-connected-inventory-internal",
  "supplier-connected-output-create",
  "supplier-connected-output-write",
  "supplier-entry",
  "supplier-extract",
  "supplier-package",
  "supplier-package-compilation",
  "supplier-package-resolution",
  "supplier-package-frontend",
  "supplier-package-other",
  "supplier-service-finalization",
  "supplier-inventory",
  "supplier-inventory-read",
  "supplier-inventory-guard",
  "supplier-inventory-internal",
  "supplier-output-create",
  "supplier-output-write",
];
const signatureStages = [
  "recordset",
  "recordset-information",
  "recordset-rejection",
  "recordset-unknown",
  "count",
  "compliance",
  "signer",
  "algorithm",
  "hash",
  "class",
  "time",
  "key-time",
].map((value) => `signature-${value}`);

describe("closed signature-policy substage observations", () => {
  it.each(signatureStages)(
    "preserves %s across splits and exact replay",
    (stage) => {
      const original = `#7 0.193 ${marker(stage)}#7 0.194 ${marker(stage, "signature-policy")}`;
      const replay = `0.193 ${marker(stage)}0.194 ${marker(stage, "signature-policy")}`;
      const text = original + replay + "failed to solve\n";
      for (let split = 0; split <= text.length; split++)
        expect(observe([text.slice(0, split), text.slice(split)])).toEqual({
          stderrClass: "build-failed",
          untrustedBootstrapStage: stage,
          untrustedBootstrapFailureFamily: "signature-policy",
        });
      expect(observe(["X".repeat(20_000) + "\n", original, replay])).toEqual({
        ...absent,
        untrustedBootstrapStage: stage,
        untrustedBootstrapFailureFamily: "signature-policy",
      });
      for (const text of [
        marker(stage, "gpg-execution"),
        original + replay + replay,
        marker(stage) + marker("verify-signature"),
      ])
        expect(observe([text])).toEqual(absent);
      expect(observe([original, "permission denied\n"]).stderrClass).toBe(
        "permission-denied",
      );
    },
  );
});

describe("exact bounded BuildKit failed-RUN replay", () => {
  it("retains the complete matching replay sequence across every byte split", () => {
    const first = `#7 0.193 ${marker("import-key")}`;
    const failure = `#7 0.194 ${marker("import-key", "gpg-execution")}`;
    const replay = `0.193 ${marker("import-key")}0.194 ${marker("import-key", "gpg-execution")}`;
    const text = first + failure + "------\n" + replay + "failed to solve\n";
    for (let split = 0; split <= text.length; split += 1)
      expect(observe([text.slice(0, split), text.slice(split)])).toEqual({
        stderrClass: "build-failed",
        untrustedBootstrapStage: "import-key",
        untrustedBootstrapFailureFamily: "gpg-execution",
      });
    expect(
      observe([first, failure, "X".repeat(20_000) + "\n", replay]),
    ).toEqual({
      ...absent,
      untrustedBootstrapStage: "import-key",
      untrustedBootstrapFailureFamily: "gpg-execution",
    });
  });

  it.each([
    `0.192 ${marker("import-key")}`,
    `0.194 ${marker("import-key")}`,
    `0.193 ${marker("list-key")}`,
    `0.193 ${marker("import-key", "gpg-execution")}`,
    `0.193 ${marker("import-key")}0.193 ${marker("import-key")}`,
    `0.193 ${marker("import-key").replace("family=none", "family=none extra=canary")}`,
    "X".repeat(300) + `0.193 ${marker("import-key")}`,
    `0.193 ${marker("import-key").trimEnd()}`,
  ])(
    "rejects unobserved, substituted, duplicate or malformed replay %s",
    (replay) => {
      expect(observe([`#7 0.193 ${marker("import-key")}`, replay])).toEqual(
        absent,
      );
    },
  );

  it("rejects missing originals and keeps the original classifier boundary", () => {
    expect(observe([`0.193 ${marker("import-key")}`])).toEqual(absent);
    const original = `#7 0.193 ${marker("import-key")}`;
    const text = "X".repeat(16_340) + "\npermission denied\n";
    expect(
      observe([original, `0.193 ${marker("import-key")}`, text]).stderrClass,
    ).toBe(observe([text]).stderrClass);
    expect(observe(["ordinary canary\n"])).toEqual(absent);
  });
});

describe("closed supplier last-entered observations", () => {
  it("refuses any new marker after a first failure category while allowing exact replay", () => {
    const failures = supplierStages.filter((stage) =>
      /-(?:package-compilation|package-resolution|package-frontend|package-other|service-finalization|inventory-read|inventory-guard|inventory-internal|output-create|output-write)$/u.test(
        stage,
      ),
    );
    for (const first of failures)
      for (const next of supplierStages)
        expect(observe([marker(first), marker(next)])).toEqual(absent);
  });
  it.each(supplierStages)(
    "keeps only entered %s through splits, late bytes and exact replay",
    (stage) => {
      const entered = supplierStages
        .slice(0, supplierStages.indexOf(stage) + 1)
        .filter(
          (value) =>
            !/-(?:package-compilation|package-resolution|package-frontend|package-other|service-finalization|inventory-read|inventory-guard|inventory-internal|output-create|output-write)$/u.test(
              value,
            ) || value === stage,
        );
      const original = entered
        .map((value, index) => `#7 0.19${index} ${marker(value)}`)
        .join("");
      const replay = entered
        .map((value, index) => `0.19${index} ${marker(value)}`)
        .join("");
      const text = original + replay + "failed to solve\n";
      for (let split = 0; split <= text.length; split++)
        expect(observe([text.slice(0, split), text.slice(split)])).toEqual({
          stderrClass: "build-failed",
          untrustedBootstrapStage: stage,
          untrustedBootstrapFailureFamily: "none",
        });
      expect(observe(["X".repeat(20_000) + "\n", original, replay])).toEqual({
        ...absent,
        untrustedBootstrapStage: stage,
        untrustedBootstrapFailureFamily: "none",
      });
      for (const family of [
        "input",
        "filesystem",
        "gpg-execution",
        "listing-policy",
        "signature-policy",
        "checksum-policy",
        "CANARY",
      ])
        expect(observe([marker(stage, family)])).toEqual(absent);
      for (const value of [
        replay,
        original + replay + replay,
        marker(stage) +
          marker(
            stage.startsWith("supplier-connected-")
              ? "supplier-connected-entry"
              : "supplier-entry",
          ),
        marker(stage).replace("family=none", "family=none CANARY"),
      ])
        expect(observe([value])).toEqual(absent);
    },
  );
});
