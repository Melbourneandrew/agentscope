import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createBuildStderrObservation } from "../image-preparation/process-output.mjs";
import { settledBuildFailure } from "../image-preparation/build-policy.mjs";

const source = readFileSync(
  new URL("../harness-material-command.mjs", import.meta.url),
  "utf8",
);
const start = source.indexOf("const maximumOutputBytes =");
if (start < 0) throw new Error("actual-command-source-boundary");
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const archive = Buffer.from("inert compressed fixture");
const member = Buffer.from("inert binary fixture");
const bundles = [{ fixed: true }];
const packagePin = {
  packageName: "@vendor/tool",
  installName: "@vendor/tool",
  version: "1.0.0",
  integrity: "sha512-fixed",
  tarballUrl: "https://registry.npmjs.org/fixed.tgz",
  attestationBundleDigest: hash(Buffer.from(JSON.stringify(bundles))),
};
const platformPackage = {
  bytes: archive.length,
  sha256: hash(archive),
  integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  memberName: "package/claude",
  memberBytes: member.length,
  memberSha256: hash(member),
};
const listing = ["claude", "package.json", "LICENSE.md", "README.md"]
  .map(
    (name) =>
      `-rwxr-xr-x 0/0 ${name === "claude" ? member.length : 1} 2026-01-01 00:00:00 package/${name}`,
  )
  .join("\n");
const policy = {
  packages: [packagePin],
  registry: "https://registry.npmjs.org/",
  verifierNpmVersion: "11.19.1",
  platformPackage,
  maximumMilliseconds: 1000,
  primaryFingerprint: "A".repeat(40),
  signerFingerprint: "A".repeat(40),
  signatureHashAlgorithm: "sha512",
  uid: "Fixed Public Fixture",
};
const gpgListing = `pub:::::::::\nfpr:::::::::${policy.primaryFingerprint}:\n`;
const signature = `[GNUPG:] GOODSIG fixed ${policy.uid}\n[GNUPG:] VALIDSIG ${policy.signerFingerprint} date 0 0 4 0 1 10 00 ${policy.primaryFingerprint}\n`;
const commandFixture = (
  operation: string,
  failedStage?: string,
  sinkFails = false,
) => {
  const process = {
    argv: ["node", "command", operation, "/verify"],
    exitCode: undefined as number | undefined,
  };
  const output: string[] = [];
  const reject = (stage: string) => {
    if (stage === failedStage) throw new Error("private-error-canary");
  };
  const context = {
    Buffer,
    createHash,
    resolve,
    performance,
    setTimeout,
    clearTimeout,
    process,
    mkdirSync: () => {
      reject("gpg-home");
    },
    writeFileSync: () => {
      reject("npm-input");
    },
    writeSync: (descriptor: number, text: string) => {
      expect(descriptor).toBe(2);
      if (sinkFails) throw new Error("private-sink-canary");
      output.push(text);
    },
    readFileSync: (path: string) => {
      if (path.endsWith("policy.json"))
        return Buffer.from(JSON.stringify(policy));
      if (path.endsWith("platform.tgz"))
        return failedStage === "platform-archive"
          ? Buffer.from("wrong")
          : Buffer.from(archive);
      return Buffer.from(
        JSON.stringify({
          packages: {
            [`node_modules/${packagePin.installName}`]: {
              version:
                failedStage === "npm-lock" ? "wrong" : packagePin.version,
              integrity: packagePin.integrity,
              resolved: packagePin.tarballUrl,
            },
          },
        }),
      );
    },
    execute: (_executable: string, arguments_: string[]) => {
      let stage: string;
      let stdout: string;
      if (arguments_.includes("--list")) {
        stage = "platform-inventory";
        stdout = listing;
      } else if (arguments_.includes("--import")) {
        stage = "gpg-import";
        stdout = "";
      } else if (arguments_.includes("--list-keys")) {
        stage = "gpg-list";
        stdout = failedStage === "gpg-key-policy" ? "" : gpgListing;
      } else if (arguments_.includes("--verify")) {
        stage = "gpg-signature";
        stdout = failedStage === "gpg-signature-policy" ? "" : signature;
      } else if (arguments_.includes("--version")) {
        stage = "npm-version";
        stdout = "11.19.1\n";
      } else if (arguments_.includes("install")) {
        stage = "npm-install";
        stdout = "";
      } else {
        stage = "npm-audit";
        stdout = JSON.stringify({
          invalid: [],
          missing: [],
          verified: [
            {
              name: packagePin.packageName,
              version: packagePin.version,
              attestationBundles: failedStage === "npm-bundles" ? [] : bundles,
            },
          ],
        });
      }
      reject(stage);
      return Promise.resolve({ stdout, stderr: "" });
    },
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      queueMicrotask(() => {
        child.stdout.emit("data", member);
        child.emit("close", failedStage === "platform-member" ? 1 : 0);
      });
      return child;
    },
  };
  return {
    process,
    output,
    run: () =>
      runInNewContext(
        `(async () => { ${source.slice(start)} })()`,
        context,
      ) as Promise<void>,
  };
};

