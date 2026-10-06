import { describe, expect, it } from "vitest";
import { createBuildStderrObservation } from "../image-preparation/process-output.mjs";

const marker = (stage: string, family = "none") =>
  `[agentscope-material:v1 stage=${stage} family=${family}]\n`;
const observe = (chunks: readonly string[]) => {
  const observation = createBuildStderrObservation();
  for (const chunk of chunks) observation.consume(Buffer.from(chunk));
  return observation.snapshot();
};
const absent = { stderrClass: "unknown" };
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
