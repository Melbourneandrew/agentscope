import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { runInNewContext } from "node:vm";
import { deriveIdentityBundle } from "@agentscope/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeFixtureResult } from "./operations.js";
import { failureEvidenceCoverageIsExact } from "./controller.js";
// @ts-expect-error existing repository release consumer has no declaration
import * as consumer from "../../../scripts/release-lane/admission.mjs";
// @ts-expect-error existing repository canonical helpers have no declaration
import * as canonical from "../../../scripts/release-lane/validation.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
type Fixture = {
  prepared: unknown;
  support: { entries: { binding: { seed: { runId: string } } }[] };
  evidence: {
    runId: string;
    scenarioId: string;
    outcome: string;
    cleanup: { outcome: string };
  };
  lifecycle: { artifactFileName: string };
  model: unknown;
  destination: unknown;
  observation: unknown;
};
const helpers = canonical as {
  canonicalJson: (value: unknown) => string;
  sha256: (value: string) => string;
};
const release = consumer as {
  bindScenarioEvidence: (
    prepared: Buffer,
    support: Buffer,
    files: Record<string, Buffer>,
    family: string,
  ) => { family: string };
  requireActualSemanticAdmission: (values: unknown) => unknown;
};
const documents = (input: Fixture) => ({
  "evidence.json": input.evidence,
  "fixture-lifecycle.json": input.lifecycle,
  "model-ledger.json": input.model,
  "destination-ledger.json": input.destination,
  "harness-observation.json": input.observation,
});
const componentFixture = (family: "codex" | "claude-code") => {
  const source = fs.readFileSync(
    new URL(
      "../../../scripts/__tests__/release-admission.test.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const begin = source.indexOf("function fixture() {"),
    end = source.indexOf("const bindCodex =", begin);
  const claude = source.indexOf("function claudeFixture() {"),
    claudeEnd = source.indexOf("const bindClaude =", claude);
  if ([begin, end, claude, claudeEnd].some((value) => value < 0))
    throw Error("synthetic-consumer-source-boundary");
  const factory = runInNewContext(
    `${source.slice(begin, end)}\n${source.slice(claude, claudeEnd)}\n({codexFixture,claudeFixture,codexSupportFixture});`,
    {
      Buffer,
      createHash,
      ...helpers,
      deriveIdentityBundle: (
        input: Parameters<typeof deriveIdentityBundle>[0],
      ) =>
        deriveIdentityBundle(
          JSON.parse(JSON.stringify(input)) as Parameters<
            typeof deriveIdentityBundle
          >[0],
        ),
    },
    { timeout: 1_000 },
  ) as {
    codexFixture: () => unknown;
    claudeFixture: () => unknown;
    codexSupportFixture: (input: unknown, family: string) => unknown;
  };
  const value = JSON.parse(
    JSON.stringify(
      family === "codex" ? factory.codexFixture() : factory.claudeFixture(),
    ),
  ) as Fixture;
  // The existing consumer preimage uses a placeholder lifecycle filename;
  // use the current producer's ordinary sanitized fixture envelope here.
  value.lifecycle.artifactFileName = "agentscope-cli.tgz";
  value.support = JSON.parse(
    JSON.stringify(factory.codexSupportFixture(value, family)),
  ) as Fixture["support"];
  return value;
};
const setup = () => {
  const root = fs.mkdtempSync(join(tmpdir(), "agentscope-success-cleanup-"));
  roots.push(root);
  const artifacts = join(root, "artifacts/integration");
  const integration = join(root, "tests/integration");
  const privateRoot = join(root, "private");
  for (const path of [artifacts, integration, privateRoot])
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const status = fs.lstatSync(privateRoot);
  const inputs = [componentFixture("codex"), componentFixture("claude-code")];
  const generic = "3".repeat(16);
  const entries = inputs.flatMap((input) => input.support.entries);
  const material = {
    manifestVersion: 1,
    disposition: "real-scenario-evidence-awaiting-release-gate",
    entries,
  };
  const support = {
    ...material,
    manifestIdentity: helpers
      .sha256(helpers.canonicalJson(material))
      .replace("sha256:", "sha256-"),
  };
  const write = (relative: string, value: unknown) => {
    const path = join(artifacts, relative);
    fs.mkdirSync(resolve(path, ".."), { recursive: true });
    fs.writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return path;
  };
  write("harness-support-evidence.json", support);
  write("current-selection.json", {});
  for (const input of inputs) {
    for (const [name, value] of Object.entries(documents(input)))
      write(`runs/${input.evidence.runId}/${name}`, value);
    write(`runs/${input.evidence.runId}/raw-private.json`, {
      raw: "PRIVATE_CANARY",
    });
    write(`contexts/${input.evidence.runId}/private.json`, {
      raw: "PRIVATE_CANARY",
    });
  }
  write(`runs/${generic}/raw.json`, { raw: "PRIVATE_CANARY" });
  write("candidates/owned/private.json", { raw: "PRIVATE_CANARY" });
  const owned = {
    artifactFiles: ["harness-support-evidence.json", "current-selection.json"],
    candidateIdentities: ["owned"],
    runIds: [...inputs.map((input) => input.evidence.runId), generic],
    requiredFailureEvidence: [] as string[],
    failureEvidence: [],
    privateStorageRetirements: [],
  };
  const output: unknown[] = [];
  let dockerFailure = false;
  const run = () => {
    const source = fs.readFileSync(
      new URL("../clean.mjs", import.meta.url),
      "utf8",
    );
    runInNewContext(
      source
        .replace(/^import[\s\S]*?from "[^"]+";$/gmu, "")
        .replace("import.meta.dirname", JSON.stringify(integration)),
      {
        ...fs,
        Buffer,
        createHash,
        resolve,
        sep,
        process,
        sanitizeFixtureResult,
        requireDisposableOuterHostCapability: () => ({
          binding: {
            dockerExecutable: "/inert",
            dockerEnvironment: {},
            privateStorage: {
              root: privateRoot,
              rootDev: status.dev,
              rootIno: status.ino,
              rootUid: status.uid,
              rootGid: status.gid,
              rootMode: status.mode & 0o7777,
            },
          },
        }),
        ownedIntegrationResources: () => owned,
        remainingIntegrationOperationMilliseconds: () => 1000,
        failureEvidenceCoverageIsExact,
        IMAGE_PREPARATION_LIMITS: { maximumEvidenceBytes: 1024 * 1024 },
        validInstalledPtyFailure: () => true,
        validCodexResearchDiagnostic: () => true,
        certificationFailureAuthorityIsValid: () => true,
        execFileSync: () => {
          if (dockerFailure) throw Error("synthetic-docker-refusal");
          return "";
        },
        console: { log: (value: unknown) => output.push(value) },
      },
      { timeout: 1000 },
    );
  };
  return {
    root,
    artifacts,
    inputs,
    owned,
    output,
    support,
    write,
    run,
    refuseDocker: () => {
      dockerFailure = true;
    },
  };
};

describe("actual success cleanup handoff (synthetic component evidence only)", () => {
  it("retains exact support/five-document bytes, deletes raw state, and preserves the existing consumer", () => {
    const input = setup();
    const supportBytes = fs.readFileSync(
      join(input.artifacts, "harness-support-evidence.json"),
    );
    const before = input.inputs.map((value) =>
      Object.fromEntries(
        Object.keys(documents(value)).map((name) => [
          name,
          fs.readFileSync(
            join(input.artifacts, "runs", value.evidence.runId, name),
          ),
        ]),
      ),
    );
    input.run();
    expect(
      fs.readFileSync(join(input.artifacts, "harness-support-evidence.json")),
    ).toEqual(supportBytes);
    for (const [index, value] of input.inputs.entries()) {
      const retained = Object.fromEntries(
        Object.keys(documents(value)).map((name) => [
          name,
          fs.readFileSync(
            join(input.artifacts, "runs", value.evidence.runId, name),
          ),
        ]),
      );
      expect(retained).toEqual(before[index]);
      expect(
        fs
          .readdirSync(join(input.artifacts, "runs", value.evidence.runId))
          .sort(),
      ).toEqual(Object.keys(documents(value)).sort());
      const family = index === 0 ? "codex" : "claude-code";
      expect(
        release.bindScenarioEvidence(
          Buffer.from(JSON.stringify(value.prepared)),
          supportBytes,
          retained,
          family,
        ).family,
      ).toBe(family);
      retained["model-ledger.json"] = Buffer.from("{}");
      expect(() =>
        release.bindScenarioEvidence(
          Buffer.from(JSON.stringify(value.prepared)),
          supportBytes,
          retained,
          family,
        ),
      ).toThrow();
    }
    expect(() => release.requireActualSemanticAdmission([])).toThrow();
    for (const path of [
      "contexts",
      "candidates/owned",
      "current-selection.json",
      `runs/${"3".repeat(16)}`,
    ])
      expect(
        fs.existsSync(join(input.artifacts, path)) &&
          fs.readdirSync(join(input.artifacts, path)).length > 0,
      ).toBe(false);
    expect(input.output.at(-1)).toBe(
      "Agentscope integration cleanup complete.",
    );
  });
});

describe("actual cleanup rejects an unsafe or incomplete success handoff", () => {
  it.each([
    "missing",
    "symlink",
    "hardlink",
    "oversized",
    "incomplete",
    "foreign-run",
  ])("refuses %s without a successful handoff", (kind) => {
    const input = setup();
    const first = input.inputs[0];
    if (first === undefined) throw Error("synthetic-input");
    const path = join(
      input.artifacts,
      "runs",
      first.evidence.runId,
      "model-ledger.json",
    );
    if (kind === "missing") fs.unlinkSync(path);
    if (kind === "symlink") {
      fs.unlinkSync(path);
      fs.symlinkSync(join(input.artifacts, "current-selection.json"), path);
    }
    if (kind === "hardlink") fs.linkSync(path, join(input.root, "alias"));
    if (kind === "oversized") fs.writeFileSync(path, Buffer.alloc(1_048_577));
    if (kind === "incomplete") {
      first.evidence.cleanup.outcome = "failed";
      input.write(`runs/${first.evidence.runId}/evidence.json`, first.evidence);
    }
    if (kind === "foreign-run") {
      const entry = input.support.entries[0];
      if (entry === undefined) throw Error("synthetic-entry");
      entry.binding.seed.runId = "f".repeat(16);
      input.write("harness-support-evidence.json", input.support);
    }
    expect(input.run).toThrow();
    expect(input.output).not.toContain(
      "Agentscope integration cleanup complete.",
    );
  });
  it("retains no success handoff when exact resource cleanup fails", () => {
    const input = setup();
    input.refuseDocker();
    expect(input.run).toThrow("synthetic-docker-refusal");
    expect(input.output).not.toContain(
      "Agentscope integration cleanup complete.",
    );
  });
  it.each(["required-failure", "private-residue"])(
    "prevents successful handoff with %s",
    (kind) => {
      const input = setup();
      if (kind === "required-failure") {
        const first = input.inputs[0];
        if (first === undefined) throw Error("synthetic-input");
        input.owned.requiredFailureEvidence.push(first.evidence.runId);
      } else fs.mkdirSync(join(input.root, "private", "unexpected"));
      expect(input.run).toThrow();
      expect(input.output).not.toContain(
        "Agentscope integration cleanup complete.",
      );
    },
  );
});