const stages = [
  "npm-input",
  "npm-version",
  "npm-install",
  "npm-lock",
  "npm-audit",
  "npm-bundles",
  "platform-archive",
  "platform-inventory",
  "platform-member",
  "gpg-home",
  "gpg-import",
  "gpg-list",
  "gpg-key-policy",
  "gpg-signature",
  "gpg-signature-policy",
];
describe("actual verifier command fixed failure stages", () => {
  it.each(stages)(
    "retains only the fixed %s marker and original failure",
    async (stage) => {
      const fixture = commandFixture(
        stage.startsWith("npm-") ? "npm-verify" : "gpg-verify",
        stage,
      );
      await fixture.run();
      expect(fixture.process.exitCode).toBe(1);
      expect(fixture.output).toEqual([
        `[agentscope-verifier:v1 failure=${stage}]\n`,
      ]);
      expect(fixture.output.join("")).not.toMatch(
        /canary|\/verify|Fixed Public Fixture/u,
      );
    },
  );
  it.each(["npm-verify", "gpg-verify"])(
    "success %s emits no failure marker",
    async (operation) => {
      const fixture = commandFixture(operation);
      await fixture.run();
      expect(fixture.process.exitCode).toBeUndefined();
      expect(fixture.output).toEqual([]);
    },
  );
  it("diagnostic delivery failure preserves command failure", async () => {
    const fixture = commandFixture("gpg-verify", "gpg-import", true);
    await fixture.run();
    expect(fixture.process.exitCode).toBe(1);
    expect(fixture.output).toEqual([]);
  });
});

const observe = (chunks: string[]) => {
  const observation = createBuildStderrObservation();
  for (const chunk of chunks) observation.consume(Buffer.from(chunk));
  return observation.snapshot();
};
const marker = (stage: string) => `[agentscope-verifier:v1 failure=${stage}]\n`;
const verifierSource = readFileSync(
  new URL("../verify-substrate-certification.mjs", import.meta.url),
  "utf8",
);
const verifierStart = verifierSource.indexOf("const exactKeys =");
const verifierEnd = verifierSource.indexOf(
  "const artifactsRoot =",
  verifierStart,
);
if (verifierStart < 0 || verifierEnd <= verifierStart)
  throw new Error("actual-failure-verifier-source-boundary");
const validateBuilder = runInNewContext(
  `${verifierSource.slice(verifierStart, verifierEnd)}; validBuilderCleanup;`,
  { createHash },
) as (value: unknown, authority: unknown, runIds: string[]) => boolean;
const digestJson = (value: unknown) =>
  `sha256:${hash(Buffer.from(JSON.stringify(value)))}`;
const validateObservedStage = (stderrClass: string) => {
  const runId = "0123456789abcdef";
  const authority = {
    daemon: `sha256:${"a".repeat(64)}`,
    buildkitImage: `sha256:${"b".repeat(64)}`,
    buildkitPlatform: `sha256:${"c".repeat(64)}`,
  };
  return validateBuilder(
    {
      diagnosticVersion: 1,
      stage: "builder-reconciliation",
      operationKind: "image-build",
      outcome: "failed-settled",
      identityDigests: {
        builder: digestJson(`agentscope-${runId}`),
        runGeneration: digestJson(runId),
        daemon: authority.daemon,
        image: authority.buildkitImage,
        platform: authority.buildkitPlatform,
      },
      process: {
        observed: true,
        exited: true,
        joined: true,
        signaled: false,
        timedOut: false,
        outputTruncated: false,
        outputBytes: 5000,
        stderrClass,
      },
      responseBytes: 0,
      responseTruncated: false,
      expectedResourceCount: 2,
      observedResourceCount: 0,
      expectedResourceDigest: digestJson([
        `buildx_buildkit_agentscope-${runId}0`,
        `buildx_buildkit_agentscope-${runId}0_state`,
      ]),
      observedResourceDigest: digestJson([]),
      reconciliationReasons: {
        builderContainer: "absent",
        builderVolume: "absent",
        builtTag: "absent",
      },
    },
    authority,
    [runId],
  );
};
describe("bounded untrusted verifier failure observation", () => {
  it.each(stages)("projects only %s through existing stderrClass", (stage) => {
    const text = marker(stage);
    expect(
      observe([text.slice(0, 9), text.slice(9), "ERROR: failed to solve\n"])
        .stderrClass,
    ).toBe(`verifier-${stage}`);
    const error = settledBuildFailure(
      {
        firstFailureDiagnostic: {
          operationKind: "image-build",
          process: { stderrClass: `verifier-${stage}` },
        },
      },
      new Error("original"),
    );
    expect(error.message).toBe(
      "integration.images.build.image-build.build-failed",
    );
    expect(validateObservedStage(`verifier-${stage}`)).toBe(true);
  });
  it("accepts exact BuildKit replay without adding outcome authority", () => {
    expect(
      observe([
        `#12 0.123 ${marker("gpg-import")}0.123 ${marker("gpg-import")}`,
      ]),
    ).toEqual({ stderrClass: "verifier-gpg-import" });
  });
  it.each([
    marker("foreign"),
    marker("gpg-import") + marker("npm-install"),
    marker("gpg-import").trimEnd(),
    marker("gpg-import").replace("v1", "v2"),
    `${marker("gpg-import").trimEnd()}private-canary\n`,
    `[agentscope-verifier:v1 failure=gpg-import]${"x".repeat(300)}\n`,
  ])(
    "refuses malformed, unlisted, ambiguous or oversized marker %#",
    (text) => {
      expect(observe([text]).stderrClass).toBe("unknown");
    },
  );
  it("does not let prior valid markers mask later oversized or partial records", () => {
    expect(
      observe([
        marker("gpg-import"),
        `[agentscope-verifier${"x".repeat(1000)}\n`,
      ]).stderrClass,
    ).toBe("unknown");
    expect(
      observe([marker("gpg-import"), "[agentscope-verifier"]).stderrClass,
    ).toBe("unknown");
  });
  it("preserves legacy classification without a verifier marker", () => {
    expect(observe(["ERROR: failed to solve\n"]).stderrClass).toBe(
      "build-failed",
    );
    expect(observe(["private-canary\n"]).stderrClass).toBe("unknown");
    expect(validateObservedStage("verifier-private-canary/value")).toBe(false);
  });
});
